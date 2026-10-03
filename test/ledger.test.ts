import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import {
  bootstrap,
  commitOp,
  computeHardRisks,
  createLedger,
  migrateItem,
  SEED_ITEMS,
  selectTimeline
} from "../src/domain/ledger/engine.js";
import { armNextWriteFault, commitToServer, resetMemoryStorage } from "../src/domain/ledger/server.js";
import type { Ledger, Op, Role, RundownItem } from "../src/types.js";

function op(partial: Partial<Op> & Pick<Op, "type" | "payload">): Op {
  return {
    opId: partial.opId ?? `op_${Math.random().toString(36).slice(2, 10)}`,
    seq: partial.seq ?? 1,
    station: partial.station ?? "导播",
    actor: partial.actor ?? "测试",
    at: partial.at ?? "2026-10-08T08:05:00+08:00",
    baseVersion: partial.baseVersion,
    ...partial
  } as Op;
}

function fresh(): Ledger {
  return createLedger(structuredClone(SEED_ITEMS));
}

function item(ledger: Ledger, id: string): RundownItem {
  const found = ledger.items.find((entry) => entry.id === id);
  assert.ok(found, `段落 ${id} 应存在`);
  return found;
}

beforeEach(() => resetMemoryStorage());

// ---- 需求 5：旧数据没有版本号，首次打开补登 --------------------------------

test("旧数据（无版本号字段）首次打开时补登基线版本", () => {
  const legacy = [
    { id: "x1", title: "老段落", type: "口播", duration: 2, presenter: "甲", source: "主控", status: "待播" }
  ];
  const ledger = bootstrap(legacy);
  assert.equal(ledger.ledgerVersion, 1);
  assert.equal(item(ledger, "x1").version, 1);
  assert.equal(item(ledger, "x1").lowerThird, "老段落");
  assert.equal(ledger.docVersion, 1);
});

test("空数据回落到内置种子，已播出段落带留档", () => {
  const ledger = bootstrap([]);
  assert.equal(ledger.items.length, SEED_ITEMS.length);
  assert.equal(item(ledger, "r1").status, "已播出");
  assert.ok(item(ledger, "r1").airedAt);
});

// ---- 需求 1：同段并发修改，后到保留为冲突并列差异，不盖先确认 ----------------

test("两岗位同改一段：后到操作记冲突、列差异，先确认版本不被覆盖", () => {
  let ledger = fresh();
  const r3 = item(ledger, "r3");
  const base = r3.version;

  const editor = op({
    station: "主编",
    seq: 1,
    type: "editItem",
    baseVersion: base,
    payload: { id: "r3", fields: { title: "主编先确认的标题" } }
  });
  const first = commitOp(ledger, editor);
  assert.equal(first.status, "applied");
  ledger = first.ledger;
  assert.equal(item(ledger, "r3").title, "主编先确认的标题");
  assert.equal(item(ledger, "r3").version, base + 1);

  // 字幕岗基于旧版本改字幕条，晚到
  const late = op({
    station: "字幕",
    seq: 1,
    type: "editItem",
    baseVersion: base,
    payload: { id: "r3", fields: { lowerThird: "字幕岗晚到版本" } }
  });
  const second = commitOp(ledger, late);
  assert.equal(second.status, "conflict");
  if (second.status !== "conflict") throw new Error("类型收窄");

  // 先确认版本未被覆盖
  assert.equal(item(ledger, "r3").title, "主编先确认的标题");
  assert.equal(item(ledger, "r3").lowerThird, "政策发布会解读");

  // 差异清单保留了后到值
  assert.equal(second.conflict.differences.length, 1);
  assert.equal(second.conflict.differences[0].field, "lowerThird");
  assert.equal(second.conflict.differences[0].incomingValue, "字幕岗晚到版本");
  assert.equal(second.conflict.differences[0].confirmedValue, "政策发布会解读");
  assert.equal(second.conflict.status, "open");
  assert.equal(ledger.conflicts.length, 0); // 原账本不变
  assert.equal(second.ledger.conflicts.length, 1); // 差异已入新账本待裁决
});

test("冲突重提同一操作 → 幂等重复，不重复记冲突", () => {
  let ledger = fresh();
  const base = item(ledger, "r3").version;
  const first = commitOp(ledger, op({ station: "主编", type: "editItem", baseVersion: base, payload: { id: "r3", fields: { title: "A" } } }));
  assert.equal(first.status, "applied");
  ledger = first.ledger;
  const late = op({ opId: "same-op", station: "字幕", type: "editItem", baseVersion: base, payload: { id: "r3", fields: { lowerThird: "B" } } });
  const conflict = commitOp(ledger, late);
  assert.equal(conflict.status, "conflict");
  if (conflict.status !== "conflict") throw new Error();
  const retry = commitOp(conflict.ledger, late);
  assert.equal(retry.status, "duplicate");
  assert.equal(retry.ledger.conflicts.length, 1);
});

