---
title: 本地 Server 与 API
nav_title: 本地 Server
description: 本地 Server 的启动参数、访问控制、REST 与 WebSocket 接口范围。
order: 2
---

# 本地 Server 与 API

本地 Server 是桌面端、H5 页面和 Claude CLI 之间的运行时边界。它提供 REST API、聊天 WebSocket、Provider 协议代理和桌面 Web 静态资源。打包后的桌面应用会自动管理它；只有源码开发、无界面部署或自定义客户端才需要手工启动。

## 启动

在仓库根目录运行：

```bash
bun run src/server/index.ts
```

默认监听 `127.0.0.1:3456`。确认服务就绪：

```bash
curl http://127.0.0.1:3456/health
```

返回格式：

```json
{
  "status": "ok",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

`/health` 是启动探针，始终公开，不代表其他接口已通过认证。

## 启动参数

| 参数 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `--host <host>` | `SERVER_HOST` | `127.0.0.1` | 监听地址 |
| `--port <port>` | `SERVER_PORT` | `3456` | HTTP 和 WebSocket 端口 |
| `--cli-path <path>` | `CLAUDE_CLI_PATH` | 自动解析 | 指定 Server 拉起的 CLI |
| `--auth-required` | `SERVER_AUTH_REQUIRED=1` | 关闭 | 对能力接口强制显式鉴权 |

命令行的 host 和 port 优先于环境变量。开发时建议保留回环地址；`0.0.0.0` 只表示接受外部连接，并不会自动完成 H5 授权、TLS 或反向代理配置。

## 提供 H5 页面

源码运行时先构建桌面 Web 资源：

```bash
cd desktop
bun run build
cd ..
bun run src/server/index.ts
```

Server 会自动查找仓库的 `desktop/dist`。从其他目录启动时，用绝对路径指定构建产物：

```bash
CLAUDE_H5_DIST_DIR=/absolute/path/to/desktop/dist \
  bun run /absolute/path/to/src/server/index.ts
