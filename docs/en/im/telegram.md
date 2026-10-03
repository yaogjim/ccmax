---
title: Telegram Integration
nav_title: Telegram
description: Get a Bot Token from BotFather, paste it into Desktop, and approve permissions with native buttons.
order: 2
---

# Telegram Integration

The fastest of the eight to set up: ask `@BotFather` for a token, paste it into Desktop, done. Permission requests come back as native buttons. It accepts private chats only; groups are not supported.

## Create a bot

In Telegram, open the official `@BotFather` account and send `/newbot`. Then:

1. Choose a display name, for example `ccmax Bot`.
2. Choose a username in Latin letters ending in `_bot`, for example `jiang_cc_hah_bot`.
3. Copy the **Bot Token** that BotFather returns.

That token is the bot's password. Do not paste it anywhere public.

## Enter the token in Desktop

1. Open **Settings → IM Adapters** and select the **Telegram** tab.
2. Paste the value into **Bot Token**.
3. Select **Save**.

**Allowed Users** can stay empty. When it is, only paired accounts are accepted. To allowlist a known account directly, enter its numeric Telegram user ID; separate several with commas.

## Pair your account

At the top of the page, under **Pairing**, select **Generate Code**. The six-character code takes effect immediately — no separate save.

Send any message to your new bot, then send the code when prompted. Once pairing is confirmed you can talk to Claude Code directly.

Codes are valid for 60 minutes, work once, and are invalidated when a new one is generated. Repeated failures are rate limited; wait a few minutes before retrying.

## Commands

- `/start` — show help and available commands
- `/help` — show available commands
- `/projects` — list recent projects and switch
- `/resume` — choose and restore a previous session
- `/status` — project, model, run state, and task summary
- `/new` — clear the current binding and choose a project again
- `/clear` — clear context, keep the project binding
- `/stop` — stop the current generation
- `/provider` — view or switch the provider
- `/model [model]` — view or switch the model
- `/skills` — list project Skills and invoke one by selecting it
- `/answer <id> <answer>` — answer a model question; for multiple questions, send JSON keyed by the full question text

## Agent capabilities and boundaries

Telegram is not a separate question-and-answer model. Regular messages and Skills selected from `/skills` enter the same Claude Code Agent session for the current project, so they retain multi-turn context and can use the file, terminal, Git, Skill, and MCP tools already available to that session. Selecting a Skill sends its `/<skill-name>` invocation into the Agent, where the existing Skill system loads `SKILL.md` and continues the task.

These capabilities are intended for one trusted user remotely controlling their own machine. A paired account receives the full Agent capabilities available in the selected project. Permission prompts are an operation gate, not an operating-system sandbox. Do not expose the Bot to public groups or untrusted accounts, and do not install unreviewed Skills, Plugins, or MCP servers from chat.

The adapter accepts private chats only from paired or allowlisted accounts. Project lists, name matching, and historical session restore are restricted to the configured project root. New remote sessions omit the permission mode so the server uses the user's global default. Restoring history preserves the existing permission mode, including `bypassPermissions` sessions inside the allowed roots; restoration itself does not change that mode. Local images in Agent output must resolve inside the active session work directory; the Adapter never fetches remote image URLs from Agent-authored text.

## Approval and reply behavior

A permission request arrives as a message with three buttons: allow once, always allow the matching operation for this session, and deny. Only a currently pending request can be confirmed, and the choice is converted to a `permission_response` for that same Desktop session.

When the model asks through `AskUserQuestion`, the message shows the full questions and options and offers only a deny button. For one question, use `/answer <id> <answer>` with an option label or your own text. Separate multiple selections with commas; numbers are not automatically mapped to options. For multiple questions, submit all answers in one JSON object, for example `/answer <id> {"Frontend framework?":"React","Database?":"SQLite"}`, using the exact full question texts as keys. Ordinary chat messages and allow buttons do not submit answers. Failed sends can be retried; submitted, Desktop-resolved, or expired requests cannot be answered again.

Replies pass through a streaming buffer: a placeholder can be sent while Claude is thinking, text deltas accumulate in place, and completed text is split into platform-sized messages.

## Sending voice, images, and files

Beyond typing, you can send images, voice notes, and files straight from Telegram. They reach the session differently:

- **Images**: downloaded and inlined into model input, so the model genuinely "sees" the picture. A caption can ride along.
- **Voice notes**: with local transcription enabled, the bot shows progress, transcribes on your machine, sends the result automatically to the current Agent, and echoes the actual text after a successful send. There is no confirmation step. When transcription is off or fails, the downloaded audio remains a file reference and the bot explicitly reports that recognition failed. Voice notes over 5 minutes are refused before download, so no file is handed over in that case.
- **Music and other audio files, documents, and video**: all treated as files, landing on your machine with only a path handed to the session. The model sees a path, but it can read the file content with tools — a reference is not the same as "cannot read", it is just not direct multimodal input.

Attachments over the size limit are rejected with a message from the bot.

A few things to know:

- Only the Telegram voice note (the hold-to-talk kind, `message.voice` in the protocol) is auto-transcribed. A recording sent as an audio file or a document is not transcribed automatically and is treated as an ordinary file. Typed original text is not transcribed or rewritten.
- For Chinese (`zh` and aliases `zh-CN` / `zh-TW` / `ZH`; blank defaults to `zh`), whisper.cpp receives an initial prompt. The default is "以下是普通话的简体中文转录。" You can override it with `stt.whisperPrompt`; `CC_STT_WHISPER_PROMPT` takes priority. A blank value still uses the default. `auto` and non-Chinese languages do not inject a prompt. There is no post-recognition Traditional-to-Simplified dictionary conversion. The prompt is only a hint: it does not guarantee Simplified Chinese or corrections, and it can change numbers, punctuation, and word choice (for example 请 → 清). There is no separate homophone correction, so 戴上 and 带上 can still be confused; check the actual echo. This path does not call an extra LLM or a cloud service. The transcript is sent as an ordinary user message, so even if it contains something like `/new` or `/allow` it is not executed as a command. A voice note also grants no extra tool permissions — file writes and commands still go through approval.
- The echo helps you verify recognition; it is not a pre-execution confirmation. Send a text correction or use `/stop` if recognition is wrong. Completed actions are not automatically undone. `/stop` also cancels queued input not yet delivered; clearing, creating or switching sessions drops pending input for the old context.
- Transcription copies are cleaned up. Original audio remains under `~/.claude/im-downloads/telegram/`; startup removes files older than 24 hours, but retention can be longer. Successful transcription does not delete the original immediately.
- Transcription runs offline on your machine and calls no third-party transcription endpoint. The transcript text, the images you send, and file content the Agent reads with tools may still be sent to the model service selected for that session — offline transcription does not mean the whole path stays off the network.

### Enabling local voice transcription (optional)

Off by default. You install the dependencies and change the configuration yourself; nothing is bundled with Desktop and nothing is downloaded for you.

Three things to prepare:

1. A whisper.cpp-compatible command-line program, such as `whisper-cli` or `whisper-cpp`. The official Python `whisper` package's `whisper` command is **not compatible**; do not use it.
2. FFmpeg, to convert Telegram's OGG/Opus audio into PCM. Set `stt.ffmpegPath` explicitly, or leave it empty to search `PATH`. Desktop can have a different `PATH` from your terminal.
3. A multilingual ggml model file. Chinese cannot use an English-only model (the kind with `.en` in the filename).

Then **add only** an `stt` block to `~/.claude/adapters.json`, leaving existing fields untouched:

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

| Key | Meaning |
|---|---|
| `stt.provider` | Always `whisper-local`; it is the only local implementation today. Empty or misspelled means transcription is off. |
| `stt.whisperPath` | Path to the whisper.cpp-compatible executable, or a command name on `PATH`. Empty probes `whisper-cli`, then `whisper-cpp`. |
| `stt.ffmpegPath` | FFmpeg executable path or command name. Empty probes `ffmpeg` on `PATH`. Replace example paths with the actual paths on your machine. |
| `stt.whisperModel` | ggml model path; `~` is expanded. Empty defaults to `whisper/ggml-base.bin` in the config directory, normally `~/.claude/whisper/ggml-base.bin`. |
| `stt.language` | Language hint; defaults to `zh`. Blank is treated as `zh`. |
| `stt.whisperPrompt` | Initial prompt passed to whisper.cpp for Chinese only (`zh` and aliases `zh-CN` / `zh-TW` / `ZH`). Empty uses the default "以下是普通话的简体中文转录。" `auto` and non-Chinese languages do not inject it. |

You can use environment variables instead: `CC_STT_PROVIDER`, `CC_STT_WHISPER_PATH`, `CC_STT_FFMPEG_PATH`, `CC_STT_WHISPER_MODEL`, `CC_STT_LANGUAGE`, `CC_STT_WHISPER_PROMPT`. Priority is environment > `adapters.json` > defaults. When `CLAUDE_CONFIG_DIR` is set, the configuration lives there instead of the default `~/.claude`.

**Restart the adapter** after changing the configuration. Desktop Settings has no dedicated transcription panel, so you install the dependencies and model yourself. On limits: a single voice note is capped at 5 minutes (judged by real duration, refused rather than truncated), and one transcription times out after 60 seconds by default.

## Development

Packaged Desktop starts the sidecar automatically. Run it by hand only when working from source:

```bash
cd adapters
bun install
bun run telegram
```

Optional overrides:

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

## Troubleshooting

**The adapter reports a missing token.** Neither `TELEGRAM_BOT_TOKEN` nor `telegram.botToken` in `~/.claude/adapters.json` took effect. Re-enter the token in Settings and save.

**Settings opens but the bot does nothing.** When running from source, the web app only writes configuration; it does not launch `bun run telegram`. Packaged Desktop starts the sidecar for you.

**A sender is rejected.** Confirm a code was generated, that it is within its 60-minute window, and that it was sent to the correct bot in a private chat.

**A voice note was not transcribed.** First confirm `stt.provider` is `whisper-local` in `~/.claude/adapters.json` and that you restarted the adapter after the change. Then confirm the machine can run a whisper.cpp-compatible program and FFmpeg, that the model path exists, and that a multilingual model is used for Chinese (not an `.en` one). These failures fall back to a file reference for audio that was downloaded successfully, with a recognition-failure notice. Failed downloads, pre-download duration rejection and user cancellation do not hand over a file. Desktop Settings has no transcription panel, so dependencies are configured manually.

**Session not restored after a restart.** Verify that `~/.claude/adapter-sessions.json` is writable and that the session still exists in Desktop.

## Source

`adapters/telegram/index.ts`, plus `pairing.ts`, `session-store.ts`, `ws-bridge.ts`, `message-buffer.ts`, and `format.ts` under `adapters/common/`.
