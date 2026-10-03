# Adapter Instructions

These rules apply to `adapters/` changes in addition to the root instructions.

- Reuse shared adapter utilities and keep platform-specific behavior within the relevant platform package.
- New text-chat platforms build on `common/chat-runtime.ts` and supply a `ChatPort`; do not re-implement pairing, command routing, or the server-stream translation per platform.
- Inbound media should be described as media candidates (`LocalAttachment` with a `mediaKind`), not assembled into wire `AttachmentRef` per platform; the shared pipeline owns text/attachment assembly. See `docs/internals/im-media-pipeline.md`. (Design: this lands with the media pipeline; until then, follow the existing per-platform attachment code.)
- Install adapter dependencies in `adapters/` on a fresh checkout; do not change root dependencies for an adapter-only task without a verified need.
- Add focused tests for the affected adapter, then follow `bun run check:impact`; adapter changes normally select `bun run check:adapters`.
- Required tests must not call real messaging platforms or use saved accounts/tokens. Use fixtures, mocked transports, and temporary session/config paths.
- Do not read or mutate the user's real adapter bindings or session files during tests.
