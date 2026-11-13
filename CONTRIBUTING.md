# 贡献指南

感谢参与 octopuses。本文说明本地开发、代码约定与提交前的检查项，帮助改动尽快通过评审。

---

## 开始之前

- 先阅读 [README.md](README.md) 了解项目定位、架构与启动方式。
- 较大的功能或重构，建议先开 Issue 说明目标、影响范围与方案，避免方向不一致导致返工。
- 安全问题不要走公开 Issue，请按 [SECURITY.md](SECURITY.md) 私密反馈。

## 本地开发

### 环境

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 20 + pnpm | 前端构建与包管理 |
| Rust 稳定版 | 桌面端与 `ots-cli` 编译 |
| 平台系统依赖 | 见 README「快速开始」 |

### 启动

```bash
pnpm install
pnpm cv:assets        # 首次克隆必跑，生成 public/cv/ 本地资产
pnpm tauri dev        # 启动桌面应用
```

仅调试前端界面时可使用 `pnpm dev`，但浏览器环境不具备 Tauri 原生能力，不能作为功能验收依据。

## 代码约定

### 模块边界

- 前端按 `app / feature / shell / components` 分层；业务能力放在对应 feature 目录，不堆进页面组件。
- `src/app/state/` 中每个 `AppStore` 字段必须恰好归属一个切片，切片之间不得反向依赖 Store 入口。
- 所有 Tauri 调用统一经 `src/app/desktop/` 封装，页面与业务模块不直接 `invoke`。
- 平台差异只允许出现在 `src/app/platform.ts` 与 `src-tauri/src/platform.rs`，其余模块不得判断操作系统。
- 单个源码文件不超过 **1000 行**。

以上边界由 `pnpm check:architecture` 与 `pnpm check:file-size` 强制检查。

### TypeScript / React

- 保持 `strict` 类型检查通过；不要用 `@ts-nocheck` 或 `any` 绕过问题。
- 组件保持单一职责；可复用的展示组件放 `src/components/`，业务状态放切片或对应 feature。
- 样式使用 `src/styles/` 下的设计令牌，不在组件里写死颜色、字号与间距。
- 副作用与异步流程放在 hook 或 feature 模块，不散落在渲染函数中。

### Rust

- 新增 Tauri 命令需在 `src-tauri/src/lib.rs` 的 `generate_handler!` 中注册。
- 凭据、密钥与令牌不得落盘明文；SSH 等凭据统一走系统钥匙串。
- 涉及文件系统、命令执行与网络访问的能力，必须经过既有审批与沙箱链路，不得新增绕过入口。

### 注释

- 新增的生产函数在紧邻上一行写函数级说明，解释「为什么这样做」而非复述代码。
- 测试函数与显而易见的 getter 不强制要求。
- 可用 `pnpm check:docs` 查看当前覆盖率。

### 版本号

版本号在以下位置保持一致，发版时一并更新：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src/app/meta.ts`
- `ots-cli/Cargo.toml`（与桌面端统一版本号）

## 提交前检查

```bash
pnpm build                # TypeScript 类型检查 + 前端构建
pnpm test                 # 前端测试
pnpm check:architecture   # 状态切片归属与循环依赖
pnpm check:file-size      # 单文件行数
pnpm check:secrets        # 疑似密钥扫描
```

涉及 `ots-cli/` 时，额外在 `ots-cli/` 下运行：

```bash
cargo test --workspace --offline
cargo clippy --workspace --all-targets --offline
```

行为变更应补充或更新 `tests/` 下的测试；修复缺陷时优先补一条能复现问题的回归测试。

## 提交与 PR

### 提交信息

使用「类型: 说明」格式，类型与现有历史保持一致：

| 类型 | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `refactor` | 不改变行为的重构 |
| `perf` | 性能优化 |
| `test` | 测试补充或调整 |
| `docs` | 文档 |
| `chore` | 构建、依赖与杂项 |

示例：`fix: 流式路径 4xx 不重试并保留错误体（v0.47.75）`

### PR 内容

- 说明**为什么改**、改了什么、影响范围；关联相关 Issue。
- 界面改动附截图或录屏；交互变化说明操作路径。
- 列出已执行的检查命令与结果。
- 一个 PR 聚焦一件事，避免混入无关格式化或重构。

### 评审关注点

- 是否破坏模块边界或引入循环依赖。
- 是否新增了绕过审批、沙箱或权限收敛的路径。
- 凭据、内部地址、客户数据是否可能进入代码、日志或测试夹具。
- 失败路径是否有可读提示，是否会留下半成品状态。

## 文档

- 面向用户的变更更新 README 的对应章节。
- 第三方依赖或模型资产变化时，同步更新 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 许可证变化需在 PR 中明确说明。

## 行为准则

参与本项目即表示同意：尊重不同经验与观点，围绕技术问题讨论，不人身攻击、不泄露他人隐私与内部数据。维护者可对违反准则的内容或贡献予以关闭或移除。
