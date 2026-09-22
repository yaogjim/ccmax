import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SITE_BASE,
  SITE_BASE_PATH,
  SITE_ORIGIN,
  cleanRoute,
  isSitePath,
  isSiteRoot,
  toAbsoluteUrl,
  toSiteHref,
  withoutSiteBase
} from './site.js'

describe('site constants', () => {
  it('唯一声明 production origin 与 Vite base', () => {
    assert.equal(SITE_ORIGIN, 'https://yaogjim.github.io')
    assert.equal(SITE_BASE, '/ccmax')
    assert.equal(SITE_BASE_PATH, '/ccmax/')
  })
})

describe('toSiteHref', () => {
  it('给逻辑 route 加上 /ccmax base', () => {
    assert.equal(toSiteHref('/'), '/ccmax/')
    assert.equal(toSiteHref('/en'), '/ccmax/en')
    assert.equal(toSiteHref('/start/install'), '/ccmax/start/install')
    assert.equal(toSiteHref('/en/start'), '/ccmax/en/start')
  })

  it('保留 query 与 hash', () => {
    assert.equal(toSiteHref('/start?x=1'), '/ccmax/start?x=1')
    assert.equal(toSiteHref('/en#top'), '/ccmax/en#top')
    assert.equal(toSiteHref('/docs?from=readme#legacy'), '/ccmax/docs?from=readme#legacy')
  })

  it('拒绝重复叠加 base', () => {
    assert.equal(toSiteHref('/ccmax'), '/ccmax')
    assert.equal(toSiteHref('/ccmax/'), '/ccmax')
    assert.equal(toSiteHref('/ccmax/en'), '/ccmax/en')
    assert.equal(toSiteHref('/ccmax/start/install?x=1#y'), '/ccmax/start/install?x=1#y')
  })

  it('外部 URL 与纯 hash 原样返回', () => {
    assert.equal(toSiteHref('https://example.com/a'), 'https://example.com/a')
    assert.equal(toSiteHref('//cdn.example/x'), '//cdn.example/x')
    assert.equal(toSiteHref('#section'), '#section')
    assert.equal(toSiteHref('mailto:hi@example.com'), 'mailto:hi@example.com')
  })
})

describe('withoutSiteBase / isSitePath', () => {
  it('从公开 href 还原逻辑 route', () => {
    assert.equal(withoutSiteBase('/ccmax'), '/')
    assert.equal(withoutSiteBase('/ccmax/'), '/')
    assert.equal(withoutSiteBase('/ccmax/en'), '/en')
    assert.equal(withoutSiteBase('/ccmax/start/install'), '/start/install')
    assert.equal(withoutSiteBase('/ccmax/en/start?x=1#y'), '/en/start')
  })

  it('已经是逻辑 route 时保持清洗后的路径', () => {
    assert.equal(withoutSiteBase('/'), '/')
    assert.equal(withoutSiteBase('/en'), '/en')
    assert.equal(withoutSiteBase('/start/install'), '/start/install')
  })

  it('只把 /ccmax 与其前缀当成站点路径', () => {
    assert.equal(isSitePath('/ccmax'), true)
    assert.equal(isSitePath('/ccmax/'), true)
    assert.equal(isSitePath('/ccmax/en'), true)
    assert.equal(isSitePath('/'), false)
    assert.equal(isSitePath('/en'), false)
    assert.equal(isSitePath('/start'), false)
    assert.equal(isSitePath('/ccmaxfoo'), false)
    assert.equal(isSitePath('/other-repo'), false)
  })

  it('站点根只认 /ccmax 与 /ccmax/', () => {
    assert.equal(isSiteRoot('/ccmax'), true)
    assert.equal(isSiteRoot('/ccmax/'), true)
    assert.equal(isSiteRoot('/ccmax/en'), false)
    assert.equal(isSiteRoot('/'), false)
    assert.equal(isSiteRoot(''), false)
  })
})

describe('toAbsoluteUrl', () => {
  it('中文首页、英文页与文档页的 canonical', () => {
    assert.equal(toAbsoluteUrl('/'), 'https://yaogjim.github.io/ccmax/')
    assert.equal(toAbsoluteUrl('/en'), 'https://yaogjim.github.io/ccmax/en')
    assert.equal(toAbsoluteUrl('/start/install'), 'https://yaogjim.github.io/ccmax/start/install')
    assert.equal(toAbsoluteUrl('/en/start'), 'https://yaogjim.github.io/ccmax/en/start')
    assert.equal(toAbsoluteUrl('/sitemap.xml'), 'https://yaogjim.github.io/ccmax/sitemap.xml')
  })

  it('已带 base 的路径不会出现双 /ccmax/', () => {
    assert.equal(toAbsoluteUrl('/ccmax'), 'https://yaogjim.github.io/ccmax/')
    assert.equal(toAbsoluteUrl('/ccmax/'), 'https://yaogjim.github.io/ccmax/')
    assert.equal(toAbsoluteUrl('/ccmax/en'), 'https://yaogjim.github.io/ccmax/en')
  })

  it('拒绝越权 external URL', () => {
    assert.throws(() => toAbsoluteUrl('https://cchaha.ai/'), /external/i)
    assert.throws(() => toAbsoluteUrl('https://example.com/x'), /external/i)
    assert.throws(() => toAbsoluteUrl('#hash'), /external/i)
    assert.throws(() => toAbsoluteUrl(''), /empty/i)
  })
})

describe('cleanRoute', () => {
  it('去掉 query/hash/扩展名并折叠斜杠', () => {
    assert.equal(cleanRoute('/start/install.md?x=1'), '/start/install')
    assert.equal(cleanRoute('/en/start.html#top'), '/en/start')
    assert.equal(cleanRoute('//ccmax//en//'), '/ccmax/en')
  })
})
