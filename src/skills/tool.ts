/**
 * `read_skill` 工具（开发者 Jan）：把技能索引与技能正文以「模型可自行读取」的方式暴露出去。
 *
 * 已知技能名直接读取正文；只有无法判断匹配技能时才先读目录（索引）。
 */

import { readSkill } from "../app/desktop/skills";
import type { SkillReadResult } from "../app/types";
import type { ChatTool } from "../model/client";
import { buildSkillToolWarning, type SkillToolScope } from "./invoke";

/** 工具名，与模型返回的 function.name 对应 */
export const READ_SKILL_TOOL_NAME = "read_skill";

/**
 * `read_skill` 的工具定义。
 *
 * `file` 这一档是给「技能自带参考文档」留的口子：技能导入时整目录复制，
 * `DB_DOC.MD`、字段字典这类文档就躺在 `skills/<技能>/` 里，但正文只注入 `SKILL.md`。
 * 没有这个参数，模型只知道「技能里应该包含」，却没有任何工具能读到它——
 * 工作区工具的作用域是项目根，压根够不到缓存目录。
 */
export const READ_SKILL_TOOL: ChatTool = {
  type: "function",
  function: {
    name: READ_SKILL_TOOL_NAME,
    description:
      "读取技能（Skill）的说明。已知对应技能名时直接传 name 读取完整正文，无需先读目录；" +
      "只有无法判断是否有匹配技能时才不传参数查目录，随后严格按匹配技能的说明完成任务。" +
      "技能目录若自带参考文档（技能目录里会列出），再传 file 传入该文档的相对路径即可读取其全文。",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "技能名，取自技能目录；省略或留空时返回技能目录本身。",
        },
        file: {
          type: "string",
          description:
            "技能目录内参考文档的相对路径（如 DB_DOC.MD），需同时传 name；" +
            "只能读该技能目录内的文件，不能包含 .. 或绝对路径。",
        },
      },
      required: [],
    },
  },
};

/**
 * 执行一次 `read_skill`（开发者 Jan）。
 *
 * 容错优先：参数不是合法 JSON、技能名不存在都作为可读文本返回，让模型自行纠错重试。
 *
 * `toolScope` 是本轮的工具表快照：技能正文是用户/第三方写的，里面提到的工具名可能来自别的
 * 客户端，也可能本轮压根没挂出来。读到正文就顺手比对并追加告警，否则模型只能照抄正文、撞一次
 * 「当前不支持的工具」，再自行下结论「我这边没有这个工具」去委派子代理绕路。
 */
export async function runReadSkillTool(
  cachePath: string | null,
  argumentsJson: string,
  toolScope: SkillToolScope | null = null,
): Promise<SkillReadResult> {
  let name: string | null = null;
  let file: string | null = null;
  const raw = argumentsJson.trim();
  if (raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as { name?: unknown; file?: unknown };
      if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
        name = parsed.name.trim();
      }
      if (typeof parsed.file === "string" && parsed.file.trim().length > 0) {
        file = parsed.file.trim();
      }
    } catch {
      return {
        ok: false,
        output:
          '工具参数不是合法 JSON，请按 {"name": "技能名"} 调用；不传参数则返回技能目录，' +
          '需要该技能自带的参考文档时再补一个 "file": "文档相对路径"。',
      };
    }
  }
  const result = await readSkill(cachePath, name, file);
  // 只有读正文时才比对：读目录时输出的是技能清单，里面没有工具名
  if (toolScope !== null && name !== null && file === null && result.ok) {
    const warning = buildSkillToolWarning(result.output, toolScope);
    if (warning.length > 0) return { ...result, output: `${result.output}\n\n${warning}` };
  }
  return result;
}