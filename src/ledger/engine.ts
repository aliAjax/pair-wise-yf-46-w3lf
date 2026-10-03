import { addMinutes, format } from "date-fns";
import type {
  BreakingChange,
  ConflictDiff,
  ConflictRecord,
  HistoryEntry,
  LedgerOp,
  OpStatus,
  OpType,
  Role,
  RundownItem,
} from "../types";

/** 本岗位（控制台）标识 */
export const CLIENT_ID = "console-local";
const BROADCAST_START = "2026-10-08T08:00:00";

export const now = () => new Date().toISOString();
export const newOpId = () => `op:${crypto.randomUUID()}`;

/** 突发插播幂等键：同一标题/锚点/原因只入库一次 */
export function breakingOpId(headline: string, insertAfter: string, reason: string) {
  return `breaking:${headline.trim()}:${insertAfter}:${reason.trim()}`;
}

/* ------------------------------------------------------------------ */
/* 迁移：旧数据没有版本号，首次打开补 1，已播出记录归入留档              */
/* ------------------------------------------------------------------ */

export interface MigratedLedger {
  items: RundownItem[];
  archive: RundownItem[];
  migrated: boolean;
  legacyCount: number;
}

export function migrateItems(raw: unknown): MigratedLedger {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const ts = now();
  let migrated = false;
  const versioned: RundownItem[] = list.map((r) => {
    if (typeof r.version === "number" && r.version >= 1) return r as unknown as RundownItem;
    migrated = true;
    return {
      ...(r as object),
      version: 1,
      updatedAt: (r.updatedAt as string) ?? ts,
      updatedBy: (r.updatedBy as Role) ?? "导播",
    } as unknown as RundownItem;
  });
  const items = versioned.filter((i) => i.status !== "已播出");
  const archive = versioned
    .filter((i) => i.status === "已播出")
    .map((i) => ({ ...i, syncState: "confirmed" as const }));
  return { items, archive, migrated, legacyCount: versioned.length };
}

/* ------------------------------------------------------------------ */
/* 硬时间重算：从未开播段落起，按已播出时长累加，超过 hardStart 即风险    */
/* ------------------------------------------------------------------ */

export interface ItemTiming {
  item: RundownItem;
  at: string;
  atDate: Date;
  risk: boolean;
}

function parseHM(hm?: string): Date | null {
  if (!hm) return null;
  const [h, m] = hm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const d = new Date(BROADCAST_START);
  d.setHours(h, m, 0, 0);
  return d;
}

export function recompute(items: RundownItem[], archive: RundownItem[] = []): ItemTiming[] {
  const start = new Date(BROADCAST_START);
  const elapsed = archive.reduce((s, it) => s + (it.duration || 0), 0);
  let cursor = addMinutes(start, elapsed);
  return items.map((item) => {
    const atDate = new Date(cursor);
    cursor = addMinutes(cursor, item.duration);
    const hard = parseHM(item.hardStart);
    return { item, at: format(atDate, "HH:mm"), atDate, risk: !!hard && atDate > hard };
  });
}

/* ------------------------------------------------------------------ */
/* 岗位权限矩阵：越权直接拒绝，不入账                                    */
/* ------------------------------------------------------------------ */

const TEXT_FIELDS = ["title", "presenter", "source"];

export function canPerform(
  type: OpType,
  actor: Role,
  payload: Record<string, unknown>,
): { allowed: boolean; reason?: string } {
  if (actor === "导播") return { allowed: true };
  switch (type) {
    case "item/add":
    case "breaking/insert":
      return actor === "主编"
        ? { allowed: true }
        : { allowed: false, reason: `${actor}岗位无权新增条目或安排突发插播` };
    case "item/update": {
      if (actor === "主编") return { allowed: true };
      if (actor === "字幕") {
        const patch = (payload.changes ?? {}) as Record<string, unknown>;
        const fields = Object.keys(patch);
        const onlyText = fields.length > 0 && fields.every((f) => TEXT_FIELDS.includes(f));
        return onlyText
          ? { allowed: true }
          : { allowed: false, reason: "字幕岗位只能改标题、主播、来源文字，不能动时长或状态" };
      }
      return { allowed: false, reason: `${actor}岗位无权修改条目内容` };
    }
    case "item/status":
      return actor === "演播室"
        ? { allowed: true }
        : { allowed: false, reason: `${actor}岗位无权确认播出状态` };
    case "item/skip":
      return actor === "演播室" || actor === "主编"
        ? { allowed: true }
        : { allowed: false, reason: `${actor}岗位无权取消条目` };
    case "item/duration":
    case "item/reorder":
      return { allowed: false, reason: `${actor}岗位无权调整时长或串联单顺序` };
    case "ledger/undo":
      return { allowed: false, reason: `${actor}岗位无权撤回账本` };
    default:
      return { allowed: false, reason: "未知操作" };
  }
}

