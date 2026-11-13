import type { SkillItem, SkillReadResult } from "../app/types";

/**
 * 浏览器演示环境（vite dev）下的内置技能（开发者 Jan）。
 *
 * 桌面端由 Rust 扫描缓存目录下的 `skills/<技能名>/SKILL.md`，浏览器无法读取本地目录，
 * 这里给两条样例技能，保证技能页、斜杠菜单与 `read_skill` 工具链路可正常演示。
 */
export const BROWSER_SKILLS: SkillItem[] = [
  {
    id: "code-review",
    name: "code-review",
    description: "按团队规范审查 diff，输出结构化问题清单",
    path: "skills/code-review/SKILL.md",
    files: [],
    body: [
      "---",
      "name: code-review",
      "description: 按团队规范审查 diff，输出结构化问题清单",
      "---",
      "",
      "# 代码审查",
      "",
      "1. 逐文件通读 diff，先判断改动是否达成目标。",
      "2. 按「正确性 / 可维护性 / 性能 / 安全」四类找问题，每条给出文件与行号。",
      "3. 只报告能证实的缺陷，不臆测；没有问题就明确说没有问题。",
    ].join("\n"),
  },
  {
    id: "release-notes",
    name: "release-notes",
    description: "根据提交记录生成版本发布说明",
    path: "skills/release-notes/SKILL.md",
    files: [],
    body: [
      "---",
      "name: release-notes",
      "description: 根据提交记录生成版本发布说明",
      "---",
      "",
      "# 发布说明",
      "",
      "1. 按「新增 / 修复 / 优化」三类归并提交记录。",
      "2. 每条一句话说清用户可感知的变化，不写实现细节。",
      "3. 结尾给出升级提示（是否需要迁移、是否破坏兼容）。",
    ].join("\n"),
  },
];

/** 渲染技能索引（开发者 Jan）；格式与桌面端 Rust 生成的 SKILLS.md 一致 */
export function browserSkillIndex(): string {
  if (BROWSER_SKILLS.length === 0) {
    return "# 技能目录\n\n当前没有可用技能。\n";
  }
  const lines = [
    "# 技能目录",
    "",
    `共 ${BROWSER_SKILLS.length} 个可用技能。需要某个技能的完整说明时，调用 read_skill 并传入技能名。`,
    "",
  ];
  for (const skill of BROWSER_SKILLS) {
    lines.push(`## ${skill.name}`);
    lines.push(`- 说明：${skill.description || "（无说明）"}`);
    lines.push(`- 路径：${skill.path}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * 浏览器环境读取技能（开发者 Jan）；`name` 为空返回索引，否则按技能名或目录名精确匹配。
 *
 * 内置样例技能没有参考文档，因此带 `file` 的请求直接返回可读的「没有参考文档」，
 * 与桌面端 `read_skill_file` 的失败文案保持一致，不让演示环境出现另一套语义。
 */
export function browserReadSkill(name: string | null, file: string | null): SkillReadResult {
  const target = name?.trim() ?? "";
  if (target.length === 0) {
    if ((file?.trim() ?? "").length > 0) {
      return { ok: false, output: "读取技能参考文档必须同时传入技能名（name）与文档相对路径（file）。" };
    }
    return { ok: true, output: browserSkillIndex() };
  }
  const matched = BROWSER_SKILLS.find((skill) => skill.name === target || skill.id === target);
  if (matched) {
    if ((file?.trim() ?? "").length > 0) {
      return { ok: false, output: "该技能目录下没有参考文档（只有 SKILL.md）。" };
    }
    return { ok: true, output: matched.body };
  }
  const available = BROWSER_SKILLS.map((skill) => skill.name).join("、") || "（当前没有可用技能）";
  return { ok: false, output: `未找到名为「${target}」的技能。可用技能：${available}` };
}