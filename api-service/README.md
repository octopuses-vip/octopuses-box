# octopuses 独立 API

API 是单独的 Node.js 进程，可以在没有桌面客户端的机器上运行。服务签发本地调用令牌，并从 octopuses 管理端读取模型列表，对外提供会话、预设 Agent、语音转写、图片生成和视频生成任务。

## 从桌面客户端启动

在客户端打开「设置 → 模型与连接 → 本地 API」，开启「API 服务」。客户端会使用内置运行时启动服务，显示本机监听地址，并提供「复制调用令牌」。在请求头中使用 `Authorization: Bearer <令牌>`。

该入口使用桌面端当前缓存目录和模型来源。管理端模式复用当前登录，在登录失效后重新登录并开启即可。本地模型模式读取缓存目录内的 `models.json`。服务在本机空闲端口运行，每次开启生成新令牌。关闭开关、退出客户端或切换登录账号、缓存目录、模型来源时会停止服务。

在客户端左侧「API 会话」可以查看这个入口创建的本地历史。带 `sessionId` 的请求按会话查看，其余请求位于「独立任务」。历史可在关闭 API 服务后查看，并按缓存和登录账号隔离。早期独立任务仅能显示已保存的结果和状态，另行部署的 API 通过自身接口查询历史。

## 启动

在仓库根目录使用 Node.js 24 启动。服务会自动读取当前目录的 `.env`（如存在），已设置的环境变量优先。启动成功后终端会输出监听地址和「接口调用令牌（Bearer）」。

```sh
pnpm api
```

也可直接运行 `node api-service/server.mjs`，无需安装前端依赖。用 `curl http://127.0.0.1:8180/health` 检查进程是否就绪。

| 环境变量 | 作用 | 默认值 |
| --- | --- | --- |
| `OCTOPUSES_API_TOKEN` | 可选的固定调用令牌，32–256 个字母、数字或 `. _ ~ -` 字符 | 每次启动随机生成 |
| `OCTOPUSES_MANAGEMENT_URL` | 读取模型列表所用的管理端基础地址 | 空 |
| `OCTOPUSES_MANAGEMENT_USERNAME` | 有权读取模型列表的管理端客户端账号 | 空 |
| `OCTOPUSES_MANAGEMENT_PASSWORD` | 上述账号的登录密码 | 空 |
| `OCTOPUSES_API_HOST` | API 监听地址 | `127.0.0.1` |
| `OCTOPUSES_API_PORT` | API 端口，设为 `0` 时使用系统分配的端口 | `8180` |
| `OCTOPUSES_API_DATA_DIR` | 会话、任务和产物目录，每个运行实例使用独立目录 | `.octopuses-api` |
| `OCTOPUSES_API_CONCURRENCY` | 同时运行的任务数（1–8） | `2` |
| `OCTOPUSES_API_CACHE_DIR` | Agent 和 Skill 所在的缓存目录 | 读取桌面端已保存的缓存位置 |
| `OCTOPUSES_API_AGENTS_FILE` | 手动维护的 Agent JSON 文件，设置后使用该文件 | 空 |
| `OCTOPUSES_API_AUTO_SKILLS` | 是否让模型为对话自动选择 Skill，设为 `false` 可关闭 | `true` |

其他机器需要调用时，可在 API 前配置 HTTPS 反向代理，或在受控网络里通过监听地址开放服务。反代需支持流式传输，并按附件上限设置请求体大小。

## 鉴权和模型

调用方复制启动时打印的本地令牌，在每个业务请求中发送 `Authorization: Bearer <token>`。同一实例的调用方共用这枚令牌和该实例的会话、任务与产物。默认每次重启生成新令牌，历史数据继续保存在原数据目录。需要固定令牌时可设置 `OCTOPUSES_API_TOKEN`。

要查询模型或运行模型任务，配置管理端地址、用户名和密码。API 首次读取模型列表时自动登录管理端，登录令牌只存在内存中，失效后自动重新登录并重试。调用方使用启动时打印的本地 API 令牌。

