import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Tag, Tooltip } from "antd";
import type { RundownItem } from "../types";

interface Props {
  item: RundownItem;
  cumulative: string;
  risk: boolean;
  canDrag: boolean;
  canDuration: boolean;
  canStatus: boolean;
  canSkip: boolean;
  onDuration: (delta: number) => void;
  onStatus: () => void;
  onSkip: () => void;
}

export function SortableItem({
  item,
  cumulative,
  risk,
  canDrag,
  canDuration,
  canStatus,
  canSkip,
  onDuration,
  onStatus,
  onSkip,
}: Props) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: item.id,
    disabled: !canDrag || item.status === "已播出",
  });
  return (
    <article
      ref={setNodeRef}
      className={`rundown-row status-${item.status}${risk ? " row-risk" : ""}${
        item.syncState === "pending" ? " row-pending" : ""
      }`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button className="drag-handle" {...attributes} {...listeners} disabled={!canDrag}>
        ⠿
      </button>
      <time>{cumulative}</time>
      <div className="row-main">
        <b>
          {item.title}
          {risk && <Tag color="red" className="risk-tag">硬时间风险</Tag>}
          {item.syncState === "pending" && <Tag color="orange" className="risk-tag">待回连</Tag>}
          {item.syncState === "conflict" && <Tag color="volcano" className="risk-tag">冲突挂起</Tag>}
        </b>
        <small>
          {item.source} · {item.presenter} · v{item.version} · {item.updatedBy}
        </small>
      </div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : "geekblue"}>{item.type}</Tag>
      <span>{item.duration} 分钟</span>
      {item.hardStart && <span className="hardstart">硬时间 {item.hardStart}</span>}
      <Tag color={item.status === "已播出" ? "green" : item.status === "已跳过" ? "red" : "default"}>
        {item.status}
      </Tag>
      <div className="row-actions">
        <Tooltip title={canDuration ? "减少时长" : "当前岗位无权调整时长"}>
          <Button size="small" disabled={!canDuration} onClick={() => onDuration(-1)}>
            -1
          </Button>
        </Tooltip>
        <Tooltip title={canDuration ? "增加时长" : "当前岗位无权调整时长"}>
          <Button size="small" disabled={!canDuration} onClick={() => onDuration(1)}>
            +1
          </Button>
        </Tooltip>
        <Tooltip title={canStatus ? "确认播出" : "仅导播/演播室可确认播出"}>
          <Button size="small" type="primary" disabled={!canStatus || item.status === "已播出"} onClick={onStatus}>
            播出
          </Button>
        </Tooltip>
        <Tooltip title={canSkip ? "取消条目" : "当前岗位无权取消"}>
          <Button size="small" danger disabled={!canSkip || item.status === "已播出"} onClick={onSkip}>
            取消
          </Button>
        </Tooltip>
      </div>
    </article>
  );
}
