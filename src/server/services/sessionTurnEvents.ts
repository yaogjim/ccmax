import { EventEmitter } from 'node:events'

export type SessionTurnOrigin = {
  entrypoint: 'telegram-public' | 'telegram-dedicated' | 'desktop'
  botId?: number
  generation?: number
  userId?: number
  chatId?: string
  turnId: string
}

export type SessionTurnContext = { turnId: string; origin: SessionTurnOrigin }
export type SessionTurnEvent = (
  | { type: 'user-input' | 'input-committed' | 'stopped'; sessionId: string }
  | { type: 'output'; sessionId: string; message: Record<string, any> }
) & { turnId?: string; origin?: SessionTurnOrigin; eventId?: string }

const turnContexts = new Map<string, SessionTurnContext>()
const permissionOrigins = new Map<string, Map<string, SessionTurnOrigin>>()
const outputIds = new WeakMap<object, string>()

export function beginSessionTurn(sessionId: string, origin: SessionTurnOrigin): void {
  turnContexts.set(sessionId, { turnId: origin.turnId, origin: { ...origin } })
}

export function getSessionTurnContext(sessionId: string): SessionTurnContext | undefined {
  return turnContexts.get(sessionId)
}

export function getSessionPermissionOrigin(sessionId: string, requestId: string): SessionTurnOrigin | undefined {
  return permissionOrigins.get(sessionId)?.get(requestId)
}

export function clearSessionTurnContext(sessionId: string): void {
  turnContexts.delete(sessionId)
  permissionOrigins.delete(sessionId)
}

// The transport owns turn admission. Collaboration observes it without making
// the WebSocket handler depend on its persistence or HTTP implementation.
const events = new EventEmitter()

export function emitSessionTurnEvent(event: SessionTurnEvent): void {
  const context = event.turnId ? undefined : turnContexts.get(event.sessionId)
  const enriched: SessionTurnEvent = { ...context, ...event }
  if (event.type === 'output') {
    const message = event.message
    const requestId = typeof message.request_id === 'string' ? message.request_id : undefined
    const isRequest = message.type === 'control_request' && message.request?.subtype === 'can_use_tool'
    if (isRequest && requestId && enriched.origin) {
      let requests = permissionOrigins.get(event.sessionId)
      if (!requests) permissionOrigins.set(event.sessionId, requests = new Map())
      requests.set(requestId, enriched.origin)
    }
    if (message.type === 'control_response' && requestId) {
      permissionOrigins.get(event.sessionId)?.delete(requestId)
    }
    let id = typeof message.uuid === 'string' && message.uuid ? message.uuid : outputIds.get(message)
    if (!id) {
      id = requestId ? `${message.type}:${requestId}` : crypto.randomUUID()
      outputIds.set(message, id)
    }
    enriched.eventId ??= `${event.sessionId}:${id}`
  }
  events.emit('event', enriched)
}

export function observeSessionTurns(listener: (event: SessionTurnEvent) => void): () => void {
  events.on('event', listener)
  return () => { events.off('event', listener) }
}

export type SessionTurnAdmissionLease = { release(): Promise<void> }
type AdmissionGuard = (sessionId: string, canAdmit: () => boolean) => Promise<SessionTurnAdmissionLease>
let admissionGuard: AdmissionGuard | undefined

export function registerSessionTurnAdmissionGuard(guard: AdmissionGuard): () => void {
  admissionGuard = guard
  return () => { if (admissionGuard === guard) admissionGuard = undefined }
}

export async function admitSessionUserTurn(sessionId: string, canAdmit: () => boolean): Promise<SessionTurnAdmissionLease> {
  if (admissionGuard) return admissionGuard(sessionId, canAdmit)
  return { release: async () => {} }
}
