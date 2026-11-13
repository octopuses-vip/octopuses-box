import type { Message } from "../app/types";

/** 函数级说明（开发者 Jan）：执行 prepareRegeneration 的单一职责，并返回可供调用方继续处理的结果。 */
export function prepareRegeneration(messages: Message[], userId: string) {
  const index = messages.findIndex((m) => m.id === userId && m.role === "user");
  if (index < 0 || messages.slice(index + 1).some((m) => m.role === "user")) throw new Error("只能重新生成最后一轮回答");
  const user = messages[index];
  const previous = messages.slice(index + 1).map(({ answerVersions: _versions, ...m }) => m);
  return { prefix: messages.slice(0, index), versions: [...(user.answerVersions ?? []), ...(previous.length ? [{ id: previous[0].id, messages: previous }] : [])] };
}

/** 函数级说明（开发者 Jan）：执行 selectAnswerVersion 的单一职责，并返回可供调用方继续处理的结果。 */
export function selectAnswerVersion(messages: Message[], userId: string, versionId: string): Message[] {
  const index = messages.findIndex((m) => m.id === userId && m.role === "user");
  if (index < 0 || messages.slice(index + 1).some((m) => m.role === "user")) return messages;
  const user = messages[index];
  const version = user.answerVersions?.find((v) => v.id === versionId);
  if (!version) return messages;
  const current = messages.slice(index + 1).map(({ answerVersions: _versions, ...m }) => m);
  const alternatives = (user.answerVersions ?? []).filter((v) => v.id !== versionId);
  if (current.length) alternatives.push({ id: current[0].id, messages: current });
  return [...messages.slice(0, index), { ...user, answerVersions: alternatives }, ...version.messages];
}
