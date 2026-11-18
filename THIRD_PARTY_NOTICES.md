# 第三方材料说明

octopuses 使用了若干第三方开源组件、模型与数据资产。本文件列出主要的直接依赖及其许可证，供分发与合规审核参考。

- 各组件仍归其原作者所有，本项目不改变其许可证。
- 以下为直接依赖的主清单；传递依赖保留各自许可证，完整清单可按文末命令生成。
- 若本文件与组件随附的 `LICENSE` 不一致，以组件自身许可证文本为准。

---

## 前端运行时依赖

| 组件 | 版本 | 许可证 | 项目 |
| --- | --- | --- | --- |
| React / React DOM | 19.1.0 | MIT | https://github.com/facebook/react |
| Zustand | 5.x | MIT | https://github.com/pmndrs/zustand |
| react-markdown | 10.x | MIT | https://github.com/remarkjs/react-markdown |
| remark-gfm | 4.x | MIT | https://github.com/remarkjs/remark-gfm |
| pdfjs-dist | 6.4.299 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| three | 0.186.1 | MIT | https://github.com/mrdoob/three.js |
| @xterm/xterm | 6.x | MIT | https://github.com/xtermjs/xterm.js |
| @xterm/addon-fit | 0.11.x | MIT | https://github.com/xtermjs/xterm.js |
| tesseract.js | 7.0.0 | Apache-2.0 | https://github.com/naptha/tesseract.js |
| tesseract.js-core | 6.1.2 | Apache-2.0 | https://github.com/naptha/tesseract.js-core |
| @tesseract.js-data/chi_sim、eng | 1.0.0 | Apache-2.0 | https://github.com/naptha/tessdata |
| onnxruntime-web | 1.30.0 | MIT | https://github.com/microsoft/onnxruntime |
| @huggingface/tokenizers | 0.2.0 | Apache-2.0 | https://github.com/huggingface/tokenizers |
| occt-import-js | 0.23.x | LGPL-2.1 | https://github.com/kovacsv/occt-import-js |
| fflate | 0.8.3 | MIT | https://github.com/101arrowz/fflate |
| @tauri-apps/api | 2.x | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |
| @tauri-apps/plugin-dialog | 2.x | MIT / Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-opener | 2.x | MIT / Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| @tauri-apps/plugin-os | 2.x | MIT / Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |

> `occt-import-js` 以 LGPL-2.1 分发。本项目仅以未修改的依赖形式使用，并以动态加载的 WASM 资产提供；如再分发或修改该组件，请遵守 LGPL-2.1 的相关义务。

---

## Rust 桌面后端依赖

| 组件 | 许可证 | 项目 |
| --- | --- | --- |
| tauri / tauri-build | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |
| tauri-plugin-opener / dialog / os | MIT / Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| serde / serde_json | MIT / Apache-2.0 | https://github.com/serde-rs/serde |
| rusqlite | MIT | https://github.com/rusqlite/rusqlite |
| portable-pty | MIT | https://github.com/wez/wezterm |
| reqwest | MIT / Apache-2.0 | https://github.com/seanmonstar/reqwest |
| mime_guess（音频 multipart 上传的传递依赖） | MIT | https://github.com/abonander/mime_guess |
| unicase（mime_guess 的传递依赖） | MIT / Apache-2.0 | https://github.com/seanmonstar/unicase |
| Symphonia 及其解码器 / 容器组件（0.5.5，长录音本地分段） | MPL-2.0 | https://github.com/pdeljanov/Symphonia/tree/v0.5.5 |
| encoding_rs | (Apache-2.0 / MIT) AND BSD-3-Clause | https://github.com/hsivonen/encoding_rs |
| sha2 | MIT / Apache-2.0 | https://github.com/RustCrypto/hashes |
| futures | MIT / Apache-2.0 | https://github.com/rust-lang/futures-rs |
| tokio | MIT | https://github.com/tokio-rs/tokio |
| russh | Apache-2.0 | https://github.com/Eugeny/russh |
| russh-sftp | Apache-2.0 | https://github.com/Eugeny/russh |
| keyring | MIT / Apache-2.0 | https://github.com/hwchen/keyring-rs |
| minisign-verify | MIT | https://github.com/jedisct1/rust-minisign-verify |

Symphonia 以未修改的 0.5.5 版本使用，原始源码可从上表项目链接获取；许可证全文见 [Symphonia-MPL-2.0.txt](THIRD_PARTY_LICENSES/Symphonia-MPL-2.0.txt)，并随桌面应用资源分发。

---

## 命令行工具 ots-cli 依赖

| 组件 | 许可证 |
| --- | --- |
| anyhow、thiserror | MIT / Apache-2.0 |
| async-trait、serde_yaml | MIT / Apache-2.0 |
| chrono、uuid | MIT / Apache-2.0 |
| clap | MIT / Apache-2.0 |
| serde、serde_json、toml、dirs | MIT / Apache-2.0 |
| tokio、tokio-util | MIT |
| tracing、tracing-subscriber | MIT |
| futures-util | MIT / Apache-2.0 |
| globset | Unlicense / MIT |
| jsonschema | MIT |
| similar | Apache-2.0 |

> `ots-cli/` 是独立的 Cargo workspace，其 `Cargo.lock` 记录了完整的传递依赖版本。

---

## 模型与数据资产

| 资产 | 许可证 | 说明 |
| --- | --- | --- |
| BGE-small-zh-v1.5（INT8 ONNX + 分词器） | MIT | BAAI 发布；运行时由用户手动下载到应用数据目录，不随安装包分发 |
| YOLOX-nano（`yolox_nano.onnx`） | Apache-2.0 | Megvii-BaseDetection 发布；构建期由 `pnpm cv:assets` 下载到 `public/cv/`，不进入版本库 |
| Tesseract OCR 语言数据（chi_sim、eng） | Apache-2.0 | 构建期从 npm 依赖复制到 `public/cv/` |

模型与数据资产的来源、版本与校验值分别记录在：

- 知识库模型：[src/knowledge/model-manifest.json](src/knowledge/model-manifest.json)
- CV 资产生成脚本：[scripts/sync-cv-assets.mjs](scripts/sync-cv-assets.mjs)

---

## 生成完整依赖清单

```bash
# 前端依赖（含传递依赖）
pnpm licenses list

# 桌面端 Rust 依赖
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1

# ots-cli 依赖
cargo metadata --manifest-path ots-cli/Cargo.toml --format-version 1
```

如需在发行物中附带完整许可证文本，可使用 `cargo about`、`cargo deny` 或 `pnpm licenses list --json` 在构建阶段生成。

---

最后更新：2026-11-13（对应 octopuses v0.47.81）


## Bundled companion runtime

Desktop bundles include the build machine's platform-matched Node.js runtime (Node.js project and contributors, MIT, with additional third-party components). The complete license from that exact Node distribution is included as `runtime/NODE-LICENSE.txt` in the application resources. `scripts/prepare-runtime.mjs` requires this license when preparing a release.