test("冲突裁决：保留先确认 / 采用后到，都闭环", () => {
  let ledger = fresh();
  const base = item(ledger, "r3").version;
  const first = commitOp(ledger, op({ station: "主编", type: "editItem", baseVersion: base, payload: { id: "r3", fields: { title: "先确认" } } }));
  assert.equal(first.status, "applied");
  if (first.status !== "applied") throw new Error();
  ledger = first.ledger;

  const late = op({ station: "字幕", type: "editItem", baseVersion: base, payload: { id: "r3", fields: { lowerThird: "后到字幕" } } });
  const conflict = commitOp(ledger, late);
  assert.equal(conflict.status, "conflict");
  if (conflict.status !== "conflict") throw new Error();
  ledger = conflict.ledger;

  // 采用后到版本：只合并后到字段，先确认标题仍保留
  const takeIncoming = op({
    station: "导播",
    type: "resolveConflict",
    payload: { conflictId: conflict.conflict.id, resolution: "incoming" }
  });
  const resolved = commitOp(ledger, takeIncoming);
  assert.equal(resolved.status, "applied");
  if (resolved.status !== "applied") throw new Error();
  assert.equal(item(resolved.ledger, "r3").lowerThird, "后到字幕");
  assert.equal(item(resolved.ledger, "r3").title, "先确认");
  const stored = resolved.ledger.conflicts.find((entry) => entry.id === conflict.conflict.id);
  assert.equal(stored?.status, "resolved");
  assert.equal(stored?.resolution, "incoming");
  assert.equal(stored?.resolvedBy, "导播");
});

test("冲突裁决：保留先确认版本，后到修改不落账", () => {
  let ledger = fresh();
  const base = item(ledger, "r3").version;
  const first = commitOp(ledger, op({ station: "演播室", type: "editItem", baseVersion: base, payload: { id: "r3", fields: { presenter: "先确认主播" } } }));
  assert.equal(first.status, "applied");
  if (first.status !== "applied") throw new Error();
  const conflict = commitOp(first.ledger, op({ station: "演播室", type: "editItem", baseVersion: base, payload: { id: "r3", fields: { presenter: "晚到主播" } } }));
  assert.equal(conflict.status, "conflict");
  if (conflict.status !== "conflict") throw new Error();
  const keep = commitOp(conflict.ledger, op({ station: "导播", type: "resolveConflict", payload: { conflictId: conflict.conflict.id, resolution: "confirmed" } }));
  assert.equal(keep.status, "applied");
  if (keep.status !== "applied") throw new Error();
  assert.equal(item(keep.ledger, "r3").presenter, "先确认主播");
  assert.equal(keep.ledger.conflicts[0].resolution, "confirmed");
});

// ---- 需求 2：插播/时长变化后未开播段失效重算，已播出留档 -------------------

test("突发插播：下游未开播段立即失效，已播出段留档不动，硬时间风险重算", () => {
  const ledger = fresh();
  const r1 = item(ledger, "r1");
  assert.equal(r1.status, "已播出");

  const result = commitOp(
    ledger,
    op({
      station: "导播",
      type: "insertBreaking",
      baseVersion: item(ledger, "r1").version,
      payload: { headline: "地震突发速报", duration: 10, insertAfter: "r1", reason: "突发新闻" }
    })
  );
  assert.equal(result.status, "applied");
  if (result.status !== "applied") throw new Error();

  const aired = item(result.ledger, "r1");
  assert.equal(aired.status, "已播出");
  assert.ok(aired.airedAt, "已播出段落必须留档播出时间");
  assert.equal(aired.stale, false);

  for (const id of ["r2", "r3", "r4"]) {
    assert.equal(item(result.ledger, id).stale, true, `${id} 应失效待确认`);
    assert.match(item(result.ledger, id).staleReason ?? "", /突发插播/);
  }

  const breaking = result.ledger.items.find((entry) => entry.title === "地震突发速报");
  assert.ok(breaking);
  assert.equal(breaking?.stale, false);

  // 时间轴顺推 + 风险：广告硬时间 08:30，插播 10 分钟后必定晚点，且所在段已失效
  const rows = selectTimeline(result.ledger.items);
  const risks = computeHardRisks(rows);
  const adRisk = risks.find((risk) => risk.itemId === "r4");
  assert.ok(adRisk, "应报出广告硬时间风险");
  // 原计划广告 08:30（连线 08:06 前有 2 分钟、广告前有 4 分钟空档），插入 10 分钟后晚点 4 分钟
  assert.equal(adRisk!.overrunMinutes, 4, `广告应晚点 4 分钟，实际 ${adRisk!.overrunMinutes}`);
  assert.equal(adRisk!.stale, true);

  // 已播出段不出现在风险清单
  assert.equal(risks.some((risk) => risk.itemId === "r1"), false);
});

