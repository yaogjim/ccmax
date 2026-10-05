export const LOCAL_MESSAGE_SEND_TOOL_NAME = 'LocalMessageSend'

export const LOCAL_MESSAGE_SEND_DESCRIPTION =
  'LocalMessageSend delivers one message right now, on the user\'s behalf, to a single account that is already paired with this desktop app (Telegram or Feishu). The recipient is verified on the server against its paired-account records: an unpaired, unknown, or ambiguous recipient is rejected, and there is no default recipient and no broadcast. Call it only when the user explicitly asks you to send a message to a named recipient. Only available while the desktop app is running.'

/**
 * Tool guidance. Written for the model, so it must never contain the internal
 * bearer token, a request URL, or any hint about constructing a raw HTTP
 * request: the credential and the exact route stay inside the tool.
 */
export function buildLocalMessageSendPrompt(): string {
  return `Send a single immediate message to one paired recipient through the running desktop app's authenticated local API.

Call this tool (\`${LOCAL_MESSAGE_SEND_TOOL_NAME}\`) only when the user explicitly asks, in conversation, to send someone a message or notification right now — for example "message Alice on Telegram that the deploy finished" or "tell Fei One the report is ready". Do not call it on your own initiative, and do not use it to report your own progress.

## Arguments

- \`recipient\` — required for dedicated Telegram and for Feishu. The person to message: a platform user id (\`111\`, \`"ou_abc"\`) or an object \`{ "userId": ... }\` / \`{ "displayName": ... }\`. Use only an identifier the user gave you or one you saw in a previous result. Never guess, and never invent a person. Omit only when \`channel\` is \`telegram\` and \`entrypoint\` is \`public\`.
- \`channel\` — required. \`telegram\` or \`feishu\`.
- \`text\` — required. The exact message body, as the user wants it delivered.
- \`entrypoint\` — Telegram only, optional. \`dedicated\` (default) uses the paired dedicated bot. \`public\` sends a report through the public bot for the current session after the server verifies the owner subscription. It does not broadcast, does not fall back to the dedicated bot, and is invalid for Feishu. Do not pass a source session id — the runtime supplies the real session.

## Recipient safety

The server re-verifies every dedicated recipient against the accounts actually paired with this app. A recipient that is unknown, ambiguous, or no longer paired is rejected — the tool returns that failure and nothing is sent. There is deliberately no default recipient and no way to broadcast to everyone: if the user has not named who should receive a dedicated message, ask them instead of calling the tool.

A public Telegram send is routed by the current session's subscription, not by a guessed person. If public is not enabled or the session is not subscribed, the tool fails with that reason — do not retry on the dedicated bot.

When the public bot is enabled, a dedicated Telegram send is only allowed if the current session is the recipient's current dedicated binding. Otherwise the tool fails and you should tell the user to use the public entry or subscribe.

## Behavior

- On dedicated success, report who received the message and on which channel.
- On public Telegram success the tool reports that the report was queued and is not yet confirmed delivered. Never tell the user it was sent or delivered.
- If the tool returns an error, tell the user it was not delivered and relay the real reason. Never claim a message was sent when the tool reported a failure.
- If the tool reports that it is unavailable, the desktop app is not running. Say so instead of falling back to a shell command or a cloud messaging feature.
- The tool only sends text. It does not expose credentials, open a URL, or accept a destination the user did not name.`
}