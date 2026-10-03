export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";

/** 条目同步状态：confirmed 已入账 / pending 离线待回连 / conflict 后到冲突 */
export type SyncState = "confirmed" | "pending" | "conflict";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
  /** 条目版本号，旧数据首次打开时补 1 */
  version: number;
  updatedAt: string;
  updatedBy: Role;
  syncState?: SyncState;
}

/** 账本操作类型 */
export type OpType =
  | "item/add"
  | "item/update"
  | "item/status"
  | "item/skip"
  | "item/duration"
  | "item/reorder"
  | "breaking/insert"
  | "ledger/undo";

/** 操作在账本/队列中的状态 */
export type OpStatus =
  | "applied" // 已入账
  | "pending" // 离线排队中
  | "written" // 回连已写入
  | "conflict" // 后到冲突，挂起
  | "rejected" // 越权/非法，直接拒绝
  | "failed"; // 写入失败，待重试

export interface LedgerOp {
  /** 幂等键：同一插播只入库一次，重试不重复写 */
  opId: string;
  /** 操作序号：全局递增，回连按序号合并 */
  seq: number;
  type: OpType;
  actor: Role;
  clientId: string;
  /** 基于哪一版账本（乐观并发） */
  baseVersion: number;
  payload: Record<string, unknown>;
  status: OpStatus;
  reason?: string;
  conflictOpId?: string;
  createdAt: string;
  appliedAt?: string;
  attempts: number;
  /** 内容指纹，用于突发插播幂等 */
  fingerprint?: string;
}

export interface ConflictDiff {
  field: string;
  label: string;
  /** 对方已确认版本 */
  before: unknown;
  /** 我方后到版本 */
  after: unknown;
}

export interface ConflictRecord {
  id: string;
  opId: string;
  seq: number;
  type: OpType;
  actor: Role;
  targetId: string;
  targetTitle: string;
  diff: ConflictDiff[];
  baseVersion: number;
  currentVersion: number;
  reason: string;
  createdAt: string;
  resolved: boolean;
  resolution?: "keep-mine" | "take-theirs";
}

export interface BreakingChange {
  id: string;
  opId: string;
  seq: number;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
}

export interface PendingChange {
  id: string;
  opId: string;
  seq: number;
  action: string;
  detail: string;
  queuedAt: string;
  status: OpStatus;
  attempts: number;
  reason?: string;
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
}
