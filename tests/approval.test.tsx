import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PermissionMode, StreamItem, Thread } from "../src/app/types";
import type { ApprovalHost } from "../src/approval/gate";
import { ApprovalCard } from "../src/conversation/blocks/ApprovalCard";

const { useAppStore } = await import("../src/app/state");
const { migratePersistedState } = await import("../src/app/state/persistence");
const { requestApproval } = await import("../src/approval/gate");

const input = { command: "example command", reason: "需要确认", pattern: "example command" };
function setMode(permissionMode: PermissionMode) {
  const thread: Thread = {
    id: "approval-test", title: "审批测试", projectId: "", createdAt: 0, updatedAtLabel: "",
    contextEntries: [], sources: [], executionContext: "local", workspacePath: null,
    worktreePath: null, branch: null, permissionMode, reviewComments: [], agentId: null,
    parentThreadId: null, contextSummary: "", contextCoveredCount: 0,
  };
  useAppStore.setState({ threads: [thread], agents: [], autoApprovalDenylist: [] });
}
function host(wait: ApprovalHost["wait"] = async () => false) {
  const cards: StreamItem[] = [];
  const value: ApprovalHost = {
    threadId: "approval-test", push: (item) => { cards.push(item); },
    patch: (id, update) => {
      const index = cards.findIndex((item) => item.id === id);
      cards[index] = update(cards[index]);
    }, wait,
  };
  return { cards, value };
}

test("升级清理评审偏好，保留缓存路径与撤销名单", () => {
  const state = migratePersistedState({
    autoReviewModel: "old-reviewer", autoReviewMaxPerRun: 5, autoReviewMaxPerSession: 20,
    autoApprovalDenylist: ["old command"], cachePath: "/test/cache", modelSource: "local",
  });
  assert.equal("autoReviewModel" in state, false);
  assert.equal("autoReviewMaxPerRun" in state, false);
  assert.equal(state.cachePath, "/test/cache");
  assert.deepEqual(state.autoApprovalDenylist, ["old command"]);
});

test("三种权限下静态拒绝与白名单均不经过额外模型或人工审批", async () => {
  for (const mode of ["ask", "auto-readonly", "auto-all"] as const) {
    setMode(mode);
    const { value, cards } = host(async () => { throw new Error("不应等待审批"); });
    assert.equal((await requestApproval({ ...input, decision: "deny" }, value)).approved, false);
    assert.equal((await requestApproval({ ...input, decision: "allow" }, value)).approved, true);
    assert.equal(cards.length, 0);
  }
});

test("只读自动与每次询问对未知操作保持等待，用户确认后才放行", async () => {
  for (const mode of ["ask", "auto-readonly"] as const) {
    setMode(mode);
    let decide!: (approved: boolean) => void;
    const waiting = new Promise<boolean>((resolve) => { decide = resolve; });
    const { value, cards } = host(() => waiting);
    const outcome = requestApproval(input, value);
    assert.equal(cards[0].type === "approval" && cards[0].status, "pending");
    decide(true);
    assert.deepEqual(await outcome, { approved: true, auto: false });
    assert.equal(cards[0].type === "approval" && cards[0].status, "approved");
  }
});

test("全部自动保留撤销名单与 Agent 权限收窄", async () => {
  setMode("auto-all");
  const automatic = host();
  assert.deepEqual(await requestApproval(input, automatic.value), { approved: true, auto: true });
  useAppStore.setState({ autoApprovalDenylist: [input.pattern] });
  assert.equal((await requestApproval(input, host().value)).approved, false);
  useAppStore.setState((state) => ({
    autoApprovalDenylist: [], threads: state.threads.map((thread) => ({ ...thread, agentId: "restricted" })),
    agents: [{ id: "restricted", name: "限制", description: "", model: "", tools: [],
      permissionMode: "ask", systemAppend: "", path: "" }],
  }));
  assert.equal((await requestApproval(input, host().value)).approved, false);
});

test("子代理审批镜像同步失效，运行中断继续向上抛出", async () => {
  setMode("auto-readonly");
  const child = host(async () => "expired");
  const parent = host();
  child.value.mirror = parent.value;
  assert.equal((await requestApproval(input, child.value)).expired, true);
  assert.deepEqual(child.cards, parent.cards);
  assert.equal(child.cards[0].type === "approval" && child.cards[0].status, "expired");
  await assert.rejects(requestApproval(input, host(async () => { throw new Error("已停止"); }).value), /已停止/);
});

test("自动放行卡片保留撤销入口，不再声称已经评审为低风险", () => {
  const html = renderToStaticMarkup(createElement(ApprovalCard, {
    command: input.command, reason: "全部自动", status: "approved", auto: true,
    onDecision: () => {}, onRevoke: () => {},
  }));
  assert.match(html, /撤销并改为手动/);
  assert.doesNotMatch(html, /评审|低风险/);
});
