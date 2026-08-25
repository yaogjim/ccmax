# project.md — ccmax 项目适配声明

> 本文件是项目对全局 agent 规范母版的唯一适配点：只记录项目声明和与母版默认值的差异。完整通用规范由母版加载，项目现有根 `AGENTS.md` 保留为仓库规则入口。

```yaml
project: ccmax
based-on-master: v0.8.0
onboarded: 2026-08-25
```

## 声明开关

- **任务真值源**：`task/todo.md`（单 owner；当前目录尚未创建，首次需要任务记录时创建）
- **Context7 MCP**：未接入
- **浏览器验证工具**：Cursor IDE Browser；仓库自动化桌面 UI 门禁使用 `agent-browser`

## 文档路径映射

项目没有覆盖母版默认的 PRD、Design、Roadmap、过程记录和任务文件路径。长期文档按母版默认路径使用；面向用户的中文和英文文档分别维护在 `docs/` 与 `docs/en/`，两者应保持对应页面同步。

## 项目上下文与权威事实源入口

只登记稳定入口和权威范围。Agent 仍须在每次设计或实现前读取当前内容，不得仅凭本表推断现状。

| 类型 | 路径 / 命令 / 入口 | 权威范围与备注 |
|------|--------------------|----------------|
| 项目定位与业务规则 | `README.md`、`README.zh-CN.md`、`docs/internals/index.md` | 产品定位、主要能力和用户入口；详细架构以 internals 文档和代码为准 |
| PRD / 验收标准 | 未登记 | 当前没有独立 PRD；具体需求以用户确认内容和现有测试为准 |
| Design / ADR | `docs/internals/`、`docs/superpowers/specs/`、`docs/adr/` | 架构、模块设计和已记录的技术决策；目录不存在的类型不得假设已登记 |
| 代码 / 配置入口 | `src/`、`desktop/`、`adapters/`、`site/`、`scripts/`、`package.json` | 分别对应 CLI/本地服务、Electron 桌面端、IM 适配器、文档站和质量/发布脚本；各目录 `AGENTS.md` 规则更具体 |
| schema / API / 契约 | `src/server/router.ts`、`src/server/api/`、`src/server/config/providerPresets.json`、`src/schemas/` | 本地 Server API、provider 配置和共享 schema 的代码真源 |
| 测试与验证命令 | `CONTRIBUTING.md`、`docs/internals/contributing.md`、`scripts/pr/change-policy.ts` | 窄测后运行 `bun run check:impact`；按选择运行 `check:server`、`check:desktop`、`check:adapters`、`check:docs` 等门禁；完整验证使用 `bun run verify` |
| 运行 / 部署 / 可观测入口 | `docs/start/install.md`、`docs/cli/`、`docs/internals/server.md`、`scripts/release.ts`、`.github/workflows/` | 本地运行、服务配置、发布和 CI 的稳定入口；默认本地 Server 地址以代码和当前配置为准 |
| 外部依赖与参考方案 | `.env.example`、`docs/cli/env.md`、`docs/start/models.md`、`release-notes/` | 环境变量、模型接入、历史发布记录；不得把历史发布说明当作当前实现事实 |

## 项目覆盖规则

1. **品牌迁移范围（项目明确要求）**：当前 `ccmax` 分支的用户可见文案、README/文档、站点标题、包和安装包元数据、版权及项目链接统一使用 `ccmax`。旧的 `cc-haha` / `Claude Code Haha` 字面量只允许在确有必要的迁移、兼容、历史数据识别和对应回归夹具中保留；不应继续作为产品名称、站点名称或新生成数据的一部分。
2. **现有根规则入口**：保留仓库现有根 `AGENTS.md`，不将其覆盖为母版薄入口。它与本文件共同作为项目入口；新增项目适配声明统一写入本文件，母版通用规则仍以全局加载版本为准。
3. **项目结构规则**：`src/`、`desktop/`、`adapters/`、`docs/`、`site/` 及 `.github/` 的嵌套 `AGENTS.md` 继续生效；编辑对应目录前必须先读取最近的嵌套规则。
4. **用户状态安全**：测试和迁移验证必须使用临时配置目录、假凭据和隔离环境，不得读取或修改真实 `~/.claude`、密钥链、令牌、会话、provider 或 IM 绑定。持久化格式变更必须提供迁移、旧 fixture 和 `bun run check:persistence-upgrade` 证据。
5. **实时服务限制**：确定性测试通过且用户明确授权前，不运行真实模型、真实消息平台或其他付费/live provider 检查。

---

## 适用说明

全局母版加载时，本声明及其覆盖规则优先于母版通用默认值。未加载全局母版的环境应至少读取根 `AGENTS.md`、本文件和各受影响目录的嵌套 `AGENTS.md`。