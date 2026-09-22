/**
 * 站点 URL / path 的唯一边界。
 *
 * 三层不要混：
 * - 逻辑 route：`/`、`/en`、`/start/install`（React state、docs 索引、legacy 映射）
 * - 公开 href：`/ccmax/`、`/ccmax/en`（浏览器地址栏、history、sitemap）
 * - 物理产物：`dist/index.html`、`dist/en/index.html`（Pages 把 artifact 根映射到 `/ccmax/`）
 *
 * 本模块无 DOM、无 import.meta.env，供 Vite config、Node 脚本和 browser bundle 共用。
 */

export const SITE_ORIGIN = 'https://yaogjim.github.io'
export const SITE_BASE = '/ccmax'
export const SITE_BASE_PATH = '/ccmax/'

const EXTERNAL_PROTOCOL = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i

export function isExternalHref(href) {
  return EXTERNAL_PROTOCOL.test(String(href))
}

export function cleanRoute(route) {
  const withoutQuery = String(route ?? '/').split(/[?#]/, 1)[0]
  let normalized = decodeURIComponent(withoutQuery || '/')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/(?:\.md|\.html)$/i, '')

  if (!normalized.startsWith('/')) normalized = `/${normalized}`
  if (normalized !== '/') normalized = normalized.replace(/\/+$/, '')
  return normalized
}

function splitHref(href) {
  const match = String(href).match(/^([^?#]*)([?#].*)?$/)
  return { path: match?.[1] || '', suffix: match?.[2] || '' }
}

export function isSitePath(pathname) {
  const route = cleanRoute(pathname)
  return route === SITE_BASE || route.startsWith(`${SITE_BASE}/`)
}

export function isSiteRoot(pathname) {
  return cleanRoute(pathname) === SITE_BASE
}

export function withoutSiteBase(pathname) {
  const route = cleanRoute(pathname)
  if (route === SITE_BASE) return '/'
  if (route.startsWith(`${SITE_BASE}/`)) return route.slice(SITE_BASE.length)
  return route
}

export function toSiteHref(href) {
  if (!href || href.startsWith('#') || isExternalHref(href)) return href

  const { path: rawPath, suffix } = splitHref(href)
  const route = /\.html$/i.test(rawPath)
    ? `/${decodeURIComponent(rawPath).replace(/^\/+/, '').replace(/\/{2,}/g, '/')}`
    : cleanRoute(rawPath)

  if (isSitePath(route)) return `${route}${suffix}`
  return `${SITE_BASE}${route === '/' ? '/' : route}${suffix}`
}

export function toAbsoluteUrl(href) {
  if (href == null || href === '') {
    throw new Error('Refusing to absolutize an empty URL')
  }
  if (href.startsWith('#') || isExternalHref(href)) {
    throw new Error(`Refusing to absolutize external URL: ${href}`)
  }

  const publicHref = toSiteHref(href)
  if (publicHref === SITE_BASE || publicHref === SITE_BASE_PATH) {
    return `${SITE_ORIGIN}${SITE_BASE_PATH}`
  }
  return `${SITE_ORIGIN}${publicHref}`
}
