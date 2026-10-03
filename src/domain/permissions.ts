import type { ItemFields, Op, Role } from "../types";

/**
 * 岗位调整范围（同一份账本的唯一授权入口，UI 与引擎共用）：
 * - 导播：播出推进、取消跳过、段落时长、顺序调整、突发插播、重算确认、冲突裁决
 * - 主编：编排内容（标题/类型/时长/硬时间）、新增条目，不能动播出推进
 * - 字幕：只能维护字幕条
 * - 演播室：只能维护主播与来源（连线/嘉宾的演播室安排）
 */
const ALLOWED_OPS: Record<Role, Op["type"][]> = {
  导播: ["editItem", "reorder", "updateStatus", "skipItem", "insertBreaking", "acknowledgeRecalc", "resolveConflict"],
  主编: ["addItem", "editItem", "insertBreaking", "acknowledgeRecalc"],
  字幕: ["editItem"],
  演播室: ["editItem"]
};

const FIELD_LABELS: Record<keyof ItemFields, string> = {
  title: "标题",
  type: "类型",
  duration: "时长",
  hardStart: "硬时间",
  presenter: "主播",
  source: "来源",
  lowerThird: "字幕条"
};

const ALLOWED_FIELDS: Record<Role, (keyof ItemFields)[]> = {
  导播: ["duration"],
  主编: ["title", "type", "duration", "hardStart"],
  字幕: ["lowerThird"],
  演播室: ["presenter", "source"]
};

export function fieldLabel(field: keyof ItemFields): string {
  return FIELD_LABELS[field];
}

export function allowedFields(role: Role): (keyof ItemFields)[] {
  return ALLOWED_FIELDS[role];
}

export function canPerform(role: Role, type: Op["type"]): boolean {
  return ALLOWED_OPS[role].includes(type);
}

/** 越权修改直接拒绝：返回拒绝原因，授权通过返回 null */
export function authorize(op: Op): string | null {
  if (!ALLOWED_OPS[op.station].includes(op.type)) {
    return `岗位「${op.station}」无权执行「${op.type}」`;
  }
  if (op.type === "editItem") {
    const fields = Object.keys((op.payload as { fields?: Partial<ItemFields> }).fields ?? {}) as (keyof ItemFields)[];
    const allowed = ALLOWED_FIELDS[op.station];
    const forbidden = fields.filter((field) => !allowed.includes(field));
    if (forbidden.length) {
      return `岗位「${op.station}」无权修改字段：${forbidden.map(fieldLabel).join("、")}`;
    }
    if (!fields.length) return "没有提交任何字段修改";
  }
  return null;
}