/* ------------------------------------------------------------------ */
/* 账本状态                                                            */
/* ------------------------------------------------------------------ */

export interface LedgerState {
  ledgerVersion: number;
  seqCounter: number;
  items: RundownItem[];
  archive: RundownItem[];
  opLog: LedgerOp[];
  conflicts: ConflictRecord[];
  outbox: LedgerOp[];
  changes: BreakingChange[];
  history: HistoryEntry[];
  migrated: boolean;
}

export function emptyLedger(): LedgerState {
  return {
    ledgerVersion: 0,
    seqCounter: 0,
    items: [],
    archive: [],
    opLog: [],
    conflicts: [],
    outbox: [],
    changes: [],
    history: [],
    migrated: false,
  };
}

/* ------------------------------------------------------------------ */
/* 变更结构应用（version 为 null 时仅投影结构，不出版本）                */
/* ------------------------------------------------------------------ */

function applyStructure(
  state: LedgerState,
  type: OpType,
  payload: Record<string, unknown>,
  actor: Role,
  ts: string,
  version: number | null,
  seq: number,
): { items: RundownItem[]; archive: RundownItem[]; changes: BreakingChange[] } {
  const touch = (it: RundownItem): RundownItem =>
    version === null ? it : { ...it, version, updatedAt: ts, updatedBy: actor, syncState: "confirmed" };
  let items = state.items;
  let archive = state.archive;
  let changes = state.changes;

  switch (type) {
    case "item/add": {
      const item: RundownItem = touch({
        id: crypto.randomUUID(),
        title: payload.title as string,
        type: payload.type as RundownItem["type"],
        duration: Number(payload.duration),
        hardStart: payload.hardStart as string | undefined,
        status: "草稿",
        presenter: payload.presenter as string,
        source: payload.source as string,
        version: 0,
        updatedAt: ts,
        updatedBy: actor,
      });
      items = [...items, item];
      break;
    }
    case "item/update": {
      const patch = (payload.changes ?? {}) as Record<string, unknown>;
      items = items.map((it) => (it.id === payload.id ? touch({ ...it, ...patch }) : it));
      break;
    }
    case "item/status": {
      const target = items.find((i) => i.id === payload.id);
      const nextStatus = payload.status as RundownItem["status"];
      items = items.map((it) => (it.id === payload.id ? touch({ ...it, status: nextStatus }) : it));
      if (nextStatus === "已播出" && target) {
        archive = [touch({ ...target, status: "已播出" }), ...archive];
        items = items.filter((i) => i.id !== payload.id);
      }
      break;
    }
    case "item/skip": {
      items = items.map((it) =>
        it.id === payload.id ? touch({ ...it, status: "已跳过" }) : it,
      );
      break;
    }
    case "item/duration": {
      const delta = Number(payload.delta);
      items = items.map((it) =>
        it.id === payload.id ? touch({ ...it, duration: Math.max(1, it.duration + delta) }) : it,
      );
      break;
    }
    case "item/reorder": {
      const order = payload.order as string[];
      items = order
        .map((id) => items.find((i) => i.id === id))
        .filter((i): i is RundownItem => Boolean(i))
        .map((it) => touch({ ...it }));
      break;
    }
    case "breaking/insert": {
      const headline = payload.headline as string;
      const duration = Number(payload.duration);
      const insertAfter = payload.insertAfter as string;
      const reason = payload.reason as string;
      const idx = items.findIndex((i) => i.id === insertAfter);
      const item: RundownItem = touch({
        id: crypto.randomUUID(),
        title: headline,
        type: "新闻片",
        duration,
        status: "待播",
        presenter: "值班主播",
        source: `插播：${reason}`,
        version: 0,
        updatedAt: ts,
        updatedBy: actor,
      });
      const next = [...items];
      next.splice(idx + 1, 0, item);
      items = next;
      changes = [
        {
          id: crypto.randomUUID(),
          opId: payload.opId as string,
          seq,
          headline,
          duration,
          insertAfter,
          reason,
          createdAt: ts,
        },
        ...changes,
      ];
      break;
    }
    case "ledger/undo": {
      const snap = (payload.snapshot ?? []) as RundownItem[];
      items = snap.map((it) => touch({ ...it }));
      archive = [];
      break;
    }
  }
  return { items, archive, changes };
}

