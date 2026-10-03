import { useEffect, useMemo, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Button, Card, Form, Input, InputNumber, Select, Switch, Tag, Timeline, message } from "antd";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { EditDialog, type EditSubmit } from "./components/EditDialog";
import { ConflictPanel } from "./components/ConflictPanel";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { bootstrapLedger, clearNotice, flushQueue, pullLedger, setOnline, setRole } from "./store/rundownSlice";
import { useDispatchOp } from "./store/useDispatchOp";
import { canPerform } from "./domain/permissions";
import { computeHardRisks, selectTimeline } from "./domain/ledger/engine";
import { armNextWriteFault } from "./domain/ledger/server";
import type { ItemType, Role, RundownItem } from "./types";

const schema = z.object({
  title: z.string().min(2),
  type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]),
  duration: z.number().min(1).max(120),
  hardStart: z.string().regex(/^(\d{2}:\d{2})?$/, "格式 HH:mm 或留空"),
  presenter: z.string().min(1),
  source: z.string().min(1),
  lowerThird: z.string().min(1)
});
type FormValues = z.infer<typeof schema>;

function fmt(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 串联单主页
// ---------------------------------------------------------------------------

function RundownPage() {
  const dispatch = useAppDispatch();
  const { ledger, role, online } = useAppSelector((state) => state.rundown);
  const dispatchOp = useDispatchOp();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [editing, setEditing] = useState<RundownItem | null>(null);

  const rows = useMemo(() => selectTimeline(ledger.items), [ledger.items]);
  const risks = useMemo(() => computeHardRisks(rows), [rows]);
  const riskByItem = useMemo(() => new Map(risks.map((risk) => [risk.itemId, risk])), [risks]);
  const cumulative = useMemo(() => new Map(rows.map((row) => [row.item.id, row.start])), [rows]);
  const total = ledger.items.filter((item) => item.status !== "已跳过").reduce((sum, item) => sum + item.duration, 0);
  const staleCount = ledger.items.filter((item) => item.stale).length;
  const openConflicts = ledger.conflicts.filter((item) => item.status === "open").length;
  const endAt = rows.at(-1)?.end ?? "--:--";

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    if (!canPerform(role, "reorder")) {
      message.error("仅导播可以调整串联单顺序");
      return;
    }
    const ids = ledger.items.map((item) => item.id);
    const oldIndex = ids.indexOf(String(event.active.id));
    const newIndex = ids.indexOf(String(event.over!.id));
    const reordered = [...ids];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    dispatchOp({ type: "reorder", fields: { ids: reordered } });
  };

  const saveEdit = ({ id, baseVersion, fields }: EditSubmit) => {
    dispatchOp({ type: "editItem", fields: { id, fields: fields as EditSubmit["fields"] }, baseVersion });
  };

  const acknowledge = () => {
    const ids = ledger.items.filter((item) => item.stale).map((item) => item.id);
    if (!ids.length) return;
    dispatchOp({ type: "acknowledgeRecalc", fields: { ids }, baseVersion: undefined });
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading">
        <div><small>2026-10-08 · 08:00 开播 · 账本 v{ledger.docVersion}</small><h2>直播串联单（可恢复编排账）</h2></div>
        <div className="head-actions">
          <Tag color={online ? "green" : "red"}>{online ? "主链路在线" : "本地应急模式"}</Tag>
          <Tag color={openConflicts ? "red" : "default"}>{openConflicts} 个冲突待裁决</Tag>
          {role === "导播" && <Button onClick={acknowledge} disabled={!staleCount}>确认重算 {staleCount ? `(${staleCount})` : ""}</Button>}
        </div>
      </div>
      <div className="summary">
        <span><b>{ledger.items.length}</b> 条内容</span>
        <span><b>{total}</b> 分钟总时长</span>
        <span className={risks.length ? "danger-text" : ""}><b>{risks.length}</b> 个硬时间风险</span>
        <span className={staleCount ? "warn-text" : ""}><b>{staleCount}</b> 段待重算确认</span>
        <span><b>{endAt}</b> 预计收播</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ledger.items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">
            {ledger.items.map((item) => <SortableItem
              key={item.id}
              item={item}
              cumulative={cumulative.get(item.id) ?? "—"}
              role={role}
              risk={riskByItem.get(item.id)}
              onDuration={(delta) => dispatchOp({ type: "editItem", fields: { id: item.id, fields: { duration: Math.max(1, item.duration + delta) } }, baseVersion: item.version })}
              onEdit={() => setEditing(item)}
              onStatus={() => dispatchOp({ type: "updateStatus", fields: { id: item.id, status: "已播出" }, baseVersion: item.version })}
              onSkip={() => dispatchOp({ type: "skipItem", fields: { id: item.id }, baseVersion: item.version })}
            />)}
          </div>
        </SortableContext>
      </DndContext>
    </Card>
    <aside className="side-stack">
      <AddItemCard />
      <BreakingForm />
    </aside>
    <EditDialog item={editing} role={role} onClose={() => setEditing(null)} onSubmit={saveEdit} />
  </div>;
}

// ---------------------------------------------------------------------------
// 新增条目（仅主编）
// ---------------------------------------------------------------------------

function AddItemCard() {
  const role = useAppSelector((state) => state.rundown.role);
  const dispatchOp = useDispatchOp();
  const { control, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { title: "", type: "新闻片", duration: 5, hardStart: "", presenter: "陈默", source: "主控", lowerThird: "" }
  });
  if (!canPerform(role, "addItem")) {
    return <Card><small className="form-hint">当前岗位「{role}」无权新增条目（仅主编可新增）。越权操作即使提交也会被账本拒绝。</small></Card>;
  }
  const submit = (values: FormValues) => {
    dispatchOp({ type: "addItem", fields: { ...values, hardStart: values.hardStart || undefined }, baseVersion: undefined });
    reset();
  };
  return <Card title="新增播出条目（主编）">
    <Form layout="vertical" onFinish={handleSubmit(submit)}>
      <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
      <div className="two-cols">
        <Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={(["新闻片", "连线", "嘉宾", "口播", "广告"] as ItemType[]).map((value) => ({ value, label: value }))} />} /></Form.Item>
        <Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item>
      </div>
      <Form.Item label="硬时间"><Controller name="hardStart" control={control} render={({ field }) => <Input {...field} placeholder="08:30，可留空" />} /></Form.Item>
      <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
      <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
      <Form.Item label="字幕条"><Controller name="lowerThird" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
      <Button htmlType="submit" type="primary" block>加入串联单</Button>
    </Form>
  </Card>;
}

