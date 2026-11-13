/** 桌面适配层：skills。运行环境差异在此处理，界面只调用公开函数。 */
import { BROWSER_SKILLS, browserReadSkill } from "../../skills/fallback";
import { type SkillItem, type SkillReadResult } from "../types";
import { isDesktopRuntime } from "./runtime";

/* ============================ 技能 ============================ */

/**
 * 扫描技能目录并刷新技能索引：技能统一放在缓存目录下的 `skills/<技能名>/SKILL.md`，
 * 索引写入缓存目录根部的 `SKILLS.md`。
 *
 * 桌面端走 Rust 命令读取本地文件；浏览器演示环境无法读盘，返回内置样例技能。
 */
export async function scanSkills(cachePath: string | null): Promise<SkillItem[]> {
  if (!cachePath) return [];
  if (!isDesktopRuntime()) return BROWSER_SKILLS;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SkillItem[]>("scan_skills", { cacheDir: cachePath });
}

export interface SkillInput {
  id: string;
  name: string;
  description: string;
  body: string;
  overwrite: boolean;
}

export interface SkillUpdateInput extends SkillInput {
  originalId: string;
}

export interface SkillImportInput {
  sourceDir: string;
  id: string | null;
  overwrite: boolean;
}

/** 技能生命周期管理的前置检查（开发者 Jan）：这些命令要在本机建目录、删目录，浏览器环境直接拒绝 */
export function requireDesktopSkills(): void {
  if (!isDesktopRuntime()) throw new Error("技能本地生命周期管理仅在桌面端可用，请在桌面端运行。");
}

/** 新建技能（开发者 Jan）：在缓存目录下建 `skills/<id>/SKILL.md` 并重建索引，返回最新技能列表 */
export async function createSkill(cachePath: string | null, input: SkillInput): Promise<SkillItem[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法创建技能。");
  requireDesktopSkills();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SkillItem[]>("create_skill", { cacheDir: cachePath, input });
}

/**
 * 更新技能（开发者 Jan）。
 *
 * 带上 `originalId` 是为了支持改 id：Rust 侧先校验新 id 合法、再改名目录，
 * 校验不过时保留原目录，避免出现「旧目录已删、新目录没建成」的空窗。
 */
export async function updateSkill(cachePath: string | null, input: SkillUpdateInput): Promise<SkillItem[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法更新技能。");
  requireDesktopSkills();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SkillItem[]>("update_skill", { cacheDir: cachePath, input });
}

/** 删除技能（开发者 Jan）：连带删除其目录并重建索引，返回删除后的技能列表 */
export async function deleteSkill(cachePath: string | null, id: string): Promise<SkillItem[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法删除技能。");
  requireDesktopSkills();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SkillItem[]>("delete_skill", { cacheDir: cachePath, input: { id } });
}

/**
 * 从本机目录导入技能（开发者 Jan）：把用户选中的目录复制成 `skills/<id>/`。
 *
 * `id` 传 null 表示沿用源目录名；`overwrite` 为 false 时遇到同名技能会报错，
 * 让用户先确认覆盖，而不是悄悄换掉已有技能。
 */
export async function importSkill(cachePath: string | null, input: SkillImportInput): Promise<SkillItem[]> {
  if (!cachePath) throw new Error("尚未配置缓存目录，无法导入技能。");
  requireDesktopSkills();
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SkillItem[]>("import_skill", { cacheDir: cachePath, input });
}

/**
 * 读取技能：`name` 为空时返回技能索引（SKILLS.md 内容），否则返回该技能的 SKILL.md 全文。
 *
 * 用于模型的 `read_skill` 工具，失败原因作为可读文本返回而非抛出，便于模型自行纠错。
 */
export async function readSkill(
  cachePath: string | null,
  name: string | null,
  file: string | null = null,
): Promise<SkillReadResult> {
  if (!cachePath) {
    return { ok: false, output: "尚未配置缓存目录，无法读取技能。" };
  }
  if (!isDesktopRuntime()) return browserReadSkill(name, file);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const output = await invoke<string>("read_skill", { cacheDir: cachePath, name, file });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}
