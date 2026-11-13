import type { ConfirmFn } from "../components/ConfirmProvider";

/**
 * 常用确认场景的语义化封装（开发者 Jan）。
 *
 * 「覆盖」与「删除」在各资源页面反复出现，措辞与危险等级集中在这里，
 * 调用方只交代「对象是谁」，避免同一个动作在不同页面写出不一样的提示语。
 */

/** 覆盖确认：目标同名资源已存在，询问是否覆盖（开发者 Jan） */
export function confirmOverwrite(confirm: ConfirmFn, target: string): Promise<boolean> {
  return confirm({
    title: "覆盖确认",
    message: `${target}已存在，确认覆盖吗？`,
    confirmText: "覆盖",
  });
}

/** 删除确认：不可撤销，确认按钮标红防误触（开发者 Jan） */
export function confirmDelete(confirm: ConfirmFn, target: string, name: string): Promise<boolean> {
  return confirm({
    title: "删除确认",
    message: `确认删除${target}「${name}」吗？此操作不可撤销。`,
    confirmText: "删除",
    danger: true,
  });
}