test("时长变化：下游失效；确认重算后版本递增、失效清除", () => {
  let ledger = fresh();
  const base = item(ledger, "r2").version;
  const edited = commitOp(ledger, op({ station: "导播", type: "editItem", baseVersion: base, payload: { id: "r2", fields: { duration: 20 } } }));
  assert.equal(edited.status, "applied");
  if (edited.status !== "applied") throw new Error();
  ledger = edited.ledger;
  assert.equal(item(ledger, "r2").duration, 20);
  assert.equal(item(ledger, "r3").stale, true);
  assert.equal(item(ledger, "r1").stale, false, "已播出不受影响");

  const ack = commitOp(ledger, op({ station: "导播", type: "acknowledgeRecalc", payload: { ids: ["r2", "r3", "r4"] } }));
  assert.equal(ack.status, "applied");
  if (ack.status !== "applied") throw new Error();
  assert.equal(item(ack.ledger, "r3").stale, false);
  assert.ok(item(ack.ledger, "r3").version > 1);
});

test("已播出段落不可修改/取消/重复播出", () => {
  const ledger = fresh();
  const denied1 = commitOp(ledger, op({ station: "主编", type: "editItem", baseVersion: item(ledger, "r1").version, payload: { id: "r1", fields: { title: "改已播出" } } }));
  assert.equal(denied1.status, "denied");
  const denied2 = commitOp(ledger, op({ station: "导播", type: "skipItem", baseVersion: item(ledger, "r1").version, payload: { id: "r1" } }));
  assert.equal(denied2.status, "denied");
});

test("播出操作留档段落快照", () => {
  const ledger = fresh();
  const result = commitOp(ledger, op({ station: "导播", type: "updateStatus", baseVersion: item(ledger, "r2").version, payload: { id: "r2", status: "已播出" } }));
  assert.equal(result.status, "applied");
  if (result.status !== "applied") throw new Error();
  const entry = result.ledger.audit.find((audit) => audit.snapshot?.id === "r2");
  assert.ok(entry?.snapshot);
  assert.equal(entry?.snapshot?.status, "已播出");
});

// ---- 需求 4：权限——越权直接拒绝 -------------------------------------------

test("岗位越权：字幕改时长、演播室改标题、主编播出，全部拒绝", () => {
  const ledger = fresh();
  const cases: Array<{ station: Role; type: Op["type"]; payload: Op["payload"] }> = [
    { station: "字幕", type: "editItem", payload: { id: "r3", fields: { duration: 99 } } },
    { station: "演播室", type: "editItem", payload: { id: "r3", fields: { title: "越权标题" } } },
    { station: "主编", type: "updateStatus", payload: { id: "r3", status: "已播出" } },
    { station: "字幕", type: "insertBreaking", payload: { headline: "字幕插播", duration: 1, insertAfter: "r1", reason: "x" } },
    { station: "导播", type: "addItem", payload: { title: "导播加条目", type: "口播", duration: 1, presenter: "a", source: "b", lowerThird: "c" } }
  ];
  for (const testCase of cases) {
    const result = commitOp(ledger, op({ station: testCase.station, type: testCase.type, baseVersion: 1, payload: testCase.payload }));
    assert.equal(result.status, "denied", `${testCase.station} ${testCase.type} 应被拒绝`);
    if (result.status === "denied") assert.match(result.reason, /无权/);
  }
});

test("字幕只改字幕条、演播室只改主播/来源，授权通过", () => {
  let ledger = fresh();
  const a = commitOp(ledger, op({ station: "字幕", type: "editItem", baseVersion: item(ledger, "r3").version, payload: { id: "r3", fields: { lowerThird: "新字幕" } } }));
  assert.equal(a.status, "applied");
  if (a.status !== "applied") throw new Error();
  ledger = a.ledger;
  const b = commitOp(ledger, op({ station: "演播室", type: "editItem", baseVersion: item(ledger, "r3").version, payload: { id: "r3", fields: { presenter: "林悦", source: "演播室B" } } }));
  assert.equal(b.status, "applied");
});

// ---- 需求 3：断网排队 → 回连按序号合并、幂等、只重试没写入 ------------------

