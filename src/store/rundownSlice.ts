import { createAsyncThunk, createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  AddItemPayload,
  AcknowledgePayload,
  BreakingPayload,
  EditItemPayload,
  Ledger,
  Op,
  OpType,
  QueuedOp,
  ReorderPayload,
  Role,
  SkipPayload,
  StatusPayload
} from "../types";
import { commitToServer, loadLedger, refreshLedger, WriteFaultError } from "../domain/ledger/server";
import { commitOp, createLedger, SEED_ITEMS, uid } from "../domain/ledger/engine";

export type NewOpInput =
  | { type: "addItem"; fields: AddItemPayload; baseVersion?: number }
  | { type: "editItem"; fields: EditItemPayload; baseVersion: number }
  | { type: "reorder"; fields: ReorderPayload; baseVersion?: number }
  | { type: "updateStatus"; fields: StatusPayload; baseVersion: number }
  | { type: "skipItem"; fields: SkipPayload; baseVersion: number }
  | { type: "insertBreaking"; fields: BreakingPayload; baseVersion: number }
  | { type: "acknowledgeRecalc"; fields: AcknowledgePayload; baseVersion?: number }
  | { type: "resolveConflict"; fields: { conflictId: string; resolution: "confirmed" | "incoming" }; baseVersion?: number };

interface RundownState {
  initialized: boolean;
  ledger: Ledger;
  role: Role;
  actor: string;
  online: boolean;
  /** 断网时排队的操作（含已确认/被拒绝的处理结果留痕） */
  queue: QueuedOp[];
  /** 各岗位本地自增操作序号，回连合并严格按序号 */
  seq: Record<Role, number>;
  lastSyncAt: string | null;
  notice: { kind: "success" | "error" | "warning"; text: string; at: number } | null;
}

const seedLedger = createLedger(SEED_ITEMS.map((item) => ({ ...item })));

const initialState: RundownState = {
  initialized: false,
  ledger: seedLedger,
  role: "导播",
  actor: "值班导播",
  online: true,
  queue: [],
  seq: { 导播: 0, 主编: 0, 字幕: 0, 演播室: 0 },
  lastSyncAt: null,
  notice: null
};

const OP_DETAIL: Record<OpType, string> = {
  addItem: "新增条目",
  editItem: "修改段落",
  reorder: "调整顺序",
  updateStatus: "播出状态",
  skipItem: "取消条目",
  insertBreaking: "突发插播",
  acknowledgeRecalc: "确认重算",
  resolveConflict: "冲突裁决"
};

export function describeOp(input: NewOpInput): string {
  switch (input.type) {
    case "addItem": return `新增条目「${input.fields.title}」`;
    case "editItem": return `修改段落 ${input.fields.id}：${Object.keys(input.fields.fields).join("、")}`;
    case "reorder": return `按 ${input.fields.ids.length} 段顺序调整串联单`;
    case "updateStatus": return `段落 ${input.fields.id} → ${input.fields.status}`;
    case "skipItem": return `取消段落 ${input.fields.id}`;
    case "insertBreaking": return `突发插播「${input.fields.headline}」`;
    case "acknowledgeRecalc": return `确认重算 ${input.fields.ids.length} 段`;
    case "resolveConflict": return `裁决冲突 ${input.fields.conflictId}`;
  }
}

function buildOp(role: Role, actor: string, seq: number, input: NewOpInput): Op {
  const payload = input.fields as Op["payload"];
  return {
    opId: uid("op"),
    seq,
    station: role,
    actor,
    at: new Date().toISOString(),
    type: input.type,
    baseVersion: input.baseVersion,
    payload
  };
}

export const bootstrapLedger = createAsyncThunk("rundown/bootstrap", async () => loadLedger());
export const pullLedger = createAsyncThunk("rundown/pull", async () => refreshLedger());

/** 在线即时提交（操作序号取当前岗位下一号） */
export const submitOp = createAsyncThunk("rundown/submit", (input: NewOpInput, { getState }) => {
  const state = (getState() as { rundown: RundownState }).rundown;
  const op = buildOp(state.role, state.actor, state.seq[state.role] + 1, input);
  return { result: commitToServer(op), op };
});

/**
 * 回连合并：待提交操作严格按 {岗位, 序号} 排序逐条入库。
 * 写入故障立即停止，已 ack/冲突/拒绝的有结果，未写入的继续留在队列——下次只重试这部分。
 * 同一操作 opId 相同，服务端幂等保证只入库一次。
 */
