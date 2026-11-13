<p align="center">
  <img src="public/logo.png" alt="octopuses" width="112" />
</p>

<h1 align="center">octopuses</h1>

<p align="center">
  <strong>开源的跨平台桌面 AI 工作台</strong><br />
  统一接入模型 · 沉淀知识资产 · 驱动工程执行 · 远程运维
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f" />
  <img alt="version" src="https://img.shields.io/badge/version-0.47.81-blue" />
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" />
  <img alt="tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" />
  <img alt="react" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
</p>

<p align="center">
  <a href="https://octopuses.vip"><strong>官方网站</strong></a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#功能特性">功能特性</a> ·
  <a href="https://github.com/octopuses-vip/octopuses-server">管理端</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

octopuses 面向需要统一管理大模型接入的组织与个人。它把「对话、知识库、工程工具、自动化、远程运维」收进同一个桌面客户端：模型接口可以在服务端集中配置，员工安装客户端、填写管理端地址并登录后即可使用获授权的模型；也支持本地模式，直接连接 OpenAI 兼容服务。

同一份代码在 macOS / Windows / Linux 上编译运行，界面与能力保持一致。

> 本项目交付的是**桌面客户端**，不是可直接部署到 Web 服务器的在线聊天网站。开发时的浏览器预览仅用于调试与界面开发，不代表客户端可以在浏览器中完整运行。对应的管理平台（服务端）见 [octopuses-server](https://github.com/octopuses-vip/octopuses-server)。

---

## 目录

- [设计初衷](#设计初衷)
- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [架构](#架构)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
- [常用命令](#常用命令)
- [首次配置](#首次配置)
- [数据与缓存目录](#数据与缓存目录)
- [数据与安全](#数据与安全)
- [平台能力矩阵](#平台能力矩阵)
- [命令行工具 ots-cli](#命令行工具-ots-cli)
- [开发约定与质量检查](#开发约定与质量检查)
- [常见问题](#常见问题)
- [许可证](#许可证)

---

## 设计初衷

| 统一接入 | 沉淀训练数据 | 运维巡检 |
| --- | --- | --- |
| 组织对大模型的接入集中管理，并便捷集成内部系统的权限体系。 | 日常使用后提取有效对话数据，为内部模型训练提供支持。 | 作为 IT 的日常巡检工具，自动检查远程服务器状态、应用日志与数据库状态，并实时分析运行状况。 |

---

## 功能特性

### 模型与会话

- **双模型来源**：首次启动选择「远程管理端」或「本地模型」，之后可在设置中切换。远程模式从服务端读取当前账号已授权的模型列表（含 `baseUrl` 与密钥）；本地模式读取缓存目录下的 `models.json`。
- **流式对话**：OpenAI 兼容 `POST {模型服务}/chat/completions`，`stream: true`；思维链与正文分别渲染为「思考」折叠块与正文。
- **思考强度**：输入区三档滑杆映射为网关的 `reasoning_effort`（`low` / `medium` / `xhigh`）。
- **多模态输入**：支持粘贴、拖拽与选择图片 / PDF / 文本文件。图片以 `image_url` 随消息发送；文本与 PDF 提取的文字内联为 `<file>` 块。PDF 限 10 MB / 200 页 / 20 万文字字符。
- **需求确认**：需求不清晰时，模型通过 `ask_user` 一次提出 1–3 个独立问题，答完后统一提交并继续运行。
- **运行预算与终止**：每轮可设置轮数 / 时长 / token 上限（填 `0` 表示不限）；运行中可在任意时刻停止，慢工具调用不会把界面钉在「运行中」。
- **上下文管理**：长会话超过阈值时自动把最旧消息折叠为滚动摘要；跨轮次按协议还原 `assistant(tool_calls)` 与 `role: "tool"` 配对。
- **用量与会话持久化**：按轮统计输入 / 输出 / 思考 token；会话、消息与片段统一写入缓存目录的 SQLite 数据库 `octopuses.db`，草稿、回答版本与搜索定位一并支持。
- **会话级工作区**：会话默认使用项目目录，也可创建独立 Git Worktree；工程工具、终端、附加上下文、Git Diff 与检查点统一跟随当前会话的有效工作区。

### 知识与训练数据

- **资料导入**：支持 PDF、DOCX、XLSX、PPTX、文本与源码（单文件 ≤10 MB），正文 SHA-256 去重，索引保存在 `knowledge.db`。
- **向量语义检索**：可选下载并启用 BGE-small-zh-v1.5（INT8 ONNX，约 24.6 MB），逐文件校验 SHA-256，使用本地 ONNX WASM 推理，运行期不依赖网络。
- **知识库 RAG**：模型可主动调用只读工具 `knowledge_search`；设置页可开启「对话自动检索」，每轮请求前自动召回相关片段并注入系统提示。
- **训练数据导出**：支持 messages JSONL（默认）/ Alpaca JSONL / ShareGPT JSONL，可预览结构；文档另可导出原始资料 JSONL。
- **知识文档导出**：按项目、会话勾选后整理为独立 Markdown 文件，整批成功后才发布，不覆盖历史导出。
- **导出质量评审**：可选启用模型清洗，只允许剔除消息或遮盖敏感原文，不允许补写答案；长会话按完整问答轮次自动分批。

### 工程执行与交付

- **代码工具**：`search_code` / `read_file` 定位代码，`apply_patch` / `write_file` 修改源码，`test_runner` 执行构建或测试。
- **命令审批**：命令由 Rust 后端按 Allow / Ask / Deny 分类；危险命令始终拒绝，未知命令经独立审批卡片确认。
- **检查点与回滚**：源码首次写入前创建检查点，可在回答附近一键撤销本轮修改；写入或回滚后自动刷新 Git Diff。
- **Git 交付**：右栏展示分支、状态与差异，支持按文件或全部暂存 / 取消暂存、显式提交、推送任务分支；前后端共同拒绝直接推送 `main` / `master`。
- **审阅闭环**：差异行评论随会话持久化，可汇总为用户消息沿原 Agent 链路继续修复。
- **集成终端**：`⌘J` 打开持久 PTY 登录 shell，工作目录跟随会话工作区，支持实时光标、`Ctrl+C`、窗口 resize 与命令历史。

### 扩展与自动化

- **技能（Skills）**：扫描缓存目录 `skills/<技能名>/SKILL.md`，启动时生成索引 `SKILLS.md`；模型按需读取正文，输入框 `/技能名` 可显式调用。
- **Agent（子代理）**：扫描 `agents/<agentId>/AGENT.md`，可绑定到会话或自动化任务，按声明收敛模型、系统提示与工具集；模型也可通过 `run_subagent` 委派独立子任务。
- **MCP**：在 `mcp/servers.json` 配置本地 stdio MCP 服务，工具包装为 `mcp_<服务id>__<工具名>`，调用前经审批。
- **自动化任务**：支持固定间隔与 cron 表达式，任务与运行记录落盘；macOS 下注册为 LaunchAgent，应用关闭后仍能按时唤起，错过的任务按「只补最近一次」补偿。
- **多项目并行**：把同一条提示词分发到多个项目，各自在独立会话中并行执行，批次记录落盘 `parallel/batches.json`。
- **联网检索**：`web_search` 抓取检索结果页，`read_url` 读取网页正文，来源汇总进右栏「来源」。
- **SSH 远程运维**：管理主机清单，支持密钥 / 密码认证、连通性测试、远程目录浏览、文件读写与命令执行；凭据经系统钥匙串保管，不落明文。
- **浏览器与电脑自动化**：`browser_cdp` 通过 DevTools 协议驱动受控浏览器；macOS 下可用 `screenshot` + `computer_click` 截屏并按坐标点按原生应用。所有操作统一经过审批闸门。
- **本地 CV 与视觉**：本地 OCR、目标检测与 3D 视图渲染，资产位于 `public/cv/`，运行期零联网。

### 产物与预览

- **产物落盘**：模型通过 `write_artifact` 写入产物目录，右栏「文件」tab 列出全部产物，「网页」tab 用沙箱 iframe 渲染 HTML。
- **多模态预览**：文本 / 图片 / PDF / 二进制按类型分别预览；Markdown 与 CSV 直接富预览，PDF 交给 WebView 内置阅读器。
- **图像生成**：`generate_image` 调用网关 `/images/generations` 出图并落盘；网关无图像渠道时返回可读的不可用提示。
- **右栏按内容出现**：只显示当前有内容的 tab（文件 / 网页 / 图片 / 差异 / 来源 / 评审），全为空时自动收起。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite 8、zustand、纯 CSS 设计令牌 |
| 桌面外壳 | Tauri 2（macOS WKWebView / Windows WebView2 / Linux WebKitGTK） |
| 原生后端 | Rust、rusqlite、portable-pty、reqwest、russh / russh-sftp、keyring |
| 模型接入 | OpenAI 兼容 Chat Completions（SSE 流式） |
| 知识库 | SQLite + 本地 ONNX WASM（BGE-small-zh-v1.5 INT8） |
| 命令行 | 独立 Cargo workspace（`ots-cli/`，六个 crate） |
| 包管理 | pnpm（提交 `pnpm-lock.yaml`） |

---

## 架构

```text
┌────────────────────────────────────────────────────┐
│ React 19 + TypeScript（src/）                      │
│ 会话 / 知识库 / 工具 / 自动化 / 设置 / 右栏预览      │
└──────────────────────┬─────────────────────────────┘
                       │ Tauri IPC（invoke / event）
┌──────────────────────▼─────────────────────────────┐
│ Tauri v2 + Rust（src-tauri/）                      │
│ 模型流式代理 / SQLite / PTY / Git / SSH / 沙箱 /    │
│ 工具执行 / 定时任务 / 系统托盘 / 在线更新            │
└──────────────────────┬─────────────────────────────┘
                       │ HTTP / SSE / stdio / SQLite
        模型服务 · MCP 服务 · SSH 主机 · 本地文件系统
```

几条贯穿全局的设计约束：

- **平台差异集中**：前端在 `src/app/platform.ts`，后端在 `src-tauri/src/platform.rs`，其余模块不判断操作系统。
- **状态切片单一归属**：`src/app/storeTypes.ts` 定义 `AppStore` 契约，每个字段必须恰好归属一个切片；`pnpm check:architecture` 会检查字段归属、运行时循环依赖与反向依赖。
- **桌面能力统一封装**：所有 Tauri 调用经 `src/app/desktop/`，页面与业务模块不直接 `invoke`。
- **模型请求经原生层转发**：流式转发、取消与转储由 `src-tauri/src/model_proxy.rs` 承担，前端只消费事件流。
- **单一文件不超过 1000 行**：由 `pnpm check:file-size` 强制，避免模块重新膨胀。

`ots-cli/` 是独立的 Rust 命令行工作区，与桌面端共用仓库但构建互不依赖，详见 [ots-cli/README.md](ots-cli/README.md)。

---

## 目录结构

<details>
<summary><strong>展开完整目录结构</strong></summary>

```text
octopuses/
├─ src/                       前端（React 19 + TypeScript + Vite）
│  ├─ app/                    应用骨架：store、router、types、persist、平台差异、桌面能力封装
│  ├─ auth/                   登录与管理端地址配置
│  ├─ cache/                  缓存目录配置、日志、会话与产物落盘
│  ├─ shell/                  主壳：侧栏、消息流、输入区、右栏、终端、命令面板
│  ├─ conversation/           消息流内容块（思考 / 工具 / 问答 / 差异 / 来源 / 用量）
│  ├─ model/                  模型客户端、附件、调用转储
│  ├─ approval/               命令审批（Allow / Ask / Deny）
│  ├─ tools/                  模型工具定义与执行
│  ├─ knowledge/              知识库导入、索引、检索、导出与评审
│  ├─ skills/ agents/ mcp/    技能、子代理、MCP
│  ├─ automations/ parallel/  自动化调度、多项目并行
│  ├─ project/ cv/ computer/  项目与工作区、本地视觉、桌面自动化
│  ├─ pages/                  搜索 / 知识库 / MCP / SSH / 自动化 / 技能 / Agent / 工具 / 并行 / 设置
│  ├─ hooks/                  useAgentRun 主循环等
│  ├─ styles/                 设计令牌与全局样式
│  └─ types/                  第三方类型声明
├─ src-tauri/                 Tauri v2 外壳（Rust）
│  ├─ src/                    会话库、模型代理、PTY、Git、SSH、MCP、沙箱、定时、托盘、更新
│  ├─ capabilities/           Tauri 权限清单
│  ├─ icons/                  应用图标
│  └─ tauri.conf.json         应用配置（窗口 / 打包 / 版本）
├─ ots-cli/                   独立 Rust CLI 工作区
├─ public/                    静态资产（logo、构建期生成的 cv/）
├─ scripts/                   构建、签名、架构与安全检查脚本
├─ tests/                     前端测试（tsx --test）
├─ index.html                 首屏 HTML（含主题防闪脚本）
├─ vite.config.ts             Vite 配置（端口 1420 / HMR 1421）
└─ package.json               脚本与依赖
```

</details>

---

## 快速开始

### 1. 准备环境

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 20 + pnpm | 前端构建与包管理 |
| Rust 稳定版 | `cargo` 需在 `PATH` 中（非交互 shell 记得 `export PATH="$HOME/.cargo/bin:$PATH"`） |
| 平台系统依赖 | macOS：Xcode Command Line Tools；Windows：WebView2 + MSVC 生成工具；Linux：见下 |

Linux（Debian / Ubuntu）：

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### 2. 克隆并启动

```bash
git clone https://github.com/octopuses-vip/octopuses-box.git
cd octopuses-box
pnpm install          # 安装前端依赖
pnpm cv:assets        # 生成 public/cv/ 本地 CV 资产（约 28 MB，不进版本库）
pnpm tauri dev        # 启动桌面窗口（首次编译较慢）
```

> `pnpm cv:assets` 是全新克隆后的**必跑步骤**：`public/cv/` 不在版本库中，缺失时 OCR / 图纸相关能力不可用。首次执行需要联网（从依赖包复制资源并下载目标检测模型）。

### 3. 打包

构建产物位于 `src-tauri/target/release/bundle/` 下的平台子目录。跨平台发行应在对应操作系统的构建环境中分别构建。

```bash
pnpm tauri build              # 当前平台全部 bundle 目标
pnpm tauri build --bundles app  # 仅打包 macOS .app
```

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm tauri dev` | 启动桌面应用（推荐） |
| `pnpm dev` | 仅启动 Vite 前端（浏览器调试，无 Tauri 外壳） |
| `pnpm build` | TypeScript 类型检查 + 前端构建（产物 `dist/`） |
| `pnpm preview` | 预览前端构建产物 |
| `pnpm test` | 运行前端测试（`tests/*.test.tsx`） |
| `pnpm tauri build` | 打包桌面应用（当前平台全部 bundle 目标） |
| `pnpm tauri build --bundles app` | 仅打包 macOS `.app` |
| `pnpm cv:assets` | 生成本地 CV 资产到 `public/cv/` |
| `pnpm check:architecture` | 检查状态切片归属与运行时循环依赖 |
| `pnpm check:file-size` | 检查单文件是否超过 1000 行 |
| `pnpm check:secrets` | 扫描仓库中的疑似密钥 |
| `pnpm check:docs` | 统计函数级注释覆盖率 |

---

## 首次配置

### 选择模型来源

| 方式 | 适用场景 | 需要准备 |
| --- | --- | --- |
| 远程管理端 | 组织集中管理账号和模型 | 管理端地址、已分配账号、网络连通性 |
| 本地模型 | 获准自行维护模型连接 | OpenAI 兼容服务地址、凭据、缓存目录 |

「本地模型」表示连接配置从本机读取，不表示模型一定运行在本机，也不保证离线使用。

### 远程管理端

1. 输入管理员提供的主机名或 IP 和端口，确认连通性检查通过。
2. 使用分配的账号登录。
3. 设置缓存目录。
4. 在会话输入区选择当前账号已授权且已启用的模型。

更换管理端地址后需要重新登录，因为登录凭据由原管理端签发。

管理端服务端的源码与部署说明见 [octopuses-server](https://github.com/octopuses-vip/octopuses-server)。

### 本地模型

进入「设置 → 本地模型配置」，编辑缓存目录下的 `models.json`。文件顶层是 JSON 数组，每条至少需要 `code` 与 `baseUrl`：

```json
[
  {
    "code": "your-model-name",
    "name": "模型显示名称",
    "provider": "服务提供方",
    "baseUrl": "https://model.example.com/v1",
    "apiKey": "替换为获准使用的密钥",
    "description": "可选说明",
    "supportsImages": false
  }
]
```

`baseUrl` 必须是绝对的 `http://` 或 `https://` 地址，`code` 不能重复。`models.json` 可能包含模型密钥，请勿提交到 Git 或公开分享。

### 缓存目录

桌面版默认使用用户主目录下的 `octopuses` 文件夹（`~/octopuses`），也可选择其他有读写权限的位置。会话数据库、知识库、运行日志、设置文件与临时产物都存放在该目录。

---

## 数据与缓存目录

```text
<cachePath>/
├─ octopuses.db           会话、消息、片段与用量（SQLite）
├─ knowledge.db           知识库检索索引（派生数据，不作为会话恢复来源）
├─ models.json            本地模型配置（可能含密钥）
├─ skills/<name>/SKILL.md 技能
├─ agents/<id>/AGENT.md   子代理
├─ mcp/servers.json       MCP 服务配置
├─ ssh/hosts.json         SSH 主机清单（凭据在系统钥匙串）
├─ automations/           自动化任务与运行记录
├─ parallel/batches.json  并行批次记录
├─ logs/                  运行日志与模型调用转储
└─ outputs/<日期>/        临时会话产物
```

项目会话生成的文件通常位于项目目录的 `output/` 下。切换缓存目录前，请先确认旧目录数据的备份与迁移安排；备份或迁移前建议退出应用。

---

## 数据与安全

- 只连接组织或个人明确批准的管理端、模型服务、MCP 服务与 SSH 主机。
- 发送文件或会话内容前，确认数据分类、服务端处理范围、留存策略与授权范围。
- SSH 密码与私钥口令由系统钥匙串保管；本地模型 `apiKey` 保存在 `models.json` 中，不要假定所有本地配置都已加密。
- 模型调用转储默认关闭；开启后会在缓存目录写入请求与执行记录，日志会尽量隐藏常见凭据，但不保证完全脱敏。
- 「全部自动」审批档仍受静态危险命令拒绝规则约束；仍需关注审批提示与操作目标。
- 备份时同时考虑缓存目录、各项目目录中的 `output/` 以及 Git 改动。

实际可用工具还取决于当前模型、会话权限、管理员策略、MCP 配置与操作系统授权。功能未出现在界面或工具列表中时，不应假定它在该设备或本轮会话可用。

### 应用内更新签名

应用内更新只信任**编译期固定**的 Minisign 公钥，服务端无法在下发时替换公钥：

```bash
# 1. 生成密钥对；私钥自行保管，不要提交到仓库
minisign -G -p octopuses.pub -s octopuses.key

# 2. 构建时注入公钥（取 .pub 文件中的 base64 行）
OCTOPUSES_UPDATE_PUBLIC_KEY="$(tail -n +2 octopuses.pub)" pnpm tauri build

# 3. 为安装包生成同名签名文件，与安装包一起上传
minisign -S -s octopuses.key -m <安装包路径>
```

- 客户端只从 HTTPS 下载与安装包同路径的 `<安装包>.minisig`，地址中不允许包含账号或 fragment。
- 未注入公钥的发行包会直接拒绝应用内更新，提示「此发行包未配置更新验签公钥」。
- 签名缺失、下载失败或校验不通过时更新终止，不会回退到未签名安装。

---

## 平台能力矩阵

| 能力 | macOS | Windows | Linux |
| --- | :---: | :---: | :---: |
| 工程工具 / 集成终端 / 会话库 / 产物预览 | ✅ | ✅ | ✅ |
| `browser_cdp`（DevTools 协议驱动受控浏览器） | ✅ | ✅ | ✅ |
| `open_in_browser`（系统默认浏览器打开链接） | ✅ | ✅ | ✅ |
| `browser_script` / `computer_script`（AppleScript） | ✅ | — | — |
| `screenshot` / `computer_click`（截屏 + 坐标点击） | ✅ | — | — |
| 内核级写隔离沙箱（Seatbelt） | ✅ | — | — |
| 系统级后台定时（应用关闭后仍唤起） | ✅ | — | — |
| 窗口装饰 | 原生 Overlay | 无边框 + 自绘 | 无边框 + 自绘 |

---

## 命令行工具 ots-cli

`ots-cli/` 是 octopuses 的本地软件工程 Agent 命令行版，以「生成 → 执行 → 验证」循环驱动模型调用工具，执行前经过策略引擎与人工审批，并在沙箱中运行。

```bash
cd ots-cli
cargo build --release --offline
cargo test --workspace --offline
cargo run -- run "修复空输入导致的崩溃，并补充单元测试" --test-command "cargo test --offline"
```

它拥有独立的 Cargo workspace 与构建产物，与桌面端共用版本号与用户级配置目录，但构建层面互不依赖。完整命令、配置分层、审批沙箱与技能说明见 [ots-cli/README.md](ots-cli/README.md)。

---

## 开发约定与质量检查

- **模块边界**：前端按 `app / feature / shell / components` 分层；`src/app/desktop/` 不依赖应用状态，状态切片不得反向依赖 Store 入口。
- **平台差异**：只允许出现在 `src/app/platform.ts` 与 `src-tauri/src/platform.rs`。
- **类型检查**：`pnpm build` 会先跑 `tsc`；提交前应保证零类型错误。
- **单元测试**：前端使用 Node 原生测试运行器（`tsx --test`），测试文件位于 `tests/`。
- **静态检查**：提交前建议依次运行：

```bash
pnpm check:architecture
pnpm check:file-size
pnpm check:secrets
pnpm test
```

- **注释**：新增的生产函数需在紧邻上一行写函数级说明；`pnpm check:docs` 用于统计覆盖率。
- **依赖安装**：CI / 可复现环境使用 `pnpm install --frozen-lockfile`。
- **参与贡献**：开发环境、代码约定与提交前检查见 [贡献指南](CONTRIBUTING.md)；安全问题请按 [安全策略](SECURITY.md) 私密反馈。

---

## 常见问题

<details>
<summary><strong>无法连接管理端</strong></summary>

核对地址与端口是否由管理员提供、设备是否在允许的网络内、DNS / 防火墙是否放行。连通性检查成功不代表账号或模型已授权。

</details>

<details>
<summary><strong>登录成功但模型列表为空</strong></summary>

远程模式请联系管理员核对账号授权与模型启用状态；本地模式请检查缓存目录下的 `models.json` 是否有效、是否至少包含一条模型配置。

</details>

<details>
<summary><strong>模型可以选择但请求失败</strong></summary>

分别检查模型服务网络、`baseUrl`、凭据、模型 `code` 与服务端状态。管理端可达不代表模型服务可达。提供错误信息前请移除地址、密钥、账号与业务数据。

</details>

<details>
<summary><strong>图片输入或工具调用不可用</strong></summary>

取决于模型能力、网关支持、当前会话的工具与权限配置，以及系统权限。macOS 屏幕操作需要在系统设置中授予「屏幕录制」与「辅助功能」权限。

</details>

<details>
<summary><strong>知识库搜索没有结果</strong></summary>

确认资料已成功导入；使用语义检索时，确认向量模型已下载启用且索引已完成。

</details>

<details>
<summary><strong>启动后界面空白或主题闪烁</strong></summary>

确认使用 `pnpm tauri dev` 而非浏览器直接打开 `index.html`；浏览器预览仅覆盖部分能力，桌面 API 不可用。

</details>

<details>
<summary><strong>更新或安装包有安全提示</strong></summary>

不要关闭系统安全功能来绕过提示。请通过可信渠道向发布管理员确认安装包来源、签名、公证状态及校验和。

</details>

---

## 许可证

项目自有代码采用 [MIT](LICENSE) 许可证，Copyright (c) 2026 octopuses。第三方组件保留各自许可，详见[第三方材料说明](THIRD_PARTY_NOTICES.md)；引用或再分发时请一并遵守其条款。

---

<p align="center">
  <sub>Copyright © 2026 octopuses · MIT License</sub><br />
  <sub><a href="https://octopuses.vip">octopuses.vip</a> · <a href="https://github.com/octopuses-vip/octopuses-box">源代码</a> · <a href="https://github.com/octopuses-vip/octopuses-server">管理端</a></sub>
</p>
