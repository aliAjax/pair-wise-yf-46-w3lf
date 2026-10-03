import { Button, Card, Empty, Tag, Timeline } from "antd";
import type { ConflictRecord, Role } from "../types";

interface Props {
  conflicts: ConflictRecord[];
  role: Role;
  onResolve: (conflictId: string, resolution: "confirmed" | "incoming") => void;
}

function fmt(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

export function ConflictPanel({ conflicts, role, onResolve }: Props) {
  const open = conflicts.filter((conflict) => conflict.status === "open");
  return (
    <Card className="conflict-card" title={<span>并发冲突 <Tag color={open.length ? "red" : "default"}>{open.length} 待裁决</Tag></span>}>
      {open.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有未裁决冲突：所有后到修改都已处理" /> : (
        <div className="conflict-list">
          {open.map((conflict) => (
            <article key={conflict.id} className="conflict-item">
              <header>
                <b>{conflict.itemTitle}</b>
                <Tag color="orange">{conflict.type}</Tag>
                <Tag>{conflict.station} · {conflict.actor}</Tag>
                <small>{fmt(conflict.at)} · 后到基于 v{conflict.incomingBaseVersion}，已确认到 v{conflict.confirmedVersion}</small>
              </header>
              <table className="diff-table">
                <thead><tr><th>字段</th><th>先确认版本（不可被覆盖）</th><th>后到修改（待裁决）</th></tr></thead>
                <tbody>
                  {conflict.differences.map((diff) => (
                    <tr key={diff.field}><td>{diff.label}</td><td className="confirmed-cell">{String(diff.confirmedValue ?? "—")}</td><td className="incoming-cell">{String(diff.incomingValue ?? "—")}</td></tr>
                  ))}
                </tbody>
              </table>
              {role === "导播" ? (
                <div className="conflict-actions">
                  <Button onClick={() => onResolve(conflict.id, "confirmed")}>保留先确认版本</Button>
                  <Button type="primary" onClick={() => onResolve(conflict.id, "incoming")}>采用后到修改</Button>
                </div>
              ) : <small className="form-hint">仅导播可裁决冲突；后到修改已安全保留，不会丢失。</small>}
            </article>
          ))}
        </div>
      )}
      {conflicts.some((item) => item.status === "resolved") && (
        <Timeline className="resolved-list" items={conflicts.filter((item) => item.status === "resolved").map((item) => ({
          color: item.resolution === "incoming" ? "blue" : "gray",
          children: <div><b>{item.itemTitle}</b><p>裁决：{item.resolution === "incoming" ? "采用后到修改" : "保留先确认版本"} · {item.resolvedBy} · {item.resolvedAt ? fmt(item.resolvedAt) : ""}</p></div>
        }))} />
      )}
    </Card>
  );
}
