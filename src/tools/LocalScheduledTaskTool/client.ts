/**
 * Client for the desktop's authenticated local HTTP API.
 *
 * The desktop app spawns the CLI with two pieces of local state:
 *
 *   CC_HAHA_DESKTOP_SERVER_URL   — e.g. `http://127.0.0.1:3456`
 *   CC_HAHA_LOCAL_ACCESS_TOKEN   — the process-scoped bearer credential
 *
 * This module is the only place that turns those into a request. It is
 * deliberately narrow because the caller is a model-driven tool:
 *
 * - The base URL must be a bare loopback origin. A non-loopback host, an
 *   embedded credential, a path, or a query string disables the tool rather
 *   than routing anything.
 * - The credential is read from the process environment, never from tool
 *   arguments, and is only ever attached to that exact loopback origin.
 * - `redirect: 'error'` stops a hostile or misconfigured server from
 *   redirecting the request somewhere the bearer token would then leak.
 * - Every request has a hard timeout so a hung local server cannot wedge a
 *   conversation turn.
 *
 * `CC_HAHA_LOCAL_ACCESS_TOKEN` is already stripped from Bash subprocess
 * environments (see `src/utils/subprocessEnv.ts`), so the model can neither
 * read it from the tool schema nor recover it via the shell.
 */

export const DESKTOP_SERVER_URL_ENV = 'CC_HAHA_DESKTOP_SERVER_URL'
export const LOCAL_ACCESS_TOKEN_ENV = 'CC_HAHA_LOCAL_ACCESS_TOKEN'

export const LOCAL_SCHEDULED_TASKS_API_PATH = '/api/scheduled-tasks'

/**
 * Every local desktop API path must sit under this prefix. The internal bearer
 * token is only ever attached to an absolute path inside this prefix on the
 * exact loopback origin this process was configured with, so a caller cannot
 * widen the credential's reach by handing over a path from model input.
 */
