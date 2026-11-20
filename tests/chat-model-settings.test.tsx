import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { useAppStore } from "../src/app/state";
import { ConfirmProvider } from "../src/components/ConfirmProvider";
import { SettingsPage } from "../src/pages/SettingsPage";

for (const modelSource of ["remote", "local"] as const) {
  for (const configured of [true, false]) {
    test(`默认对话模型始终声明 OpenAI 标准接口（${modelSource}，${configured ? "已配置" : "无模型"}）`, () => {
      const before = useAppStore.getState();
      const initial = useAppStore.getInitialState();
      const beforeInitial = { ...initial };
      const beforeWindow = globalThis.window;
      const description = "用于日常问答的模型说明";
      try {
        globalThis.window = {
          matchMedia: () => ({ matches: false }),
        } as unknown as Window & typeof globalThis;
        useAppStore.setState({
          settingsCategory: "models",
          modelSource,
          model: configured ? "chat-test" : "",
          modelOptions: configured
            ? [{ id: "chat-test", label: "测试对话模型", description, supportsImages: false }]
            : [],
          remoteModels: [],
          modelConfigStatus: "ready",
          modelConfigError: null,
        });
        // Server rendering reads Zustand's initial snapshot, not the client state.
        Object.assign(initial, useAppStore.getState());
        const html = renderToStaticMarkup(
          createElement(ConfirmProvider, { children: createElement(SettingsPage) }),
        );
        const start = html.indexOf('<div class="page__section-label">默认对话模型</div>');
        assert(start >= 0);
        const section = html.slice(start, html.indexOf("允许图片输入", start));
        assert.match(section, /OpenAI 标准接口（Chat Completions）/);
        assert.match(section, /POST \/chat\/completions/);
        assert.match(section, /基础地址/);
        assert.match(section, /\/v1/);
        assert.match(section, configured ? new RegExp(description) : /暂无可用对话模型/);
      } finally {
        globalThis.window = beforeWindow;
        Object.assign(initial, beforeInitial);
        useAppStore.setState(before);
      }
    });
  }
}
