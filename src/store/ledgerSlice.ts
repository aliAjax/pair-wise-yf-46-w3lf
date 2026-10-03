import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { AppDispatch, RootState } from ".";
import {
  applyOp,
  breakingOpId,
  CLIENT_ID,
  emptyLedger,
  queueOp,
  replayOutbox,
  resolveConflict,
  snapshot,
  type LedgerState,
} from "../ledger/engine";
import { loadLedger, saveLedger, clearLegacy } from "../ledger/storage";
import type { OpType, Role } from "../types";

/* ----------------------------- 切片状态 ----------------------------- */

interface Toast {
  kind: "success" | "warning" | "error" | "info";
  message: string;
}

interface LedgerSliceState extends LedgerState {
  role: Role;
  online: boolean;
  clientId: string;
  lastToast: Toast | null;
  legacyNotice: string | null;
  replaySummary: { written: number; conflict: number; rejected: number; failed: number } | null;
}

const loaded = loadLedger();
const initialState: LedgerSliceState = {
  ...loaded.state,
  role: "导播",
  online: true,
  clientId: CLIENT_ID,
  lastToast: null,
  legacyNotice: loaded.legacy
    ? `检测到 ${loaded.legacyCount} 条旧版数据无版本号，首次打开已补版本 v1`
    : null,
  replaySummary: null,
};

function toLedger(s: LedgerSliceState): LedgerState {
  return {
    ledgerVersion: s.ledgerVersion,
    seqCounter: s.seqCounter,
    items: s.items,
    archive: s.archive,
    opLog: s.opLog,
    conflicts: s.conflicts,
    outbox: s.outbox,
    changes: s.changes,
    history: s.history,
    migrated: s.migrated,
  };
}

function describe(type: OpType, payload: Record<string, unknown>): { label: string; detail: string } {
  switch (type) {
    case "item/add":
      return { label: "新增条目", detail: payload.title as string };
    case "item/update":
      return { label: "修改条目", detail: (payload.changes as { title?: string })?.title ?? "内容更新" };
    case "item/status":
      return { label: "播出状态", detail: `→ ${payload.status}` };
    case "item/skip":
      return { label: "取消条目", detail: "标记为已跳过" };
    case "item/duration":
      return {
        label: "调整时长",
        detail: `${Number(payload.delta) > 0 ? "增加" : "减少"} ${Math.abs(Number(payload.delta))} 分钟`,
      };
    case "item/reorder":
      return { label: "调整顺序", detail: "直播串联单顺序变化" };
    case "breaking/insert":
      return { label: "突发插播", detail: payload.headline as string };
    case "ledger/undo":
      return { label: "撤回", detail: "恢复上一版编排" };
  }
}

/* ------------------------------- 切片 ------------------------------- */