/* ------------------------------------------------------------------ */
/* 差异计算                                                            */
/* ------------------------------------------------------------------ */

const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  type: "类型",
  duration: "时长",
  presenter: "主播",
  source: "来源",
  status: "状态",
  hardStart: "硬时间",
};

function diffFor(
  type: OpType,
  payload: Record<string, unknown>,
  target: RundownItem | undefined,
): ConflictDiff[] {
  if (!target) {
    if (type === "item/reorder")
      return [{ field: "order", label: "串联单顺序", before: "已确认顺序", after: "调整后的顺序" }];
    if (type === "breaking/insert")
      return [{ field: "insert", label: "突发插播", before: "未插入", after: payload.headline }];
    if (type === "ledger/undo")
      return [{ field: "undo", label: "撤回", before: "当前版本", after: "上一版本" }];
    return [];
  }
  const diffs: ConflictDiff[] = [];
  if (type === "item/duration") {
    diffs.push({
      field: "duration",
      label: "时长",
      before: target.duration,
      after: Math.max(1, target.duration + Number(payload.delta)),
    });
    return diffs;
  }
  if (type === "item/status") {
    diffs.push({ field: "status", label: "状态", before: target.status, after: payload.status });
    return diffs;
  }
  if (type === "item/skip") {
    diffs.push({ field: "status", label: "状态", before: target.status, after: "已跳过" });
    return diffs;
  }
  const patch = (payload.changes ?? payload) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id" || k === "opId") continue;
    const before = (target as unknown as Record<string, unknown>)[k];
    if (JSON.stringify(before) !== JSON.stringify(v)) {
      diffs.push({ field: k, label: FIELD_LABELS[k] ?? k, before, after: v });
    }
  }
  return diffs;
}

function targetOf(type: OpType, payload: Record<string, unknown>): string | undefined {
  if (type === "item/reorder" || type === "breaking/insert" || type === "ledger/undo") return undefined;
  return payload.id as string | undefined;
}

/** 该操作是否触碰某一段落（用于并发判定） */
function opTouchesItem(o: LedgerOp, itemId: string): boolean {
  const p = o.payload;
  if (p.id === itemId) return true;
  if (o.type === "breaking/insert" && p.insertAfter === itemId) return true;
  if (o.type === "item/reorder" || o.type === "ledger/undo") return true;
  return false;
}

const LIST_OPS: OpType[] = ["item/reorder", "breaking/insert", "ledger/undo"];

/**
 * 并发判定：基于 baseVersion 之后是否有"批次之外"的已确认操作触碰同一段落。
 * 回连合并时，批次内先执行的操作（ignoreOpIds）属于同一因果链，不算并发。
 */
function isStale(
  state: LedgerState,
  type: OpType,
  payload: Record<string, unknown>,
  target: RundownItem | undefined,
  baseVersion: number,
  ignoreOpIds?: Set<string>,
): boolean {
  const external = (o: LedgerOp) => o.status === "applied" && !ignoreOpIds?.has(o.opId);
  if (target) {
    if (target.version <= baseVersion) return false;
    const touch = state.opLog.find((o) => external(o) && opTouchesItem(o, target.id));
    return Boolean(touch);
  }
  if (state.ledgerVersion <= baseVersion) return false;
  const touch = state.opLog.find((o) => external(o) && LIST_OPS.includes(o.type));
  return Boolean(touch);
}