export const LOCAL_DESKTOP_API_PREFIX = '/api/'
const MAX_API_PATH_LENGTH = 2_048
const SAFE_API_SEGMENT_PATTERN = /^[A-Za-z0-9._~!$&'()*+,;=:@%-]+$/

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000

/**
 * Hostnames that can only be the local machine. `localhost` is included
 * because the desktop may advertise it, but it is resolved by the OS rather
 * than trusted as a name.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export type LocalScheduledTaskApiErrorKind =
  | 'unavailable'
  | 'invalid_url'
  | 'http_error'
  | 'invalid_response'
  | 'network_error'
  | 'timeout'

export class LocalScheduledTaskApiError extends Error {
  readonly kind: LocalScheduledTaskApiErrorKind
  readonly status?: number

  constructor(
    kind: LocalScheduledTaskApiErrorKind,
    message: string,
    status?: number,
  ) {
    super(message)
    this.name = 'LocalScheduledTaskApiError'
    this.kind = kind
    this.status = status
  }
}

type EnvLike = Record<string, string | undefined>

/**
 * Normalize the desktop server URL to a bare loopback origin.
 *
 * Returns `null` for anything that is not exactly `http://<loopback>[:port]`.
 * `https` is rejected too: the desktop server is plain HTTP on loopback, and
 * accepting a TLS origin would only widen what a stale environment variable
 * can redirect the bearer token to.
 */
export function resolveLocalScheduledTaskBaseUrl(
  env: EnvLike = process.env,
): string | null {
  const raw = env[DESKTOP_SERVER_URL_ENV]?.trim()
  if (!raw) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:') return null
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return null
  if (parsed.username || parsed.password) return null
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null
  if (parsed.search || parsed.hash) return null

  return `http://${parsed.host}`
}

/**
 * Validate an absolute local desktop API path.
 *
 * Tool code supplies the path, never the model, but it is validated here anyway
 * so a future caller cannot hand the bearer token to an unexpected route: the
 * path must start with `/api/`, must not contain an empty, `.`, or `..`
 * segment, and must not carry a query, fragment, backslash, or whitespace.
 * Returns the normalized path, or `null` when it is not an acceptable target.
 */
export function resolveLocalDesktopApiPath(path: string): string | null {
  if (typeof path !== 'string') return null
  if (!path.startsWith(LOCAL_DESKTOP_API_PREFIX)) return null
  if (path.length > MAX_API_PATH_LENGTH) return null
  if (/[?#\\\s]/.test(path)) return null

  const segments = path.slice(1).split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null
    if (!SAFE_API_SEGMENT_PATTERN.test(segment)) return null
  }
  return `/${segments.join('/')}`
}

function resolveLocalAccessToken(env: EnvLike = process.env): string | null {
  const token = env[LOCAL_ACCESS_TOKEN_ENV]?.trim()
  return token && token.length > 0 ? token : null
}

/**
 * True only when both the loopback origin and the internal token are present.
 * This is the gate for both tool visibility and every request.
 */
export function isLocalScheduledTaskApiAvailable(env: EnvLike = process.env): boolean {
  return (
    resolveLocalScheduledTaskBaseUrl(env) !== null &&
    resolveLocalAccessToken(env) !== null
  )
}

function clampTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS
  }
  return Math.min(timeoutMs, MAX_TIMEOUT_MS)
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return response.statusText || `HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text) as { message?: unknown; error?: unknown }
      if (typeof parsed.message === 'string' && parsed.message) return parsed.message
      if (typeof parsed.error === 'string' && parsed.error) return parsed.error
    } catch {
      // Fall through to the raw body.
    }
    return text.slice(0, 300)
  } catch {
    return response.statusText || `HTTP ${response.status}`
  }
}

/**
 * One authenticated request against the desktop's local HTTP API.
 *
 * The credential never appears here: it is read from the process environment
 * and attached only to the exact loopback origin this process was configured
 * with. Callers supply an absolute path under {@link LOCAL_DESKTOP_API_PREFIX};
 * anything else is rejected before a request is made.
 */
export type LocalDesktopApiRequest = {
  /** Absolute local API path, e.g. `/api/scheduled-tasks`. */
  path: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
  env?: EnvLike
  fetchImpl?: typeof fetch
}

/**
 * Perform one authenticated request against the local desktop API and return
 * the parsed JSON body. Throws {@link LocalScheduledTaskApiError} for every
 * failure mode so callers can report a precise reason.
 */
export async function callLocalDesktopApi<T>(
  request: LocalDesktopApiRequest,
): Promise<T> {
  const env = request.env ?? process.env
  const baseUrl = resolveLocalScheduledTaskBaseUrl(env)
  const token = resolveLocalAccessToken(env)

  if (!baseUrl) {
    throw new LocalScheduledTaskApiError(
      'unavailable',
      'The local desktop API is unavailable: no trusted loopback desktop server is configured.',
    )
  }
  if (!token) {
    throw new LocalScheduledTaskApiError(
      'unavailable',
      'The local desktop API is unavailable: the desktop internal token is not configured.',
    )
  }

  const path = resolveLocalDesktopApiPath(request.path)
  if (!path) {
    throw new LocalScheduledTaskApiError('invalid_url', 'Invalid local desktop API path.')
  }
  const url = `${baseUrl}${path}`

  const controller = new AbortController()
  const externalSignal = request.signal
  const onExternalAbort = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timeoutMs = clampTimeoutMs(request.timeoutMs)
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
  if (request.body !== undefined) headers['Content-Type'] = 'application/json'

  const fetchImpl = request.fetchImpl ?? globalThis.fetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      // Never follow a redirect: the Authorization header must stay on the
      // exact loopback origin this process was configured with.
      redirect: 'error',
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new LocalScheduledTaskApiError(
        'timeout',
        `The local desktop request timed out after ${timeoutMs}ms.`,
      )
    }
    if (externalSignal?.aborted) {
      throw new LocalScheduledTaskApiError('network_error', 'The local desktop request was aborted.')
    }
    throw new LocalScheduledTaskApiError(
      'network_error',
      `Could not reach the local desktop server: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  } finally {
    clearTimeout(timer)
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
  }

  if (!response.ok) {
    throw new LocalScheduledTaskApiError(
      'http_error',
      await readErrorMessage(response),
      response.status,
    )
  }

  if (response.status === 204) return undefined as T

  const text = await response.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new LocalScheduledTaskApiError(
      'invalid_response',
      'The local desktop server returned a malformed JSON response.',
    )
  }
}

export type LocalScheduledTasksRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /**
   * Path segments appended after `/api/scheduled-tasks`. Each segment is
   * percent-encoded, so a model-supplied id cannot introduce `..`, an extra
   * path component, or a query string.
   */
  segments: readonly string[]
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
  env?: EnvLike
  fetchImpl?: typeof fetch
}

/**
 * Scheduled-task convenience wrapper over {@link callLocalDesktopApi}. Kept
 * separate so the tool keeps expressing the route it means rather than a raw
 * path string.
 */
export async function callLocalScheduledTasksApi<T>(
  request: LocalScheduledTasksRequest,
): Promise<T> {
  const suffix = request.segments
    .map(segment => encodeURIComponent(segment))
    .join('/')
  const path = suffix
    ? `${LOCAL_SCHEDULED_TASKS_API_PATH}/${suffix}`
    : LOCAL_SCHEDULED_TASKS_API_PATH

  return callLocalDesktopApi<T>({
    path,
    method: request.method,
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.env === undefined ? {} : { env: request.env }),
    ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
  })
}

/** Human-readable reason a call failed, safe to show the model. */
export function describeLocalScheduledTaskApiError(error: unknown): string {
  if (error instanceof LocalScheduledTaskApiError) {
    switch (error.kind) {
      case 'unavailable':
        return error.message
      case 'timeout':
        return `The local desktop request timed out. ${error.message}`
      case 'http_error':
        return `The local desktop request failed (HTTP ${error.status}): ${error.message}`
      case 'network_error':
        return `The local desktop request could not be delivered: ${error.message}`
      case 'invalid_response':
        return 'The local desktop server returned an unreadable response.'
      case 'invalid_url':
        return 'The local desktop request path was invalid.'
    }
  }
  return error instanceof Error ? error.message : String(error)
}