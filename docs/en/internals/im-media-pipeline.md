---
title: IM message pipeline
nav_title: IM message pipeline
description: How a Telegram voice note passes authorization, offline transcription, session checks and a text echo before entering the existing Agent session.
order: 14
---

# IM message pipeline

The IM ingresses reuse ccmax's project session and Agent rather than standing up a second question-answering system. This page covers the inbound-media responsibilities, the contract for Telegram local voice transcription, and the boundaries you should keep apart when reading the code: capability versus verification.

## Scope and user-visible behavior

The implemented scope is **voice notes in Telegram private chats (`message.voice`)**. After an authorized user sends a voice note, the bot signals progress, transcribes locally, automatically sends the result to the currently bound Agent, and echoes the actual text after the WebSocket send succeeds. The echo is not a confirmation dialog; a later text correction does not automatically revoke an instruction that has already been sent.

- Music and recordings in `message.audio`, and audio uploaded as a document, stay ordinary files; they are not automatically replaced with transcript text. Media format and user intent are two different things.
- Images keep the existing inline input path; documents and video keep the file-reference path.
- WeChat uses `voice_item.text` from the protocol and takes the text the platform provides; it does not call this local transcription pipeline. When the platform provides no text, ccmax does not guarantee it can backfill a transcription.
- This change does not migrate Telegram's whole chat runtime, does not touch permission cards or the menu, and does not add group chats, mixed-message aggregation, PDF parsing, cloud transcription, or a model bundled with the app.

Local transcription processes user input. The Agent still handles tool calls under the existing permission model; voice grants no extra permissions. Text such as `/new` or `/allow` appearing in a transcript is not re-parsed as an IM management command.

## Capability boundary: a reference is not "cannot read"

The protocol-side `AttachmentRef` still has only `file | image`:

- An image enters the model's image block.
- An ordinary file enters the user message as `@"path"`. When tools and permissions allow, the Agent can read text, documents, or run the appropriate tool; this is not direct multimodal input, and it is not "every file is impossible to understand".
- An audio file reference on its own produces no transcript. Only a successful transcription yields voice text the Agent can use.

When audio transcription fails, the file reference is kept, but the notice must say clearly that **the voice content was not recognized**, and ask the user to resend text or check the local dependencies. Handing over a file must not be presented as the bot having understood.

Download staging happens locally. Local Whisper does not call a third-party transcription endpoint; the transcript text, images, and file content the Agent reads may still be sent to the model service selected for that session. Offline transcription does not make the whole Agent path offline.

## Module responsibilities

### Platform entrypoint

`adapters/telegram/index.ts` owns the private-chat check, pairing authorization, message dedup, session management, control commands, and the message return path. Media download can happen only after the private-chat, authorization and dedup checks pass.

`adapters/telegram/inbound.ts` extracts the lazy download needs from a Telegram message, forwards `voice.duration`, and calls the shared pipeline. The platform code knows "this is a voice note"; the shared pipeline does not guess from MIME whether it is a user instruction.

### Materialization and assembly

`LocalAttachment` keeps `kind: 'image' | 'file'` and adds `mediaKind?: 'voice'` and `durationSeconds?: number` only for the behavior that actually needs them. An untagged attachment maps to a protocol attachment unchanged.

`adapters/common/attachment/pipeline.ts` consumes materialized attachments and the original text and produces:

- the assembled user text;
- the attachment references still to be sent;
- user-visible notices;
- the transcript text actually merged in;
- the cancellation state.

This is an asynchronous processing module with an injectable transcription dependency, not a mathematically pure function. Notice output is separated from the platform SDK, and cancellation and timeouts are part of the interface contract.

### Local transcription

The `TranscriptionProvider` call input includes the audio bytes, MIME, optional filename and language, a duration ceiling, and an `AbortSignal`. Expected failures return a structured reason; cancellation must stop the work and finish resource cleanup — it must not be a Promise that never settles.

The `whisper-local` order of operations:

1. Locate a whisper.cpp-compatible CLI, FFmpeg, and the user-provided model file; it downloads nothing and installs nothing.
2. Write the audio into a private temporary directory.
3. Use FFmpeg to convert to 16 kHz mono 16-bit PCM WAV. Decode at most the duration ceiling plus one second, and use that one second to detect over-long input; over-long input is refused transcription rather than truncated and passed off as a complete result.
4. Validate the WAV's actual data length and duration.
5. Call whisper.cpp's `-otxt -of` output contract and read the separate text file. stdout/stderr are bounded diagnostics only. For Chinese only, `--prompt` is also passed; `auto` and non-Chinese languages do not receive it.
6. Wait for the child process to exit and delete the temporary directory produced by this decode and transcription.