/* ------------------------------------------------------------------ */
/* 入账：权限 -> 幂等 -> 乐观并发 -> 应用                               */
/* ------------------------------------------------------------------ */

export interface ApplyInput {
  state: LedgerState;
  type: OpType;
  actor: Role;
  clientId: string;
  payload: Record<string, unknown>;
  opId?: string;
  baseVersion?: number;
  /** 这批操作自身的 opId 集合：回连合并时，批次内先执行的操作不算并发 */
  ignoreOpIds?: Set<string>;
}

export interface ApplyOutcome {
  state: LedgerState;
  op: LedgerOp;
  outcome: "applied" | "conflict" | "rejected";
  conflict?: ConflictRecord;
}

export function applyOp(input: ApplyInput): ApplyOutcome {
  const { state, type, actor, clientId, payload } = input;
  const ts = now();
  const baseVersion = input.baseVersion ?? state.ledgerVersion;
  const opId = input.opId ?? newOpId();
  const seq = state.seqCounter + 1;

  // 幂等：已入账过（重试/重复提交）直接返回，不重复写
  const existing = state.opLog.find((o) => o.opId === opId);
  if (existing) {
    return {
      state,
      op: existing,
      outcome: existing.status === "conflict" ? "conflict" : existing.status === "rejected" ? "rejected" : "applied",
    };
  }

  const perm = canPerform(type, actor, payload);
  if (!perm.allowed) {
    const op: LedgerOp = {
      opId,
      seq,
      type,
      actor,
      clientId,
      baseVersion,
      payload,
      status: "rejected",
      reason: perm.reason,
      createdAt: ts,
      attempts: 1,
    };
    return {
      state: { ...state, seqCounter: seq, opLog: [op, ...state.opLog] },
      op,
      outcome: "rejected",
    };
  }

  const targetId = targetOf(type, payload);
  const target = state.items.find((i) => i.id === targetId);
  const stale = isStale(state, type, payload, target, baseVersion, input.ignoreOpIds);

  if (stale) {
    // 后到的写：保留为冲突，列出差异，不盖掉先确认版本
    const diff = diffFor(type, payload, target);
    const conflict: ConflictRecord = {
      id: `cf:${opId}`,
      opId,
      seq,
      type,
      actor,
      targetId: targetId ?? "",
      targetTitle: target?.title ?? "整段串联单",
      diff,
      baseVersion,
      currentVersion: target?.version ?? state.ledgerVersion,
      reason: `你基于 v${baseVersion} 修改，期间已被其他岗位确认到 v${target?.version ?? state.ledgerVersion}`,
      createdAt: ts,
      resolved: false,
    };
    const op: LedgerOp = {
      opId,
      seq,
      type,
      actor,
      clientId,
      baseVersion,
      payload,
      status: "conflict",
      reason: conflict.reason,
      conflictOpId: conflict.id,
      createdAt: ts,
      attempts: 1,
    };
    return {
      state: {
        ...state,
        seqCounter: seq,
        opLog: [op, ...state.opLog],
        conflicts: [conflict, ...state.conflicts],
      },
      op,
      outcome: "conflict",
      conflict,
    };
  }

  const version = state.ledgerVersion + 1;
  const applied = applyStructure(state, type, payload, actor, ts, version, seq);
  const op: LedgerOp = {
    opId,
    seq,
    type,
    actor,
    clientId,
    baseVersion,
    payload,
    status: "applied",
    createdAt: ts,
    appliedAt: ts,
    attempts: 1,
  };
  return {
    state: {
      ...state,
      seqCounter: seq,
      ledgerVersion: version,
      items: applied.items,
      archive: applied.archive,
      changes: applied.changes,
      opLog: [op, ...state.opLog],
    },
    op,
    outcome: "applied",
  };
}

/* ------------------------------------------------------------------ */
/* 离线排队                                                            */
/* ------------------------------------------------------------------ */

