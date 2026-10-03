import { Alert, Button, Card, Empty, Tag } from "antd";
import { format } from "date-fns";
import type { ConflictRecord } from "../types";

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

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === "") return "（空）";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function ConflictPanel({
  conflicts,
  onResolve,
}: {
  conflicts: ConflictRecord[];
  onResolve: (id: string, resolution: "keep-mine" | "take-theirs") => void;
}) {
  const open = conflicts.filter((c) => !c.resolved);
  if (!open.length)
    return (
      <Card title="冲突对账">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有未解决的并发冲突" />
      </Card>
    );
  return (
    <Card
      title={
        <span>
          冲突对账 <Tag color="red">{open.length}</Tag>
        </span>
      }
    >
      <Alert
        type="warning"
        showIcon
        message="两个岗位同时改了同一段落：后到的版本已挂起，不会盖掉先确认的版本。请核对差异后选择保留哪一版。"
        style={{ marginBottom: 12 }}
      />
      <div className="conflict-list">
        {open.map((c) => (
          <article key={c.id} className="conflict-card">
            <div className="conflict-head">
              <Tag color="volcano">{TYPE_LABELS[c.type] ?? c.type}</Tag>
              <b>{c.targetTitle}</b>
              <small>
                {c.actor} · 序号 {c.seq} · {format(new Date(c.createdAt), "HH:mm:ss")}
              </small>
            </div>
            <p className="conflict-reason">{c.reason}</p>
            <table className="diff-table">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>对方已确认（保留）</th>
                  <th>我方后到（挂起）</th>
                </tr>
              </thead>
              <tbody>
                {c.diff.map((d) => (
                  <tr key={d.field}>
                    <td>{d.label}</td>
                    <td className="diff-before">{fmt(d.before)}</td>
                    <td className="diff-after">{fmt(d.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="conflict-actions">
              <Button onClick={() => onResolve(c.id, "take-theirs")}>采用对方确认版</Button>
              <Button type="primary" danger onClick={() => onResolve(c.id, "keep-mine")}>
                保留我方版本并重算
              </Button>
            </div>
          </article>
        ))}
      </div>
    </Card>
  );
}
