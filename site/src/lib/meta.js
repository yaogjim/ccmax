import { toAbsoluteUrl, withoutSiteBase } from './site.js'

function upsert(selector, create) {
  let node = document.head.querySelector(selector)
  if (!node) {
    node = create()
    document.head.append(node)
  }
  return node
}

function setMetaContent(attribute, key, value) {
  const selector = `meta[${attribute}="${key}"]`
  if (!value) {
    document.head.querySelector(selector)?.remove()
    return
  }
  const node = upsert(selector, () => {
    const meta = document.createElement('meta')
    meta.setAttribute(attribute, key)
    return meta
  })
  node.setAttribute('content', value)
}

function setLink(rel, href, hreflang) {
  const selector = hreflang ? `link[rel="${rel}"][hreflang="${hreflang}"]` : `link[rel="${rel}"]:not([hreflang])`
  if (!href) {
    document.head.querySelector(selector)?.remove()
    return
  }
  const node = upsert(selector, () => {
    const link = document.createElement('link')
    link.setAttribute('rel', rel)
    if (hreflang) link.setAttribute('hreflang', hreflang)
    return link
  })
  node.setAttribute('href', href)
}

/**
 * SPA 换页时同步 title / description / canonical / hreflang。
 * 静态构建会把同样的值写进每条路由的 HTML 骨架，所以爬虫拿到的也是对的。
 */
export function setPageMeta({ alternate, canonical, description, lang, title }) {
  document.title = title
  document.documentElement.lang = lang

  setMetaContent('name', 'description', description)
  setMetaContent('property', 'og:title', title)
  setMetaContent('property', 'og:description', description)
  setMetaContent('property', 'og:url', canonical ? toAbsoluteUrl(canonical) : null)

  setLink('canonical', canonical ? toAbsoluteUrl(canonical) : null)

  if (canonical) {
    const logical = withoutSiteBase(canonical)
    const isEnglish = logical === '/en' || logical.startsWith('/en/')
    setLink('alternate', toAbsoluteUrl(canonical), isEnglish ? 'en' : 'zh-Hans')
    setLink('alternate', alternate ? toAbsoluteUrl(alternate) : null, isEnglish ? 'zh-Hans' : 'en')
  }
}