// ---------------------------------------------------------------------------
// 突发插播（导播/主编）
// ---------------------------------------------------------------------------

function BreakingForm() {
  const { ledger, role, online } = useAppSelector((state) => state.rundown);
  const dispatchOp = useDispatchOp();
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: ledger.items[0]?.id ?? "", reason: "突发新闻" });
  const anchor = ledger.items.find((item) => item.id === values.insertAfter);
  const allowed = canPerform(role, "insertBreaking");
  const submit = () => {
    if (!anchor) return;
    dispatchOp({ type: "insertBreaking", fields: { headline: values.headline, duration: values.duration, insertAfter: anchor.id, reason: values.reason }, baseVersion: anchor.version });
    if (!online) message.warning("断网：已占操作序号进入应急队列并本地预演");
    setValues((current) => ({ ...current, headline: "" }));
  };
  return <Card title="突发插播" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" disabled={!allowed} />
    <div className="two-cols">
      <InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" disabled={!allowed} />
      <Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={ledger.items.filter((item) => item.status !== "已跳过").map((item) => ({ value: item.id, label: `插在「${item.title}」后 · v${item.version}` }))} />
    </div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" disabled={!allowed} />
    <Button type="primary" danger block disabled={!allowed || values.headline.length < 2} onClick={submit}>立即插入并重算硬时间风险</Button>
    {!allowed && <small className="form-hint">「{role}」无权突发插播。</small>}
    {!online && allowed && <small>离线操作先排队（同一插播同一操作号，回连只入库一次），本地顺序仍可用于应急播出。</small>}
  </Card>;
}

// ---------------------------------------------------------------------------
// 应急队列：回连按序号合并
// ---------------------------------------------------------------------------

function QueuePage() {
  const { queue, online, lastSyncAt } = useAppSelector((state) => state.rundown);
  const dispatch = useAppDispatch();
  const pending = queue.filter((item) => item.status === "pending");
  return <Card
    title={<span>本地应急队列 <Tag color={pending.length ? "red" : "default"}>{pending.length} 待提交</Tag></span>}
    extra={<div className="head-actions">
      <Button size="small" onClick={() => { armNextWriteFault(); message.warning("已注入下一次写入故障（用于演示只重试未写入部分）"); }}>模拟下一次写入失败</Button>
      <Button type="primary" disabled={online || pending.length === 0} onClick={() => void dispatch(flushQueue())}>回连：按操作序号合并</Button>
    </div>}
  >
    <small className="form-hint">合并规则：按岗位操作序号逐条入库；服务端按操作号幂等，同一插播只入库一次；写入失败只重试仍未写入的部分。{lastSyncAt ? ` 上次同步 ${fmt(lastSyncAt)}` : ""}</small>
    <div className="queue-list">
      {queue.length === 0 && <p>当前没有排队操作。</p>}
      {queue.map((entry) => (
        <article key={entry.op.opId} className={`queue-${entry.status}`}>
          <Tag color={entry.status === "pending" ? "red" : entry.status === "acked" ? "green" : entry.status === "conflict" ? "orange" : "default"}>
            {entry.status === "pending" ? "未提交" : entry.status === "acked" ? "已入库" : entry.status === "conflict" ? "冲突待裁决" : "已拒绝"}
          </Tag>
          <b>{entry.detail}</b>
          <small>#{entry.op.seq} · {entry.op.station} · {fmt(entry.queuedAt)} · op {entry.op.opId.slice(-6)}</small>
          {entry.denialReason && <small className="error">拒绝原因：{entry.denialReason}</small>}
          {entry.conflictId && <small className="warn-text">差异已入冲突清单：{entry.conflictId.slice(-6)}</small>}
        </article>
      ))}
    </div>
  </Card>;
}

