import type { LedgerState } from "./engine";
import { emptyLedger, migrateItems, now } from "./engine";
import type { Role, RundownItem } from "../types";

const LEDGER_KEY = "pair-wise-yf-46/ledger/v1";
const LEGACY_KEY = "pair-wise-yf-46/rundown";

export interface PersistedLedger extends LedgerState {
  role?: string;
}

/** 首次打开的种子数据（带版本号 v1） */
function seedLedger(): LedgerState {
  const ts = now();
  const seed: RundownItem[] = [
    { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控", version: 1, updatedAt: ts, updatedBy: "导播" as Role },
    { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚", version: 1, updatedAt: ts, updatedBy: "导播" as Role },
    { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A", version: 1, updatedAt: ts, updatedBy: "导播" as Role },
    { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串", version: 1, updatedAt: ts, updatedBy: "导播" as Role },
  ];
  const migrated = migrateItems(seed);
  return {
    ...emptyLedger(),
    ledgerVersion: 1,
    items: migrated.items,
    archive: migrated.archive,
    migrated: true,
  };
}

/** 读取账本；旧数据（无版本号）首次打开补版本并归档已播出记录 */
export function loadLedger(): { state: LedgerState; legacy: boolean; legacyCount: number } {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as LedgerState;
      return { state: { ...emptyLedger(), ...parsed }, legacy: false, legacyCount: 0 };
    }
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const migrated = migrateItems(JSON.parse(legacyRaw));
      const state: LedgerState = {
        ...emptyLedger(),
        ledgerVersion: 1,
        items: migrated.items,
        archive: migrated.archive,
        migrated: true,
      };
      return { state, legacy: true, legacyCount: migrated.legacyCount };
    }
  } catch {
    // 损坏数据忽略，走种子账本
  }
  return { state: seedLedger(), legacy: false, legacyCount: 0 };
}

export function saveLedger(state: LedgerState): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时静默，内存态仍可工作
  }
}

export function clearLegacy(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore
  }
}

export type { RundownItem };
