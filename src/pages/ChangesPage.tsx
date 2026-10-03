import { Card, Empty, Tag, Timeline } from "antd";
import { format } from "date-fns";
import { useAppSelector } from "../store/hooks";

export function ChangesPage() {
  const changes = useAppSelector((s) => s.ledger.changes);
  return (
    <Card title="突发变更记录">
      {changes.length ? (
        <Timeline
          items={changes.map((item) => ({
            children: (
              <div>
                <b>{item.headline}</b>
                <p>
                  <Tag color="red">插播 {item.duration} 分钟</Tag>
                  <Tag>序号 #{item.seq}</Tag>
                </p>
                <small>
                  {item.reason} · {format(new Date(item.createdAt), "HH:mm:ss")} 入账
                </small>
              </div>
            ),
          }))}
        />
      ) : (
        <Empty description="还没有突发插播入账" />
      )}
    </Card>
  );
}
