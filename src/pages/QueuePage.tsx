import { useState } from "react";
import { Alert, Button, Card, Empty, Switch, Table, Tag, Tooltip } from "antd";
import { format } from "date-fns";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { replayQueue } from "../store/ledgerSlice";
import type { LedgerOp, OpStatus } from "../types";

const TYPE_LABELS: Record<string, string> = {
  "item/add": "新增条目",
  "item/update": "修改内容",
  "item/status": "播出状态",
  "item/skip": "取消条目",
  "item/duration": "调整时长",
  "item/reorder": "调整顺序",
  "breaking/insert": "突发插播",
  "ledger/undo": "撤回",
};

const STATUS_META: Record<OpStatus, { color: string; text: string }> = {
  applied: { color: "green", text: "已入账" },
  pending: { color: "orange", text: "待同步" },
  written: { color: "green", text: "已写入" },
  conflict: { color: "volcano", text: "冲突挂起" },
  rejected: { color: "red", text: "已拒绝" },
  failed: { color: "gold", text: "写入失败" },
};

function detailOf(op: LedgerOp): string {
  const p = op.payload;
  if (typeof p.headline === "string") return p.headline;
  if (typeof p.title === "string") return p.title;
  if (typeof p.status === "string") return `→ ${p.status}`;
  if (typeof p.delta === "number") return `时长 ${p.delta > 0 ? "+" : ""}${p.delta}`;
  if (Array.isArray(p.order)) return `顺序 ${p.order.length} 条`;
  return TYPE_LABELS[op.type] ?? op.type;
}

export function QueuePage() {
  const dispatch = useAppDispatch();
  const { outbox, online, replaySummary } = useAppSelector((s) => s.ledger);
  const [flaky, setFlaky] = useState(false);

  const pending = outbox.filter((o) => o.status !== "written");
  const hasFailed = outbox.some((o) => o.status === "failed");

  const columns = [
    { title: "序号", dataIndex: "seq", width: 70, render: (seq: number) => <b>#{seq}</b> },
    {
      title: "类型",
      dataIndex: "type",
      width: 110,
      render: (type: LedgerOp["type"]) => <Tag>{TYPE_LABELS[type] ?? type}</Tag>,
    },
    { title: "内容", render: (_: unknown, op: LedgerOp) => detailOf(op) },
    { title: "岗位", dataIndex: "actor", width: 90 },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (status: OpStatus) => {
        const meta = STATUS_META[status];
        return <Tag color={meta.color}>{meta.text}</Tag>;
      },
    },
    {
      title: "说明",
      render: (_: unknown, op: LedgerOp) =>
        op.reason ? <small className="error">{op.reason}</small> : <small>{format(new Date(op.createdAt), "HH:mm:ss")}</small>,
    },
    {
      title: "操作",
      width: 90,
      render: (_: unknown, op: LedgerOp) =>
        op.status === "written" ? (
          <Tooltip title="已写入，重试时自动跳过（幂等）">
            <Tag color="green">已入库</Tag>
          </Tooltip>
        ) : (
          <Button size="small" onClick={() => dispatch(replayQueue(flaky))}>
            重试
          </Button>
        ),
    },
  ];

  return (
    <Card
      title="本地应急队列"
      extra={
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Tooltip title="模拟主链路抖动：每 3 条写入失败 1 条，用于验证只重试未写入部分">
            <label style={{ color: "#6b7485" }}>
              <Switch checked={flaky} onChange={setFlaky} /> 模拟链路抖动
            </label>
          </Tooltip>
          <Button type="primary" disabled={online && !pending.length} onClick={() => dispatch(replayQueue(flaky))}>
            {online ? "回连合并队列" : "主链路恢复后提交"}
          </Button>
        </div>
      }
    >
      {!online && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前离线：操作先在队列排队。回连后按操作序号合并；同一插播按内容幂等只入库一次；已写入的不会重复写。"
        />
      )}
      {replaySummary && (
        <Alert
          type={replaySummary.failed || replaySummary.conflict ? "warning" : "success"}
          showIcon
          style={{ marginBottom: 12 }}
          message={`上次合并：写入 ${replaySummary.written}，冲突 ${replaySummary.conflict}，拒绝 ${replaySummary.rejected}，失败 ${replaySummary.failed}`}
        />
      )}
      {hasFailed && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="存在写入失败的操作。点击「重试未写入部分」即可，已写入的会自动跳过，不会重复入库。"
          action={
            <Button size="small" danger onClick={() => dispatch(replayQueue(flaky))}>
              重试未写入部分
            </Button>
          }
        />
      )}
      {outbox.length ? (
        <Table
          rowKey="opId"
          size="small"
          columns={columns}
          dataSource={[...outbox].sort((a, b) => b.seq - a.seq)}
          pagination={false}
        />
      ) : (
        <Empty description="应急队列为空" />
      )}
    </Card>
  );
}
