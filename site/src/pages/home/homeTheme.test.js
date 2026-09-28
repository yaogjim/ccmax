import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/**
 * 落地页的美术指导自带一套 `--wander-*` 调色板（纸面、插画、液体玻璃），
 * 它必须是 base.css token 的别名层：颜色全部派生自 token，主题由
 * `<html data-theme>` 翻转，本文件不出现 `[data-theme]` 补丁。
 * 曾经这里是写死的浅色值 + `color-scheme: light`，于是深色用户的首页
 * 停在「纸」版式上。以下断言把「两套主题都要工作」钉在源码层。
 */
const homeCss = readFileSync(new URL('./home.css', import.meta.url), 'utf8')
const baseCss = readFileSync(new URL('../../styles/base.css', import.meta.url), 'utf8')

// 照片底部那条深色文字带用的两个 token 故意不随主题变：照片本身不翻，
// 压在上面的浅色小字也不该翻。除它们之外，调色板里的每一档都必须翻转。
const themeIndependentTokens = new Set(['--forest-light', '--forest-deep'])

function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function rules(css) {
  const source = withoutComments(css)
  const parsed = []
  let index = 0

  while (index < source.length) {
    const open = source.indexOf('{', index)
    if (open === -1) break
    let depth = 0
    let close = -1
    for (let cursor = open; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1
      else if (source[cursor] === '}') {
        depth -= 1
        if (depth === 0) {
          close = cursor
          break
        }
      }
    }
    parsed.push({
      selector: source.slice(index, open).trim(),
      body: source.slice(open + 1, close === -1 ? undefined : close)
    })
    index = close === -1 ? source.length : close + 1
  }

  return parsed
}

function declaredTokens(body) {
  const tokens = new Map()
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+)/gi)) {
    tokens.set(match[1], match[2].trim())
  }
  return tokens
}

const baseTokens = new Map()
const baseLightTokens = new Map()
const baseDarkTokens = new Map()

for (const rule of rules(baseCss)) {
  if (!rule.selector.includes(':root')) continue
  const isDark = rule.selector.includes("data-theme='dark'")
  for (const [name, value] of declaredTokens(rule.body)) {
    baseTokens.set(name, value)
    if (isDark) baseDarkTokens.set(name, value)
    else baseLightTokens.set(name, value)
  }
}

const paletteRule = rules(homeCss).find(rule => /\.wander-page\b/.test(rule.selector) && rule.body.includes('--wander-'))
assert.ok(paletteRule, 'home.css: 找不到 .wander-page 调色板')
const palette = declaredTokens(paletteRule.body)

function tokensFor(theme) {
  return new Map([...baseTokens, ...(theme === 'dark' ? baseDarkTokens : baseLightTokens)])
}

function lookup(name) {
  return palette.get(name) ?? baseTokens.get(name)
}

