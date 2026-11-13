import assert from "node:assert/strict";
import test from "node:test";
import { createConversationPreparer, filterToolHint } from "../src/tools/conversationHints";
import { buildAskUserHint, ASK_USER_TOOL } from "../src/tools/askUser";
import { buildMountedToolsHint } from "../src/tools/catalog";
import { buildBoundSkillsHint, buildSkillHint, buildSkillInstruction, buildSkillToolWarning } from "../src/skills/invoke";
import { buildSshToolsHint } from "../src/tools/ssh";
import { READ_SKILL_TOOL } from "../src/skills/tool";
import type { ChatMessage } from "../src/model/client";
import type { SkillItem, SshHost } from "../src/app/types";

const skill = { id: "domain", name: "领域技能", description: "处理领域数据", body: "使用 ask_user 确认后继续", files: ["reference.md"] } as SkillItem;

test("首轮追问提示在后续轮和无工具结论轮被替换，静态规则与图追加说明保留", () => {
  const prepare = createConversationPreparer((tools) => [
    tools.length ? buildMountedToolsHint(tools) : "本轮没有可调用的工具",
    buildAskUserHint(tools.some((tool) => tool.function.name === "ask_user")),
    buildSkillToolWarning(skill.body, { mounted: new Set(tools.map((tool) => tool.function.name)), known: new Set(["ask_user"]) }),
  ].join("\n"));
  const original: ChatMessage[] = [{ role: "system", content: "静态项目规则" }, { role: "user", content: "任务" }];
  const first = prepare(original, [ASK_USER_TOOL]);
  assert.match(String(first[0].content), /调用 ask_user/);
  assert.doesNotMatch(String(first[0].content), /工具名校验/);
  const next = prepare([...first, { role: "system", content: "图节点角色" }], []);
  const text = String(next[0].content);
  assert.match(text, /本轮不再提供 ask_user/);
  assert.match(text, /工具名校验/);
  assert.doesNotMatch(text, /一次提交 1-3/);
  assert.match(text, /静态项目规则/);
  assert.match(text, /图节点角色/);
  assert.equal(next.filter((message) => message.role === "system").length, 1);
  assert.deepEqual(prepare(next, []), next);
  assert.equal(original.length, 2);
  assert.equal((text.match(/本轮动态工具提示开始/g) ?? []).length, 1);
});

test("部分能力白名单不会宣告未挂载的同类工具", () => {
  const hint = "使用 read_file 读取。使用 search_code 定位；使用 apply_patch 修改。";
  assert.equal(filterToolHint(hint, new Set(["read_file"]), new Set(["read_file", "search_code", "apply_patch"])), "使用 read_file 读取。");
});

test("技能对闲聊免读、领域任务强制，正文不宣告本轮缺失的读取能力", () => {
  assert.match(buildSkillHint(), /闲聊.*无需读取技能目录或正文/);
  assert.match(buildSkillHint(), /相关领域技能必须先读取并严格遵循/);
  assert.match(READ_SKILL_TOOL.function.description, /已知对应技能名时直接传 name/);
  assert.match(READ_SKILL_TOOL.function.description, /只有无法判断是否有匹配技能时才不传参数查目录/);
  assert.doesNotMatch(READ_SKILL_TOOL.function.description, /先不传参数调用一次/);
  assert.match(buildBoundSkillsHint([skill]), /必须先调用 read_skill/);
  const instruction = buildSkillInstruction(skill, "", false);
  assert.match(instruction, /本轮未提供 read_skill/);
  assert.doesNotMatch(instruction, /如需查阅其他技能可调用|需要其中的内容时调用/);
});

test("SSH 提示只暴露主机标识和名称，不承诺每次人工审批", () => {
  const host = { id: "production", name: "生产环境运维", host: "192.0.2.87", username: "secretAdmin", port: 22487, enabled: true } as SshHost;
  const hint = buildSshToolsHint([host]);
  assert.match(hint, /production｜生产环境运维/);
  for (const secret of [host.host, host.username, String(host.port)]) assert.ok(!hint.includes(secret));
  assert.match(hint, /可能自动批准、拒绝或要求人工确认/);
  assert.doesNotMatch(hint, /每次远程操作都会弹出人工审批/);
  assert.equal(buildSshToolsHint([{ ...host, enabled: false }]), "");
});
