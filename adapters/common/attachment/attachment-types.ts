/**
 * Shared attachment types for IM adapters.
 */

import type { AttachmentRef } from '../ws-bridge.js'
export type { AttachmentRef }

/** Platform tag — used for local staging subdir and telemetry. */
export type ImPlatform =
  | 'feishu'
  | 'telegram'
  | 'wechat'
  | 'dingtalk'
  | 'whatsapp'
  | 'wecom'
  | 'qq'
  | 'slack'

/** Result of downloading an IM resource into the local stage dir. */
export interface LocalAttachment {
  kind: 'image' | 'file'
  /**
   * Optional media semantics for the shared inbound pipeline. Only voice
   * notes (`message.voice`) are marked `'voice'` and auto-transcribed; the
   * wider MediaKind set from docs/internals/im-media-pipeline.md is
   * deliberately deferred. `kind` stays the wire-routing field. Ordinary
   * audio files are left unmarked so they pass through as file references.
   */
  mediaKind?: 'voice'
  /** Platform-reported media duration in seconds (Telegram `voice.duration`). */
  durationSeconds?: number
  name: string        // original filename, or synthesized if none
  path: string        // absolute path on disk (under ~/.claude/im-downloads)
  size: number        // bytes
  mimeType: string    // detected or provided
  buffer: Buffer      // raw bytes (kept so caller can choose base64 vs path)
}

/** Pending outbound media found in Agent stream output. */
export interface PendingUpload {
  id: string          // fingerprint, used for dedup
  source:
    | { kind: 'base64'; data: string; mime: string }
    | { kind: 'path'; path: string; mime?: string }
    | { kind: 'url'; url: string; mime?: string }
  alt?: string
}