```

| 变量 | 说明 |
|------|------|
| `CLAUDE_H5_DIST_DIR` | H5 构建产物目录，目录内必须有 `index.html` |
| `CLAUDE_H5_PUBLIC_BASE_URL` | 固定的公开服务地址 |
| `CLAUDE_H5_AUTO_PUBLIC_URL=1` | 在启用 H5 时尝试生成局域网公开地址 |

完整的 Token、允许来源、手机访问和 Nginx 配置见 [H5 访问](../desktop/remote.md)。

## 访问控制

Server 根据请求来源和能力路径决定是否允许访问：

| 请求 | 默认行为 |
|------|----------|
| `GET /health` | 公开，用于启动探针 |
| H5 静态页面和 assets | 公开的启动外壳；页面本身不包含会话数据 |
| 直接回环请求 | 仅当客户端地址、Host 和 Origin 都是本机，且没有反向代理跟踪头时视为本机可信 |
| H5 关闭时的远程能力请求 | 拒绝 `/api`、`/proxy`、`/ws` 和文件能力 |
| H5 开启时的远程能力请求 | 要求有效 H5 Token，并校验浏览器 Origin |
| `--auth-required` / `SERVER_AUTH_REQUIRED=1` | 即使 H5 未开启，也对能力接口要求显式认证 |

“连接来自 `127.0.0.1`”本身不足以证明是本机用户。反向代理必须保留公开 `Host`，或传递 `Forwarded`、`X-Forwarded-*`、`X-Real-IP`、`Via` 中至少一种，让 Server 能区分反代流量和直接回环流量。

### Token 传递

- REST、协议代理和文件接口：`Authorization: Bearer <token>`
- 浏览器 WebSocket：`/ws/<session-id>?token=<token>`

H5 模式使用设置页生成的 H5 Token。显式 `--auth-required` 模式也能接受与服务端 `ANTHROPIC_API_KEY` 相同的 Bearer Token，但不建议为了远程访问暴露模型密钥；优先启用 H5 并使用独立 Token。

CORS 只限制浏览器读取响应，不是身份认证。非浏览器客户端不会因为 CORS 而安全。

## HTTP 接口范围

业务 REST API 位于 `/api/*`，主要覆盖：

- 会话、对话、搜索和文件系统；
- 设置、权限、模型、effort 和 Providers；
- Agents、任务、团队和计划任务；
- Skills、插件、市场和 MCP；
- IM 适配器和 Computer Use；
- 诊断、Doctor、活动统计、记忆和 traces；
- H5 访问控制。

具体请求与响应以 `src/server/api/` 的当前处理器为准。内部 `/sdk/<session-id>` WebSocket 是 Server 为自己拉起的 Claude CLI 使用的通道，不是第三方客户端 API。

`/proxy/*` 是 Provider 的协议转换入口，包含运行时认证和模型路由状态。不要把它当成通用的、无状态 OpenAI 代理公开出去。

## 定时任务通知的公共授权边界

`src/server/services/cronService.ts` 的 `TaskNotificationConfig.telegramEntrypoints` 为可选数组，取值为 `dedicated`、`public`，可同时选择；缺省专属。它仅影响 Telegram，创建和更新都经同一校验，仍要求唯一显式收件人。公共选择以 adapter 配置中的 owner 验证，专属选择以配对记录验证；同时选择时同一个人必须满足两个入口条件。

公共任务通知是普通公共会话报告以外的受限路径，不放宽 `/api/notifications/send` 或 `LocalMessageSend` 的 `sourceSessionId`、订阅与 Telegram-only 约束。只有 `CronScheduler.finalizeTaskRun` 提供绑定原 task/run 的内部 `getTaskNotificationContext` 闭包：每次调用重新读取 `scheduled_tasks.json` 的登记任务与当前 `scheduled_tasks_log.json` 的已结算运行，不使用 SQLite 派生视图或调用方自报正文。任务必须仍登记且通知仍启用并选择公共；一次性任务的自动禁用不等于删除，不据此否定已结束运行。

`notificationService.ts` 在首次发送及每次重试前重新校验该上下文、收件人与当前 owner、公共启用状态及实际执行目录的 realpath 项目根范围。Bot token、owner 与配置代次绑定到投递开始时的快照；变更后拒绝，不改投新身份。缺少可信闭包、任务删除、运行伪造或收件人篡改都明确失败。该分支直接复用 HTTP 传输，不要求公共轮询进程在线，不创建订阅、会话回复映射或审批凭据。

任务仍使用 `NotificationDeliveryStore` 的 pending/settle、已确认/失败/不确定与重启恢复规则，而非会话报告 outbox。公共幂等键仅在原任务键后增加 `::public`；专属旧键不变。可选 `telegramEntrypoint` 记录区分两端，旧记录通过既有规范化读取并解释为专属，不重写旧任务配置；两端独立结算，一端失败不抑制另一端。429 遵守 `retry_after`、5xx 有界重试，每次再次验权；超时或网络不确定不盲目重发。来源头部区分订阅会话与任务，任务标明 task/run，正文保留既有任务摘要上限。用户操作见 [定时任务](../desktop/schedule.md)。

## 聊天 WebSocket

客户端连接：

```text
ws://127.0.0.1:3456/ws/<session-id>
```

常用客户端消息包括：

- `user_message`、`stop_generation`
- `permission_response`、`computer_use_permission_response`
- `set_permission_mode`、`set_runtime_config`
- `sync_state`、`prewarm_session`
- `ping`

服务端会发送连接与会话状态、文本增量、思考、工具调用与结果、权限请求、重试/降级状态、错误、任务/团队更新和 `pong`。完整字段以 `src/server/ws/events.ts` 为准。

桌面客户端每 30 秒发送一次 ping；等待 pong 10 秒后会主动重连。重连退避上限为 30 秒，并不会在固定次数后永久停止。自定义客户端应能重复连接、重新同步状态，并忽略未知的新增消息字段。

## 反向代理清单

远程使用时至少完成：

1. 在 Server 端启用 H5，生成独立 Token，并配置精确的允许来源。
2. 使用 HTTPS，不在公开网络传输明文 Token。
3. 转发静态页面、`/api/*`、`/proxy/*` 和 `/ws/*`。
4. 为 `/ws/*` 开启 WebSocket upgrade。
5. 保留公开 Host 和标准代理头。
6. 不向公网转发内部 `/sdk/*`。

## 排查

| 现象 | 检查 |
|------|------|
| 端口无法监听 | `SERVER_PORT` 是否被占用；是否传入了有效数字 |
| `/health` 正常但 API 为 `403` | 请求被判定为远程，而 H5 尚未启用 |
| API 或 WebSocket 为 `401` | H5 Token 过期、缺失，或 WebSocket 没有 query token |
| 浏览器提示 CORS | 当前页面的精确 Origin 是否在 H5 允许列表 |
| WebSocket 反复重连 | 代理是否支持 upgrade、Token 是否传入、空闲连接是否被代理关闭 |
| 页面 `404` | 尚未构建 `desktop/dist`，或 `CLAUDE_H5_DIST_DIR` 指向错误 |
| 远程请求被当成本机 | 反向代理是否删除了公开 Host 和全部代理跟踪头 |
