import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Tag, Tooltip } from "antd";
import type { HardRisk, Role, RundownItem } from "../types";
import { canPerform } from "../domain/permissions";

interface Props {
  item: RundownItem;
  cumulative: string;
  role: Role;
  risk?: HardRisk;
  onDuration: (delta: number) => void;
  onEdit: () => void;
  onStatus: () => void;
  onSkip: () => void;
}

export function SortableItem({ item, cumulative, role, risk, onDuration, onEdit, onStatus, onSkip }: Props) {
  const locked = item.status === "已播出";
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id, disabled: locked || !canPerform(role, "reorder") });
  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status} ${item.stale ? "is-stale" : ""} ${risk ? "is-risk" : ""}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button className="drag-handle" {...attributes} {...listeners} disabled={locked || !canPerform(role, "reorder")}>⠿</button>
      <time>{cumulative}</time>
      <div className="row-main">
        <b>{item.title} {item.breakingId && <Tag color="volcano">突发</Tag>}</b>
        <small>{item.source} · {item.presenter}{item.lowerThird ? ` · 字幕：${item.lowerThird}` : ""}</small>
        {item.staleReason && <small className="stale-reason">⚠ {item.staleReason}</small>}
      </div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : "geekblue"}>{item.type}</Tag>
      <span>{item.duration} 分钟</span>
      <div className="status-stack">
        <Tag color={locked ? "green" : item.status === "已跳过" ? "red" : item.stale ? "orange" : "default"}>
          {locked ? "已播出留档" : item.stale ? "待重算确认" : item.status}
        </Tag>
        <Tooltip title="段落版本：后到修改携带旧版本会记为冲突，不覆盖本版本">
          <Tag className="version-tag">v{item.version}</Tag>
        </Tooltip>
      </div>
      <div className="risk-stack">
        {item.hardStart && <Tag color={risk ? "red" : "default"}>硬 {item.hardStart}</Tag>}
        {risk && <Tag color="red">晚点 {risk.overrunMinutes}′</Tag>}
      </div>
      <div className="row-actions">
        {canPerform(role, "editItem") && !locked && (
          <Tooltip title={role === "导播" ? "调整时长" : role === "字幕" ? "改字幕条" : role === "演播室" ? "改主播/来源" : "改编排字段"}>
            <Button size="small" onClick={onEdit}>编辑</Button>
          </Tooltip>
        )}
        {role === "导播" && !locked && <>
          <Button size="small" onClick={() => onDuration(-1)}>-1</Button>
          <Button size="small" onClick={() => onDuration(1)}>+1</Button>
          <Button size="small" type="primary" disabled={item.status === "已跳过"} onClick={onStatus}>播出</Button>
          <Button size="small" danger disabled={item.status === "已跳过"} onClick={onSkip}>取消</Button>
        </>}
      </div>
    </article>
  );
}