```sh
OCTOPUSES_MANAGEMENT_URL=http://127.0.0.1:8000 \
  OCTOPUSES_MANAGEMENT_USERNAME="$MANAGEMENT_USERNAME" \
  OCTOPUSES_MANAGEMENT_PASSWORD="$MANAGEMENT_PASSWORD" pnpm api
```

上面的 `MANAGEMENT_USERNAME` 和 `MANAGEMENT_PASSWORD` 是部署环境提供的账号和密码。也可以把三个 `OCTOPUSES_MANAGEMENT_*` 变量放入已被 Git 忽略的项目根目录 `.env` 文件，再直接运行 `pnpm api`。

下列调用示例中的 `OCTOPUSES_API_TOKEN` 使用服务启动时打印的本地令牌。模型列表只返回模型标识、名称和已声明的能力。未配置管理端时，服务可启动并校验本地令牌，需要模型列表的请求返回 `503`。

```sh
curl http://127.0.0.1:8180/v1/models \
  -H "Authorization: Bearer $OCTOPUSES_API_TOKEN"
```

从返回的 `data[].code` 选取对应类型的模型。服务会使用管理端为所选模型配置的基础地址和密钥。

## 会话和 Agent

`POST /v1/sessions` 传入 `{"model":"模型标识"}` 创建会话，返回 `id`。对话任务传入此 ID，服务会带上最近的已完成轮次。每个会话同时只接受一轮进行中的对话。独立对话可以在任务中直接指定 `model`。

通常直接运行 `pnpm api` 即可。API 优先使用启动环境或 `.env` 中已有的 `OCTOPUSES_API_CACHE_DIR`。缺少该配置时，API 从桌面端导出的 `~/.octopuses/cache-location.json` 读取缓存位置。目录存在时，API 会把该值补到 `.env` 并立即使用。桌面端切换目录后，如需重新自动读取，删掉 `.env` 中旧的缓存目录配置，然后重启 API。旧版桌面端升级后，打开一次应用即可导出已有设置。独立部署的服务器可通过 `.env` 指定服务器上的缓存目录。

服务启动时扫描缓存的 `agents/<id>/AGENT.md`，将找到的 Agent 写入 API 数据目录下的 `agents.generated.json`（默认 `.octopuses-api/agents.generated.json`），并自动加载。源 Agent 目录存在时，重启会同步目录内容。源目录暂时不存在时，API 会读取上一次生成的配置。

也可通过 `OCTOPUSES_API_AGENTS_FILE` 指定手动配置，文件格式如下。

```json
[
  {
    "id": "editor",
    "name": "文字编辑",
    "model": "你的聊天模型标识",
    "instructions": "用简洁的中文整理用户提供的材料，保留原意。"
  }
]
```

通过 `GET /v1/agents` 查看本地已加载的 Agent。查询列表只需要本地 API 令牌。创建会话时传 `{"agentId":"editor"}` 即可使用该 Agent，也可以在独立对话任务里传 `agentId`。Agent 未指定 `model` 时由调用方提供模型。实际创建会话或提交任务时仍会校验管理端的模型授权。服务版 Agent 复用名称、模型和提示词，执行文本对话。桌面工作区、终端、SSH、浏览器工具在桌面端使用。

## 自动选择 Skill

API 启动时读取缓存目录中的 `skills/<id>/SKILL.md`。调用 `POST /v1/jobs` 时提交普通的对话请求，例如 `{"type":"chat","agentId":"editor","prompt":"把以下访谈内容整理成问答稿"}`。如果有可用 Skill，服务会先用同一个聊天模型，根据任务、最近会话和技能简介选择相关技能，再把选中的正文加入回答提示词。模型可以选择零个或多个技能，每轮最多加入三个，正文总长最多 32,000 字符。

