import assert from "node:assert/strict";
import test from "node:test";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { useAppStore } from "../src/app/state";
import { effectiveArtifactDir, resolveMarkdownLinkTarget } from "../src/app/state/artifacts";
import type { ArtifactInfo, Thread } from "../src/app/types";

const htmlFile: ArtifactInfo = { name: "spider-spirit-bike.html", kind: "text", bytes: 40, modifiedAt: 1 };
const page = "<h1>自行车页面</h1>";

test("文件链接识别产物引用与受限工作区路径", () => {
  const context = {
    artifacts: [htmlFile, { ...htmlFile, name: "报告 #2.html" }],
    workspacePath: "/project",
    artifactDir: "/project/output",
  };
  const resolve = (href: string) => resolveMarkdownLinkTarget(href, context);
  const expected = { kind: "artifact", dir: context.artifactDir, name: htmlFile.name };
  for (const href of [
    htmlFile.name, "./output/spider-spirit-bike.html", "/project/output/spider-spirit-bike.html",
    "file:///project/output/spider-spirit-bike.html", "sandbox:/mnt/data/spider-spirit-bike.html",
  ]) assert.deepEqual(resolve(href), expected);
  assert.equal(resolve("output/%E6%8A%A5%E5%91%8A%20%232.html?view=1#page")?.kind, "artifact");
  assert.deepEqual(resolve("./src/app.ts"), { kind: "workspace", projectPath: "/project", path: "src/app.ts" });
  for (const href of [
    "https://example.com/page.html", "#page", "file://host/project/output/spider-spirit-bike.html",
    "sandbox:/mnt/data/unknown.html", "/project-other/file.html", "output/%2e%2e/%2e%2e/file.html",
  ]) assert.equal(resolve(href), null, href);
});

test("冷启动会话能从正文链接选中准确的 HTML，失效链接给出反馈", { timeout: 2000 }, async (t) => {
  const previous = globalThis.window;
  globalThis.window = { crypto: globalThis.crypto } as Window & typeof globalThis;
  t.after(() => {
    clearMocks();
    if (previous) globalThis.window = previous;
    else Reflect.deleteProperty(globalThis, "window");
  });
  const id = "link-test";
  const thread: Thread = {
    id, title: "链接测试", projectId: "", createdAt: 1, updatedAtLabel: "",
    contextEntries: [], sources: [], executionContext: "local", workspacePath: null,
    worktreePath: null, branch: null, permissionMode: "auto-readonly", reviewComments: [],
    agentId: null, parentThreadId: null, contextSummary: "", contextCoveredCount: 0,
  };
  const errors: string[] = [];
  useAppStore.setState({
    threads: [thread], activeThreadId: id, cachePath: "/fixture-cache",
    artifacts: [], activeArtifact: null, artifactStatus: "idle", rightPanelOpen: false,
    showNotice: (text) => errors.push(text),
  });
  const artifactDir = effectiveArtifactDir(useAppStore.getState());
  const calls: string[] = [];
  mockIPC((command, args) => {
    calls.push(command);
    assert.equal((args as { dir: string }).dir, artifactDir);
    if (command === "artifact_list") return [{ ...htmlFile, name: "other.html", modifiedAt: 2 }, htmlFile];
    if (command === "artifact_read") {
      assert.equal((args as { name: string }).name, htmlFile.name);
      return page;
    }
    assert.fail(`unexpected ${command}`);
  });

  const opened = new Promise<void>((done) => {
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.rightPanelOpen) { unsubscribe(); done(); }
    });
  });
  const { openMarkdownLink } = useAppStore.getState();
  assert.equal(openMarkdownLink("https://example.com/"), false);
  assert.equal(openMarkdownLink(htmlFile.name), true);
  await opened;
  assert.equal(useAppStore.getState().rightTab, "web");
  assert.equal(useAppStore.getState().activeArtifact?.name, htmlFile.name);
  assert.equal(useAppStore.getState().activeArtifact?.content, page);
  assert.deepEqual(calls, ["artifact_list", "artifact_read"]);

  const missing = new Promise<string>((done) => useAppStore.setState({ showNotice: done }));
  assert.equal(openMarkdownLink("missing.html"), true);
  assert.match(await missing, /无法打开链接/);
  assert.deepEqual(errors, []);
  assert.equal(useAppStore.getState().activeArtifact?.name, htmlFile.name);
});
