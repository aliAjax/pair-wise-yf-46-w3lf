// 可恢复编排账：领域模型
// 串联单条目、突发插播、应急队列、硬时间风险全部落在同一份带版本号的账本里。

export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";

/** 旧数据第一次打开账本时补登的版本号 */
export const BASELINE_VERSION = 1;

/**
 * 可编辑字段。字幕只能动字幕条；演播室只能动主播与来源；
 * 主编可改编排内容字段；导播的编排通过专门操作（插播/时长/顺序）表达。
 */
export interface ItemFields {
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  presenter: string;
  source: string;
  lowerThird: string;
}

export interface RundownItem extends ItemFields {
  id: string;
  status: ItemStatus;
  /** 段落版本：后到修改携带小于该版本的 baseVersion 时记为冲突，不覆盖 */
  version: number;
  /** 未开播段落在插播/时长变化后立即失效，等待确认重算 */
  stale: boolean;
  /** 失效原因，用于在岗人员核对重算依据 */
  staleReason?: string;
  /** 已播出段落留档：锁定版本、记录播出时间，硬时间重算不再触动 */
  airedAt?: string;
  /** 由哪条突发插播生成 */
  breakingId?: string;
}

export type OpType =
  | "addItem"
  | "editItem"
  | "reorder"
  | "updateStatus"
  | "skipItem"
  | "insertBreaking"
  | "acknowledgeRecalc"
  | "resolveConflict";

export interface AddItemPayload extends ItemFields {}
export interface EditItemPayload {
  id: string;
  fields: Partial<ItemFields>;
}
export interface ReorderPayload {
  ids: string[];
}
export interface StatusPayload {
  id: string;
  status: Extract<ItemStatus, "待播" | "已播出" | "已跳过" | "草稿">;
}
export interface SkipPayload {
  id: string;
}
export interface BreakingPayload {
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
}
export interface AcknowledgePayload {
  ids: string[];
}
export interface ResolvePayload {
  conflictId: string;
  resolution: "confirmed" | "incoming";
}

export interface Op {
  /** 客户端生成的全局唯一操作号；服务端按它去重，同操作只入库一次 */
  opId: string;
  /** 站内自增序号，回连时严格按序号合并 */
  seq: number;
  station: Role;
  actor: string;
  at: string;
  type: OpType;
  /** 该操作读取时依据的目标段落版本（段级乐观锁依据） */
  baseVersion?: number;
  payload:
    | AddItemPayload
    | EditItemPayload
    | ReorderPayload
    | StatusPayload
    | SkipPayload
    | BreakingPayload
    | AcknowledgePayload
    | ResolvePayload;
}

export type FieldDifference = {
  field: keyof ItemFields;
  label: string;
  /** 已确认版本的值 */
  confirmedValue: string | number | undefined;
  /** 后到版本的值 */
  incomingValue: string | number | undefined;
};

export interface ConflictRecord {
  id: string;
  opId: string;
  type: OpType;
  station: Role;
  actor: string;
  at: string;
  /** 目标段落（插入冲突指向锚点段落） */
  itemId?: string;
  itemTitle: string;
  /** 先确认的版本号与后到者携带的 baseVersion */
  confirmedVersion: number;
  incomingBaseVersion: number;
  differences: FieldDifference[];
  /** 后到操作原文，解决冲突时可选择采用 */
  incomingOp: Op;
  status: "open" | "resolved";
  resolution?: "confirmed" | "incoming";
  resolvedAt?: string;
  resolvedBy?: Role;
}

export interface AuditEntry {
  id: string;
  opId: string;
  type: OpType;
  station: Role;
  actor: string;
  at: string;
  detail: string;
  /** 已播出记录留档：保留播出瞬间的段落快照 */
  snapshot?: RundownItem;
}

export interface BreakingRecord {
  id: string;
  opId: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
  station: Role;
  actor: string;
  /** 是否已并入账本（离线预演时为 false，回连入库后回写） */
  committed: boolean;
}

export interface Ledger {
  /** 账本全局版本（账本结构版本，始终保留在数据上） */
  ledgerVersion: number;
  docVersion: number;
  items: RundownItem[];
  /** 已入库操作 opId 集合，断线重连/重复提交时幂等去重 */
  appliedOpIds: string[];
  /** 已记为冲突的操作 opId，重提同一操作按重复处理 */
  conflictOpIds: string[];
  /** 已入审计流的操作序号 */
  opLog: Op[];
  conflicts: ConflictRecord[];
  audit: AuditEntry[];
  changes: BreakingRecord[];
  /** 最后一条入库操作的 { seq@station } 合并依据 */
  lastSeq: Partial<Record<Role, number>>;
  updatedAt: string;
}

/** 断网时排队的本地操作 */
export interface QueuedOp {
  op: Op;
  status: "pending" | "acked" | "conflict" | "denied";
  detail: string;
  queuedAt: string;
  /** 服务端拒绝原因（越权/领域规则不允许） */
  denialReason?: string;
  conflictId?: string;
}

export interface HardRisk {
  itemId: string;
  title: string;
  /** 顺推预计开播时间 */
  projectedStart: string;
  hardStart: string;
  /** 超出硬时间的分钟数 */
  overrunMinutes: number;
  /** 所在段落已失效，时间轴本身待重算确认 */
  stale: boolean;
}

export interface TimelineRow {
  item: RundownItem;
  start: string;
  end: string;
}
