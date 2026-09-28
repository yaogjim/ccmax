---
title: 上游内容移除记录
nav_title: 上游移除记录
description: 记录 ccmax 分支按项目要求移除的上游内容，合并 main 后必须保持移除，不需要再次向用户确认。
order: 2
---

这份清单记录 ccmax 分支明确要求移除的上游内容。合并上游 `main` 时，冲突解决和功能移植都以「这些内容不回来」为默认前提；不需要再向用户重新确认一次。

上游合并已经把这些入口带回一次（见下表「历史」列里的 `3d800209`），所以合并后请按文末清单自查，而不是凭印象判断。

## 一、侧栏标题区

| 位置 | 移除内容 | 历史 |
| --- | --- | --- |
| `desktop/src/components/layout/Sidebar.tsx` | 标题区里指向项目仓库的 GitHub 图标链接，以及配套的本地 `GitHubIcon()` 组件 | `9c0ec627` 首次移除 → 上游合并 `3d800209` 带回 → 已再次移除 |

回归锚点：`desktop/src/components/layout/Sidebar.test.tsx` 的「renders one wordmark and it is the short one」断言 `sidebar-title-region` 内不存在 `a[href*="github.com"]`。

## 二、设置 → 关于

文件：`desktop/src/pages/settings/AboutSettings.tsx`。

| 位置 | 移除内容 | 历史 |
| --- | --- | --- |
| 版本号右侧 | 「更新日志」链接（跳 GitHub Releases，键 `settings.about.changelog`） | 已移除 |
| 版本行下方 | GitHub 仓库卡片：仓库名 + 求 Star 提示 | `9c0ec627` 首次移除 → `3d800209` 带回 → 已再次移除 |
| 更新卡片下方 | 「反馈问题」卡片（跳 GitHub Issues） | `9c0ec627` 首次移除 → `3d800209` 带回 → 已再次移除 |
| 页面下半部分 | 作者区（`AUTHOR_GITHUB`、`程序员阿江-Relakkes`）与社交入口（`SOCIAL_LINKS`：Bilibili / Douyin / Xiaohongshu）；上游新增的企业微信群二维码入口及 `desktop/public/icons/wechat-group-qr.png` 图片 | `9c0ec627` 首次移除；合并 0.6.7 时继续保持移除 |

保留、不要一起删掉：`BrandSeal` 标记、`ccmax` 标题、版本号、「应用更新」卡片（含「检查更新」和「高级更新代理」）。

### 连带删除的 i18n 键

五个语言包（`en` / `zh` / `zh-TW` / `jp` / `kr`）同步删除：

- `settings.about.changelog`
- `settings.about.starHint`
- `settings.about.feedback`
- `settings.about.feedbackDesc`

回归锚点：`desktop/src/i18n/index.test.tsx` 的「carries no key for the removed About-panel entries」断言这 4 个键不会在任一语言包复活；`desktop/src/pages/settings/AboutSettings.test.tsx` 断言这些入口不再渲染。

### 连带更新的文档

`docs/desktop/settings.md` 与 `docs/en/desktop/settings.md` 的「关于 / About」小节说明已改为「版本号和应用更新入口」，不再列「更新日志、GitHub 仓库、反馈入口」。

## 三、仓库级文件与配置

这些不是 UI 文案，而是刻意删除的文件和未启用的发布接线。合并时不要把上游版本带回来。

| 位置 | 状态 | 证据 |
| --- | --- | --- |
| `.github/FUNDING.yml` | 已删除 | `3d800209` 删除该文件 |
| `THIRD_PARTY_LICENSES.md` | 已删除 | `d9f9af52` 删除该文件 |
| `desktop/src-tauri/tauri.release-ci.json` | 已删除 | `3d800209` 删除该文件 |
| `docs/public/CNAME` | 已删除，站点构建不生成 CNAME | `3d800209` 删除该文件 |
| `site/scripts/generate-docs-manifest.mjs` | `excludedDirectoryNames` 必须含 `agents`：`docs/agents/`（本文件与 `project.md`）是内部项目材料，不进 `docs-index.js`、搜索索引、sitemap 或 `dist/agents/` | `check-docs.mjs` 的「docs/agents must stay out of the published manifest」断言 |
| Tauri 未发布更新器接线：`updater` 配置、capability `updater:default`、`tauri-plugin-updater` 依赖、`tauri_plugin_updater` 初始化 | 保持不接线 | `desktop/src-tauri/tauri-config.test.ts` 的「disables the unpublished Tauri updater wiring completely」逐项固定 |

品牌、产品名、仓库地址、包标识和数据目录这些**改名**要求不在本清单内，见 [`project.md`](./project.md) 的「项目覆盖规则」。

## 四、合并 main 后的自查

先定位可能被带回的入口：

```bash
grep -rn "github.com" desktop/src/components/layout/Sidebar.tsx
grep -rn "yaogjim/ccmax" desktop/src/pages/settings/ --exclude="*.test.tsx"
grep -rn "settings\.about\.\(changelog\|starHint\|feedback\)" desktop/src/i18n/locales/
grep -n "excludedDirectoryNames" site/scripts/generate-docs-manifest.mjs   # 结果里必须有 agents
```

再跑回归测试（在 `desktop/` 下）：

```bash
bun run test -- --run src/components/layout/Sidebar.test.tsx src/pages/settings/AboutSettings.test.tsx src/i18n/index.test.tsx
```

最后按根规则跑 `bun run check:impact` 选中的检查；涉及 `desktop/` 的合并通常选中 `bun run check:desktop`。

新增「又要移除一次」的条目时，请在本文件补一行，并同时加一条断言移除的回归测试——单靠注释挡不住下一次合并。