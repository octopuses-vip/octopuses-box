import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],

  resolve: {
    // onnxruntime-web 默认入口会把带 jsep（WebGPU）的 wasm 内联成构建资产，
    // 而本项目只用 wasm 后端、且由 env.wasm.wasmPaths 指向 public/cv 下的本地副本，
    // 那份内联资产纯属重复（28MB）。这里启用官方的「外置 wasm」条件入口，让它不再内联，
    // 与 sync-cv-assets 复制的文件、以及 registry 里声明的路径保持一致。
    // 前三个是 Vite 的默认条件，一并列出以免覆盖掉默认解析行为。
    conditions: [
      "module",
      "browser",
      "development|production",
      "onnxruntime-web-use-extern-wasm",
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