使用的技能 ID 会出现在 `result.skillIds`。选择请求失败或格式不可用时，任务仍会生成普通回答，并在结果中标记 `skillSelection: "unavailable"`。缓存里没有可用 Skill 时，直接生成回答。更新本地 Skill 后重启 API 可刷新目录。API 只使用 `SKILL.md` 的文字指引，包含脚本、参考文件或桌面工具的步骤需在桌面端运行。

## 发送任务

所有任务均提交到 `POST /v1/jobs`，以 JSON 返回 HTTP 202 和任务 ID。以下是各类型的请求示例。

| 类型 | 请求示例 | 完成结果 |
| --- | --- | --- |
| 会话对话 | `{"type":"chat","sessionId":"会话ID","prompt":"整理这段材料"}` | `result.text` |
| 独立对话 | `{"type":"chat","model":"聊天模型标识","prompt":"写一段介绍"}` | `result.text` |
| 语音转写 | `{"type":"transcribe","model":"qwen3-asr","filename":"录音.mp3","audioBase64":"..."}` | 转写文字和 TXT 产物 |
| 生成图片 | `{"type":"image","model":"图片模型标识","prompt":"海边日出","size":"1024x1024"}` | 图片产物 |
| 生成视频 | `{"type":"video","model":"视频模型标识","prompt":"海边日出","seconds":"8","size":"832x480"}` | MP4 产物和上游任务 ID |

```sh
curl http://127.0.0.1:8180/v1/jobs \
  -H "Authorization: Bearer $OCTOPUSES_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"type":"chat","model":"你的聊天模型标识","prompt":"用一句话介绍这个服务"}'
```

语音转写的 `audioBase64` 是原文件的标准 Base64，解码后上限 25 MiB。服务将文件直接以 multipart 发送到语音模型，可选传入 `language`。长音频分段和转写续传由桌面客户端提供。图片模型需返回 `data[0].b64_json`。视频的 `seconds` 和 `size` 可省略，取值以模型为准。图生视频使用 `input_reference.image_url`，值为 JPEG、PNG 或 WebP 的 Base64 data URL，参考图上限 10 MiB。视频模型需通过 `/videos/{id}/content` 直接返回 MP4。单个产物上限 256 MiB。

## 查询进度和下载

| 方法和路径 | 结果 |
| --- | --- |
| `GET /health` | 检查进程是否在线，无需令牌 |
| `GET /v1/models` | API 服务的管理端账号所获授权的模型 |
| `GET /v1/agents` | 可用 Agent 预设 |
| `POST /v1/sessions` | 新建会话 |
| `GET /v1/sessions/{id}` | 读取会话和最近 20 轮已完成对话 |
| `POST /v1/jobs` | 提交任务 |
| `GET /v1/jobs/{id}` | 查询状态、结果或错误 |
| `GET /v1/jobs/{id}/events` | SSE 进度流 |
| `POST /v1/jobs/{id}/cancel` | 取消服务端排队或等待 |
| `GET /v1/jobs/{id}/artifact` | 下载生成的产物 |

SSE 先发送 `status` 快照，再推送状态变化。聊天模型流式返回时，会出现 `delta` 文字增量。终态快照附带完整结果或错误，之后流关闭。断线可以重新连接并获取最新快照。

```sh
curl -N "http://127.0.0.1:8180/v1/jobs/$JOB_ID/events" \
  -H "Authorization: Bearer $OCTOPUSES_API_TOKEN"
```

任务状态为 `queued`、`running`、`completed`、`failed` 或 `cancelled`。等待与执行中的任务总数上限为 8。完成的媒体任务在 `result.artifact` 提供文件名、类型、大小和下载路径。下载时使用当前的本地 API 令牌。

取消停止 API 服务内的任务。若模型已接收生成请求，上游仍可能继续执行，视频的 `upstreamId` 可用于核对。服务重启后保留已完成任务、会话与产物，重启打断的任务显示失败，保留已知的上游 ID。提交失败或中断的上游生成请求不会自动重复提交。

`pnpm test:api` 使用本地模拟管理端和模型服务验证上述流程。
