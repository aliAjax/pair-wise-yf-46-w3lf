import { useMemo, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Alert, Button, Card, Form, Input, InputNumber, Select, Tag, Tooltip } from "antd";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { SortableItem } from "../components/SortableItem";
import { ConflictPanel } from "../components/ConflictPanel";
import { recompute } from "../ledger/engine";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { commitOp, resolveConflictThunk, undo } from "../store/ledgerSlice";
import type { Role } from "../types";

const schema = z.object({
  title: z.string().min(2),
  type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]),
  duration: z.number().min(1).max(120),
  presenter: z.string().min(1),
  source: z.string().min(1),
});
type FormValues = z.infer<typeof schema>;

const can = {
  drag: (r: Role) => r === "导播",
  duration: (r: Role) => r === "导播",
  status: (r: Role) => r === "导播" || r === "演播室",
  skip: (r: Role) => r === "导播" || r === "主编" || r === "演播室",
  add: (r: Role) => r === "导播" || r === "主编",
  breaking: (r: Role) => r === "导播" || r === "主编",
};

export function RundownPage() {
  const dispatch = useAppDispatch();
  const { items, archive, role, online, conflicts, outbox, history } = useAppSelector((s) => s.ledger);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const timing = useMemo(() => recompute(items, archive), [items, archive]);
  const archiveTiming = useMemo(() => recompute(archive, []), [archive]);
  const total = items.reduce((sum, it) => sum + it.duration, 0);
  const riskCount = timing.filter((t) => t.risk).length;
  const pendingCount = outbox.filter((o) => o.status !== "written").length;
  const openConflicts = conflicts.filter((c) => !c.resolved).length;

  const { control, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" },
  });

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || !can.drag(role)) return;
    const oldIndex = items.findIndex((it) => it.id === event.active.id);
    const newIndex = items.findIndex((it) => it.id === event.over!.id);
    const order = arrayMove(items, oldIndex, newIndex).map((it) => it.id);
    dispatch(commitOp("item/reorder", { order }));
  };

  const submit = (values: FormValues) => {
    dispatch(commitOp("item/add", values));
    reset();
  };

  return (
    <div className="page-grid">
      <Card className="main-card">
        <div className="card-heading">
          <div>
            <small>2026-10-08 · 08:00 开播</small>
            <h2>直播串联单</h2>
          </div>
          <div className="head-actions">
            <Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag>
            <Tooltip title={role === "导播" ? "撤回上一步（作为新入账）" : "仅导播可撤回"}>
              <Button onClick={() => dispatch(undo())} disabled={role !== "导播" || !history.length}>
                撤回上一步
              </Button>
            </Tooltip>
          </div>
        </div>

        {!online && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={`离线模式：${pendingCount} 条操作在应急队列排队，回连后按操作序号合并，不影响本地播出顺序。`}
          />
        )}
        {openConflicts > 0 && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 12 }}
            message={`${openConflicts} 条并发冲突待对账：后到版本已挂起，未覆盖已确认版本。`}
          />
        )}

        <div className="summary">
          <span>
            <b>{items.length}</b> 条待播
          </span>
          <span>
            <b>{total}</b> 分钟待播
          </span>
          <span className={riskCount ? "danger-text" : ""}>
            <b>{riskCount}</b> 个硬时间风险
          </span>
          <span>
            <b>{timing.at(-1)?.at ?? "--:--"}</b> 预计收播
          </span>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((it) => it.id)} strategy={verticalListSortingStrategy}>
            <div className="rundown-list">
              {timing.map(({ item, at, risk }) => (
                <SortableItem
                  key={item.id}
                  item={item}
                  cumulative={at}
                  risk={risk}
                  canDrag={can.drag(role)}
                  canDuration={can.duration(role)}
                  canStatus={can.status(role)}
                  canSkip={can.skip(role)}
                  onDuration={(delta) => dispatch(commitOp("item/duration", { id: item.id, delta }))}
                  onStatus={() => dispatch(commitOp("item/status", { id: item.id, status: "已播出" }))}
                  onSkip={() => dispatch(commitOp("item/skip", { id: item.id }))}
                />
              ))}
              {!items.length && <p className="empty-hint">当前没有待播条目。</p>}
            </div>
          </SortableContext>
        </DndContext>

        {archive.length > 0 && (
          <details className="archive-block">
            <summary>
              已播出留档（{archive.length} 条，只留档不再参与重算）
            </summary>
            <div className="rundown-list archive-list">
              {archiveTiming.map(({ item, at }) => (
                <article key={item.id} className="rundown-row status-已播出">
                  <span className="drag-handle">🔒</span>
                  <time>{at}</time>
                  <div className="row-main">
                    <b>{item.title}</b>
                    <small>
                      {item.source} · {item.presenter} · v{item.version} · {item.updatedBy} 确认
                    </small>
                  </div>
                  <Tag color="green">已播出</Tag>
                  <span>{item.duration} 分钟</span>
                </article>
              ))}
            </div>
          </details>
        )}
      </Card>

      <aside className="side-stack">
        <Card title="新增播出条目">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="标题">
              <Controller
                name="title"
                control={control}
                render={({ field, fieldState }) => (
                  <>
                    <Input {...field} status={fieldState.error ? "error" : ""} />
                    <small className="error">{fieldState.error?.message}</small>
                  </>
                )}
              />
            </Form.Item>
            <div className="two-cols">
              <Form.Item label="类型">
                <Controller
                  name="type"
                  control={control}
                  render={({ field }) => (
                    <Select {...field} options={["新闻片", "连线", "嘉宾", "口播", "广告"].map((v) => ({ value: v, label: v }))} />
                  )}
                />
              </Form.Item>
              <Form.Item label="时长">
                <Controller
                  name="duration"
                  control={control}
                  render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />}
                />
              </Form.Item>
            </div>
            <Form.Item label="主播">
              <Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} />
            </Form.Item>
            <Form.Item label="来源">
              <Controller name="source" control={control} render={({ field }) => <Input {...field} />} />
            </Form.Item>
            <Tooltip title={can.add(role) ? "" : `${role}岗位无权新增条目`}>
              <Button htmlType="submit" type="primary" block disabled={!can.add(role)}>
                加入串联单
              </Button>
            </Tooltip>
          </Form>
        </Card>
        <BreakingForm canBreak={can.breaking(role)} role={role} />
        <ConflictPanel
          conflicts={conflicts}
          onResolve={(id, resolution) => dispatch(resolveConflictThunk(id, resolution))}
        />
      </aside>
    </div>
  );
}

