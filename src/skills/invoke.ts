import type { SkillItem } from "../app/types";

/** 显式调用技能的解析结果（开发者 Jan） */
export interface SkillInvocation {
  skill: SkillItem;
  /** 去掉调用标记后的任务描述，可能为空 */
  rest: string;
}

/**
 * 项目绑定技能提示（开发者 Jan）：把本项目绑定的技能逐个点名，并明确「这类任务先读技能」。
 *
 * 只有常驻的 `buildSkillHint`（让人去 `read_skill` 查目录）时，模型并不知道本项目到底绑了哪些
 * 领域技能；遇到 ERP 表结构这类问题，它看不到有对口技能，就默认去联网检索或连远程主机。
 * 这里把绑定技能连同自带参考文档一并列出，让模型在动手前就选对通路。
 */
export function buildBoundSkillsHint(skills: SkillItem[]): string {
  if (skills.length === 0) return "";
  const lines = [
    `本项目已绑定 ${skills.length} 个技能，它们是这些领域任务的权威资料：涉及相关领域时，` +
      "必须先调用 read_skill 取用对应技能并严格按其说明执行，不要默认改用联网检索或远程主机。",
  ];
  for (const skill of skills) {
    const docs =
      skill.files.length > 0
        ? `；自带参考文档：${skill.files.join("、")}（用 read_skill 同时传 name="${skill.id}" 与 file 读取）`
        : "";
    lines.push(`- ${skill.name}：${skill.description.trim() || "（无说明）"}${docs}`);
  }
  return lines.join("\n");
}

/**
 * 解析用户输入中的显式技能调用（开发者 Jan）。
 *
 * 支持两种写法：行首的 `/技能名` 与 `技能名:`，后面可跟同一行的任务描述。
 * 命中条件是该技能名后紧跟空白或行尾（避免 `/code` 误命中 `code-review`）。
 * 未命中任何传入技能时返回 null。
 */
export function parseSkillInvocation(text: string, skills: SkillItem[]): SkillInvocation | null {
  const head = text.trimStart();
  for (const skill of skills) {
    const slash = `/${skill.name}`;
    if (head.startsWith(slash)) {
      const rest = head.slice(slash.length);
      if (rest.length === 0 || /^\s/.test(rest)) return { skill, rest: rest.trim() };
    }
    const colon = `${skill.name}:`;
    if (head.startsWith(colon)) return { skill, rest: head.slice(colon.length).trim() };
  }
  return null;
}

/**
 * 技能提示注入文本（开发者 Jan）：常驻系统消息，告诉模型有 `read_skill` 工具可用。
 *
 * 不含技能清单——清单由模型自行调用 `read_skill`（不传参数）读取技能目录，避免常驻内容过长。
 */
export function buildSkillHint(): string {
  return [
    "闲聊、问候或不涉及技能领域的普通交流无需读取技能目录或正文。",
    "处理具体任务时，先根据已提供的技能名称与描述判断是否匹配；相关领域技能必须先读取并严格遵循，",
    "已知对应技能时直接调用 read_skill 并传 name，无需先读目录；只有无法判断是否有匹配技能时才不传参数查目录。",
    "没有匹配技能时按常规方式处理，不要为完成形式上的检查而重复读取。",
  ].join("");
}

/**
 * 显式调用技能时的注入文本（开发者 Jan）：给出该技能的完整说明。
 *
 * 末尾那句「无需再读」是针对**这一个**技能的：常驻提示在鼓励模型去 `read_skill` 查目录，
 * 若不点明正文已在此处，模型可能白跑一次往返把刚注入的同一份正文再取一遍。只否掉本次显式
 * 调用的技能名，读其他技能的能力照旧保留——技能正文不进历史，跨轮次仍要靠 `read_skill` 找回。
 *
 * `skill.files` 是技能目录里 `SKILL.md` 之外的参考文档（导入时整目录复制进来的字段字典、
 * 表结构文档等）。正文只注入 `SKILL.md`，这些文档不在注入范围内、也不在项目工作区内，
 * 不点名它们模型就完全不知道有；点名了还得同时给出取用方式，否则模型会拿 `read_file` /
 * `search_code` 去够——那两个工具的作用域是项目根，够不到缓存目录下的技能目录。
 *
 * `toolWarning` 是正文与本轮工具表的比对结果（见 `buildSkillToolWarning`），没有需要提醒的
 * 内容时传空串，此时正文原样注入。
 */
export function buildSkillInstruction(skill: SkillItem, toolWarning = "", canReadSkill = true): string {
  const warning = toolWarning.length > 0 ? `\n\n${toolWarning}` : "";
  const docs =
    skill.files.length === 0
      ? ""
      : `\n\n该技能目录还自带 ${skill.files.length} 份参考文档：${skill.files.join("、")}。` +
        (canReadSkill
          ? `需要其中的内容时调用 read_skill，同时传入 name="${skill.id}" 与 file="文档相对路径"。`
          : "本轮未提供 read_skill，无法读取这些参考文档，请说明缺失信息，不要臆造内容。") +
        `这些文档在缓存目录下的技能目录里，不在项目工作区内，read_file 与 search_code 读不到它们。`;
  return (
    `用户显式调用了技能「${skill.name}」，请严格按以下技能说明完成任务。` +
    `该技能的说明已完整给出，无需再次读取它。${canReadSkill ? "如需查阅其他技能可调用 read_skill。" : "本轮没有 read_skill 工具。"}\n\n` +
    skill.body +
    docs +
    warning
  );
}

