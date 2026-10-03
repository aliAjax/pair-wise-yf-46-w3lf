import { Card, Empty, Table, Tag } from "antd";
import { format } from "date-fns";
import { useAppSelector } from "../store/hooks";
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
  failed: { color: "gold", text: "失败" },
};

function detailOf(op: LedgerOp): string {
  const p = op.payload;
  if (typeof p.headline === "string") return p.headline;
  if (typeof p.title === "string") return p.title;
  if (typeof p.status === "string") return `→ ${p.status}`;
  if (typeof p.delta === "number") return `时长 ${p.delta > 0 ? "+" : ""}${p.delta}`;
  if (Array.isArray(p.order)) return `顺序 ${p.order.length} 条`;
  if (typeof p.snapshot !== "undefined") return "恢复上一版编排";
  return TYPE_LABELS[op.type] ?? op.type;
}

export function LedgerPage() {
  const { opLog, ledgerVersion } = useAppSelector((s) => s.ledger);
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
      title: "版本",
      width: 110,
      render: (_: unknown, op: LedgerOp) => (
        <small>
          v{op.baseVersion} → v{op.status === "applied" || op.status === "written" ? op.baseVersion + 1 : op.baseVersion}
        </small>
      ),
    },
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
      title: "时间",
      width: 100,
      render: (_: unknown, op: LedgerOp) => <small>{format(new Date(op.createdAt), "HH:mm:ss")}</small>,
    },
    {
      title: "原因/说明",
      render: (_: unknown, op: LedgerOp) =>
        op.reason ? <small className="error">{op.reason}</small> : <small>—</small>,
    },
  ];

  return (
    <Card
      title={
        <span>
          操作账本 <Tag color="blue">当前 v{ledgerVersion}</Tag>
        </span>
      }
    >
      {opLog.length ? (
        <Table
          rowKey="opId"
          size="small"
          columns={columns}
          dataSource={[...opLog].sort((a, b) => b.seq - a.seq)}
          pagination={false}
        />
      ) : (
        <Empty description="账本还是空的" />
      )}
    </Card>
  );
}
