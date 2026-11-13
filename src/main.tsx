import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles/tokens.css";
/* 颜色全部来自 themes.css：导入顺序必须在 global.css 之前，保证变量先声明后使用 */
import "./styles/themes.css";
import "./styles/global.css";
import "./styles/search.css";

/**
 * 渲染入口（开发者 Jan）：把 `App` 挂到 `index.html` 的 `#root` 上。
 *
 * 样式导入顺序在此固定：tokens → themes → global，后面的文件才能直接引用前面声明的 CSS 变量。
 * `StrictMode` 只在开发环境额外跑一遍副作用，用于暴露未清理的订阅 / 定时器。
 */
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