function BreakingForm({ canBreak, role }: { canBreak: boolean; role: Role }) {
  const dispatch = useAppDispatch();
  const items = useAppSelector((s) => s.ledger.items);
  const online = useAppSelector((s) => s.ledger.online);
  const [values, setValues] = useFormState(items);
  return (
    <Card title="突发插播" className="breaking-card">
      <Input
        value={values.headline}
        onChange={(event) => setValues({ ...values, headline: event.target.value })}
        placeholder="插播标题"
      />
      <div className="two-cols">
        <InputNumber
          value={values.duration}
          onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })}
          addonAfter="分钟"
        />
        <Select
          value={values.insertAfter}
          onChange={(value) => setValues({ ...values, insertAfter: value })}
          options={items.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))}
        />
      </div>
      <Input
        value={values.reason}
        onChange={(event) => setValues({ ...values, reason: event.target.value })}
        placeholder="插播原因"
      />
      <Tooltip title={canBreak ? "" : `${role}岗位无权安排突发插播`}>
        <Button
          type="primary"
          danger
          block
          disabled={!canBreak || values.headline.length < 2}
          onClick={() => {
            dispatch(commitOp("breaking/insert", values));
            setValues({ ...values, headline: "" });
          }}
        >
          {online ? "立即插入并重算时长" : "插入（离线排队，回连合并）"}
        </Button>
      </Tooltip>
      {!online && <small>离线操作将在主链路恢复后按操作序号合并，同一插播只入库一次。</small>}
    </Card>
  );
}

function useFormState(items: { id: string }[]) {
  const [values, setValues] = useState({
    headline: "",
    duration: 5,
    insertAfter: items[0]?.id ?? "",
    reason: "突发新闻",
  });
  return [values, setValues] as const;
}