export function queueOp(input: ApplyInput): { state: LedgerState; op: LedgerOp } {
  const { state, type, actor, clientId, payload } = input;
  const ts = now();
  const opId = input.opId ?? newOpId();
  const seq = state.seqCounter + 1;
  const op: LedgerOp = {
    opId,
    seq,
    type,
    actor,
    clientId,
    baseVersion: state.ledgerVersion,
    payload,
    status: "pending",
    createdAt: ts,
    attempts: 0,
  };
  return { state: { ...state, seqCounter: seq, outbox: [op, ...state.outbox] }, op };
}

/* ------------------------------------------------------------------ */
/* 回连合并：按操作序号，只重试没写入的部分，幂等去重                    */
/* ------------------------------------------------------------------ */

export interface ReplayResult {
  state: LedgerState;
  results: { opId: string; status: OpStatus; reason?: string }[];
}

function markOutbox(state: LedgerState, opId: string, status: OpStatus, reason?: string): LedgerState {
  return {
    ...state,
    outbox: state.outbox.map((o) =>
      o.opId === opId
        ? {
            ...o,
            status,
            reason,
            attempts: o.attempts + 1,
            appliedAt: status === "written" ? now() : o.appliedAt,
          }
        : o,
    ),
  };
}

export function replayOutbox(state: LedgerState, flaky = false): ReplayResult {
  let current = state;
  const results: ReplayResult["results"] = [];
  // 只处理没写入的：written 跳过（幂等），failed/pending 重试
  const pending = current.outbox
    .filter((o) => o.status !== "written")
    .sort((a, b) => a.seq - b.seq);
  // 本批次操作互为因果，不判并发
  const batchOpIds = new Set(current.outbox.map((o) => o.opId));

  for (const op of pending) {
    // 模拟链路抖动：每 3 条失败 1 条，验证"只重试没写入的部分"
    if (flaky && op.seq % 3 === 0) {
      current = markOutbox(current, op.opId, "failed", "写入超时，链路抖动");
      results.push({ opId: op.opId, status: "failed", reason: "写入超时，链路抖动" });
      continue;
    }
    const outcome = applyOp({
      state: current,
      type: op.type,
      actor: op.actor,
      clientId: op.clientId,
      payload: op.payload,
      opId: op.opId,
      baseVersion: op.baseVersion,
      ignoreOpIds: batchOpIds,
    });
    current = outcome.state;
    const status: OpStatus =
      outcome.outcome === "applied" ? "written" : outcome.outcome === "conflict" ? "conflict" : "rejected";
    current = markOutbox(current, op.opId, status, outcome.op.reason);
    results.push({ opId: op.opId, status, reason: outcome.op.reason });
  }
  return { state: current, results };
}

/* ------------------------------------------------------------------ */
/* 冲突解决                                                            */
/* ------------------------------------------------------------------ */

export function resolveConflict(
  state: LedgerState,
  conflictId: string,
  resolution: "keep-mine" | "take-theirs",
): { state: LedgerState; conflict?: ConflictRecord } {
  const conflict = state.conflicts.find((c) => c.id === conflictId);
  if (!conflict || conflict.resolved) return { state };

  if (resolution === "take-theirs") {
    return {
      state: {
        ...state,
        conflicts: state.conflicts.map((c) =>
          c.id === conflictId ? { ...c, resolved: true, resolution } : c,
        ),
      },
      conflict,
    };
  }

  // keep-mine：把后到的操作作为一次新写入（新 opId），在当前版本上重放
  const held = state.opLog.find((o) => o.opId === conflict.opId);
  if (!held) return { state };
  const replayed = applyOp({
    state,
    type: held.type,
    actor: held.actor,
    clientId: held.clientId,
    payload: held.payload,
    opId: newOpId(),
    baseVersion: state.ledgerVersion,
  });
  return {
    state: {
      ...replayed.state,
      conflicts: replayed.state.conflicts.map((c) =>
        c.id === conflictId ? { ...c, resolved: true, resolution } : c,
      ),
    },
    conflict,
  };
}

/* ------------------------------------------------------------------ */
/* 历史快照（撤回用）                                                   */
/* ------------------------------------------------------------------ */

export function snapshot(items: RundownItem[], label: string, detail: string) {
  return {
    id: crypto.randomUUID(),
    label,
    detail,
    time: now(),
    snapshot: structuredClone(items),
  };
}
