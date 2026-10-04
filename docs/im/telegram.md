---
title: Telegram 接入
nav_title: Telegram
description: 找 BotFather 要一个 Bot Token 填进桌面端，在 Telegram 私聊里点按钮批权限。
order: 2
---

# Telegram 接入

八个平台里接入最快的一个：找 `@BotFather` 要一个 Token，粘进桌面端就完事，权限审批是原生按钮。适合能连上 Telegram 的个人用户。限制是只处理私聊，不处理群组；国内网络下的连通性要你自己解决。

## 创建机器人

在 Telegram 里搜索官方账号 `@BotFather`。

![搜索 BotFather](../images/im/telegram/01-search-botfather.png)

给它发送 `/newbot`。

![发送 newbot 命令](../images/im/telegram/02-newbot-command.png)

按提示走完两步：

1. 取一个机器人名称，例如 `ccmax 机器人`。
2. 取一个用户名，全英文且必须以 `_bot` 结尾，例如 `jiang_cc_hah_bot`。

创建成功后复制 BotFather 返回的**Bot Token**。这枚 Token 等同于机器人的密码，别贴到公开的地方。

![复制 Bot Token](../images/im/telegram/03-bot-token.png)

## 在桌面端填 Token

1. 打开「设置」→「IM 接入」，切到「Telegram」Tab。
2. 把 Bot Token 粘进「Bot Token」。
3. 点「保存」。

![填写 Bot Token](../images/im/telegram/04-fill-bot-token.png)

「允许的用户」可以留空。留空时只有完成配对的人能用。要直接放行已知账号，就填 Telegram 数字用户 ID，多个用逗号分隔。

## 配对

回到页面顶部的「配对管理」，点「生成配对码」，拿到一枚 6 位码。这一步立即生效，不需要再点保存。

![生成配对码](../images/im/telegram/05-generate-pairing-code.png)

在 Telegram 里私聊刚创建的机器人，随便发一条消息，按提示把这枚码发过去。看到配对成功提示就可以开始对话。

![配对成功](../images/im/telegram/06-pair-success.png)

配对码 60 分钟内有效、只能用一次，重新生成后旧码立刻作废。连续输错会被限流，等几分钟再试。

## 支持的命令

- `/start` — 显示帮助和可用命令
- `/help` — 显示当前可用命令
- `/projects` — 列出最近项目并用按钮新建会话
- `/sessions` — 查看并恢复当前项目的历史会话
- `/resume` — 恢复历史会话；已绑定项目时默认列出当前项目历史，未绑定时先选项目
- `/cancel` — 取消当前的项目或会话选择
- `/status` — 当前项目、模型、运行状态和任务摘要
- `/new` — 清空当前绑定并重新选择项目
- `/clear` — 清空上下文，保留项目绑定
- `/stop` — 停止本轮生成
- `/provider` — 查看或切换 Provider
- `/model [model]` — 查看或切换模型
- `/skills` — 查看当前项目可用的 Skills，点选后直接调用
- `/answer [id] <答案>` — 回答模型提问。单题可直接点选或回复文字；多题可逐题作答，或一次提交 JSON（题号或完整问题文本，可不带请求 ID）

## Agent 能力与边界

Telegram 不是一套独立的问答模型。普通消息和从 `/skills` 点选的 Skill 都会进入当前项目的同一条 Claude Code Agent 会话，因此会延续多轮上下文，并能使用该会话已经加载的文件、终端、Git、Skills 和 MCP 工具。点选 Skill 后，adapter 会把对应的 `/<skill-name>` 作为用户消息送入 Agent，由现有 Skill 系统加载 `SKILL.md` 并继续执行。

这些能力只适合单一可信用户远程控制自己的机器。配对账号获得的是当前项目中的完整 Agent 能力，权限确认只是操作闸门，并不是操作系统沙箱；不要把 Bot 暴露给公开群聊或不可信账号，也不要从聊天中安装未经本机审核的 Skill、Plugin 或 MCP。

Adapter 只接受已配对或在允许列表中的私聊账号。项目列表、名称匹配和历史会话恢复都会限制在配置的项目根目录内；新建远程会话不指定权限模式，由服务端使用用户的全局默认设置。恢复历史会话沿用原有权限模式，目录边界内的 `bypassPermissions` 会话也可恢复，恢复本身不会修改权限模式。Agent 输出中的本地图片只能从当前会话工作目录读取，远程图片 URL 不会由 Adapter 自动请求。

## 权限审批与消息表现