const slice = createSlice({
  name: "ledger",
  initialState,
  reducers: {
    setRole(state, action: PayloadAction<Role>) {
      state.role = action.payload;
      state.lastToast = { kind: "info", message: `当前岗位：${action.payload}` };
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
      state.lastToast = action.payload
        ? { kind: "info", message: "主链路已恢复，操作将直接入账" }
        : { kind: "warning", message: "已进入本地应急队列，操作先排队、回连后合并" };
    },
    dismissToast(state) {
      state.lastToast = null;
    },
    dismissLegacy(state) {
      state.legacyNotice = null;
    },
    applyOpAction(
      state,
      action: PayloadAction<{
        type: OpType;
        payload: Record<string, unknown>;
        actor: Role;
        clientId: string;
        opId?: string;
      }>,
    ) {
      const { type, payload, actor, clientId, opId } = action.payload;
      const before = snapshot(state.items, describe(type, payload).label, describe(type, payload).detail);
      const outcome = applyOp({ state: toLedger(state), type, actor, clientId, payload, opId });
      const next = outcome.state;
      Object.assign(state, next);
      if (outcome.outcome === "applied") {
        state.history = type === "ledger/undo" ? state.history.slice(1) : [before, ...state.history];
        state.lastToast = { kind: "success", message: `已入账 v${next.ledgerVersion}：${describe(type, payload).detail}` };
      } else if (outcome.outcome === "conflict") {
        state.lastToast = {
          kind: "warning",
          message: `后到修改已挂起为冲突，未覆盖已确认版本：${outcome.op.reason ?? ""}`,
        };
      } else {
        state.lastToast = { kind: "error", message: `已拒绝：${outcome.op.reason ?? "越权操作"}` };
      }
    },
    queueOpAction(
      state,
      action: PayloadAction<{
        type: OpType;
        payload: Record<string, unknown>;
        actor: Role;
        clientId: string;
        opId?: string;
      }>,
    ) {
      const { type, payload, actor, clientId, opId } = action.payload;
      const outcome = queueOp({ state: toLedger(state), type, actor, clientId, payload, opId });
      Object.assign(state, outcome.state);
      state.lastToast = { kind: "warning", message: `已排入应急队列（序号 ${outcome.op.seq}），回连后按序合并` };
    },
    replayFinished(state, action: PayloadAction<ReturnType<typeof replayOutbox>>) {
      const { state: next, results } = action.payload;
      Object.assign(state, next);
      const written = results.filter((r) => r.status === "written").length;
      const conflict = results.filter((r) => r.status === "conflict").length;
      const rejected = results.filter((r) => r.status === "rejected").length;
      const failed = results.filter((r) => r.status === "failed").length;
      state.replaySummary = { written, conflict, rejected, failed };
      state.lastToast = {
        kind: failed || conflict ? "warning" : "success",
        message: `回连合并完成：写入 ${written} 条${conflict ? `，冲突 ${conflict} 条` : ""}${
          rejected ? `，拒绝 ${rejected} 条` : ""
        }${failed ? `，失败 ${failed} 条（可重试未写入部分）` : ""}`,
      };
    },
    resolveFinished(
      state,
      action: PayloadAction<{
        result: ReturnType<typeof resolveConflict>;
        conflictId: string;
        resolution: "keep-mine" | "take-theirs";
      }>,
    ) {
      const { result, resolution } = action.payload;
      if (result.state) Object.assign(state, result.state);
      state.lastToast = {
        kind: resolution === "keep-mine" ? "warning" : "info",
        message: resolution === "keep-mine" ? "已保留我方版本并重新入账" : "已采用对方确认版本",
      };
    },
    hydrate(state, action: PayloadAction<Partial<LedgerState>>) {
      Object.assign(state, action.payload);
    },
  },
});

export const {
  setRole,
  setOnline,
  dismissToast,
  dismissLegacy,
  applyOpAction,
  queueOpAction,
  replayFinished,
  resolveFinished,
  hydrate,
} = slice.actions;

export default slice.reducer;

/* -------------------------------  thunk  ------------------------------ */

/** 提交一个操作：在线直接入账，离线先排队；突发插播按内容幂等 */
export const commitOp =
  (type: OpType, payload: Record<string, unknown>) =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const { role, online, clientId } = getState().ledger;
    const opId =
      type === "breaking/insert"
        ? breakingOpId(payload.headline as string, payload.insertAfter as string, payload.reason as string)
        : undefined;
    if (online) {
      dispatch(applyOpAction({ type, payload, actor: role, clientId, opId }));
    } else {
      dispatch(queueOpAction({ type, payload, actor: role, clientId, opId }));
    }
  };

/** 回连合并应急队列；flaky 模拟链路抖动，仅未写入部分会重试 */
export const replayQueue =
  (flaky = false) =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const result = replayOutbox(toLedger(getState().ledger), flaky);
    dispatch(replayFinished(result));
  };

/** 解决冲突：keep-mine 重放我方，take-theirs 保留对方确认版 */
export const resolveConflictThunk =
  (conflictId: string, resolution: "keep-mine" | "take-theirs") =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const result = resolveConflict(toLedger(getState().ledger), conflictId, resolution);
    dispatch(resolveFinished({ result, conflictId, resolution }));
  };

/** 撤回上一步（作为一次新入账，账本可追溯） */
export const undo = () => (dispatch: AppDispatch, getState: () => RootState) => {
  const s = getState().ledger;
  const last = s.history[0];
  if (!last) return;
  dispatch(
    applyOpAction({
      type: "ledger/undo",
      payload: { snapshot: last.snapshot },
      actor: s.role,
      clientId: s.clientId,
    }),
  );
};

/** 持久化 + 清理旧键 */
export const persistLedger = () => (_dispatch: AppDispatch, getState: () => RootState) => {
  const s = getState().ledger;
  saveLedger(toLedger(s));
  clearLegacy();
};

export { emptyLedger };