The Python `whisper` console script is not treated as whisper.cpp. Different CLIs differ in arguments, model format, and output; "the file is executable" does not mean "the implementation is compatible". The default language is `zh`; Chinese cannot use an English-only `.en` model. Chinese languages inject the default Simplified-Chinese guidance prompt; there is no post-recognition dictionary conversion.

## Ordering, control commands and session ownership

Ordinary user input enters each chat's own processing queue in receipt order; a slow voice note received first must not be overtaken by text received later. Control commands and permission answers use the existing short-operation queue and do not wait for transcription to finish.

Each inbound task has its own cancellation signal and session ownership. Session operations must obey:

- `/stop` cancels input not yet handed to the Agent and stops the current generation.
- `/clear`, creating a new session, or switching sessions invalidates previously pending input; a late transcription result must not be written into a cleared context or a new session.
- A reconnect on the same session does not automatically change ownership; session, authorization and connection state are re-checked before sending.
- Permission callbacks and `/answer` are not held up in the queue by long local transcription.
- On adapter shutdown, pending work is cancelled and child processes reclaimed. `stopTelegramAdapter()` returns an awaitable Promise; the `SIGINT` and `SIGTERM` handlers wait for in-flight transcription cancellation and cleanup before exiting, rather than exiting immediately after requesting cancellation and leaving local processes behind.

Transcription runs at most 2 jobs globally, with at most 8 additional waiting jobs. Each chat accepts at most 8 unfinished ordinary inputs, counted from receipt rather than execution. A full chat queue rejects new input; a full transcription queue falls back to a file. Downloads run inside the authorized, deduplicated chat queue, so jobs that have not started do not retain audio bytes.

These constraints do not promise exactly-once across a process crash. A successful WebSocket write and the Agent having finished processing are different events; a failed send does not automatically retry an operation with an unknown outcome.

## Text normalization and echo

Transcription, text normalization, and execution are separate responsibilities:

- For Chinese only (`zh` and aliases `zh-CN` / `zh-TW` / `ZH`; blank defaults to `zh`), whisper.cpp receives a `--prompt` initial prompt. The default is "以下是普通话的简体中文转录。" `stt.whisperPrompt` can override it; `CC_STT_WHISPER_PROMPT` takes priority. A blank environment value falls back to the file configuration; an absent or whitespace-only effective prompt uses that default. `auto` and non-Chinese languages do not inject a prompt. There is no post-recognition Traditional/Simplified dictionary conversion. Original typed text and ordinary audio files are not processed. The shared pipeline still trims surrounding whitespace and normalizes line breaks.
- The prompt is only a recognition hint. It does not guarantee Simplified output or corrections. It can change numbers, punctuation, and word choice (for example 请 → 清). There is no separate homophone-correction step, so 戴上 and 带上 can still be confused; verify the actual echo. It does not call an extra LLM or a cloud service to polish or correct the text.
- Punctuation comes first from the recognition engine. Without evidence it does not guess homophones or rewrite intent.
- Proper-noun boosting requires validating the selected engine's hotword or prompt parameters before it is introduced; the current implementation does not claim to provide it.
- The echo must contain the text actually sent, sent as plain text, so transcript content cannot accidentally trigger Telegram Markdown/HTML formatting.
- Beyond Telegram's single-message length limit it reuses the existing splitter.

A notice that only says "transcribed the file" is not enough for the user to spot an error. A successful transcription also does not mean the instruction is safe or accurately recognized; tool operations still go through the existing approval.

## Limits and degradation

The duration ceiling is **300 seconds**. Telegram's `voice.duration` is used for a pre-download check, and the normalized WAV's actual duration is used for the second check. Compressed byte count cannot be converted into a reliable duration.

The transcription pipeline's default time budget is **60 seconds**. A timeout triggers cancellation and releases the concurrency slot only after the child process has closed and cleanup has run; cleanup may have a short grace period, so 60 seconds is not an exact guarantee of the message return time. Download needs its own independent time and byte bounds; it must not wait forever or read a whole file before discovering it is over the limit.

Missing configuration, engine/model/decoder, unsupported format, empty output, corrupt audio, excessive duration, timeout, oversized output, and process failures degrade explicitly. An empty transcript is not success. There is currently no independent voice-activity detector, so the recognition engine can still hallucinate text for silence or noise; echo and permission checks do not replace evaluation with real samples.

When Telegram metadata already reports more than 300 seconds, the voice is refused before download; no file handover is claimed. Other degradation keeps the successfully downloaded file and original text, states that recognition failed, and claims file handover only after the WebSocket send succeeds. User cancellation is different: neither the audio nor a late transcript is delivered as fallback.