test("离线队列回连：按岗位序号合并；同一插播 opId 只入库一次", () => {
  let ledger = fresh();

  // 离线期间：导播两条操作（序号 1、2）
  const q1 = op({ opId: "offline-1", station: "导播", seq: 1, type: "editItem", baseVersion: item(ledger, "r2").version, payload: { id: "r2", fields: { duration: 15 } } });
  let r1 = commitToServer(q1);
  assert.equal(r1.status, "applied");
  ledger = r1.ledger;

  const q2 = op({ opId: "offline-2", station: "导播", seq: 2, type: "insertBreaking", baseVersion: item(ledger, "r1").version, payload: { headline: "离线插播", duration: 3, insertAfter: "r1", reason: "断网期间编排" } });
  const r2 = commitToServer(q2);
  assert.equal(r2.status, "applied");

  // 网络抖动重发 q2：同一插播只入库一次
  const replay = commitToServer(q2);
  assert.equal(replay.status, "duplicate");
  assert.equal(replay.ledger.changes.filter((change) => change.headline === "离线插播").length, 1);
  assert.equal(replay.ledger.appliedOpIds.filter((id) => id === "offline-2").length, 1);

  // 跨岗位：主编序号独立
  const editorOp = op({ opId: "offline-3", station: "主编", seq: 1, type: "editItem", baseVersion: item(replay.ledger, "r3").version, payload: { id: "r3", fields: { title: "主编离线改题" } } });
  const r3 = commitToServer(editorOp);
  assert.equal(r3.status, "applied");
  assert.equal(r3.ledger.lastSeq["导播"], 2);
  assert.equal(r3.ledger.lastSeq["主编"], 1);
});

test("写入故障：操作未入库；故障后重试成功，且故障期间已写入的不重复", () => {
  const ledger0 = fresh();
  const q1 = op({ opId: "fault-1", station: "导播", seq: 1, type: "editItem", baseVersion: item(ledger0, "r2").version, payload: { id: "r2", fields: { duration: 11 } } });
  const q2 = op({ opId: "fault-2", station: "导播", seq: 2, type: "editItem", baseVersion: item(ledger0, "r3").version, payload: { id: "r3", fields: { duration: 7 } } });

  // q1 正常写入
  assert.equal(commitToServer(q1).status, "applied");
  // q2 前注入一次写入失败
  armNextWriteFault();
  assert.throws(() => commitToServer(q2), /未入库/);

  // q2 没有写入：r3 时长不变，appliedOpIds 不含 fault-2
  const reloaded = commitToServer(op({ opId: "probe", station: "主编", seq: 99, type: "acknowledgeRecalc", payload: { ids: [] } })).ledger;
  assert.equal(item(reloaded, "r2").duration, 11);
  assert.equal(item(reloaded, "r3").duration, 12);
  assert.equal(reloaded.appliedOpIds.includes("fault-2"), false);

  // 只重试没写入的 q2
  const retry = commitToServer(q2);
  assert.equal(retry.status, "applied");
  assert.equal(item(retry.ledger, "r3").duration, 7);
  assert.equal(retry.ledger.appliedOpIds.filter((id) => id === "fault-1").length, 1);
});

test("离线编辑晚到撞先确认版本：回连合并时记冲突而不是覆盖", () => {
  // 服务端：主编在线先把 r3 改了
  const online = commitToServer(op({ opId: "live-1", station: "主编", seq: 1, type: "editItem", baseVersion: item(fresh(), "r3").version, payload: { id: "r3", fields: { title: "在线先确认" } } }));
  assert.equal(online.status, "applied");

  // 另一岗位离线时基于旧版本改了同段，回连提交
  const stale = op({ opId: "off-stale", station: "字幕", seq: 1, type: "editItem", baseVersion: 1, payload: { id: "r3", fields: { lowerThird: "离线晚到" } } });
  const merged = commitToServer(stale);
  assert.equal(merged.status, "conflict");
  if (merged.status !== "conflict") throw new Error();
  assert.equal(merged.ledger.items.find((entryItem) => entryItem.id === "r3")?.title, "在线先确认");
  assert.equal(merged.conflict.differences[0].incomingValue, "离线晚到");
});

// ---- 时间轴边角 -------------------------------------------------------------

test("已跳过段落不占位，顺推时间轴", () => {
  let ledger = fresh();
  const skip = commitOp(ledger, op({ station: "导播", type: "skipItem", baseVersion: item(ledger, "r2").version, payload: { id: "r2" } }));
  assert.equal(skip.status, "applied");
  if (skip.status !== "applied") throw new Error();
  ledger = skip.ledger;
  const rows = selectTimeline(ledger.items);
  assert.equal(rows.find((row) => row.item.id === "r2"), undefined);
  assert.equal(rows.find((row) => row.item.id === "r3")?.start, "08:04");
});

test("拖拽顺序与当前顺序不一致（他岗已调）判冲突", () => {
  const ledger = fresh();
  const ids = ["r4", "r3", "r2", "r1"];
  const result = commitOp(ledger, op({ station: "导播", type: "reorder", payload: { ids } }));
  assert.equal(result.status, "conflict");
});
