import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

import {
  DEFAULT_LOCALE,
  normalizeStoredLocale,
  prefersChinese,
  resolveBrowserLocale,
  resolveRootRedirect
} from './locale.js'

describe('prefersChinese', () => {
  it('认所有中文变体', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans', 'zh-Hant-TW', 'ZH-cn']) {
      assert.equal(prefersChinese([tag]), true, tag)
    }
  })

  it('不把 zh 开头的其他语言当中文', () => {
    // zhuang（壮语）真实存在于 BCP-47，前缀匹配写松了会误判。
    assert.equal(prefersChinese(['zha']), false)
    assert.equal(prefersChinese(['zhuang']), false)
  })

  it('列表里任意一项是中文就算中文', () => {
    assert.equal(prefersChinese(['en-US', 'zh-CN']), true)
    assert.equal(prefersChinese(['en-US', 'ja', 'ko']), false)
  })

  it('输入不是数组或含脏值时不炸', () => {
    assert.equal(prefersChinese(undefined), false)
    assert.equal(prefersChinese(null), false)
    assert.equal(prefersChinese([]), false)
    assert.equal(prefersChinese([null, undefined, 42, ' zh-CN ']), true)
  })
})

describe('normalizeStoredLocale', () => {
  it('只接受 zh / en', () => {
    assert.equal(normalizeStoredLocale('zh'), 'zh')
    assert.equal(normalizeStoredLocale('en'), 'en')
    assert.equal(normalizeStoredLocale('fr'), null)
    assert.equal(normalizeStoredLocale(''), null)
    assert.equal(normalizeStoredLocale(null), null)
  })
})

describe('resolveBrowserLocale', () => {
  it('浏览器首选语言含中文时选择中文', () => {
    for (const languages of [['zh'], ['zh-CN'], ['zh-TW'], ['zh-Hant'], ['en-US', 'zh-CN']]) {
      assert.equal(resolveBrowserLocale({ languages }), 'zh', JSON.stringify(languages))
    }
  })

  it('其他语言及缺失的浏览器语言都选择英文', () => {
    assert.equal(DEFAULT_LOCALE, 'en')
    for (const language of ['en-US', 'ja-JP', 'fr-FR', '', 'zho']) {
      assert.equal(resolveBrowserLocale({ languages: [language] }), 'en', language)
    }
    assert.equal(resolveBrowserLocale(), 'en')
  })

  it('优先使用浏览器的语言列表，并在没有列表时回退到 language', () => {
    assert.equal(resolveBrowserLocale({ languages: ['ja-JP', 'zh-CN'], language: 'zh-CN' }), 'zh')
    assert.equal(resolveBrowserLocale({ languages: [], language: 'zh-CN' }), 'zh')
    assert.equal(resolveBrowserLocale({ languages: [], language: 'ja-JP' }), 'en')
  })
})

describe('resolveRootRedirect', () => {
  it('中文浏览器留在 /ccmax 中文站', () => {
    assert.equal(resolveRootRedirect({ languages: ['zh-CN'], pathname: '/ccmax' }), null)
    assert.equal(resolveRootRedirect({ languages: ['zh-CN'], pathname: '/ccmax/' }), null)
  })

  it('非中文浏览器从 /ccmax/ 跳 /ccmax/en', () => {
    assert.equal(resolveRootRedirect({ languages: ['en-US'], pathname: '/ccmax' }), '/ccmax/en')
    assert.equal(resolveRootRedirect({ languages: ['en-US'], pathname: '/ccmax/' }), '/ccmax/en')
    assert.equal(resolveRootRedirect({ languages: ['ja-JP'], pathname: '/ccmax/' }), '/ccmax/en')
  })

  it('拿不到浏览器语言时按英文兜底', () => {
    assert.equal(resolveRootRedirect({ languages: [], pathname: '/ccmax' }), '/ccmax/en')
    assert.equal(resolveRootRedirect({ pathname: '/ccmax/' }), '/ccmax/en')
  })

  it('URL 根和其他仓库路径 fail-closed', () => {
    for (const pathname of ['/', '', '//', '/other-repo', '/other-repo/docs']) {
      assert.equal(resolveRootRedirect({ languages: ['en'], pathname }), null, JSON.stringify(pathname))
    }
  })

  it('只动站点根，带前缀的地址一概不碰', () => {
    // 这是整个功能的安全边界：英文用户点开中文文档不该被踢走，反之亦然。
    const cases = ['/en', '/en/', '/start', '/en/start', '/desktop/pets', '/internals', '/ccmax/en', '/ccmax/start']
    for (const pathname of cases) {
      assert.equal(resolveRootRedirect({ languages: ['en-US'], pathname }), null, pathname)
      assert.equal(resolveRootRedirect({ languages: ['zh-CN'], pathname }), null, pathname)
    }
  })

  it('记住的偏好优先于浏览器语言', () => {
    // 中文浏览器手动切到英文后，回首页不该被弹回中文，否则切换器等于没用。
    assert.equal(resolveRootRedirect({ languages: ['zh-CN'], pathname: '/ccmax/', stored: 'en' }), '/ccmax/en')
    assert.equal(resolveRootRedirect({ languages: ['en-US'], pathname: '/ccmax/', stored: 'zh' }), null)
  })

  it('偏好是脏值时退回浏览器语言', () => {
    assert.equal(resolveRootRedirect({ languages: ['zh-CN'], pathname: '/ccmax/', stored: 'garbage' }), null)
    assert.equal(resolveRootRedirect({ languages: ['en-US'], pathname: '/ccmax/', stored: '' }), '/ccmax/en')
  })
})

describe('index.html 首帧语言分流', () => {
  // 内联副本用 Vite %BASE_URL% 注入构建 base；测试里按 /ccmax/ 展开成构建后的样子。
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const rawBootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((script) => script.includes('window.location.pathname'))
  const bootstrap = rawBootstrap.replaceAll('%BASE_URL%', '/ccmax/')

  function runBootstrap({ pathname = '/ccmax/', stored = null, languages, language = '' }) {
    let redirectedTo = null
    runInNewContext(bootstrap, {
      document: { documentElement: { lang: 'zh-CN' } },
      localStorage: { getItem: () => stored },
      navigator: { languages, language },
      window: {
        location: {
          pathname,
          search: '?from=homepage',
          hash: '#discover',
          replace: (url) => { redirectedTo = url }
        }
      }
    })
    return redirectedTo
  }

  it('中文浏览器留在中文首页，其他语言带查询和锚点进入英文首页', () => {
    assert.equal(runBootstrap({ languages: ['zh-CN'] }), null)
    assert.equal(runBootstrap({ languages: ['ja-JP'] }), '/ccmax/en?from=homepage#discover')
  })

  it('手动选择优先于浏览器语言，明确路径不重定向', () => {
    assert.equal(runBootstrap({ languages: ['zh-CN'], stored: 'en' }), '/ccmax/en?from=homepage#discover')
    assert.equal(runBootstrap({ languages: ['ja-JP'], stored: 'zh' }), null)
    assert.equal(runBootstrap({ pathname: '/ccmax/start', languages: ['ja-JP'] }), null)
  })

  it('只认站点根 /ccmax，URL 根与其他 Pages 路径不动', () => {
    assert.equal(runBootstrap({ pathname: '/', languages: ['ja-JP'] }), null)
    assert.equal(runBootstrap({ pathname: '/other-repo', languages: ['ja-JP'] }), null)
  })
})