Claude 请求敏感权限时，Telegram 里会收到一条带按钮的消息，三个选项分别是允许一次、本次会话内永久允许同类操作、拒绝。只有当前待处理的请求才能被确认，点完结果直接回传给同一条桌面端会话。

模型通过 `AskUserQuestion` 提问时，Telegram 会发一张带选项按钮的卡片，按题目逐题作答。单题点选选项或直接发文字都会提交整份答案；多题点选会先收齐，到摘要页再点「提交全部」一次送出。也可以回复那条问题消息来定向作答。当前有多条待回答问题时，普通文字不会猜最新一条，需要先点选要回答的目标。

`/answer` 可以不带请求 ID：唯一待答时 `/answer Axios` 即可；多题用 JSON，键可以是完整问题文本，也可以是从 1 起的题号，例如 `/answer {"1":"React","2":"SQLite"}`。带上旧的 `/answer <id> {...}` 仍然有效。草稿只留在当前进程里，不会写进会话文件；`/stop` 会让当前提问失效但不会替你点拒绝，`/deny` 才会把拒绝回传给同一条桌面端会话。`/allow` 和 `/always` 不能用来回答提问。发送失败可以按最新卡片重试；已提交、已由桌面端处理或已结束的请求不能再答。

回复走一层流式缓冲：思考阶段先发占位消息，正文逐步累积更新，完成后按 Telegram 的长度上限分片发送。

## 发送语音、图片与文件

除了打字，你还可以从 Telegram 直接发图片、语音和文件过来。它们进入会话的方式不一样：

- **图片**：下载后直接内联进模型输入，模型能真正"看到"这张图，可以带说明文字一起发。
- **语音便签**：开启本地转写后，机器人先提示处理状态，在本机把语音转成文字，自动交给当前 Agent，并在发送成功后回显实际发送的文字，不增加确认步骤。未开启或识别失败时保留已下载的文件引用，并明确说明没有识别出语音。超过 5 分钟的语音便签会在下载前拒绝，此时不会转交文件。
- **音乐、录音等音频文件，以及文档、视频**：都按文件处理，只把文件落到本机、把路径交给会话。模型看到的是路径，但可以在会话里用工具读文件内容——引用不等于读不了，只是它不是直接的多模态输入。

超过大小限制的附件会被拒绝，机器人会回一条提示。

几点需要知道：

- Telegram 里只有"语音便签"（按住说话那类，协议里的 `message.voice`）会自动转写；以音频文件或文档形式发来的录音不会自动转写，只当普通文件。手打的原始文字也不会被转写或改写。
- 中文转写（`zh` 及别名 `zh-CN` / `zh-TW` / `ZH`；空白默认 `zh`）会给 whisper.cpp 注入一条初始 prompt。其默认文案为「以下是普通话的简体中文转录。」可用 `stt.whisperPrompt` 覆盖，`CC_STT_WHISPER_PROMPT` 环境变量优先；这两处留空时仍用默认值。`auto` 和非中文语言不注入。识别完成后没有简繁字典转换。这条 prompt 只是引导，不保证所有输出都是简体，也不保证纠错；它可能改变数字、标点和用字（例如把「请」写成「清」），没有独立的同音字纠错，「戴上」和「带上」仍可能混淆，请核对实际回显。转写在本机完成，不为此再调用额外的 LLM 或云端服务。转写文字会当普通用户消息送进会话，所以转写里即使出现 `/new`、`/allow` 之类字样，也不会被当成命令执行；语音也不会额外获得任何工具权限，改文件、跑命令照旧要走权限审批。
- 回显方便核对，但不是执行前确认。发现识别错误请立即发文字纠正，或用 `/stop` 停止；已经执行的操作不会自动撤销。`/stop` 也会取消尚未投递的排队输入，`/clear`、新建或切换会话会丢弃旧会话的待处理输入。
- 转写用的临时复制文件会清理；下载的原始音频保存在本机 `~/.claude/im-downloads/telegram/`，启动时清理超过 24 小时的旧文件，可能保留更久，不是转写后立即删除。
- 转写在本机离线完成，不调用第三方转写接口。但转写出的文字、你发的图片、以及 Agent 用工具读到的文件内容，仍可能发送给这条会话所选用的模型服务——离线转写不等于整条链路都不出本机。

### 开启本地语音转写（可选）

默认关闭，需要你自己装好依赖并改配置。它不随桌面端分发，也不会自动下载。

准备三样东西：