The copied input, normalized WAV and transcript output are cleaned up on success, failure and cancellation. Original downloads are stored under `~/.claude/im-downloads/telegram/`. Telegram startup calls `AttachmentStore.gc()` to remove files older than the default 24 hours; this is startup-triggered cleanup, not precise expiry. Files can remain longer during uninterrupted operation or while the app is stopped. Omitting a successfully transcribed voice from protocol attachments does not delete its original audio immediately.

## Implementation dependencies and stage boundaries

Stages advance through independently verifiable capabilities rather than directories. The earlier plan put platform end-to-end acceptance before the real transcriber, making Phase 2 depend on Phase 3. Helper assembly results alone cannot prove entrypoint behavior.

| Stage | Delivery boundary | Required evidence | Dependency |
|---|---|---|---|
| Phase 1: minimal media contract | Voice-note marker, transcription result, text assembly, fallback and cancellation signal | Isolated fake-provider regressions; unchanged ordinary image/file behavior | None |
| Phase 2: runnable local processing | FFmpeg normalization, whisper.cpp file output, actual duration, process cleanup, explicit configuration and old-config compatibility | Fake CLI/decoder process tests; config and write-preservation regressions; real decoding evidence tracked separately | Phase 1 |
| Phase 3: Telegram integration | Actual authorization/dedup entrypoint, bounded queues, command cancellation, session ownership, automatic delivery and plain-text echo | grammY entrypoint with local WebSocket integration tests; relevant repository gates; real recognition and platform smoke tracked separately | Phases 1 and 2 |

The earlier Phase 2 (Telegram wiring) maps to the current Phase 3, and the earlier Phase 3 (local engine) maps to the current Phase 2. Existing code can be retained and repaired, but file existence, passing helpers and historical gate logs do not establish stage completion. Real recognition quality, the real Telegram service and cross-operating-system behavior are always reported separately from offline integration tests.

## Configuration and runtime environment

Transcription is off by default. Only an explicit `whisper-local` configuration calls the local program. Configuration priority is environment variable, `adapters.json`, default; the adapter must be restarted after a configuration change.

The minimum configuration is the provider, a compatible CLI, the FFmpeg decoder, and a multilingual model. Settings currently offers no model download and no dedicated transcription panel; for how to configure it, see [Telegram Integration](../im/telegram.md).

Forward compatibility is handled at the loading boundary: old files without `stt` receive disabled defaults and need no rewrite or global schema marker. Desktop settings and pairing writes preserve the entire `stt` object, including unknown nested fields. Environment overrides affect runtime only, not the stored file. Invalid providers or field types produce explicit diagnostics.

`stt.whisperPath` / `CC_STT_WHISPER_PATH` select the recognition executable; `stt.ffmpegPath` / `CC_STT_FFMPEG_PATH` select the decoder; `stt.whisperModel` / `CC_STT_WHISPER_MODEL` select the model; `stt.language` / `CC_STT_LANGUAGE` select the language; `stt.whisperPrompt` / `CC_STT_WHISPER_PROMPT` select the Chinese initial prompt (blank uses the default guidance). The desktop process can have a different `PATH` from a terminal, so explicit executable paths are more reliable.

The child process uses an argument array and never builds a command through shell concatenation; it inherits only the environment variables it needs and not the Bot Token or model-service credentials. Tests must not depend on a real model, credentials, or the default user directory on the machine.

## Extension and verification boundaries

Adding a platform still requires that platform's authorization, dedup, metadata extraction, download, and session wiring; calling one shared function does not fill in a platform protocol by itself. The existing `InboundChatMessage` and `ImChatRuntime` do not need another generic message bus.

A future transcription provider can reuse the cancellation, duration and structured-result contract; widen the semantic types when there is a second real use case. Today it does not introduce the unused five-way media enum, a handler registry, or automatic multi-provider failover retries.

Verification has three layers that cannot substitute for each other:

1. Pipeline and process contract tests: use a fake provider, fake compatible CLI/FFmpeg, and a temporary config dir to verify text, duration, cancellation, resource cleanup, and degradation.
2. Inbound wiring tests: drive the actual grammY entrypoint through authorization, a real local WebSocket, and a mock session to verify send, echo, ordering, cancellation, and recovery. A helper test alone is not a "full path into the model".
3. Real recognition verification: use explicitly authorized Chinese OGG/Opus samples, a specified binary and model, and record recognition errors and end-to-end latency. A fake program emitting fixed Chinese does not prove real recognition quality, the silence-hallucination rate, or cross-platform compatibility.

FFmpeg installation, executable discovery, and process termination behavior need separate verification on macOS, Linux and Windows. When platform evidence is missing, report it as unverified rather than writing a skipped test down as passing. Real recognition and a real Telegram smoke test require separate authorization and are not part of the required offline gate.
