---
title: 环境变量
nav_title: 环境变量
description: 认证、模型、Azure、本地运行相关的环境变量与实际生效顺序。
order: 2
---

# 环境变量

ccmax 有两条配置路径：

- 桌面端用户优先在 **设置 → 服务商** 中选择、测试并激活提供商。应用会管理对应的认证、模型映射和协议代理。
- 从源码运行 CLI 时，可以使用 `.env`、Shell 环境变量或 Claude Code 的 `settings.json`。

不要在多个位置重复保存同一把 API Key。排查问题时，先确认当前是否激活了桌面端 Provider。

## 常用变量

### Anthropic 兼容接口

| 变量 | 必填 | 说明 |
|------|------|------|
| `ANTHROPIC_API_KEY` | 与 Auth Token 二选一 | 通过 `x-api-key` 请求头发送 |
| `ANTHROPIC_AUTH_TOKEN` | 与 API Key 二选一 | 通过 `Authorization: Bearer` 请求头发送 |
| `ANTHROPIC_BASE_URL` | 否 | Anthropic Messages 兼容端点的基础地址 |
| `ANTHROPIC_MODEL` | 否 | 当前会话的默认模型 |
| `ANTHROPIC_DEFAULT_FABLE_MODEL` | 否 | Fable 模型槽位；仅在提供商支持时配置 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 否 | Haiku 模型槽位 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | 否 | Sonnet 模型槽位 |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | 否 | Opus 模型槽位 |
| `API_TIMEOUT_MS` | 否 | API 请求超时，单位为毫秒；默认 `600000` |

认证变量取决于服务端要求的请求头，不能仅凭提供商名称判断。如果返回 `401`，先核对服务商文档和桌面端 Provider 的认证策略。

### Azure OpenAI

Azure OpenAI 使用独立的 Responses API 路径：

| 变量 | 必填 | 说明 |
|------|------|------|
| `CLAUDE_CODE_USE_AZURE_OPENAI` | 是 | 设为 `1` 启用 Azure OpenAI |
| `AZURE_OPENAI_BASE_URL` | 是 | Azure 资源基础地址；也接受 `AZURE_OPENAI_ENDPOINT` |
| `AZURE_OPENAI_API_VERSION` | 否 | API 版本；默认 `2025-04-01-preview` |
| `AZURE_OPENAI_API_KEY` | 是 | Azure OpenAI API Key |
| `AZURE_OPENAI_CODEX_DEPLOYMENT` | 视模型而定 | Codex 模型对应的 Azure deployment 名称 |

示例：

```ini
CLAUDE_CODE_USE_AZURE_OPENAI=1
AZURE_OPENAI_BASE_URL=https://your-resource.cognitiveservices.azure.com
AZURE_OPENAI_API_VERSION=2025-04-01-preview
AZURE_OPENAI_API_KEY=your_azure_openai_key
AZURE_OPENAI_CODEX_DEPLOYMENT=your_codex_deployment
```

### 定时任务超时

每个任务的运行时限在「新建任务 / 编辑任务」窗口的「单次执行超时（秒）」里单独填写，可以留空。默认 600 秒（10 分钟），填 `1800` 表示 30 分钟；超时后 CLI 子进程被终止，这次运行记录标记为 `timeout`。该值以毫秒整数 `timeoutMs` 保存在任务文件 `scheduled_tasks.json`（默认 `~/.claude/scheduled_tasks.json`）中，随任务一起读取，因此不受从 Finder、Dock 还是终端启动的影响。

保存后无需重启应用：后续运行使用新值，已经开始的那次运行保持原时限。清空该字段（或在接口更新时传 `null`）会删除任务级覆盖，重新沿用下面的环境变量或默认值。

优先级为：任务的 `timeoutMs` → Server 进程环境变量 `CC_HAHA_TASK_TIMEOUT_MS` → 默认 `600000` 毫秒。任务值和环境变量都接受 `1`–`2147483647` 的整数毫秒；保存任务时会拒绝非法值，执行时若读取到手工改坏的任务值或非法环境变量，则回退到下一层。界面按秒填写，可以精确到毫秒（例如 `0.5` 表示 500 毫秒）；`0` 不代表无限运行。

环境变量仍是兼容入口，需在启动 ccmax 前设置；它只在该任务没有有效覆盖值时生效。macOS 上先正常退出已运行的应用，再在终端中启动，例如设置为 30 分钟：