/** 把一档调色板沿 var() 链走到最后引用到的 base token 名。 */
function leafTokens(expression, seen) {
  const references = [...expression.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(match => match[1])
  const leaves = []

  for (const name of references) {
    assert.ok(!seen.has(name), `home.css: ${name} 在调色板里循环引用`)
    const value = lookup(name)
    assert.ok(value, `home.css: ${name} 在 base.css 与 home.css 里都没有定义`)
    const nested = leafTokens(value, new Set([...seen, name]))
    leaves.push(...(nested.length > 0 ? nested : [name]))
  }

  return leaves
}

function hexToRgb(value) {
  const hex = value.trim().match(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i)
  assert.ok(hex, `期望十六进制颜色，拿到 ${value}；对比度断言需要可解析的值`)
  const digits = value.trim().slice(1)
  const full = digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits
  return [0, 2, 4].map(offset => Number.parseInt(full.slice(offset, offset + 2), 16))
}

function luminance([red, green, blue]) {
  const channel = value => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

function contrast(foreground, background) {
  const [high, low] = [luminance(foreground), luminance(background)].sort((left, right) => right - left)
  return (high + 0.05) / (low + 0.05)
}

/** 沿 var() 链取到实际色值（浅色 / 深色各算一次）。 */
function colorOf(entry, theme) {
  const tokens = tokensFor(theme)
  let value = palette.get(entry)
  assert.ok(value, `home.css: 调色板缺少 ${entry}`)

  for (let hop = 0; hop < 8; hop += 1) {
    const reference = value.match(/var\(\s*(--[a-z0-9-]+)/i)
    if (!reference) return value
    value = tokens.get(reference[1])
    assert.ok(value, `home.css: ${reference[1]} 在 base.css 里没有定义`)
  }

  assert.fail(`home.css: ${entry} 的 var() 链太深，解析不出来`)
}

const contrastPairs = [
  ['--wander-ink', '--wander-paper', '正文'],
  ['--wander-muted', '--wander-paper', '次级文字'],
  ['--wander-faint', '--wander-paper', '标注与图注'],
  ['--wander-accent', '--wander-paper', '强调色文字'],
  ['--wander-olive', '--wander-canvas', '强调句与状态点'],
  ['--wander-on-strong', '--wander-strong', '实心按钮上的文字'],
  ['--wander-on-accent', '--wander-accent', '按钮悬停态上的文字'],
  ['--wander-photo-ink', '--wander-photo-band', '照片带上的文字']
]

describe('landing page theme tokens', () => {
  it('derives every palette entry from a base.css token', () => {
    for (const [name, value] of palette) {
      assert.match(value, /var\(/, `home.css: ${name} 是写死的 ${value}，没有引用 token`)
    }
  })

  it('carries no raw colour value anywhere in the stylesheet', () => {
    const source = withoutComments(homeCss)
    const literals = source.match(
      /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(|(?<![\w-])(?:white|black|silver|gray|grey)(?![\w-])/gi
    )
    assert.equal(literals, null, `home.css 里还有字面色值：${literals && literals.join(', ')}`)
  })

  it('resolves every var() it uses to a declaration in base.css or its own palette', () => {
    const unresolved = new Set()
    for (const match of withoutComments(homeCss).matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      if (!lookup(match[1])) unresolved.add(match[1])
    }
    assert.deepEqual([...unresolved], [], 'home.css 引用了未定义的 token')
  })

  it('binds every palette entry to tokens that differ between the two themes', () => {
    for (const [name, value] of palette) {
      for (const leaf of leafTokens(value, new Set([name]))) {
        if (themeIndependentTokens.has(leaf)) continue
        assert.ok(
          baseLightTokens.has(leaf) && baseDarkTokens.has(leaf),
          `home.css: ${name} 依赖 ${leaf}，它只在单套主题里定义，落地页会钉死在那个主题上`
        )
        assert.notEqual(
          baseLightTokens.get(leaf),
          baseDarkTokens.get(leaf),
          `home.css: ${name} 依赖 ${leaf}，两套主题里是同一个值`
        )
      }
    }
  })

  it('lets the document theme decide color-scheme instead of forcing light', () => {
    // `color-scheme: light` 是之前那版「首页单主题」的实现手段：它会把滚动条
    // 和表单控件钉在浅色上。主题现在由 index.html 的引导脚本写在 <html data-theme>。
    const source = withoutComments(homeCss)
    assert.doesNotMatch(source, /color-scheme/)
    assert.doesNotMatch(source, /\[data-theme/, '落地页不该用主题补丁规则，颜色应直接来自 token')
  })

  it('keeps no palette entry around without a user', () => {
    const source = withoutComments(homeCss)
    for (const [name] of palette) {
      assert.ok(source.split(`var(${name})`).length > 1, `home.css: ${name} 定义了却没人用`)
    }
  })

  it('keeps every foreground pair at WCAG AA in both themes', () => {
    for (const theme of ['light', 'dark']) {
      for (const [foreground, background, label] of contrastPairs) {
        const ratio = contrast(hexToRgb(colorOf(foreground, theme)), hexToRgb(colorOf(background, theme)))
        assert.ok(
          ratio >= 4.5,
          `${theme}: ${label} ${foreground} on ${background} 只有 ${ratio.toFixed(2)}:1`
        )
      }
    }
  })

  it('makes the two themes resolve to different surfaces', () => {
    for (const entry of ['--wander-paper', '--wander-canvas', '--wander-sunken', '--wander-ink', '--wander-accent']) {
      assert.notEqual(colorOf(entry, 'light'), colorOf(entry, 'dark'), `home.css: ${entry} 没有两套主题`)
    }
  })
})