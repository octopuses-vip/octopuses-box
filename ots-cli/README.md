# ots-cli CLI

> 当前版本：**v0.2.1**

> **本目录是 [octopuses](../README.md) 项目的命令行工具**（仓库内路径 `ots-cli/`）。
> 它与桌面端共用同一个 Git 仓库，但拥有**独立的 Cargo workspace**（自己的 `Cargo.toml` / `Cargo.lock` 与
> `crates/`），两者在构建层面互不依赖，可分别编译与测试。

`ots-cli` 是 octopuses 项目的本地软件工程 Agent 命令行版。
它在终端里以「**生成 → 执行 → 验证**」循环驱动大模型调用工具，执行前经过策略引擎与人工审批，
并在沙箱中运行，全程输出结构化日志、单行进度与可回放的审计记录。

核心能力：

- **gent 循环**：生成-执行-测试持续迭代，支持迭代次数、质量阈值、时长 / token 预算、无进展、手动中断等多种终止条件组合。
- **工具调用系统**：可扩展的工具注册与调用框架，统一做参数校验、超时、取消、并发与输出截断，支持同步 / 异步两种工具实现。
- **审批沙箱**：敏感操作先预览影响范围、再走人工审批，审批结果落盘可跨进程回放，执行在逻辑沙箱 / macOS Seatbelt 中隔离。
- **技能（Skill）**：把可复用工作流写成 `SKILL.md`（YAML 前置区 + 正文），系统提示只放索引，模型按需载入正文，并可按技能声明收窄可用工具。
- **配置文件管理**：用户级 / 项目级 / 显式文件 / 环境变量 / 命令行六层合并。

---

## 目录