/** 工具名校验的作用域（开发者 Jan） */
export interface SkillToolScope {
  /** 本轮真正挂进工具表的名字 */
  mounted: Set<string>;
  /** 客户端所有可能挂出的名字（内置工具 + 本轮的 MCP 工具） */
  known: Set<string>;
}

/** 强上下文：中文里明确「调用某个工具」的写法，如「使用 search_code 定位」 */
const STRONG_CONTEXT_PATTERN = /(?:调用|使用|通过|执行)\s*`?([a-z][a-z0-9_]{2,})`?/g;
/** 弱上下文：反引号包住的标识符。文档里的列名、字段名也常这么写，需要再收窄 */
const CODE_SPAN_PATTERN = /`([a-z][a-z0-9_]{2,})`/g;
/** 任意 snake_case 标识符：只在它恰好是已知工具名时才采信，这个词表很小、不会误判 */
const IDENTIFIER_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
/**
 * 调用写法：`search_content(pattern=...)`。技能正文常直接抄别的客户端的调用示例，没有中文上下文。
 * 这里同样要求带下划线——本客户端的工具名全是多段 snake_case，这样 `for (`、`print(` 这类
 * 代码示例里的关键字不会被当成工具名误报。
 */
const CALL_PATTERN = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\(/g;

/** 已知工具名的动词前缀集合，用来把弱上下文里的候选收窄成「真的像工具名」 */
function knownPrefixes(known: Set<string>): Set<string> {
  const prefixes = new Set<string>();
  for (const name of known) {
    const head = name.split("_")[0];
    if (head.length >= 3) prefixes.add(head);
  }
  return prefixes;
}

/**
 * 技能正文与本轮工具表的交叉校验（开发者 Jan）：返回一段可直接拼在正文后面的告警，
 * 没有需要提醒的内容时返回空串。
 *
 * 技能正文是用户/第三方写的，里面出现的工具名可能来自别的客户端（`shell`、`grep`、
 * `db_query`），也可能这个工具本轮根本没挂出来（没选项目就没有 `search_code`，Agent 白名单
 * 也能把它摘掉）。不做比对时，模型只会撞一次「当前不支持的工具」，然后自行下结论
 * 「我这边没有检索工具」，再委派一个工具表完全相同的子代理去绕路——正文照抄、结论照错。
 *
 * 采信分四档，从严到宽，避免把文档里的列名、字段名当成工具名误报：
 * 1. 恰好是已知工具名 → 无条件采信（词表封闭，提到就是提到这个工具）；
 * 2. 出现在「调用/使用/通过/执行 X」这类中文上下文里 → 采信为「客户端没有这个工具」；
 * 3. 写成 `X(...)` 的调用形式 → 采信，正文直接抄了别的客户端的调用示例时没有中文上下文可依赖；
 * 4. 只是反引号包住的标识符 → 还要求它的动词前缀与某个已知工具同名，否则不采信。
 */
export function buildSkillToolWarning(body: string, scope: SkillToolScope): string {
  const prefixes = knownPrefixes(scope.known);
  const unavailable: string[] = [];
  const nonexistent: string[] = [];
  const seen = new Set<string>();

/** 函数级说明（开发者 Jan）：执行 accept 的单一职责，并返回可供调用方继续处理的结果。 */
  const accept = (name: string, trusted: boolean) => {
    if (seen.has(name)) return;
    seen.add(name);
    if (scope.mounted.has(name)) return;
    if (scope.known.has(name)) {
      unavailable.push(name);
      return;
    }
    if (!trusted) {
      const head = name.split("_")[0];
      if (!name.includes("_") || !prefixes.has(head)) return;
    }
    nonexistent.push(name);
  };

  for (const match of body.matchAll(IDENTIFIER_PATTERN)) {
    const name = match[0];
    if (scope.known.has(name) && !scope.mounted.has(name)) accept(name, true);
  }
  for (const match of body.matchAll(STRONG_CONTEXT_PATTERN)) accept(match[1], true);
  for (const match of body.matchAll(CALL_PATTERN)) accept(match[1], true);
  for (const match of body.matchAll(CODE_SPAN_PATTERN)) accept(match[1], false);

  if (unavailable.length === 0 && nonexistent.length === 0) return "";
  const lines = ["【工具名校验】技能正文里提到的工具名与本轮工具表不一致："];
  if (unavailable.length > 0) {
    lines.push(
      `- 客户端有这个工具，但本轮没有挂出来（Agent 工具白名单收窄，或挂载条件不满足）：${unavailable.join("、")}`,
    );
  }
  if (nonexistent.length > 0) {
    lines.push(`- 客户端没有这些工具（可能是别的客户端的工具名，或这里根本执行不了的命令）：${nonexistent.join("、")}`);
  }
  lines.push(
    "请按本轮清单里的实际工具名执行：缺少的能力改用清单内的工具完成，或直接向用户说明缺少什么；" +
      "不要臆造工具名，也不要改用 run_subagent 委派来绕开——子会话的工具表不会比你更宽。",
  );
  return lines.join("\n");
}