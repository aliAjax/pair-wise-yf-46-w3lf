import { BASELINE_VERSION } from "../../types";
import type {
  AuditEntry,
  BreakingRecord,
  ConflictRecord,
  FieldDifference,
  HardRisk,
  ItemFields,
  Ledger,
  Op,
  RundownItem,
  TimelineRow
} from "../../types";
import { authorize, fieldLabel } from "../permissions";

export function uid(prefix = "id"): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${rand}`;
}

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHHMM = (min: number): string => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// 旧数据迁移：没有版本号的段落，首次打开账本时按基线版本补登
// ---------------------------------------------------------------------------

export function migrateItem(raw: Partial<RundownItem>): RundownItem {
  return {
    id: String(raw.id ?? uid("r")),
    title: String(raw.title ?? "未命名段落"),
    type: (raw.type ?? "口播") as RundownItem["type"],
    duration: Number(raw.duration ?? 1),
    hardStart: raw.hardStart ? String(raw.hardStart) : undefined,
    presenter: String(raw.presenter ?? ""),
    source: String(raw.source ?? ""),
    lowerThird: String(raw.lowerThird ?? raw.title ?? ""),
    status: (raw.status ?? "待播") as RundownItem["status"],
    version: typeof raw.version === "number" && raw.version >= BASELINE_VERSION ? raw.version : BASELINE_VERSION,
    stale: Boolean(raw.stale),
    staleReason: raw.staleReason ? String(raw.staleReason) : undefined,
    airedAt: raw.airedAt ? String(raw.airedAt) : undefined,
    breakingId: raw.breakingId
  };
}

export const SEED_ITEMS: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", presenter: "陈默", source: "主控", lowerThird: "早间新闻提要", status: "已播出", version: 3, stale: false, airedAt: "2026-10-08T08:04:00+08:00" },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", presenter: "陈默", source: "记者周岚", lowerThird: "记者 周岚｜城市更新现场", status: "待播", version: 2, stale: false },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, presenter: "陈默", source: "演播室A", lowerThird: "政策发布会解读", status: "待播", version: 1, stale: false },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", presenter: "系统", source: "广告串", lowerThird: "", status: "待播", version: 1, stale: false }
];

export function createLedger(items: RundownItem[] = SEED_ITEMS, now = new Date().toISOString()): Ledger {
  return {
    ledgerVersion: 1,
    docVersion: BASELINE_VERSION,
    items,
    appliedOpIds: [],
    conflictOpIds: [],
    opLog: [],
    conflicts: [],
    audit: [],
    changes: [],
    lastSeq: {},
    updatedAt: now
  };
}

/** 首次打开：旧数组补版本号后建账；已经是账本则原样返回（补齐历史账本缺的字段） */
export function bootstrap(raw: unknown, now = new Date().toISOString()): Ledger {
  if (raw && typeof raw === "object" && "ledgerVersion" in raw && Array.isArray((raw as Ledger).items)) {
    const ledger = raw as Ledger;
    return {
      ...createLedger([], now),
      ...ledger,
      items: ledger.items.map((item) => (typeof item.version === "number" ? item : migrateItem(item))),
      appliedOpIds: ledger.appliedOpIds ?? [],
      conflictOpIds: ledger.conflictOpIds ?? [],
      opLog: ledger.opLog ?? [],
      conflicts: ledger.conflicts ?? [],
      audit: ledger.audit ?? [],
      changes: ledger.changes ?? [],
      lastSeq: ledger.lastSeq ?? {}
    };
  }
  const list = Array.isArray(raw) ? (raw as Array<Partial<RundownItem>>).map(migrateItem) : SEED_ITEMS.map((item) => ({ ...item }));
  return createLedger(list.length ? list : SEED_ITEMS.map((item) => ({ ...item })), now);
}

// ---------------------------------------------------------------------------
// 操作结果
// ---------------------------------------------------------------------------

export type CommitOutcome =
  | { ok: true; ledger: Ledger; status: "applied" | "duplicate" }
  | { ok: false; ledger: Ledger; status: "conflict"; conflict: ConflictRecord }
  | { ok: false; ledger: Ledger; status: "denied"; reason: string };

// ---------------------------------------------------------------------------
// 时间轴与硬时间风险：跳过段不占位，顺推开播时间
// ---------------------------------------------------------------------------

export function selectTimeline(items: RundownItem[], anchorMinutes = 8 * 60): TimelineRow[] {
  let cursor = anchorMinutes;
  return items
    .filter((item) => item.status !== "已跳过")
    .map((item) => {
      const start = cursor;
      cursor += item.duration;
      return { item, start: toHHMM(start), end: toHHMM(cursor) };
    });
}

export function computeHardRisks(rows: TimelineRow[]): HardRisk[] {
  return rows
    .filter(({ item }) => item.hardStart && item.status !== "已播出")
    .map(({ item, start }) => ({ itemId: item.id, title: item.title, projectedStart: start, hardStart: item.hardStart!, overrunMinutes: toMin(start) - toMin(item.hardStart!), stale: item.stale }))
    .filter((risk) => risk.overrunMinutes > 0);
}

// ---------------------------------------------------------------------------
// 差异比对：冲突时列出已确认版本与后到版本的字段差异
// ---------------------------------------------------------------------------

function diffFields(item: RundownItem, incoming: Partial<ItemFields>): FieldDifference[] {
  return (Object.keys(incoming) as (keyof ItemFields)[]).flatMap((field) => {
    const confirmedValue = item[field] as string | number | undefined;
    const incomingValue = incoming[field] as string | number | undefined;
    if (String(confirmedValue ?? "") === String(incomingValue ?? "")) return [];
    return [{ field, label: fieldLabel(field), confirmedValue, incomingValue }];
  });
}

function buildConflict(ledger: Ledger, op: Op, item: RundownItem, differences: FieldDifference[], itemTitle = item.title): ConflictRecord {
  return {
    id: uid("c"),
    opId: op.opId,
    type: op.type,
    station: op.station,
    actor: op.actor,
    at: op.at,
    itemId: item.id,
    itemTitle,
    confirmedVersion: item.version,
    incomingBaseVersion: op.baseVersion ?? BASELINE_VERSION,
    differences,
    incomingOp: op,
    status: "open"
  };
}

function auditFor(op: Op, detail: string, snapshot?: RundownItem): AuditEntry {
  return { id: uid("a"), opId: op.opId, type: op.type, station: op.station, actor: op.actor, at: op.at, detail, snapshot: snapshot ? structuredClone(snapshot) : undefined };
}

/** 下游未开播段落立即失效；已播出段落留档不动 */
function invalidateDownstream(items: RundownItem[], fromIndex: number, reason: string): void {
  for (let i = fromIndex; i < items.length; i += 1) {
    const target = items[i];
    if (target.status === "已播出") continue;
    if (target.status === "已跳过") continue;
    target.stale = true;
    target.staleReason = reason;
  }
}

// ---------------------------------------------------------------------------
// 变更落账（不加乐观锁检查，供 applied 路径与冲突裁决“采用后到版本”复用）
// ---------------------------------------------------------------------------

function mutate(ledger: Ledger, op: Op): { ledger: Ledger; detail: string; snapshot?: RundownItem } {
  const next: Ledger = structuredClone(ledger);
  let detail = "";
  let snapshot: RundownItem | undefined;
  const items = next.items;

  switch (op.type) {
    case "addItem": {
      const payload = op.payload as AddItemLike;
      const item: RundownItem = { id: uid("r"), ...payload, status: "待播", version: BASELINE_VERSION, stale: false };
      items.push(item);
      detail = `新增条目「${item.title}」`;
      break;
    }
    case "editItem": {
      const payload = op.payload as { id: string; fields: Partial<ItemFields> };
      const item = items.find((entry) => entry.id === payload.id);
      if (!item) throw new DomainError("目标段落不存在或已被移除");
      if (item.status === "已播出") throw new DomainError(`「${item.title}」已播出留档，不能再修改`);
      const durationChanged = payload.fields.duration !== undefined && payload.fields.duration !== item.duration;
      Object.assign(item, payload.fields);
      item.version += 1;
      if (durationChanged) {
        const index = items.findIndex((entry) => entry.id === item.id);
        invalidateDownstream(items, index + 1, `上游「${item.title}」时长变化，硬时间需重算确认`);
      }
      detail = `修改「${item.title}」（v${item.version - 1}→v${item.version}）`;
      break;
    }
    case "reorder": {
      const payload = op.payload as { ids: string[] };
      const byId = new Map(items.map((item) => [item.id, item]));
      const reordered = payload.ids.map((id) => byId.get(id)).filter((item): item is RundownItem => Boolean(item));
      const tail = items.filter((item) => !payload.ids.includes(item.id));
      next.items = [...reordered, ...tail];
      invalidateDownstream(next.items, 0, "串联单顺序调整，硬时间需重算确认");
      detail = `调整顺序：${reordered.length} 个段落`;
      break;
    }
    case "updateStatus": {
      const payload = op.payload as { id: string; status: RundownItem["status"] };
      const item = items.find((entry) => entry.id === payload.id);
      if (!item) throw new DomainError("目标段落不存在");
      if (payload.status === "已播出") {
        if (item.status === "已播出") throw new DomainError(`「${item.title}」已播出留档`);
        item.status = "已播出";
        item.airedAt = op.at;
        item.stale = false;
        item.staleReason = undefined;
        snapshot = structuredClone(item);
      } else {
        item.status = payload.status;
      }
      item.version += 1;
      detail = `「${item.title}」→ ${item.status}`;
      break;
    }
    case "skipItem": {
      const payload = op.payload as { id: string };
      const item = items.find((entry) => entry.id === payload.id);
      if (!item) throw new DomainError("目标段落不存在");
      if (item.status === "已播出") throw new DomainError(`「${item.title}」已播出，不能取消`);
      item.status = "已跳过";
      item.stale = false;
      item.version += 1;
      const index = items.findIndex((entry) => entry.id === item.id);
      invalidateDownstream(items, index + 1, `「${item.title}」取消，硬时间需重算确认`);
      detail = `取消条目「${item.title}」`;
      break;
    }
    case "insertBreaking": {
      const payload = op.payload as BreakingLike;
      const anchor = items.find((entry) => entry.id === payload.insertAfter);
      if (!anchor) throw new DomainError("插播锚点段落不存在");
      const item: RundownItem = {
        id: uid("r"),
        title: payload.headline,
        type: "新闻片",
        duration: payload.duration,
        presenter: "值班主播",
        source: `突发插播：${payload.reason}`,
        lowerThird: payload.headline,
        status: "待播",
        version: BASELINE_VERSION,
        stale: false,
        breakingId: uid("b")
      };
      const index = items.findIndex((entry) => entry.id === anchor.id);
      items.splice(index + 1, 0, item);
      anchor.version += 1;
      invalidateDownstream(items, index + 2, `突发插播「${item.title}」插入，硬时间需重算确认`);
      const record: BreakingRecord = {
        id: item.breakingId!,
        opId: op.opId,
        headline: item.title,
        duration: item.duration,
        insertAfter: anchor.id,
        reason: payload.reason,
        createdAt: op.at,
        station: op.station,
        actor: op.actor,
        committed: true
      };
      next.changes.unshift(record);
      detail = `突发插播「${item.title}」（${item.duration} 分钟）插入「${anchor.title}」之后`;
      break;
    }
    case "acknowledgeRecalc": {
      const payload = op.payload as { ids: string[] };
      let count = 0;
      for (const item of items) {
        if (payload.ids.includes(item.id) && item.stale) {
          item.stale = false;
          item.staleReason = undefined;
          item.version += 1;
          count += 1;
        }
      }
      detail = `确认重算 ${count} 个未开播段落`;
      break;
    }
    case "resolveConflict": {
      const payload = op.payload as { conflictId: string; resolution: "confirmed" | "incoming" };
      const conflict = next.conflicts.find((entry) => entry.id === payload.conflictId);
      if (!conflict || conflict.status === "resolved") throw new DomainError("冲突不存在或已解决");
      let merged = next;
      if (payload.resolution === "confirmed") {
        detail = `冲突裁决：保留先确认版本「${conflict.itemTitle}」，驳回后到修改`;
      } else {
        // 采用后到版本：先在当前账本上重放后到操作（不做版本检查），再在合并结果上标记裁决
        const replay = mutate(next, conflict.incomingOp);
        merged = replay.ledger;
        detail = `冲突裁决：「${conflict.itemTitle}」采用后到版本`;
      }
      const resolved = merged.conflicts.find((entry) => entry.id === payload.conflictId);
      if (resolved) {
        resolved.status = "resolved";
        resolved.resolution = payload.resolution;
        resolved.resolvedAt = op.at;
        resolved.resolvedBy = op.station;
      }
      // 用合并后的账本继续走统一的入账（审计/序号/docVersion）流程
      for (const key of ["items", "appliedOpIds", "opLog", "audit", "changes", "conflicts", "lastSeq"] as const) {
        (next as unknown as Record<string, unknown>)[key] = structuredClone(merged[key]);
      }
      break;
    }
  }

  next.appliedOpIds.push(op.opId);
  next.opLog.unshift(op);
  next.audit.unshift(auditFor(op, detail, snapshot));
  const stationMax = Math.max(next.lastSeq[op.station] ?? 0, op.seq);
  next.lastSeq = { ...next.lastSeq, [op.station]: stationMax };
  next.docVersion += 1;
  next.updatedAt = op.at;
  return { ledger: next, detail, snapshot };
}

type AddItemLike = ItemFields;
type BreakingLike = { headline: string; duration: number; insertAfter: string; reason: string };

export class DomainError extends Error {}

// ---------------------------------------------------------------------------
// 提交入口：去重 → 授权 → 领域规则 → 乐观锁冲突 → 落账
// ---------------------------------------------------------------------------

export function commitOp(ledger: Ledger, op: Op): CommitOutcome {
  if (ledger.appliedOpIds.includes(op.opId) || ledger.conflictOpIds.includes(op.opId)) {
    return { ok: true, ledger, status: "duplicate" };
  }

  const denial = authorize(op);
  if (denial) return { ok: false, ledger, status: "denied", reason: denial };

  // 冲突是"后到操作保留为冲突并列出差异"，差异清单要入档，且不能盖掉先确认版本
  const asConflict = (conflict: ConflictRecord): CommitOutcome => ({
    ok: false,
    ledger: { ...structuredClone(ledger), conflicts: [conflict, ...ledger.conflicts], conflictOpIds: [...ledger.conflictOpIds, op.opId] },
    status: "conflict",
    conflict
  });

  const checkVersion = (item: RundownItem | undefined): boolean =>
    Boolean(item && op.baseVersion !== undefined && item.version === op.baseVersion);

  try {
    switch (op.type) {
      case "editItem": {
        const payload = op.payload as { id: string; fields: Partial<ItemFields> };
        const item = ledger.items.find((entry) => entry.id === payload.id);
        if (!item) return { ok: false, ledger, status: "denied", reason: "目标段落不存在或已被移除" };
        if (item.status === "已播出") return { ok: false, ledger, status: "denied", reason: `「${item.title}」已播出留档，不能再修改` };
        if (!checkVersion(item)) {
          return asConflict(buildConflict(ledger, op, item, diffFields(item, payload.fields)));
        }
        break;
      }
      case "updateStatus":
      case "skipItem": {
        const payload = op.payload as { id: string };
        const item = ledger.items.find((entry) => entry.id === payload.id);
        if (!item) return { ok: false, ledger, status: "denied", reason: "目标段落不存在" };
        if (item.status === "已播出") return { ok: false, ledger, status: "denied", reason: `「${item.title}」已播出留档` };
        if (!checkVersion(item)) {
          const differences: FieldDifference[] = [
            { field: "status" as keyof ItemFields, label: "播出状态", confirmedValue: item.status, incomingValue: op.type === "skipItem" ? "已跳过" : (op.payload as { status: string }).status }
          ];
          return asConflict(buildConflict(ledger, op, item, differences));
        }
        break;
      }
      case "insertBreaking": {
        const payload = op.payload as BreakingLike;
        const anchor = ledger.items.find((entry) => entry.id === payload.insertAfter);
        if (!anchor) return { ok: false, ledger, status: "denied", reason: "插播锚点段落不存在" };
        if (!checkVersion(anchor)) {
          const differences: FieldDifference[] = [
            { field: "title", label: "插播标题", confirmedValue: anchor.title, incomingValue: payload.headline },
            { field: "duration", label: "插播时长（分钟）", confirmedValue: anchor.duration, incomingValue: payload.duration }
          ];
          return asConflict(buildConflict(ledger, op, anchor, differences, `锚点「${anchor.title}」位置已变化`));
        }
        break;
      }
      case "reorder": {
        const payload = op.payload as { ids: string[] };
        const currentIds = ledger.items.map((item) => item.id);
        const sameSet = payload.ids.length === currentIds.length && payload.ids.every((id) => currentIds.includes(id));
        const sameOrder = sameSet && payload.ids.every((id, index) => id === currentIds[index]);
        if (!sameSet) {
          const added = currentIds.filter((id) => !payload.ids.includes(id)).map((id) => ledger.items.find((item) => item.id === id)?.title).filter(Boolean);
          const differences: FieldDifference[] = [
            { field: "title", label: "串联单结构", confirmedValue: added.length ? `已新增插播：${added.join("、")}` : "段落集合已变化", incomingValue: `拖拽时的 ${payload.ids.length} 段顺序` }
          ];
          const anchor = ledger.items.find((item) => item.id === payload.ids[0]) ?? ledger.items[0];
          return asConflict(anchor ? buildConflict(ledger, op, anchor, differences, "串联单结构已变化") : missingConflict(ledger, op));
        }
        if (!sameOrder) {
          const titleOf = (id: string) => ledger.items.find((item) => item.id === id)?.title ?? id;
          const differences: FieldDifference[] = [
            { field: "title", label: "段落顺序", confirmedValue: currentIds.map(titleOf).join(" → "), incomingValue: payload.ids.map(titleOf).join(" → ") }
          ];
          const anchor = ledger.items.find((item) => item.id === payload.ids[0]) ?? ledger.items[0];
          return asConflict(anchor ? buildConflict(ledger, op, anchor, differences, "段落顺序已被另一岗位调整") : missingConflict(ledger, op));
        }
        break;
      }
      case "addItem":
      case "acknowledgeRecalc":
      case "resolveConflict":
        break;
    }

    const { ledger: next } = mutate(ledger, op);
    if (op.type === "resolveConflict") {
      // resolve 内部产生的子变更与自身操作都已入流，无需额外处理
    }
    return { ok: true, ledger: next, status: "applied" };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, ledger, status: "denied", reason: error.message };
    throw error;
  }
}

function missingConflict(ledger: Ledger, op: Op): ConflictRecord {
  return {
    id: uid("c"),
    opId: op.opId,
    type: op.type,
    station: op.station,
    actor: op.actor,
    at: op.at,
    itemTitle: "串联单结构",
    confirmedVersion: ledger.docVersion,
    incomingBaseVersion: op.baseVersion ?? BASELINE_VERSION,
    differences: [],
    incomingOp: op,
    status: "open"
  };
}