1. whisper.cpp 兼容的命令行程序，例如 `whisper-cli` 或 `whisper-cpp`。官方 Python 版 `whisper` 的 `whisper` 命令**不兼容**，不要用它。
2. FFmpeg，用来把 Telegram 的 OGG/Opus 音频转成标准 PCM。可以通过 `stt.ffmpegPath` 指定路径，留空时从 `PATH` 查找；桌面程序的 `PATH` 可能与终端不同。
3. 一个多语言 ggml 模型文件。中文不能用英文专用模型（文件名带 `.en` 的那种）。

然后在 `~/.claude/adapters.json` 里**只新增**一段 `stt`，不要动已有的字段：

```json
{
  "stt": {
    "provider": "whisper-local",
    "whisperPath": "/usr/local/bin/whisper-cli",
    "ffmpegPath": "/usr/local/bin/ffmpeg",
    "whisperModel": "~/.claude/whisper/ggml-base.bin",
    "language": "zh"
  }
}
```

| 键 | 说明 |
|---|---|
| `stt.provider` | 固定填 `whisper-local`；这是目前唯一的本地实现。留空或写错等于关闭转写。 |
| `stt.whisperPath` | whisper.cpp 兼容可执行文件的路径，或 `PATH` 上的命令名。留空时自动找 `whisper-cli`、`whisper-cpp`。 |
| `stt.ffmpegPath` | FFmpeg 可执行文件路径或命令名。留空时从 `PATH` 查找 `ffmpeg`。示例路径需替换成本机实际路径。 |
| `stt.whisperModel` | ggml 模型文件路径，支持 `~`。留空默认配置目录下的 `whisper/ggml-base.bin`（通常是 `~/.claude/whisper/ggml-base.bin`）。 |
| `stt.language` | 语言提示，默认 `zh`。空白同样按 `zh` 处理。 |
| `stt.whisperPrompt` | 仅中文（`zh` 及别名 `zh-CN` / `zh-TW` / `ZH`）时传给 whisper.cpp 的初始 prompt。留空使用默认「以下是普通话的简体中文转录。」 `auto` 和非中文不注入。 |

也可以改用环境变量，优先级高于配置文件：`CC_STT_PROVIDER`、`CC_STT_WHISPER_PATH`、`CC_STT_FFMPEG_PATH`、`CC_STT_WHISPER_MODEL`、`CC_STT_LANGUAGE`、`CC_STT_WHISPER_PROMPT`。优先级是环境变量 > `adapters.json` > 默认值。设置了 `CLAUDE_CONFIG_DIR` 时，配置文件位于该目录，而不是默认的 `~/.claude`。

改完配置要**重启 adapter** 才生效；桌面设置页里没有专门的语音转写面板，依赖和模型都要你自己装。限制方面：单条语音最长 5 分钟（按真实时长判断，超过会拒绝转写而不是截断），单次转写默认 60 秒超时。

## 本地开发启动

发布版桌面端会自动把 adapter 作为 sidecar 拉起。只有从源码运行或单独调试时才需要手动启动：

```bash
cd adapters
bun install
bun run telegram
```

可选的环境变量覆盖：

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## 常见问题

**adapter 启动时报缺少 Token**：`TELEGRAM_BOT_TOKEN` 和 `~/.claude/adapters.json` 里的 `telegram.botToken` 都没生效，回设置页把 Token 填好并保存。

**设置页能打开但机器人没反应**：源码运行时 webapp 只负责写配置，不会自动拉起 `bun run telegram`；发布版桌面端才会通过 sidecar 自动启动。

**发消息提示未授权**：检查是否已生成配对码、码是否还在 60 分钟有效期内、是否发到了正确的机器人私聊里。

**发了语音但没转成文字**：先确认 `~/.claude/adapters.json` 里 `stt.provider` 是 `whisper-local`，并且改完配置后重启过 adapter。再确认本机能执行 whisper.cpp 兼容程序和 FFmpeg、模型文件路径存在、中文用的是多语言模型（不是 `.en`）。这些问题会导致转写降级：已下载的音频保留文件引用，并提示没有识别出语音；下载失败、下载前超长拒绝或主动取消时不会转交文件。桌面设置页没有语音转写面板，这些都要手工配置。

**重启后会话没接回来**：检查 `~/.claude/adapter-sessions.json` 能否正常写入，以及桌面端里那条会话是否还在。

## 源码入口

`adapters/telegram/index.ts`，以及 `adapters/common/` 下的 `pairing.ts`、`session-store.ts`、`ws-bridge.ts`、`message-buffer.ts`、`format.ts`。