- [快速开始](#快速开始)
- [架构与依赖方向](#架构与依赖方向)
- [核心模块](#核心模块)
  - [1. gent 循环](#1-gent-循环生成--执行--验证)
  - [2. 工具调用系统](#2-工具调用系统)
  - [3. 审批沙箱](#3-审批沙箱)
  - [4. 技能](#4-技能skills)
- [命令行参考](#命令行参考)
- [使用示例](#使用示例)
- [配置文件](#配置文件)
- [运行产物](#运行产物)
- [开发与测试](#开发与测试)
- [变更记录](#变更记录)

---

## 快速开始

```bash
# 构建（离线可用）
cargo build --release --offline

# 配置模型接入（任选其一）
export OPENAI_API_KEY=sk-xxx
# 或写入项目级配置
ots config init

# 提一个任务，交给循环去完成
ots run "修复 src/parser.rs 中空输入导致的崩溃，并补充单元测试" \
  --test-command "cargo test --offline" \
  --max-iterations 6

# 只想跑一轮，不做验证循环
ots exec "解释 src/loop.rs 的执行流程"
```

要求：Rust 1.88+（workspace `rust-version`）；Seatbelt 沙箱仅 macOS 可用。

---

## 架构与依赖方向

采用 cargo workspace 多 crate 结构，依赖**单向流动**：所有 crate 依赖 `ots-core`，`ots-core` 不依赖任何兄弟 crate。
因此领域逻辑（循环、工具抽象、策略、审批契约）与具体实现（HTTP 客户端、文件系统、macOS 沙箱、命令行）可以独立演进。

```
                         ┌──────────────────────────────┐
                         │          ots-cli           │  可执行程序 ots：命令行、日志、进度、审计
                         └───┬───────┬───────┬──────┬───┘
                             │       │       │      │
              ┌──────────────┘       │       │      └──────────────┐
              ▼                      ▼       ▼                     ▼
      ┌───────────────┐      ┌─────────────┐ ┌──────────────┐ ┌────────────┐
      │  ots-llm    │      │ ots-tools │ │ots-sandbox │ │ots-config│
      │ OpenAI 兼容流 │      │ 内置/外部工具│ │策略/审批/守卫│ │ 分层配置   │
      └───────┬───────┘      └──────┬──────┘ └──────┬───────┘ └──────┬─────┘
              │                     │               │                │
              │              ┌──────┘               │                │
              │              ▼                      │                │
              │      ┌───────────────┐              │                │
              │      │ ots-config  │◄─────────────┘                │
              │      └───────┬───────┘                               │
              │              │                                       │
              └──────────────┴───────────────────────────────────────┘
                             ▼
                    ┌────────────────┐
                    │   ots-core   │  领域契约：循环内核、工具抽象、
                    │  （无兄弟依赖）│  策略/审批/守卫 trait、事件与提示词
                    └────────────────┘
```

| crate | 职责 | 关键类型 |
| --- | --- | --- |
| `ots-core` | 领域层：循环内核、工具抽象、策略 / 审批 / 守卫契约、事件流、提示词 | `AgentLoop`、`LoopPolicy`、`Tool`、`ToolRuntime`、`PolicyEngine`、`ApprovalBroker`、`ExecGuard`、`Verifier`、`LoopEvent` |
| `ots-config` | 六层配置加载、深度合并、校验、TOML 序列化 | `OtsConfig`、`LoadOptions`、`LoadedConfig`、`validate` |
| `ots-llm` | OpenAI 兼容 Chat Completions 客户端，SSE 流式解析、重试 | `OpenAiCompatibleClient`、`LlmConfig`、`LlmError` |
| `ots-tools` | 内置工具与外部工具注册 | `ShellTool`、`ReadFileTool`、`WriteFileTool`、`ApplyPatchTool`、`TestRunnerTool`、`ExternalTool`、`UseSkillTool` |
| `ots-sandbox` | 逻辑沙箱 + macOS Seatbelt、策略引擎、操作预览、审批存储 | `SandboxGuard`、`PolicyEngineImpl`、`SeatbeltProfile`、`ApprovalStore` |
| `ots-cli` | 可执行程序：参数解析、装配、日志 / 进度渲染、审计落盘 | 二进制名 `ots` |

解耦手段：横切关注点全部通过 trait 注入。循环不构造具体沙箱、不感知 HTTP、不决定如何展示——
`ExecGuard` / `Generator` / `PolicyEngine` / `ApprovalBroker` / `EventSink` 都由上层装配。

---

## 核心模块

### 1. gent 循环（生成 → 执行 → 验证）

实现位置：`crates/ots-core/src/looping.rs`

每轮迭代固定执行四个阶段：

```
IterationStarted
  → 生成：调用 Generator，流式输出正文 / 推理增量
  → 执行：解析 tool_calls，经策略 → 审批 → 沙箱，最后并发执行（受 max_tool_concurrency 限制）
  → 验证：Verifier 给出 (passed, score, summary)
  → 判定：命中任一终止条件则结束，否则注入 continue_prompt 进入下一轮
```

**可组合的终止条件**（`LoopPolicy`，全部可独立开关）：

| 条件 | 配置项 | 默认 | 说明 |
| --- | --- | --- | --- |
| 达到最大迭代数 | `agent.max_iterations` | 8 | `--max-iterations` |
| 达到质量阈值 | `agent.quality_threshold` | 0.9 | 验证得分 ≥ 阈值即终止 |
| 验证通过即终止 | `agent.stop_on_verification_pass` | true | 与 `--max-iterations` 组合决定循环上限 |
| 时长预算 | `agent.max_duration_secs` | 1800 | `--max-duration`，`0` 表示不限制 |
| token 预算 | `agent.max_total_tokens` | 不限制 | `--max-total-tokens` |
| 连续无进展 | `agent.stall_patience` | 2 | `--stall-patience`，`0` 表示禁用 |
| 用户中断 | — | — | `Ctrl-C` → `CancellationToken` → `TerminationReason::UserInterrupted`（退出码 130） |
| 不可恢复错误 | — | — | `TerminationReason::FatalError` |

**实时日志与状态监控**：循环本身只 `emit` 事件，展示交给 `EventSink`：

- 单行进度：`⟳ 第 2/8 轮 · 生成中… 128 字符`，结束行用 `\r` + 清行覆盖，不刷屏（`--no-progress` 关闭）。
- 结构化日志：`--log-format json` 输出 `{"type":"tool_finished","call_id":…,"duration_ms":…}`。
- 审计落盘：`.octopuses/audit.jsonl` 追加写；高频增量事件（`generation_delta` / `reasoning_delta`）自动跳过，避免审计文件被淹没。
- `--json` 在结束时打印完整 `LoopOutcome`（终止原因、迭代数、token 用量、改动文件、耗时）。

**重试语义（重要）**：重试由 LLM 客户端负责（指数退避），循环层**只在两种情况下**重试模型调用——

1. 错误属于可重试类别（网络抖动、超时、5xx）：`CoreError::is_retryable()`；
2. 本次尝试**尚未向用户输出过任何正文增量**（`DeltaTracker` 保护），否则重试会把同一段正文重复打印。

鉴权失败（401）、请求参数非法（400）等确定性错误会被归类为 `GenerationRefused`，立即失败并给出明确原因，不做无谓重试。

### 2. 工具调用系统

实现位置：`crates/ots-core/src/tool.rs`（抽象与运行时）、`crates/ots-tools/`（具体工具）

一个工具 = `ToolSpec`（自描述元数据）+ `Tool::invoke`（执行体）。运行时统一处理横切关注点：

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    fn supports_preview(&self) -> bool { false }              // 是否支持只算影响、不落盘
    async fn invoke(&self, inv: ToolInvocation, ctx: &ToolContext) -> Result<ToolResult, ToolError>;
    async fn preview(&self, inv: ToolInvocation, ctx: &ToolContext) -> Result<Preview, ToolError> { … }
}
```

`ToolRuntime::execute` 的职责链：

1. **查找**：未注册的工具直接返回 `ToolErrorKind::UnknownTool`。
2. **参数校验**：按工具自己的 JSON Schema 校验（必填、类型、枚举、`additionalProperties`），
   失败时**不抛异常给用户**，而是把结构化的 `状态: 失败（InvalidArguments）` 文本回灌给模型，让它自己修参数。
3. **超时与取消**：`tokio::select!` 同时监听工具 future、`ctx.timeout` 与 `CancellationToken`；超时映射为 `Timeout`，取消映射为 `Cancelled`。
4. **并发**：同一轮内的多个工具调用按 `agent.max_tool_concurrency` 用 `Semaphore` 限流并发执行，结果按原始顺序回填消息。
5. **输出截断**：超过 `tools.max_output_bytes` 时保留首尾、中间省略，并置 `truncated = true`（不会截断到字符边界中间）。
6. **结果结构化**：`ToolResult { ok, stdout, stderr, exit_code, duration_ms, truncated, error_kind, data }`，
   失败分类为 `InvalidArguments` / `UnknownTool` / `Timeout` / `Cancelled` / `Denied` / `Failed`。

**注册方式**：

- 内置工具（6 个）：`shell`（High，写）、`read_file`（Low，只读）、`write_file`（Medium，写，支持预览）、
  `apply_patch`（Medium，写，支持预览）、`test_runner`（Medium，只读，标记为配置声明的验证手段）、
  `use_skill`（Low，只读，载入技能正文；有技能被装载时才会注册）。
- 白名单 / 黑名单：`tools.enabled` / `tools.disabled`（后者优先）。
- **外部工具**（配置文件注册）：`tools.external[]`，声明 `name` / `description` / `command` / `args`（支持 `{{参数名}}` 占位）/
  `parameters`（JSON Schema）/ `risk` / `mutating` / `timeout_secs` / `env`。
  注册后与内置工具完全同权：模型可调用、`ots tools run` 可手动调用、同样经过策略与审批。
- 环境变量白名单：`tools.env_allowlist`，子进程只会继承列出的变量，避免密钥泄漏。

示例：

```toml
[[tools.external]]
name = "ruff"
description = "对指定路径运行 ruff 检查"
command = "/usr/local/bin/ruff"
args = ["check", "{{path}}", "--output-format", "concise"]
risk = "low"
mutating = false
timeout_secs = 60

[tools.external.parameters]
type = "object"
required = ["path"]
additionalProperties = false

[tools.external.parameters.properties.path]
type = "string"
description = "要检查的文件或目录"
```

### 3. 审批沙箱

实现位置：`crates/ots-sandbox/`（`policy.rs` / `preview.rs` / `approval.rs` / `guard.rs` / `rules.rs`）

**三段式授权**：`策略引擎初筛 → 操作预览 → 人工审批 → 沙箱执行`。

1. **策略引擎初筛**（`PolicyEngine`）
   按权限模式 `approval.mode` 与路径 / 命令规则给出 `Allow` / `Ask` / `Deny`：

   | 模式 | 行为 |
   | --- | --- |
   | `read-only` | 拒绝一切写操作 |
   | `auto`（默认） | 低风险放行，其余进入审批 |
   | `full-access` | 跳过审批，但仍受沙箱硬性规则约束 |

   规则优先级：`deny_paths` / `deny_commands` → `allow_paths` / `allow_commands` → 风险等级判定。
   默认拒绝：`.git/objects/**`、`**/*.pem`、`**/.env`、`sudo`、`rm -rf /` 等。
   被配置声明为验证手段的工具（`test_runner` 不传参 / 恰好等于 `agent.test_command`）直接放行。

2. **操作预览**（`supports_preview` + `preview`）
   支持预览的工具（`write_file` / `apply_patch`）在执行前生成 diff 与受影响文件列表，
   审批界面据此展示「将改动哪些文件的哪些行」，让审批人看到**影响范围**而非仅一个命令名。
   命令行侧也可用 `ots sandbox preview <tool> --args '…'` 单独预览，不执行、不落盘。

3. **审批流程与分级**（`ApprovalBroker` + `ApprovalStore`）
   状态机：`Pending → Approved / Denied / Expired`。
   记录以 JSONL 追加写入 `.octopuses/approvals.jsonl`，因此**可以跨进程审批**：
   一个后台运行的 `ots` 进程把请求落盘后等待，另一个终端用 `ots approvals approve <id>` 完成决策，等待方随即恢复执行。
   风险分级：`Low` 自动放行；`Medium` / `High` 交互确认；`Critical` 默认拒绝，除非 `approval.allow_critical = true`
   且用户原样输入 `approval.elevated_phrase`（默认「我确认执行」）。
   非交互场景可用 `--yes` 自动批准（请确认风险），或由 `approval.deferred_wait_secs` 决定等待外部审批的时长。

4. **沙箱隔离**（`ExecGuard`）

   | 后端 | 隔离方式 |
   | --- | --- |
   | `logical`（默认） | 路径规范化 + 越界拦截 + 环境变量白名单，进程仍在宿主机运行 |
   | `seatbelt` | 逻辑沙箱之上再套 macOS `sandbox-exec`，用生成的 Seatbelt profile 做内核级限制 |
   | `none` | 不做限制（仅用于受控环境） |

   子进程写权限默认限定在：工作区、`sandbox.writable_paths`、`sandbox.writable_system_paths`（默认 `/private/tmp`、`/tmp`）。
   网络默认允许（`sandbox.allow_network`），可关闭。`ots sandbox check --command …` / `--path …` 可以预先验证某条命令或路径会不会被拦。

### 4. 技能（skills）

实现位置：`crates/ots-core/src/skill.rs`（元数据与收窄语义）、`crates/ots-tools/src/skill.rs`（装载与 `use_skill` 工具）

技能 = 一个目录下的 `SKILL.md`：首部的 YAML 前置区声明元数据，其后是给模型的正文。

```markdown
---
name: fix-bug
description: 定位并修复缺陷，补充回归测试
allowed_tools: [read_file, shell, apply_patch]
---
1. 先复现问题，读相关日志。
2. 修改最小范围，保持风格一致。
3. 补一条回归测试并跑通。
```

**搜索顺序**（同名技能「后写覆盖」，因此越靠后优先级越高）：用户级 `<配置目录>/octopuses/skills/` →
项目级 `<工作区>/.octopuses/skills/` → `skills.paths[]`。

**按需加载**：系统提示只放「名称 + 描述」索引（提示词开销与正文长度解耦）；
模型与某技能匹配时调用 `use_skill` 读取完整正文，正文按 `skills.max_body_bytes` 上限截断。
`use_skill` 只接受技能名、不接受路径，因此不存在路径穿越的输入面，无需经过沙箱守卫。

**工具收窄**：技能声明 `allowed_tools` 后，自**下一轮迭代**起本会话可用工具收窄为
「当前范围 ∩ 声明范围」（多技能叠加取交集），并始终保留 `use_skill` 以便继续载入其它技能；
收窄生效时控制台打一行 Warning 提示。`allowed_tools` 缺省表示不约束，`[]` 表示只留 `use_skill`。
全局 `--no-skill-scope` 关闭收窄（正文照常加载，只是不再限制工具）。

**配置**：

```toml
[skills]
enabled = true
disabled = []                    # 黑名单，按技能名
paths = []                       # 额外技能根目录，优先级最高
max_body_bytes = 32768           # 正文读取上限
```

---

## 命令行参考

### 全局参数

```
Usage: ots [OPTIONS] <COMMAND>

Commands:
  run        运行「生成-执行-测试」循环，直到达成终止条件
  exec       只执行一轮：生成 + 工具调用，不进入验证循环
  tools      查看与手动调用工具
  skills     查看技能
  approvals  查看与处理人工审批
  sandbox    查看沙箱配置与操作预览
  config     管理配置文件

Options:
  -c, --config <FILE>              显式指定的配置文件（也可用环境变量 OTS_CONFIG）
  -C, --workspace <DIR>            工作区根目录，默认为当前目录
  -m, --model <MODEL>              覆盖模型名（llm.model）
      --log-level <LEVEL>          覆盖日志级别（trace/debug/info/warn/error，或 tracing 过滤器表达式）
      --log-format <FORMAT>        日志与事件输出格式 [text / json]
      --json                       以 JSON 输出（等价于 --log-format json）
  -y, --yes                        自动批准所有需要审批的操作（非交互场景，请确认风险后再使用）
      --permission-mode <MODE>     覆盖权限模式 [read-only / auto / full-access]
      --sandbox <BACKEND>          覆盖沙箱后端 [logical / seatbelt / none]
      --no-progress                关闭单行进度显示
      --show-reasoning             显示模型的推理（思维链）增量
      --no-skill-scope             关闭「按技能声明收窄可用工具」（技能正文照常加载）
      --skip-validate              跳过启动前的配置校验（不推荐）
  -h, --help / -V, --version
```

### 子命令

```
ots run <GOAL> [--max-iterations N] [--quality-threshold RATIO] [--max-duration SECS]
                 [--max-total-tokens N] [--stall-patience N] [--test-command CMD]
                 [--verifier test-command|none] [--no-verify]
                 [--tool-timeout SECS] [--tool-concurrency N]
ots exec <GOAL> [--tool-timeout SECS]

ots tools list
ots tools schema <NAME>
ots tools run <NAME> [--args JSON] [--dry-run]

ots skills list
ots skills show <NAME>

ots approvals list [--pending]
ots approvals show <ID>
ots approvals approve <ID> [--note TEXT]
ots approvals deny <ID> [--note TEXT]

ots sandbox preview <TOOL> [--args JSON]
ots sandbox profile
ots sandbox check [--command CMD] [--path PATH] [--access read|write]

ots config init [--user] [--force]
ots config show
ots config validate
ots config path
```

退出码约定：`0` 成功、`130` 用户中断、`2` 参数或环境错误、`1` 运行失败。

---

## 使用示例

**循环 + 客观验证**：让模型改代码并用测试命令自证。

```bash
ots run "为 src/parser.rs 补齐空输入分支并加单元测试" \
  --test-command "cargo test -p parser --offline" \
  --max-iterations 6 \
  --quality-threshold 0.9 \
  --stall-patience 2
```

**只跑一轮**：适合问答、代码解释、单次改动。

```bash
ots exec "说明 crates/ots-core/src/looping.rs 里 DeltaTracker 的作用"
```

**CI 场景**：JSON 日志 + 自动批准 + 关闭进度。

```bash
ots --json --log-format json --yes --no-progress \
  run "补齐缺失的错误处理并保证 cargo test 通过" \
  --test-command "cargo test --workspace --offline" \
  --max-iterations 4
```

**先预览再决定**：看看某次写操作会改什么。

```bash
ots sandbox preview write_file --args '{"path":"src/lib.rs","content":"..."}'
ots sandbox check --command "rm -rf build" --access write
ots sandbox check --path ~/.ssh/id_rsa --access read
```

**跨进程审批**：终端 A 挂起等待审批，终端 B 决策。

```bash
# 终端 A
ots run "清理构建产物"            # 落到 Pending，等待
# 终端 B
ots approvals list --pending
ots approvals approve 3f9c1a2b --note "确认只删 target/"
```

**注册并调用外部工具**：

```bash
ots tools list                              # 看到 ruff
ots tools schema ruff                       # 打印参数 JSON Schema
ots tools run ruff --args '{"path":"src/"}' --dry-run
```

**使用技能**：把工作流沉淀成技能，让模型按需载入。

```bash
mkdir -p .octopuses/skills/fix-bug
$EDITOR .octopuses/skills/fix-bug/SKILL.md        # 写入上文的 YAML 前置区 + 正文

ots skills list                             # 名称 / 来源 / 工具范围 / 说明
ots skills show fix-bug                     # 元数据 + 完整正文
ots --json skills show fix-bug              # 机器可读版本

ots run "修复 src/parser.rs 的空输入崩溃"    # 模型会先 use_skill fix-bug 再按步骤执行
ots --no-skill-scope run "…"                # 载入技能，但不按 allowed_tools 收窄工具
```

---

## 配置文件

### 分层与优先级（低 → 高）

1. 内置默认值
2. 用户级：`dirs::config_dir()/octopuses/config.toml`（macOS 为 `~/Library/Application Support/octopuses/config.toml`，Linux 为 `~/.config/octopuses/config.toml`）
3. 项目级：`<工作区>/.octopuses/config.toml`
4. 显式指定：`--config <FILE>` / `OTS_CONFIG`
5. 环境变量：`OTS__<路径>`，`__` 表示层级，例如 `OTS__LLM__MODEL=gpt-4o`
6. 命令行参数

合并策略为**深度合并**：对象逐层递归，数组与标量整体覆盖。所有字段都有默认值，
因此配置文件只写想覆盖的部分即可；未知字段会被 `ots config validate` 报错，避免拼写错误被静默忽略。

### 示例

```toml
[llm]
provider = "openai-compatible"
base_url = "https://api.openai.com/v1"
model = "gpt-4o"
api_key_env = "OPENAI_API_KEY"   # 从环境变量读取密钥，避免明文入库
temperature = 0.2
max_tokens = 8192
timeout_secs = 600
stream = true
max_retries = 3

[agent]
max_iterations = 8
quality_threshold = 0.9
stop_on_verification_pass = true
max_duration_secs = 1800         # 0 = 不限制
max_total_tokens = 0             # 0 = 不限制
stall_patience = 2               # 0 = 禁用
max_tool_concurrency = 4
tool_timeout_secs = 120
verifier = "test-command"        # test-command | none
test_command = "cargo test --workspace --offline"
instructions_files = ["AGENTS.md"]  # 注入系统提示的项目指令文件
# system_prompt_extra = "回答一律使用中文。"

[tools]
enabled = []                     # 非空时只启用列出的工具
disabled = ["shell"]             # 优先级高于 enabled
max_output_bytes = 65536
env_allowlist = ["PATH", "HOME", "LANG", "TMPDIR", "TERM", "USER", "SHELL"]

[skills]
enabled = true                   # 关闭后既不扫描技能目录，也不注册 use_skill
disabled = []                    # 黑名单，按技能名
paths = []                       # 额外技能根目录，优先级高于用户级 / 项目级
max_body_bytes = 32768           # use_skill 读取正文的上限

[approval]
mode = "auto"                    # read-only | auto | full-access
allow_paths = [".octopuses/tmp/**"]
deny_paths = [".git/objects/**", "**/*.pem", "**/.env"]
allow_commands = ["ls", "cat", "git status", "git diff"]
deny_commands = ["sudo", "shutdown", "reboot", "mkfs", "rm -rf /"]
allow_critical = false
elevated_phrase = "我确认执行"
deferred_wait_secs = 600
# store_path = ".octopuses/approvals.jsonl"

[sandbox]
enabled = true
backend = "logical"              # logical | seatbelt | none
allow_network = true
writable_paths = []
readable_paths = []
writable_system_paths = ["/private/tmp", "/tmp"]

[logging]
level = "info"
format = "text"                  # text | json
progress = true
# audit_path = ".octopuses/audit.jsonl"

[project]
# workspace = "/path/to/workspace"
```

常用命令：

```bash
ots config init                # 生成项目级配置，写入当前生效配置，保证初始化后行为不变
ots config init --user         # 写入用户级配置（macOS: ~/Library/Application Support/octopuses/config.toml）
ots config show                # 展示合并后的生效配置与各来源
ots config validate            # 校验配置（模型为空、测试命令缺失、外部工具重名等）
ots config path                # 打印各级配置文件路径
```

---

## 运行产物

均位于工作区的 `.octopuses/` 下：

| 路径 | 内容 |
| --- | --- |
| `.octopuses/config.toml` | 项目级配置（`config init` 生成） |
| `.octopuses/approvals.jsonl` | 审批记录追加日志，可回放，用于跨进程审批 |
| `.octopuses/audit.jsonl` | 审计事件流（跳过高频增量事件） |
| `.octopuses/tmp/` | 默认允许写入的临时目录 |

---

## 开发与测试

```bash
cargo build --offline                        # 构建
cargo test  --workspace --offline            # 全部单元测试
cargo clippy --workspace --all-targets --offline   # 静态检查，要求零告警

# 单 crate
cargo test -p ots-core --offline
```

测试规模：183 个单元测试，覆盖循环终止条件与重试语义、参数校验回灌、工具执行与截断、
策略规则与反例、审批状态机与跨进程回放、沙箱路径规范化与 Seatbelt profile 生成、
SSE 流式解析与错误分类、六层配置合并、技能装载与前置区解析、技能工具范围收窄。

---

## 变更记录

### v0.2.1

**结构调整（无功能变更）**：本工具作为 ots-cli 项目的命令行工具并入其仓库，路径由独立仓库 `ots-cli/` 调整为 `octopuses/ots-cli/`。

- 与桌面端**统一版本号**（`0.2.0` → `0.2.1`，与桌面端 `src-tauri/Cargo.toml`、`tauri.conf.json`、`package.json` 保持一致）。
- 保留独立的 Cargo workspace：`ots-cli/Cargo.toml` 的 `members = ["crates/*"]` 与各 crate 的 `path` 依赖相对路径均无需调整。
- 修正 `ots-cli/Cargo.toml` 的 `repository` 元数据：由占位地址 `https://github.com/octopuses/ots-cli` 改为实际仓库 `https://github.com/octopuses-vip/octopuses-box`。
- 两者共用用户级基目录 `~/Library/Application Support/octopuses/`（macOS 上 `dirs::config_dir()` 与桌面端 `path().data_dir()` 指向同一处），因此约定分区：

  | 归属 | 目录 / 文件 |
  | --- | --- |
  | 桌面端 | `cache/temp`、`cache/logs`、`cache/sessions`、`cache/artifacts`、`cache/manifest.json` |
  | CLI | `config.toml`、`skills/`、工作区内的 `.octopuses/{audit,approvals}.jsonl` |

### v0.2.0

新增**技能（Skill）**支持：把可复用工作流写成 `SKILL.md`，按需载入并可收窄可用工具。

**新增功能**

- **技能装载**（`ots-tools/src/skill.rs`）
  - 技能格式：`<技能根>/<目录名>/SKILL.md`，YAML 前置区（`---` 包裹）声明 `name` / `description` / `allowed_tools`，其后为正文。
  - 三类技能根：用户级 `<配置目录>/octopuses/skills/` → 项目级 `<工作区>/.octopuses/skills/` → `skills.paths[]`；同名按「后写覆盖」，装载顺序经排序保证可复现。
  - 容错：根目录不存在静默跳过；子目录无 `SKILL.md` 或解析失败只告警不中断；`skills.disabled` 按名跳过。
  - 前置区使用 `serde_yaml` 解析，`deny_unknown_fields` 让拼写错误（如 `allowed_tool`）立即暴露。
- **`use_skill` 工具**：只接受技能名，返回带元数据表头的正文与结构化 `data`（`skill` / `description` / `allowed_tools` / `path` / `truncated`），正文按 `skills.max_body_bytes` 截断；仅在「技能功能开启且确有技能被装载」时注册。
- **按需加载**：系统提示新增「可用技能」段，只列「名称 + 描述」索引（`AgentInstructions.skills`），提示词开销与正文长度解耦。
- **工具收窄**（`ots-core/src/skill.rs` + `looping.rs`）
  - `RunState.tool_scope` 记录会话级范围；`visible_tools` 过滤模型可见工具（软约束），`execute_tool_calls` 前置拦截越界调用并回灌结构化 `Denied`（硬拦截）。
  - 多技能叠加取**交集**（`narrow_scope`），且无条件保留 `use_skill`，避免模型被锁死在已加载的技能里。
  - 收窄自**下一轮迭代**生效（同一批工具调用并发执行），生效时输出 Warning 提示可见工具清单。
  - 新增 `LoopEvent::SkillLoaded { name, allowed_tools, scope_applied }`，控制台渲染「技能 x 已加载（工具范围: …）」。
  - `LoopConfig.skill_scope` 与全局 `--no-skill-scope` 提供逆开关：关闭后正文照常加载，只是不再限制工具。
- **命令行**：新增 `ots skills list` / `ots skills show <NAME>`（均支持 `--json`）；新增全局参数 `--no-skill-scope`。
- **配置**：新增 `[skills]` 段（`enabled` / `disabled` / `paths` / `max_body_bytes`，默认上限 32 KiB），并在 `config validate` 中加入对应校验（正文上限过小报错、空路径与空黑名单项只提醒）。

**bug 修复**

| # | 问题 | 原因 | 修复 |
| --- | --- | --- | --- |
| 1 | 技能声明的工具范围交集会把自己排除掉，模型再也无法加载其它技能 | `narrow_scope` 只把 `use_skill` 并入声明集合，而「当前 ∩ 声明」仍会把它过滤掉 | 交集计算完成后无条件 `insert(use_skill)`，并补上回归测试「收窄结果始终保留载入工具」 |
| 2 | 收窄测试误判为失败：断言范围内工具执行成功，但脚本第二轮并未调用它 | 测试脚本与该轮断言不一致 | 让第二轮同时调用范围内工具（成功）与越界工具（拒绝），同时覆盖两条路径 |

**验证**

- `cargo clippy --workspace --all-targets --offline`：零告警。
- `cargo test --workspace --offline`：183 passed / 0 failed（技能相关新增 26 个用例）。
- 端到端实测：`ots skills list` / `skills show` / `--json skills list` 输出正确；`use_skill` 仅在存在技能时注册；无技能时 `ots tools list` 不含 `use_skill`。

### v0.1.0

首个可用版本：cargo workspace 六 crate 骨架，三大核心模块与配置文件管理全部落地。

**新增功能**

- **gent 循环**
  - `AgentLoop` 状态机：生成 → 执行 → 验证 → 判定，`LoopPolicy` 提供 6 类可组合终止条件（最大迭代数、质量阈值、时长预算、token 预算、连续无进展、验证通过即终止），外加用户中断（`Ctrl-C` → `CancellationToken`）。
  - 事件驱动解耦：`LoopEvent`（18 种）+ `EventSink`，同一份事件流可渲染为单行进度、结构化日志或审计 JSONL。
  - `Verifier`：`test-command` 按退出码与输出判定得分；`none` 表示不做客观验证。
  - 验证未通过时按 `continue_prompt` 模板注入失败详情（迭代号 / 得分 / 结论 / 细节），引导下一轮修正。
- **工具调用系统**
  - `Tool` + `ToolSpec` 抽象、`ToolRegistry` 注册中心、`ToolRuntime` 统一执行。
  - 参数按工具自带 JSON Schema 校验；失败结果**结构化回灌给模型**而非直接报错终止。
  - 同步 / 异步统一为 `async_trait`，天然支持异步工具；`tokio::select!` 处理超时与取消。
  - 并发限流（`Semaphore`）、输出截断（保留首尾、不破坏字符边界）、结果结构化（`ok` / `exit_code` / `error_kind` / `data`）。
  - 内置 5 个工具：`shell`、`read_file`、`write_file`、`apply_patch`、`test_runner`。
  - 外部工具注册：配置文件声明命令、参数模板（`{{占位}}`）、JSON Schema、风险等级、超时与环境变量，与内置工具同权。
  - 白名单 / 黑名单、环境变量白名单（子进程不继承未列出的变量）。
- **审批沙箱**
  - `PolicyEngine` 三段式裁决（`Allow` / `Ask` / `Deny`），支持权限模式、路径 glob、命令前缀、风险分级；Critical 默认拒绝并需原样输入确认短语。
  - 操作预览：写类工具在执行前输出 diff 与受影响文件列表。
  - 审批状态机 `Pending → Approved / Denied / Expired`，JSONL 追加落盘并支持回放，实现**跨进程审批**（一个进程等待、另一个终端决策）。
  - 沙箱守卫：逻辑沙箱（路径规范化 + 越界拦截 + 环境变量白名单）；macOS 上叠加 Seatbelt（`sandbox-exec`）生成内核级 profile。
- **配置文件管理**
  - 六层合并（内置默认 → 用户级 → 项目级 → `--config` → 环境变量 `OTS__*` → 命令行），深度合并、逐字段默认值、未知字段报错。
  - `config init` / `show` / `validate` / `path` 四件套，`show` 会标注每个值的来源。
- **LLM 接入**
  - OpenAI 兼容 Chat Completions，SSE 流式解析：`data:` 分帧、`[DONE]` 终止、`tool_calls` 按 index 分片拼接、`reasoning_content` 推理增量、`stream_options.include_usage` 用量统计。
  - 指数退避重试，并区分「可否重试」语义。
- **命令行**
  - 全局参数：`--config` / `--workspace` / `--model` / `--log-level` / `--log-format` / `--json` / `--yes` / `--permission-mode` / `--sandbox` / `--no-progress` / `--show-reasoning` / `--skip-validate`。
  - 子命令：`run`、`exec`、`tools`、`approvals`、`sandbox`、`config`。
  - 退出码约定：0 成功 / 130 用户中断 / 2 参数或环境错误 / 1 运行失败。

**bug 修复**

| # | 问题 | 原因 | 修复 |
| --- | --- | --- | --- |
| 1 | Seatbelt 沙箱对字面路径不生效 | `/var` 在 macOS 上是到 `/private/var` 的软链，规则里写 `/var/...` 与实际访问路径不一致 | 生成 profile 前对全部路径做规范化（symlink 解析），规则与内核判定路径统一 |
| 2 | 策略引擎把项目自己的验证命令也拦下来审批 | 未区分「模型临时构造的任意命令」与「项目配置声明的验证手段」 | `ToolSpec` 增加 `config_verified` 标记，`test_runner` 不传参或恰好等于 `agent.test_command` 时直接放行 |
| 3 | 反例测试偶发失败 | 测试用固定目录名，并行运行时互相干扰 | 反例用例改用 `tempfile` 独占临时目录 |
| 4 | 401 鉴权失败被重试 3 次，白等 3 秒 | 循环层对所有模型错误一律重试，且 `LlmError → CoreError` 转换丢失了「可否重试」信息 | 新增 `CoreError::GenerationRefused` 与 `CoreError::is_retryable()`；循环按可重试性判定；转换时保留语义；重试统一由 LLM 客户端负责（指数退避），CLI 侧 `generation_retries = 0` |
| 5 | 模型已输出正文后重试导致同一段内容打印两遍 | 重试判定只看错误类型，没看是否已经产生过可见输出 | 新增 `DeltaTracker` 包装 `StreamSink`，一旦有正文增量就不再整体重试（推理增量不计入） |
| 6 | 验证被跳过时显示「验证未通过（得分 0.00）」，误导用户 | `VerificationFinished` 事件只有 `passed`，无法区分「未通过」与「未配置验证手段」 | 事件增加 `skipped` 字段，控制台渲染为「验证已跳过: …」 |
| 7 | `cargo clippy` 静态检查有告警 | 未使用的导入、`useless_format`、`too_many_arguments`、`derivable_impls`、`large_enum_variant`、`field_reassign_with_default`、`print_literal` 等 | 逐项整改，`cargo clippy --workspace --all-targets` 归零 |
| 8 | `ots --json` 场景下事件渲染重复 | `config validate` 会把提醒打到 stdout，日志层又打一遍 | 由 `wants_validation_report()` 判断该子命令是否自行展示，避免重复 |

**验证**

- `cargo clippy --workspace --all-targets --offline`：零告警。
- `cargo test --workspace --offline`：157 passed / 0 failed。
- 端到端实测：跨进程审批（落盘 → `approvals list --pending` → `approvals approve` → 等待进程恢复并写入文件）、Seatbelt 越界写入被拒（退出码 1，`Operation not permitted`）、`--yes` 自动批准、`--dry-run` 不落盘、`run --json`、审计落盘与高频事件跳过。
