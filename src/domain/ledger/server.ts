import type { Ledger, Op } from "../../types";
import { bootstrap, commitOp, type CommitOutcome } from "./engine";

const KEY = "pair-wise-yf-46/ledger/v1";
const LEGACY_KEY = "pair-wise-yf-46/rundown";
const FAULT_KEY = "pair-wise-yf-46/fault-next";

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

let memory: StorageLike | null = null;

function memoryStorage(): StorageLike {
  if (!memory) {
    const map = new Map<string, string>();
    memory = {
      getItem: (key) => (map.has(key) ? map.get(key)! : null),
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => void map.delete(key)
    };
  }
  return memory;
}

/** 自测环境重置内存存储（清空"服务端"数据） */
export function resetMemoryStorage(): void {
  memory = null;
}

function storage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined") {
      const probe = "__probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    /* 自测环境无 localStorage */
  }
  return memoryStorage();
}

/** 读取账本：旧数据（无版本号数组，含上一版存储键）首次打开时迁移补版本 */
export function loadLedger(now = new Date().toISOString()): Ledger {
  const store = storage();
  const raw = store.getItem(KEY) ?? store.getItem(LEGACY_KEY);
  const ledger = bootstrap(raw ? (JSON.parse(raw) as unknown) : null, now);
  // 迁移成功后立刻回写新键，旧键保留作为留档，不再覆盖
  if (!store.getItem(KEY)) store.setItem(KEY, JSON.stringify(ledger));
  return ledger;
}

/** 模拟下一次 commit 落盘失败（故障注入，自测与应急队列演示用） */
export function armNextWriteFault(): void {
  storage().setItem(FAULT_KEY, "1");
}

export class WriteFaultError extends Error {
  constructor() {
    super("主链路写入失败：操作未入库，请只重试未写入的部分");
    this.name = "WriteFaultError";
  }
}

export type ServerResult = CommitOutcome & {
  /** 本次合并依据的操作序号 */
  seq: number;
  station: Op["station"];
};

/**
 * 服务端提交：
 * - 按 opId 幂等，同一插播/同一操作只入库一次；
 * - 写入失败发生在持久化之前，账本不变，客户端重试安全；
 * - 冲突/拒绝不属故障，不重试。
 */
export function commitToServer(op: Op): ServerResult {
  const store = storage();
  const ledger = loadLedger(op.at);
  const outcome = commitOp(ledger, op);

  if (outcome.status === "conflict" || outcome.status === "denied" || outcome.status === "duplicate") {
    // 冲突也要持久化（差异清单入档，供两岗查看）；duplicate 是服务端已有，无需再写
    if (outcome.status !== "duplicate") {
      if (store.getItem(FAULT_KEY)) {
        store.removeItem(FAULT_KEY);
        throw new WriteFaultError();
      }
      store.setItem(KEY, JSON.stringify(outcome.ledger));
    }
    return { ...outcome, seq: op.seq, station: op.station };
  }

  if (store.getItem(FAULT_KEY)) {
    store.removeItem(FAULT_KEY);
    throw new WriteFaultError();
  }
  store.setItem(KEY, JSON.stringify(outcome.ledger));
  return { ...outcome, seq: op.seq, station: op.station };
}

export function refreshLedger(now = new Date().toISOString()): Ledger {
  return loadLedger(now);
}