// ---------------------------------------------------------------------------
// 突发变更 / 审计历史
// ---------------------------------------------------------------------------

function ChangesPage() {
  const { ledger } = useAppSelector((state) => state.rundown);
  return <Card title="突发变更记录">
    <Timeline items={ledger.changes.map((item) => ({ color: "red", children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟 · {item.station}/{item.actor}</p><small>{fmt(item.createdAt)} · 操作号 {item.opId.slice(-6)}</small></div> }))} />
  </Card>;
}

function AuditPage() {
  const { ledger } = useAppSelector((state) => state.rundown);
  return <Card title="编排账审计流（含已播出留档）">
    <Timeline items={ledger.audit.map((entry) => ({
      color: entry.snapshot ? "green" : "blue",
      children: <div>
        <b>{entry.detail}</b>
        <p>{entry.station}/{entry.actor}</p>
        <small>{fmt(entry.at)} · op {entry.opId.slice(-6)}</small>
        {entry.snapshot && <div className="aired-archive">已播出留档：{entry.snapshot.title} · {entry.snapshot.duration} 分钟 · 播出于 {fmt(entry.snapshot.airedAt ?? entry.at)}（v{entry.snapshot.version}）</div>}
      </div>
    }))} />
  </Card>;
}

function ConflictsRoute() {
  const { ledger, role } = useAppSelector((state) => state.rundown);
  const dispatchOp = useDispatchOp();
  return <ConflictPanel conflicts={ledger.conflicts} role={role} onResolve={(conflictId, resolution) => dispatchOp({ type: "resolveConflict", fields: { conflictId, resolution }, baseVersion: undefined })} />;
}

// ---------------------------------------------------------------------------
// 外壳
// ---------------------------------------------------------------------------

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { t, i18n } = useTranslation();
  const queueCount = state.queue.filter((entry) => entry.status === "pending").length;

  useEffect(() => { void dispatch(bootstrapLedger()); }, [dispatch]);

  // 在线时每 2 秒拉取账本：另一岗位（或另一标签页）确认的版本会即时出现
  useEffect(() => {
    if (!state.online || !state.initialized) return;
    const timer = setInterval(() => void dispatch(pullLedger()), 2000);
    return () => clearInterval(timer);
  }, [dispatch, state.online, state.initialized]);

  useEffect(() => {
    if (!state.notice) return;
    const key = `notice-${state.notice.at}`;
    const fn = { success: message.success, error: message.error, warning: message.warning }[state.notice.kind];
    fn({ content: state.notice.text, key, duration: 4 });
    const timer = setTimeout(() => dispatch(clearNotice()), 4200);
    return () => clearTimeout(timer);
  }, [dispatch, state.notice]);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Recoverable rundown ledger</small></div></div>
      <nav>
        <NavLink to="/">{t("rundown")}</NavLink>
        <NavLink to="/conflicts">{t("conflicts")} {state.ledger.conflicts.some((item) => item.status === "open") ? <em>{state.ledger.conflicts.filter((item) => item.status === "open").length}</em> : null}</NavLink>
        <NavLink to="/changes">{t("changes")}</NavLink>
        <NavLink to="/queue">{t("queue")} {queueCount ? <em>{queueCount}</em> : null}</NavLink>
        <NavLink to="/audit">{t("audit")}</NavLink>
      </nav>
      <Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button>
    </aside>
    <main>
      <header className="topbar">
        <div><small>串联单 · 突发插播 · 应急队列 · 硬时间 同一份可恢复编排账</small><h1>{t("title")}</h1></div>
        <div className="top-actions">
          <label>链路 <Switch checked={state.online} checkedChildren="在线" unCheckedChildren="断网" onChange={(value) => dispatch(setOnline(value))} /></label>
          <label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{ value: "导播" }, { value: "主编" }, { value: "字幕" }, { value: "演播室" }]} /></label>
          <small>{state.actor}</small>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<RundownPage />} />
        <Route path="/conflicts" element={<ConflictsRoute />} />
        <Route path="/changes" element={<ChangesPage />} />
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Routes>
    </main>
  </div>;
}
