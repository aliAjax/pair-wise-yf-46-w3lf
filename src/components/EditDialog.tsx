import { useEffect } from "react";
import { Form, Input, InputNumber, Modal, Select } from "antd";
import type { ItemType, Role, RundownItem } from "../types";
import { allowedFields, fieldLabel } from "../domain/permissions";

export interface EditSubmit {
  id: string;
  baseVersion: number;
  fields: Partial<RundownItem>;
}

interface Props {
  item: RundownItem | null;
  role: Role;
  onClose: () => void;
  onSubmit: (values: EditSubmit) => void;
}

const TYPES: ItemType[] = ["新闻片", "连线", "嘉宾", "口播", "广告"];

export function EditDialog({ item, role, onClose, onSubmit }: Props) {
  const [form] = Form.useForm();
  const fields = allowedFields(role);

  useEffect(() => {
    if (item) form.setFieldsValue({ title: item.title, type: item.type, duration: item.duration, hardStart: item.hardStart, presenter: item.presenter, source: item.source, lowerThird: item.lowerThird });
  }, [item, form]);

  if (!item) return null;

  const submit = () => {
    const values = form.getFieldsValue() as Partial<RundownItem>;
    const changed: Partial<RundownItem> = {};
    for (const field of fields) {
      const rawNext = values[field] as string | number | undefined;
      const next: string | number | undefined = field === "hardStart" ? (rawNext ? String(rawNext) : undefined) : rawNext;
      const current = item[field] as string | number | undefined;
      if (String(next ?? "") !== String(current ?? "")) {
        changed[field] = next as never;
      }
    }
    if (Object.keys(changed).length) onSubmit({ id: item.id, baseVersion: item.version, fields: changed });
    onClose();
  };

  return (
    <Modal open title={`编辑段落「${item.title}」 · ${role}权限（基线 v${item.version}）`} onCancel={onClose} onOk={submit} okText="提交修改（携带版本号）" cancelText="取消">
      <Form form={form} layout="vertical">
        {fields.includes("title") && <Form.Item label={fieldLabel("title")} name="title"><Input /></Form.Item>}
        {fields.includes("type") && <Form.Item label={fieldLabel("type")} name="type"><Select options={TYPES.map((value) => ({ value, label: value }))} /></Form.Item>}
        {fields.includes("duration") && <Form.Item label={fieldLabel("duration")} name="duration"><InputNumber min={1} max={180} addonAfter="分钟" /></Form.Item>}
        {fields.includes("hardStart") && <Form.Item label={fieldLabel("hardStart") + "（HH:mm，可空）"} name="hardStart"><Input placeholder="08:30" /></Form.Item>}
        {fields.includes("presenter") && <Form.Item label={fieldLabel("presenter")} name="presenter"><Input /></Form.Item>}
        {fields.includes("source") && <Form.Item label={fieldLabel("source")} name="source"><Input /></Form.Item>}
        {fields.includes("lowerThird") && <Form.Item label={fieldLabel("lowerThird")} name="lowerThird"><Input.TextArea rows={2} /></Form.Item>}
      </Form>
      <small className="form-hint">提交携带读到的 v{item.version}；若已有另一岗位先确认，本次修改会进入冲突清单而不是覆盖。</small>
    </Modal>
  );
}