export const flushQueue = createAsyncThunk("rundown/flush", (_unused: void, { getState }) => {
  const state = (getState() as { rundown: RundownState }).rundown;
  const pending = state.queue
    .filter((entry) => entry.status === "pending")
    .sort((a, b) => (a.op.station === b.op.station ? a.op.seq - b.op.seq : a.op.station.localeCompare(b.op.station)));
  const results: Array<{ opId: string; result: Awaited<ReturnType<typeof commitToServer>> }> = [];
  for (const entry of pending) {
    try {
      results.push({ opId: entry.op.opId, result: commitToServer(entry.op) });
    } catch (error) {
      if (error instanceof WriteFaultError) {
        return { results, halted: true, ledger: refreshLedger() };
      }
      throw error;
    }
  }
  return { results, halted: false, ledger: refreshLedger() };
});

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    hydrate(state, action: PayloadAction<Ledger>) {
      state.ledger = action.payload;
      state.initialized = true;
    },
    setRole(state, action: PayloadAction<Role>) {
      state.role = action.payload;
      state.actor = action.payload === "导播" ? "值班导播" : `值班${action.payload}`;
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
    },
    clearNotice(state) {
      state.notice = null;
    },
    /**
     * 离线入口：先占操作序号排队，再在本地账本预演，
     * 让断网期间本地播出仍有编排依据；回连后以服务端合并结果为准。
     */
    enqueueOffline(state, action: PayloadAction<NewOpInput>) {
      const input = action.payload;
      const seq = state.seq[state.role] + 1;
      state.seq[state.role] = seq;
      const op = buildOp(state.role, state.actor, seq, input);
      const outcome = commitOp(state.ledger, op);
      if (outcome.status === "applied") {
        state.ledger = outcome.ledger;
        state.queue.unshift({ op, status: "pending", detail: OP_DETAIL[op.type], queuedAt: op.at });
      } else if (outcome.status === "conflict") {
        // 本地预演也可能与刚拉到的他岗版本冲突：差异入档，操作不应用、不重试
        state.ledger = outcome.ledger;
        state.queue.unshift({ op, status: "conflict", detail: OP_DETAIL[op.type], queuedAt: op.at, conflictId: outcome.conflict.id });
      } else if (outcome.status === "denied") {
        state.queue.unshift({ op, status: "denied", detail: OP_DETAIL[op.type], queuedAt: op.at, denialReason: outcome.reason });
      } else {
        state.queue.unshift({ op, status: "acked", detail: OP_DETAIL[op.type], queuedAt: op.at });
      }
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(bootstrapLedger.fulfilled, (state, action) => {
        state.ledger = action.payload;
        state.initialized = true;
      })
      .addCase(pullLedger.fulfilled, (state, action) => {
        state.ledger = action.payload;
      })
      .addCase(submitOp.fulfilled, (state, action) => {
        state.seq[state.role] = Math.max(state.seq[state.role], action.payload.op.seq);
        const { result } = action.payload;
        if (result.status === "applied" || result.status === "conflict") {
          state.ledger = result.ledger;
        }
        if (result.status === "applied") {
          state.notice = { kind: "success", text: "已确认入库，编排账版本更新", at: Date.now() };
        } else if (result.status === "conflict") {
          state.notice = { kind: "warning", text: `与先确认版本冲突：「${result.conflict.itemTitle}」，后到修改已保留为差异，未覆盖原版本`, at: Date.now() };
        } else if (result.status === "duplicate") {
          state.notice = { kind: "warning", text: "同一操作已入库，重复提交被忽略", at: Date.now() };
        } else if (result.status === "denied") {
          state.notice = { kind: "error", text: `越权/违规操作已拒绝：${result.reason}`, at: Date.now() };
        }
      })
      .addCase(submitOp.rejected, (state, action) => {
        state.notice = { kind: "error", text: `主链路写入失败，操作未入库：${action.error.message ?? "未知错误"}。请重试该操作`, at: Date.now() };
      })
      .addCase(flushQueue.fulfilled, (state, action) => {
        const { results, halted, ledger } = action.payload;
        for (const { opId, result } of results) {
          const entry = state.queue.find((item) => item.op.opId === opId);
          if (!entry) continue;
          if (result.status === "applied" || result.status === "duplicate") {
            entry.status = "acked";
          } else if (result.status === "conflict") {
            entry.status = "conflict";
            entry.conflictId = result.conflict.id;
          } else if (result.status === "denied") {
            entry.status = "denied";
            entry.denialReason = result.reason;
          } else {
            entry.status = "acked";
          }
        }
        state.ledger = ledger;
        state.lastSyncAt = new Date().toISOString();
        const remaining = state.queue.filter((entry) => entry.status === "pending").length;
        const conflicts = state.queue.filter((entry) => entry.status === "conflict").length;
        state.notice = halted
          ? { kind: "error", text: `主链路写入中断：${remaining} 条未写入操作仍在队列，恢复后只重试这部分`, at: Date.now() }
          : remaining
            ? { kind: "warning", text: `回连合并结束：${remaining} 条未写入待重试，${conflicts} 条冲突待裁决`, at: Date.now() }
            : { kind: "success", text: `回连合并完成：排队操作已按序号全部入库（${conflicts ? `其中 ${conflicts} 条冲突` : "无冲突"}）`, at: Date.now() };
      });
  }
});

export const { hydrate, setRole, setOnline, clearNotice, enqueueOffline } = slice.actions;
export default slice.reducer;