```bash
CC_HAHA_TASK_TIMEOUT_MS=1800000 /Applications/ccmax.app/Contents/MacOS/ccmax
```

从源码启动本地 Server 时，同样把该变量放在启动命令前。Finder 或 Dock 启动不会自动继承终端里的 `export`；也不能依赖 CLI 的 `settings.json.env` 为 Server 设置这个值。

这个时限与 `API_TIMEOUT_MS` 的单次模型请求超时不同，也不限制普通 IM 聊天回合。调大任务时限不会修复模型、网络或等待用户回答的问题，建议保留有限时限。

### 本地运行与隐私

| 变量 | 说明 |
|------|------|
| `CLAUDE_CONFIG_DIR` | 改用指定配置目录，而不是默认的 `~/.claude`；适合便携模式和隔离测试 |
| `CLAUDE_CODE_FORCE_RECOVERY_CLI` | 设为 `1` 使用简化的 Recovery CLI |
| `CLAUDE_CODE_SHELL_PREFIX` | 为 Bash 工具增加 Shell 前缀，例如 Windows 下的 `wsl -e bash -lc` |
| `DISABLE_TELEMETRY` | 设为 `1` 禁用遥测 |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 设为 `1` 禁用非必要网络请求 |

本地 Server 的 `SERVER_HOST`、`SERVER_PORT`、`SERVER_AUTH_REQUIRED` 等变量见 [本地 Server](../internals/server.md)。

## 配置方式

### 桌面端 Provider

桌面端把 Provider 索引保存到：

```text
~/.claude/cc-haha/providers.json
```

应用管理的 Provider 环境写入隔离的 ccmax 配置，不需要手工复制到 `~/.claude/settings.json`。当 CLI 读取到已激活的 Provider 时，会复用其认证、模型和协议设置；`openai_chat` 与 `openai_responses` Provider 会自动使用本机回环代理。

详细流程见 [第三方模型](../start/models.md)。

### `.env` 文件

源码仓库中的 `bin/ccmax` 会在项目根目录存在 `.env` 时加载它：

```bash
cp .env.example .env
```

一个 Anthropic 兼容接口的最小示例：

```ini
ANTHROPIC_AUTH_TOKEN=sk-example
ANTHROPIC_BASE_URL=https://provider.example.com/anthropic
ANTHROPIC_MODEL=provider-model
ANTHROPIC_DEFAULT_HAIKU_MODEL=provider-model
ANTHROPIC_DEFAULT_SONNET_MODEL=provider-model
ANTHROPIC_DEFAULT_OPUS_MODEL=provider-model
```

`.env` 只用于源码启动脚本。桌面端创建的 CLI 子进程会跳过仓库 `.env`，避免旧密钥覆盖当前激活的 Provider。

### `settings.json`

用户级设置位于 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-example",
    "ANTHROPIC_BASE_URL": "https://provider.example.com/anthropic",
    "ANTHROPIC_MODEL": "provider-model"
  }
}
```

项目还可能包含 `.claude/settings.json` 或 `.claude/settings.local.json`。这些文件属于工作区输入；只在可信项目中使用，尤其不要从不可信仓库接受 `PATH`、`LD_PRELOAD`、代理地址或认证相关环境变量。

## 实际生效顺序

这里不存在可靠的“Shell > `.env` > settings”三段式规则：

1. `bin/ccmax` 先让 Bun 加载仓库 `.env`。
2. CLI 初始化时合并已启用的用户、项目、本地、命令行和受管设置来源。
3. 已激活的 ccmax Provider 会覆盖普通 Claude 设置中的 Provider 路由变量，防止两个客户端互相污染。
4. 桌面端 host 注入的运行时变量受到保护，不能被 `settings.json` 中的同名字段替换。
5. 企业受管策略和 `--setting-sources` 也会影响最终结果。

因此，切换模型提供商时应只保留一个主要配置入口。桌面端用户使用 Providers 设置页；纯 CLI 用户使用 `.env` 或用户级 `settings.json` 之一。

## 安全建议

- 不要提交 `.env`、Provider 配置或包含密钥的 `settings.json`。
- 不要在截图、Issue、日志或诊断包中暴露完整 Token。
- 使用 `CLAUDE_CONFIG_DIR` 做测试隔离，避免读写真实用户配置。
- `--print` 会跳过工作区信任对话框，只能在可信目录运行。更多限制见 [CLI 参考](./reference.md)。
- 远程访问本地 Server 时，不要把 CORS 当成身份认证；请启用 H5 Token 或显式鉴权。
