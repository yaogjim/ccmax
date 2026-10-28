---
title: 上游可靠性执行与验证记录
nav_title: 可靠性实施
description: 内部实施批次及证据记录，不公开发布。
order: 3
---

# 上游可靠性实施计划

本文件把 [PRD](prd.md)、[路线图](roadmap.md) 和 [设计](design.md) 转为独立可验证批次。除明确记录外，下面条目均不是已完成声明。

## 执行规则

- 一级先修，二级先探针后决定，三级按需求。独立批次通过后继续，不为每次测试请求批准。
- 每批先 `git status --short`，保护他人改动；不切分支、提交、推送、发布或替换运行应用。
- 失败回归→修复→聚焦验证→实际 `check:impact` 路由→所选检查。跨进程/UI 需确定性 smoke；持久变化需前向迁移、旧夹具和升级门禁。
- 测试临时 HOME/CLAUDE_CONFIG_DIR，禁 `.env` 与 terminal shell env 继承，只用 fake key、fixture、loopback 或合成档案。真实模型/平台另需授权。
- 状态使用 `passed/failed/skipped/blocked/not run`；记录历史/源码/离线/UI/真实服务证据，不能互相替代。

## 2026-10-27 压缩与 Teams 边界补缺草案（未批准）

### 当前结论、范围与路线

**当前授权（2026-10-27）：** 用户已授权继续后续阶段开发，随后明确要求按全局阶段持续推进、不在内部小步骤后停下；技术选型优先采用最合适的方案，不反复请求既定政策确认。P0-B 已取得隔离运行证据；P2-1 Stop 持久恢复、P2-2 成员请求原子提交及 P2-3 停止水位已接线并有定向证据；正在推进标准 P3 整链。用户明确不做执行前标记，保留已披露写失败后崩溃窗口。消费侧实例隔离与权限取消合同仍由技术取证解决，不能用授权代替事实。**Teams 补缺 delivery_status=verified-partial；整体 Design Readiness=not-ready。** P0 只读和 A4/A5/M1 仅文档授权是历史阶段，以下历史段落不覆盖最新授权；不提交、不推送、不访问真实团队/供应商、不伪造维护者审批的边界保持。P1 证据沿用，2026-10-26 的历史门禁不能证明本轮变更完成。

业务主线：用户在成员页发出指令→正确团队实例接收→按授权启动角色→交付及独立验收→Stop 后停止→恢复服务不擅自继续→用户新指令后续跑；压缩请求在该执行过程中保持预算、取消和显式配置正确。当前补齐的是这条已有链路的边界，不新增 Teams 功能体系。

本批范围仅为 BG-C1/C2、BG-T1/T2/T3、BG-D1 和 BG-V1。SQLite、worker/trace/MCP 资源调查、真实 IM/模型、跨平台、安装发布及 S4 不进入本草案。没有新增依赖、抽象层、兼容 fallback、任务系统或 required CI lane 的授权。

顺序：**P0 事实与决策闭合→P1 压缩纵向补缺→P2 Teams 纵向补缺→P3 近真实整链验收。** P1 不依赖权限政策，但必须取得单独实施批准；P2 内部不按技术层拆任务，先固定 Stop 持久化，再处理实例发送和等待结算，BG-D1 按决策落地。P3 依赖所有实际选入的修复。不为每个测试或编辑新增交付任务。

### 事实分类与追踪

以下为本草案唯一执行状态表；具体机制和备选方案只在 [Design 边界草案](design.md#2026-10-27-边界补缺设计草案未批准) 维护。

| 工作项 | 需求／设计锚点 | 当前证据与分类 | 最小验收结果 | 当前状态／缺口 |
|---|---|---|---|---|
| BG-C1 | REL-002 / Design BG-C1 | 红例已复现并修复：cap 先算后验 | 高 thinking 不被非法 fork cap 降低，宽裕窗口保持缓存参数 | **verified-partial**：单测+loopback 通过；真实模型未跑（见 P1 证据） |
| BG-C2 | REL-002 / Design BG-C2 | Azure 红例已复现并修复；PTL 外循环用例未红（既有保护有效） | 结构化耗尽保留；full/partial PTL 真实请求总数≤6，取消/耗尽无成功边界 | **verified-partial**：loopback 计数通过；PTL 无需改生产代码（见 P1 证据） |
| BG-T1 | REL-008/009 / Design BG-T1 | 跨宿主复发已修复并回归：持久 `pausedAt` 在恢复时读回 | Stop→进程重启→旧消息/ready task 不唤醒；新合法指令才恢复 | **verified-partial**：单测 44 pass、双真实宿主探针通过；写失败窗口、运行中竞态与 HTTP/UI 重启未覆盖 |
| BG-T2 | REL-003 / Design BG-T2、T2 请求身份合同 | 请求准入、共同锁提交与删除重建反向交错均已有确定性证据；消费侧旧身份可误领同名新实例邮箱已由公开入口复现 | 延迟旧请求及校验/写入间重建均零错投；正常重试一次落盘 | **verified-partial**：发送侧零错投；消费实例 fencing 未实现，真实浏览器拒绝/刷新/重发未验证，证据见 P2-2 |
| BG-T3 | REL-003 / Design BG-T3、T3 停止水位合同 | 已接入持久 stopEpoch 与发送提交水位；新版服务对旧配置返回基线 0 | 只结算停止前对应等待，新发送不被旧 stopped patch 清除 | **verified-partial**：store 红例已修复，首次 Stop、回执倒序与旧服务缺字段边界均有测试；浏览器整链待 P3，证据见 P2-3 |
| BG-D1 | [REL-009-A1～A5](prd.md#rel-009团队权限上限2026-10-27-确认) / [Design BG-D1](design.md#bg-d1rel-009-批准后权限政策与差异合同) | 当前跟随父权限已核实；用户已选择 A，与目标存在差异 | 按下列权限矩阵验证上限、增量批准、收紧和恢复 | planned；政策 A 已确认；四项源码盘点已回收，A4 旧团队重新确认及 A5 在途请求立即取消政策已确认；F1 裁决表、F2/F3 一致性及 F4 迁移/回退合同仍阻塞，Design not-ready |
| BG-V1 | REL-003/008/009/010 / Design BG-V1 | 标准 smoke 已扩展为单一隔离整链脚本，但本机缺 agent-browser，lane 实际 SKIPPED | 从实际批准 UI 到服务重启与明确继续，单一隔离场景通过 | planned；已有脚本与 35 项相邻协议测试，浏览器证据缺失（env gap），见 P3 |

### P0：最小取证与决策闭合

**目标：** 不凭静态推断直接打补丁，形成可审核的差异 Design；此阶段不是功能实施。

**范围与动作：**

- 核对 BG-T1 的 Stop 调用者、持久写入/终止顺序、异常传播和 runtime 恢复入口，定义写失败及并发 Stop/继续的最终安全状态。说明同主控多个 plan 和旧记录如何处理。
- 核对 BG-T2 全部调用方，以及团队创建、删除、邮箱提交所用锁的共同边界；判定能否复用既有生命周期锁。没有可证明的提交隔离时，保持 not-ready，不把开头检查包装为完整修复。
- 核对 BG-T3 的停止信号、stream/刷新代次和待命唤醒顺序，明确旧停止快照与新消息的裁决；不能用未证明的时间比较替代身份和代次。
- BG-D1 的政策 A 已于 2026-10-27 获用户确认，不再请求 A/B 选择。按 Design D1-F1～F4 补齐模式关系、运行中收紧、增量批准一致性、旧数据与回退的只读取证；具体 UI/API/schema 合同仍未批准。旧 API 缺实例身份的处理保持 BG-T2 的独立兼容决策，不混成总批准。用户已授权 P0 只读取证；四路盘点已回收，REL-003-M1 缺身份即拒绝政策也已确认。政策确认不等于完整身份提交隔离或错误合同就绪，不授权 P2 编码。
- 在上述结论写入 Design 后，做一次聚焦独立实现模拟，覆盖最高风险并发、持久写失败、旧数据与回退。复核有未决事项时不将 Design Readiness 改为 approved。

**验收：** fact-gap 有当前锚点或明确探针，decision-gap 有用户确认；两个实现者不再需要临场决定暂停恢复、消息提交及权限政策。每项就绪状态独立标记，不能用全局批准跳过局部未知。

**测试方式：** 本轮只读；进入后续测试取证需要用户另行批准。后续先在既有测试 harness 一次固定一个红例；若红例通过，记录未复现和实际保护路径，删除该项生产修复需求，不为制造失败而删除现有保护。

**文档：** Design 固化合同；确有业务规则变化且已确认时才改 PRD；本 Plan 只引用合同和记录证据。

**回退：** 此阶段仅文档，无数据迁移或运行副作用；拒绝提案不改当前代码。

### P0-B：隔离行为探针与合同闭合（2026-10-27 已批准）

目标是将承重推断变成可复现证据，不是实施生产修复。范围仅相邻测试/夹具与本 feature 文档；不改生产实现、不新增依赖或门禁、不调用真实供应商。P2/P3 开发授权有效，Design 仍 not-ready。

执行顺序：① Stop service 入口、持久失败及独立宿主重启，区分内存恢复与实际进程重启；② HTTP 缺身份重试、成员替换与提交交错，核对 live/history；③ 实际 executor 的单调用取消及合法 sibling，区分请求与终止；④ fake tools/classifier/hooks 下的权限副作用和最终输入边界。使用临时 HOME/config、fake key、loopback、受控 Promise 屏障。无可用生产接缝时报告具体缺口，不新增生产 hook 或仿造执行器替代验证。

验收为入口、命令、fixture、观察与未覆盖清晰且可复现；诊断脚本不以 `.test.ts` 命名，不接常规门禁，输出 `requirementSatisfied` 区分现状复现与需求通过。测试失败或缺陷实证不通过删除断言/skip 掩盖。回退仅移除独立探针，保留证据；不涉及真实数据迁移。

合同退出条件与后续编排：在 Design 固化身份与错误、lifecycle→config→inbox 锁范围、提交序号/Stop 水位、批准版本与最终输入、定向取消/未决状态、旧格式与回退。完全不可写后崩溃的恢复保证、纯权限裁决接缝和取消隔离未闭合前，不进入对应 P2 生产实现；若候选改变普通崩溃恢复语义，明确列为产品决策缺口，不自行采用。最终设计完成后做一次独立实现模拟，P2 引用通过门禁的稳定锚点，P3 复用标准 smoke 验真实服务重启。

**证据（持续更新）：**

- `bun --no-env-file src/server/__tests__/fixtures/teamMessageIdentity.probe.ts` → 退出 0（诊断按预期复现缺陷，**不是产品通过**）。实际 HTTP handler→service→mailbox：缺身份同 messageId 两次返回 `[200,200]`，live 被写入且只保留一条，history 未变，`requirementSatisfied=false`。这证明 messageId 幂等不能替代实例检查。
- 同脚本在真实 `resolveMemberName` 完成后建立 Promise 屏障，经生产 `mutateTeamFileAsync` 替换成员 sessionId，再释放请求；HTTP 200 且迟到消息写入同名 inbox。此证据仅覆盖当前 name-only 入口，未实现的完整身份合同不能据此宣称验证；尚未覆盖团队删除重建、live/history 部分写入或锁外快照覆盖。
- `bun --no-env-file src/utils/permissions/fixtures/teamPermissionEvaluation.probe.ts` → 退出 0。真实 `hasPermissionsToUseTool` + synthetic ask tool：default/acceptEdits→ask、dontAsk→deny、plan 在 bypass capability=false/true 时分别 ask/allow、bypassPermissions→allow；十种组合的显式 deny 均 deny。对 default/plan 各评估一次实际调用 tool.checkPermissions 两次，不能假设双 context 为无副作用纯交集。覆盖不含 auto/classifier、审批 hook、参数改写及生产工具纯性；不把 fake tool 计数当所有工具已有副作用证明。
- `bun --no-env-file run ./src/services/tools/fixtures/teamPermissionCancellation.probe.ts` → 主线程复跑退出 0，观察断言通过、两个 `requirementSatisfied=false`。真实 StreamingToolExecutor/runToolUse，fake tools 和 mocked hooks/permission：单 child 的 `permission_revoked` 使 parent 与另一合法 child 一起 abort。合法工具忽略 abort 并发 progress 后，executor 输出 synthetic error、清空 in-progress 并结束结果消费，但实际工具仍等待独立屏障；释放屏障才完成。`networkAttempts=0`，临时环境清理。此证据反对直接复用普通 child abort 实现 A5，也证明 synthetic result 不是终止证据；不覆盖真实 Teams 控制协议、无 progress 路径、后台/外部终止或跨重启未决栅栏。
- 临时 HOME/CLAUDE_CONFIG_DIR、禁非必要流量下运行 `bun --no-env-file test src/utils/permissions/permissions.autoMode.test.ts` → **1 pass / 14 skip / 0 fail**。当前入口的编译 feature 分支未运行实际 auto 分类矩阵；不能把跳过当作 auto 权限已验证，不启用真实分类模型替代。
- `src/server/services/__fixtures__/teamStopRecovery.probe.ts` 经主线程实跑，退出 0（探针完成），`requirementSatisfied=false`。实际 ConversationService + fixture worker + loopback：Stop 宿主确认接收，待命成员在创建 ready task 后 1000 ms 内未启动；该宿主退出后启动不同 PID 的恢复宿主，未发送新指令，2500 ms 观察期内成员已首次启动，loopback 收到 `Work as analyst`，`initialStartPending=false`。正常 Stop 前后 config 字节相同，**不是注入写失败的证据**。无 forget/reset 代替进程重启，但这不是完整 HTTP 服务/浏览器重启验收。

复跑命令（只用临时目录及空环境）：

```bash
probe_home=$(mktemp -d /tmp/team-stop-probe.XXXXXX); mkdir -p "$probe_home/tmp"; env -i HOME="$probe_home" CLAUDE_CONFIG_DIR="$probe_home" TMPDIR="$probe_home/tmp" PATH="$(dirname "$(which bun)"):/usr/bin:/bin:/usr/sbin:/sbin" bun --no-env-file run src/server/services/__fixtures__/teamStopRecovery.probe.ts; result=$?; rm -rf "$probe_home"; exit "$result"
```

写失败探针曾尝试现有 fs/promises rename spy，但命中数为 0、注入断言失败，已移除无效注入；未新增生产 hook，写盘失败/掉电窗口保留为 test gap。宿主清理真实 fixture 子进程并等待退出，临时目录均删除；没有真实团队/模型调用。

**当前缺口分类：** `feature gap`：实例校验、Stop 持久化与调用级取消尚未实现；`test gap`：完整身份删除重建、live/history 部分提交、旧快照覆盖、allow 后输入变化/hook allow、无 progress/后台取消及跨重启未决调用未覆盖；`env gap`：直接 Bun 测试入口的 auto feature 分支跳过；`product-decision gap`：执行前持久运行标记导致部分普通崩溃进入待确认的恢复语义尚未批准；`permission-secret gap`：CLI core 维护者审批未取得，真实供应商未授权。缺口不由诊断脚本退出 0 消除。

**检查范围：** `bun run check:impact` 退出 0，按整个分支报告 2656 changed files、选中 policy/desktop/server/provider-contract/chat-contract/agent-flow/adapters/native/persistence-upgrade/docs/coverage，`Blocked: yes`（CLI core 维护者审批/标签）。本 P0-B 未运行这些整分支 lane 或完整 verify，不声称整分支就绪。内部文档链接目标、围栏、尾随空白、本机路径排除检查及 `git diff --check` 通过；不是官方 docs 构建证据。

### P2-1：Stop 跨恢复持久化（2026-10-27 已实施）

**目标：** 用户停下的团队在服务重启后仍保持停止，只有新指令才恢复。

**RED：** `teamPlanRuntime.supervisor.test.ts` 新增「a Stop outlives the runtime: the restored team stays paused until a new instruction」，修复前于“durable Stop record”处超时失败，失败原因正确（磁盘没有 Stop 记录），不是环境错误。

**GREEN（最小修改）：** 团队配置新增可选 `pausedAt`；Stop 的既有 config mutation 一并写入；`rehydrateTeamPlanRuntime` 读回并交给既有暂停门禁；解除暂停时以“仅清除本次解除的时间值”为条件写回清除。未改动权限、消息或取消路径。

**证据：**
- `bun --no-env-file test src/server/services/teamPlanRuntime.supervisor.test.ts -t 'outlives the runtime'` → 1 pass / 0 fail。
- `bun --no-env-file test src/server/services/teamPlanRuntime.supervisor.test.ts` → **44 pass / 0 fail**，含旧夹具路径（无 `pausedAt` 的团队重启后仍按 ready task 启动）未回归。
- `src/server/services/__fixtures__/teamStopRecovery.probe.ts` 双真实宿主复跑：`normal` 场景 `durableStopRecorded=true`、重启后未被唤醒（`requirementSatisfied=true`）；`write-failure` 场景通过目录只读使写盘真实失败（断言 `durableStopRecorded=false`），重启后成员自动启动——即已披露的残余窗口，探针如实记录而非宣称保证。

**未覆盖：** 完整 HTTP/桌面 UI 重启链（P3）；运行中成员 Stop 竞态；写失败时的用户可见提示属 F2；旧版本降级后暂停失效属已披露回退限制。

**回退：** 仅撤回 `pausedAt` 写入/读回与回归用例；字段可选、不迁移历史数据，撤回后回到“重启即忘”的旧行为。

### P2-2：成员消息实例隔离（2026-10-27 进行中）

对应 BG-T2 / REL-003-M1，补齐成员页→HTTP→真实邮箱的身份准入；合同见 Design「T2 请求身份合同」。最终验收仍要求并发替换/重建无错投，不能在入口检查完成时标记 accepted。

- 请求参数贯通 `incarnationId`、`memberSessionId`，缺失 400、过期或 legacy 无 session 409、当前 roster 无成员 404。拒绝先于任何邮箱写入。未新增持久格式，未改变其他 SendMessage 入口。
- RED：历史 inbox-only 成员传入虚构 session 后仍发送成功；增加回归后先观察拒绝断言失败，再改为只接受当前 roster 的可信 session。非法 JSON body `null` 先复现 500，再明确返回 400。
- `HOME=<临时目录> CLAUDE_CONFIG_DIR=<临时目录>/config bun test src/server/__tests__/teams.test.ts` → **105 pass / 0 fail**。覆盖缺身份重复发送零目录创建、已有 live/history 原字节不变、团队/成员身份冲突、legacy 无 session、正常发送、messageId 重试与存储失败。桌面 API/store 接线和测试另在同阶段完成。
- 更新并实跑 `bun --no-env-file run src/server/__tests__/fixtures/teamMessageIdentity.probe.ts`（空环境、临时 HOME/config）：缺身份两次 `[400,400]` 且 live/history 不变，`requirementSatisfied=true`；完整身份经入口校验后、成员解析屏障期间替换 session，仍返回 200 并写入，`requirementSatisfied=false`。这是新的并发反例，不把入口通过当提交隔离。
- 共同锁已接入 lifecycle→config→inbox，发送保持 config 锁直至邮箱提交；成员替换先完成则拒绝旧身份。`holds the member instance through mailbox commit while replacement waits` 先 RED（替换观察邮箱为 `[]`）后 GREEN；Teams 全套最终 **107 pass / 0 fail / 378 assertions**。身份 probe 复跑两项 true，发送先提交、替换后旧身份重试 409；不再执行旧的屏障内等待被锁 mutation 的死锁时序。
- runtime 三处旧快照整写（review 初始化、成员注册、撤销）改为 config 锁内 mutation；保留 missing/stale 行为，其他 I/O 错误不吞掉。子代理报告三项 barrier RED→GREEN，全套 supervisor **47 pass / 0 fail / 242 assertions**；主控已复核实际代码及 barrier。测试同时修正旧恢复用例误把 lead 通知当成员请求的问题，限定 reader 的 session 后保留原业务断言。
- 桌面从原快照传完整身份；缺身份不登记 waiter、不补取身份、不自动重投。API/store/成员页三套聚焦 `node desktop/node_modules/vitest/vitest.mjs run --root desktop --config <仓库>/desktop/vitest.config.ts src/pages/SubagentRunPage.test.tsx src/api/teams.test.ts src/stores/teamStore.test.ts` → **122 pass / 0 fail**。页面夹具同步真实 session 与 incarnation，workflow 和刷新按对应成员键验证。
- 整合检查历史：`check:server` 为 **7813 pass / 1 fail**（唯一 supervisor 恢复夹具观察错对象，随后上述全套聚焦修复通过）；`check:desktop` 为 **9162 pass / 2 fail / 8 skip**（两个页面旧身份夹具，随后上述聚焦修复通过）。不得把局部复测称为整套重新全绿。桌面 lint/build 首次命令参数位置错误，仅打印 Bun 帮助，即使退出 0 也不计通过；改用 `bun run --cwd desktop lint && bun run --cwd desktop build` 重跑后退出 0，日志确认 ESLint、TypeScript 与 Vite 实际执行，构建通过（保留 chunk-size warning）。`check:persistence-upgrade` 退出 0，包含原有 skipped，不代表全部平台覆盖。`check:chat-contract` 所有 suite 通过（桌面 452 项），`check:agent-flow` 8 passed / 0 failed；均为隔离 mock 协议证据，不是 Teams 浏览器整链验收。
- 删除重建反向交错已补确定性 barrier：send 先持 lifecycle，观测 cleanup 实际锁请求等待；cleanup 获锁时断言旧指令只在旧 live，旧 read 消息进入旧 history；删除后重建同名团队并复用 member session，仅 incarnation 改变，旧身份重试 409 且新 live/history 原字节不变。临时 HOME/config 的 Teams 全套 **109 pass / 0 fail / 394 assertions**，包括首次 Stop 响应基线 0；主控复核了锁屏障与两份文件断言。
- 消费侧只读取证：`inProcessRunner.ts:takeTeammateMailbox` 接受 teamName/agentName，`teammateMailbox.ts:getInboxPath` 按名字定位，claim 仅以 envelope identity 在 inbox 锁下判定，未比较 incarnation/memberSession。随后新增隔离行为探针 `diagnoses an old consumer claiming a recreated same-name mailbox`：真实 cleanup/recreate 后 generation、leadSession、member session 均改变，以保留旧身份调用 production `takeTeammateMailbox`，实际取得新指令，新 live 清空、history 标 read，真正新消费者再取为 null。聚焦 1 pass / 0 fail / 7 assertions、随后 Teams 全文件 110 pass / 0 fail / 401 assertions；其中此用例是缺陷特征复现，不是隔离验收通过；未启动真实旧 runner，因此“现实旧进程存活”仍待验证。不能把发送侧共同锁当作消费隔离证明，生产消费 fencing 尚未修复。
- **仍缺**：真实浏览器新版身份拒绝/刷新/重发验收、旧邮箱消费隔离、部分提交与崩溃恢复。BG-T2 保持 verified-partial，非 accepted。不新增随意重试或提交后补偿。回退须同步客户端/服务端，不恢复无身份自动转投；本批不迁移真实数据。

### P2-2-C：消费侧实例隔离（2026-10-27 进行中）

用户要求先闭合合同再实现，REL-003-C/v3 已经方案审批，Design 对应章节 approved；本交付仍属于 P2-2，不按编辑步骤或会话拆任务。主控负责整合、文档和完成声明；实现子代理负责生产接线与同区测试。delivery_status=verified-partial；身份持久恢复、注册预留、pane backend 映射、permission waiter 失效拒绝与按实例退出清理已接线并补充组合回归。完整浏览器／pane 运行证据及最终门禁缺口仍按下方检查点记录，不能提升为 accepted。

- 目标与范围：创建／可信恢复→固定身份→全部自动消费→本地输入／SDK 实发→安全 ACK。引用 Design C-ID/C-LOCK/C-DELIVER/C-ORDER/C-RESTORE，不复制合同。保持发送 envelope、权限与 Stop 政策；新增可选持久消费身份，不挪用 sessionId。
- 顺序：先从已复现旧消费者误领新邮箱的公开入口转回归，接通身份发行和受锁消费，再覆盖权限响应、lead/poller/attachments、恢复和 SDK 队列；每条链及时相关测试，最后组合验证。
- C01/C02：旧团队重建、成员替换拒绝，新消费者及 sibling 正常；检查新 live/history 原字节及实际输入无污染。
- C03/C04：read 后重建，重复 envelope ID 和 legacy tuple 碰撞；真实锁 barrier 覆盖消费先提交与替换先提交，不用 sleep 猜调度。
- C05/C06：busy/print/SDK 队列排空前替换，实际 sent 与 ACK 分离；permission/shutdown/计划协议、stale 后零 task claim、正常 idle 不误杀；ACK 失败保留 ack_pending，不重发。
- C07/C08：正常发行、原实例恢复、新身份重新加入、缺身份/未知版本/fork拒绝；无 ID 消息兼容、unknown fields 保留；I/O fallback 不绕过身份，Stop 分别处理 SDK 未读和本地已领取批次。
- 测试环境：复用 createSandboxedTestEnvironment，临时 HOME/config/XDG、fake key、mock/loopback；不得真实供应商或历史。先同区 RED/GREEN，再 check:impact 选中检查，持久变更须 check:persistence-upgrade。浏览器缺 agent-browser 仍为环境缺口。
- 文档与回退：证据只在本节记录，PRD 不写完成状态；roadmap 引用本节。仅回退本次 diff，保留原工作区修改；旧代码不理解 fence，降级不保证隔离，不能自动迁移真实用户数据。

设计证据：两路只读盘点及独立 Plan 实现模拟；v1 拒绝，v2 聚焦失败/恢复后仍有 ACK 占位和 Stop 队列歧义，v3 修复，两项定向复核通过，方案审批通过。上述为设计证据，不是生产测试。已同步 PRD/Design/Plan/roadmap；四份文档 frontmatter、围栏配对、尾随空白、私有绝对路径检查通过，git diff --check 通过。新回归与实现正在同一交付内推进，不提前声明 accepted。

**2026-10-27 实现检查点（同一交付未完成）：**

- 已接入 scoped read/claim/ACK 与本地 attachment 接纳、hook 延迟队列、print dequeue、process-worker SDK queued/sent 回执及 ack_pending。lead 创建与 host snapshot 携带 scope；这些代码落点不等于 C01～C08 全部通过。
- print 既有 drain/pause 测试失败原因为 fixture 无 lifecycle/config/scope；补齐合成实例后保留原行为断言，新增缺身份停收、旧队列拒绝、身份拒绝不进入 ACK fallback。三文件 **13 pass / 0 fail / 64 assertions**。
- runner 红例：替换 roster 实例后旧 runner 仍进行第二次 runAgent，预期 1 次、实际 2 次。修正循环入口校验、受 scope 锁保护的自动 task claim、按实例 ID 的 activity 更新与 scoped idle 通知后通过；新增读邮箱时替换后不领取新任务的反例。当前 `takeTeammateMailbox` 的公开返回仍将拒绝合并为 null，外层 guard 仅补齐部分停转，不称 C-FAIL 完整。
- 隔离 HOME/config（createSandboxedTestEnvironment）组合命令：`bun --no-env-file test`，显式列出 `attachments.teammateMailbox.test.ts`、`useInboxPoller.test.tsx`、`conversationService.consumerScope.test.ts`、`inProcessRunner{,.runtime,.helpers}.test.ts`、`consumerScope.identity.test.ts`、`print.leadMailbox{,Drain,Pause}.test.ts` → **93 pass / 0 fail / 367 assertions**。属于合成 fixture / mock 证据，非浏览器或真实模型。
- `check:server` 初次整套 **640 文件 / 7847 pass / 3 fail / 2 failed-files**；失败为 SendMessage 及 spawn 的旧 fixture 无 lifecycle/leadSessionId。补齐 fixture 后两文件聚焦 **9 pass / 0 fail / 27 assertions**；不冒称整套重新全绿。`inProcessRunner.resume.test.ts` 补齐同类 fixture 后 **3 pass / 0 fail / 15 assertions**，仅证明当前进程记忆及旧 metadata 读取，不证明 C-RESTORE 持久身份合同。最终 runner 小调整后，runtime/resume/spawn/SendMessage 四文件组合 **27 pass / 0 fail / 112 assertions**；随后增加合法 idle 自动领取的正向测试（真实 lifecycle/config/task 锁），runtime 单文件 **16 pass / 0 fail / 74 assertions**，证明新增 task fence 不死锁且合法任务进入 in_progress。
- `check:persistence-upgrade` 首次 **failed（1 个 check）**：上述 resume 旧 fixture 等待超时；修正 fixture 后整套复测 **all checks passed**（保留既有 skipped）；不代表尚未接线的持久 scope 合同已验证。`check:chat-contract` 全 suite passed（桌面 452 项），`check:agent-flow` **8 pass / 0 fail**；后两者不验证尚未实现的 scope 恢复。
- `check:impact` 默认比较整分支共 2668 文件，路由多表面全套；另以本轮 11 个核心文件显式检查，要求 policy/server/provider-contract/chat-contract/agent-flow/persistence/coverage。CLI core 仍 blocked：缺 `allow-cli-core-change` 标签与维护者审批，未伪造。未运行全分支 verify，不称 PR-ready。随后相关门禁：`check:provider-contract` **36 deterministic suites passed**；`check:coverage` **passed=5 / failed=0**。`check:policy` 首次 **355 pass / 1 fail**，发现本次 scoped 替换遗留的 print 三个、attachments 一个未使用导入；仅移除这四个导入后整条 policy 复测退出 0（policy 单测 356 项全过，deploy 172 项全过），未改门禁或断言。
- **历史 feature gap（下方续做检查点已更新，不代表当前仍全部未实施）**：C-RESTORE 的 transcript/AgentMetadata 写入、加载、压缩保留及两恢复入口清除/验证尚未接线；C-ID 的单一 transcript/instance ID、lifecycle→config 注册预留、pane 先预留后启动与 backend 映射、恢复调用者/目标原 scope 核验尚缺。C-FAIL 的 permission waiter 拒绝、退出移除条件及最终同步接纳仍需补齐；hook 协议提前 claim 与 C-ORDER 次序偏差需按原合同修正。下一步先闭合这些正式入口，补同区 RED/GREEN，不能仅增加 helper 测试提升状态。
- **test/env/permission gap**：C03/C04 碰撞及双向锁屏障、C07 持久恢复和完整退出清理证据不足；P3 缺 agent-browser 的独立环境阻断不变；CLI core 维护者审批仍缺。未接触真实配置/供应商，未 commit/push/切分支。

**2026-10-27 按已批准合同续做检查点：**

- C-RESTORE 已接入 transcript 同步接纳时捕获、异步写入、加载与压缩保留；AgentMetadata 合并保留 unknown fields。两恢复入口先清除旧 binding，再验证最后一次明确 scope；未知版本、无身份、跨 owner 与 fork 不取得消费资格，历史仍可读并有警告。print 两条恢复分支等待恢复验证。
- C-ID 注册统一使用同一个 transcript/instance ID；lifecycle→config 内验证调用者并预留成员，再启动。pane 先预留 UUID/session，启动参数携带固定 scope；tmux/iTerm2 仅匹配原 pane session。启动失败和退出只清理原实例，晚到操作不得清空新实例邮箱或移除替代成员。
- 原实例恢复验证持久 scope、metadata 文件身份、parent owner 与调用者；显式重新加入使用新 ID，并沿用旧历史作上下文，不改写旧 metadata。并发恢复以完整目标身份归并，等待后复核目标，冲突不按名字转投；返回文案区分原实例恢复和新身份重新加入。
- C-FAIL/C-ORDER：permission UI 和邮箱 waiter 在身份失效后拒绝并清理自己的等待项；晚到 allow 受最终锁保护。`takeTeammateMailbox` 对 stale/unbound/unsupported 明确拒绝，不再等同空邮箱；hook 普通消息保持先本地接纳再 mark，权限/协议处理需 scoped claim 成功。最终退出/idle 通知仅作用原 scope。
- 最终审阅补充 RED→GREEN：真实 claim 后以确定性屏障替换成员，旧 runner 虽未再次调用模型，仍把旧批次追加至本地 task 输入（断言正文不应出现而失败）。`takeNextPrompt` 改为最终双锁复核后同步追加，三个调用点均等待其结果；四文件 runtime/helpers/resume/SendMessage 组合 **45 pass / 0 fail / 174 assertions**。不撤回失效前已合法执行的副作用，不新增持久事务。
- 新增闭环组合：通过 `createSandboxedTestEnvironment` 执行 `bun --no-env-file test`，覆盖 sessionStorage/sessionRestore、useSwarmInitialization、replTranscriptBinding、consumerScope、runner runtime/helpers/resume、spawn、teammateInit、teamRuntimeSnapshot、spawnMultiAgent、SendMessage 共 **14 文件 / 88 pass / 0 fail / 384 assertions**。这在末次 handoff 修复前执行；末次修改由上述 45 项相关回归补验，不把旧完整结果当最终冻结证据。
- `check:server` 修复后完整复测：**645 文件 / 7892 pass / 0 fail / 0 failed-files**；替代此前 4 失败的中间运行，先前 scheduled-task/supervisor 等待失败未在本次复现。该完整运行早于末次 handoff 修复，修复后相关四文件补验通过。`check:desktop`：**548 文件 / 9168 pass / 8 skipped**，ESLint、TypeScript、Vite build 实际通过，保留 chunk-size warning。
- 新增消费身份兼容检查后，以隔离 HOME/config 执行完整 `check:persistence-upgrade`，退出 0 且 `all checks passed`；包含 legacy 无 scope、unknown fields、压缩/重载、两恢复入口与重新加入，保留既有 skip。相关已有门禁：policy **356+172 项 / 0 fail**；provider-contract **36 suites passed**；chat-contract 全部通过；agent-flow **8 pass / 0 fail**。末次 runner 修改未改变这些协议接口，未重复整套跨面检查。
- `check:impact` 只传生产路径会误报缺匹配测试；把实际修改及新增的 runtime 测试一并传入（107 文件）后，该阻断消失，仍选中 policy/desktop/server/provider/chat/agent/persistence/coverage；**CLI core 维护者审批与标签仍 blocked**，未伪造。
- **test gap / failed**：本次完整 `check:coverage` 为 **passed=5 / failed=1**，变更行 **68.62%（2268/3305）<90%**，不能沿用此前 coverage 全绿声明。instrumentation 的 server/tools/utils 进程有退出 1 注记；per-file server correctness 已单独通过，但不证明覆盖率门禁通过。低覆盖集中于 runner、spawnMultiAgent、hook、REPL；本轮不降低阈值、不改路由、不删断言。报告为本地 artifacts 下本次 coverage-report，不提交生成物。
- **env/test gap**：标准浏览器 lane 仍缺 agent-browser；真实 pane 启动／重连、浏览器最终交接未运行。独立 root TypeScript 检查受缺 `bun-types` 阻断；desktop TypeScript 已通过，不借其证明 root 编译。C01～C08 已有多条生产入口回归，但未逐项建立所有新 live/history/queue/socket 拒绝断言的完整证据闭包，尤其完整跨进程时序不能仅凭 helper 测试宣布覆盖。
- 当前 **delivery_status=verified-partial**：已补齐上述必要生产接线并修复最终 handoff 反例；未把持久兼容、局部组合或 mock 结果称为浏览器整链 accepted。未使用真实配置/历史/供应商，未 commit/push/切分支。剩余工作仅为同合同验收证据及覆盖率缺口，不扩大到权限政策或其他能力。

**2026-10-28 按用户纠正收窄为必要补缺：**

- 必须补齐本合同可直接判断正确性的证据，而非把所有环境问题都升级为实现任务。新增 C01/C03 回归：持有原 scope 的消费者先读旧批次，真实删除并重建同名团队后，read/claim/ACK 全部 stale；新 live 原字节保持、history 不创建。消息含重复 envelope ID 和完全相同 legacy tuple；新实例仍完整领取 5 条并写入已读历史，避免只测无身份 unbound。
- 新增 C04 顺序证据：旧消费在真实 lifecycle→config 锁内停于 barrier，观察替换确已请求 config 锁后才释放；旧批提交成功、替换随后完成。替换后的旧 read/claim/ACK 拒绝，新 live/history 原字节不变。没有用 sleep 猜测调度。
- 最终隔离组合使用 createSandboxedTestEnvironment 执行 identity、runtime、helpers、resume、SendMessage 五文件，**52 pass / 0 fail / 216 assertions**。新增的是已实现合同的证据，不伪称新生产缺陷的 RED→GREEN；runner 最终接纳反例沿用前述真实 RED 记录。
- `check:impact --files` 对上述五文件确认仍需 policy/server/provider/chat/agent/persistence/coverage；CLI core 审批 blocked，未伪造。最终隔离 `check:server` 复验退出 0：**645 文件 / 7895 pass / 0 fail / 0 failed-files**，覆盖末次 runner handoff 与新增身份测试。最终 `check:policy` 退出 0：policy **356 pass / 0 fail**，deploy **172 pass / 0 fail**，shell 语法检查通过。最终标准 `check:coverage` 复验退出 1，报告 `artifacts/coverage/2026-10-28T07-08-35-374Z/coverage-report.md`：**passed=5 / failed=1**，变更行 **68.71%（2268/3301）<90%**。root instrumentation 实际 **7787 pass / 5 skip / 140 fail**，仍可复现 NODE_ENV guard 异常；这与逐文件 sandbox 的 server 全绿是不同执行模式，不能互相替代。不能把比例微变称为覆盖改善：covered 数仍为 2268。覆盖率仍是验收前必须解决的 test gap，污染写入者和其余低覆盖原因尚未确证；本轮不盲改、不再次重复整套门禁、不降低阈值。
- coverage 失败必须保留并调查，但此前“已确定为某测试删除 NODE_ENV 后未恢复”的归因不成立：agentWorkers 文件头已有环境快照和 afterEach 恢复。这是此前分析错误，不能据此修改该测试；确切污染源仍待实证，不把恢复正常的测试改成所谓修复。只读调查与主控复核确认旧 coverage 日志中 DreamTask setup/teardown 确因 NODE_ENV 非 test 触发 guard；这只能证明环境当时异常，不能反推写入者，也不能解释全部 139 个失败。隔离的 claudeRequiredThinking + DreamTask 正常组合未复现污染；未修改 guard、未在消费测试内强设 NODE_ENV 掩盖故障。
- 后续取证确认两条独立污染链，而非恢复正常的 agentWorkers 文件：① 单进程 coverage 中 `claudeRequiredThinking` 请求测试超时，异步 finally 未及时恢复 NODE_ENV，后续文件捕获 production；正常组合通过不能排除超时路径。故意 50 ms 超时探针修复前哨兵失败，修复后立即及延后哨兵通过（故意超时本身仍失败，取消伴随异步错误，不计全绿）。该测试增加 afterEach 同步恢复、幂等清理及 AbortController，防止迟到 finally 覆盖下一测试。② history 使用的 mock.module 跨文件持久覆盖 sleep/lock/fs，mock.restore 不会注销。history 改为可恢复 spyOn，保留全部原断言；history + withRetry 由原 6 fail 变为 **48 pass / 0 fail / 174 assertions**，带 coverage 模式同样通过。主控再用 sandbox 合并 history、withRetry、claudeRequiredThinking、DreamTask：**4 文件 / 86 pass / 0 fail / 355 assertions**。未改生产、阈值或路由；标准 coverage 复验退出 1，报告 `artifacts/coverage/2026-10-28T07-45-12-738Z/coverage-report.md`：5 个 suite passed、changed-lines **89.04%（2869/3222）<90%**，root instrumentation **7876 pass / 5 skip / 51 fail**。环境 guard 级联已消失，但请求超时及其他跨文件失败仍存在；不能把插桩进程记为全绿。LCOV 可测行集合也发生变化，不能把比例变化全归为新增行为覆盖。下一步仅补消费合同中有实际价值的未覆盖行为，不扩展为全仓污染清理、不放宽门槛。
- 在既有 useInboxPoller Harness 补充 7 条协议消费回归：sandbox 合法/畸形请求、成员权限更新、mode 切换及 mutation 时实例替换、计划批准回信、确认队列不可用保留未读、leader 三类决议回信。真实调用 hook，依赖仍使用既有 seam，不改生产代码；主控使用 createSandboxedTestEnvironment 独立复验：**23 pass / 0 fail / 76 assertions**。聚焦 LCOV 显示 hook 覆盖增加，但不把投影比例作为门禁证据；新增回归后的标准 `check:coverage` **退出 0**，最终报告 `artifacts/coverage/2026-10-28T08-01-03-252Z/coverage-report.md`：**5 个范围 passed / 0 failed，变更行 91.78%（2959/3224）≥90%，Failures=none**。hook 变更行实测 **277/314（88.22%）**，不再使用投影。root instrumentation 仍为 **7883 pass / 5 skip / 51 fail**；沿用既有门禁对完整 LCOV 与逐文件正确性的分离，不将其称为断言全绿。逐文件 server 的既有 645 文件 / 7895 pass 证据早于末次测试代码修订；三个受影响测试文件由上述 86 项组合和 23 项 hook 独立补验，生产快照未再修改。`git diff --check` 通过，已复核本轮测试 diff 与工作区状态。此次必要补缺的 C01/C03、C04 证据及 coverage 门槛已满足，停止扩展测试清理；真实 pane/浏览器未运行、CLI core 审批仍 blocked，整体保持 **verified-partial**，不称 accepted 或 PR-ready。未 commit/push/切分支，未使用真实供应商或用户数据。
- 不必为本轮新增依赖补 root tsc 或安装 agent-browser；前者不是当前仓库声明的检查入口，后者属于仍未验证的实际浏览器/pane 环境边界。两项不算通过，也不借此扩大范围。CLI 审批是外部权限门槛，不能用代码补足。当前仍为 **verified-partial**，不能声称 accepted 或 PR-ready；coverage 和真实入口证据缺口保持可见。

### P2-3：Stop 等待结算（2026-10-27 已接线，部分验证）

对应 REL-003 / BG-T3；合同见 Design「T3 停止水位合同」。用户确认后续顺序为 T3→T2 剩余交错→P3，且明确不做执行前持久运行标记；普通崩溃恢复语义不变，Stop 写失败后立即崩溃的窗口继续披露，不将其称为已解决。

- RED：桌面新回归在发送后 Stop 仍为 `thinking`，断言 `expected 'thinking' to be 'idle'` 失败。
- GREEN：Stop 的 config mutation 单调递增 `stopEpoch`；成员发送在共同锁内返回其提交时水位。detail/workbench/team_update 贯通该字段，桌面只在同身份的团队水位严格大于发送水位时结束等待；不伪造回复、错误或交付成功。相同/倒序水位及旧服务缺字段不触发 Stop 结算。
- `bun --no-env-file test src/server/__tests__/teams.test.ts` → **108 pass / 0 fail / 381 assertions**，包含发送响应水位与旧配置省略字段。
- 隔离 HOME/config 的 `bun --no-env-file test src/server/services/teamPlanRuntime.supervisor.test.ts` → **48 pass / 0 fail / 245 assertions**；包含 Stop 水位仅随用户 Stop 推进，以及现有批准、待命、动态任务、交付退回、Stop/继续与恢复组合用例。这是 service fixture 证据，不是浏览器服务重启整链。命令经管道输出，退出码不单独作为依据，已核对实际汇总为零失败。
- 在 `desktop/` 运行 `node node_modules/vitest/vitest.mjs run src/stores/chatStore.test.ts src/stores/teamStore.test.ts src/api/teams.test.ts` → **465 pass / 0 fail**。
- 在 `desktop/` 运行 `node node_modules/vitest/vitest.mjs run src/pages/SubagentRunPage.test.tsx src/components/agentTeams` → **191 pass / 0 fail**。
- 首次 Stop 边界复核发现此前响应省略旧 config 的零水位，导致首次停止无法结算。HTTP 回归先 RED（收到 `{ok:true}`，缺少 `stopEpoch:0`），服务端改为在锁内返回 `config.stopEpoch ?? 0`，不写旧配置。桌面参数化覆盖 0/4 两个起点并补 Stop 先于发送回执的交错，`teamStore.test.ts` **66 pass / 0 fail**；旧服务无响应水位仍保守等待。
- 既有 `check:persistence-upgrade` 加入 Stop 旧配置基线/跨恢复用例，隔离 HOME/config 重跑退出 0，日志 `all checks passed`；保留原有 skip，不外推全平台通过。
- 完整 `check:desktop` 复跑通过：**548 文件、9168 passed / 8 skipped**，lint、TypeScript/Vite build 均通过。`check:chat-contract` 首次复跑暴露本轮后台终态测试等待文件出现而非持久化 Promise 完成的竞态（112 pass / 1 fail）；已改用同一事件的持久化 Promise 屏障，不改生产转发或断言，`check:chat-contract` 复测全部通过（桌面协议 452 项），`check:agent-flow` **8 passed / 0 failed**。完整 `check:server` 为 **638 文件、7821 passed / 0 failed**；该运行期间新增的消费特征探针和通知测试屏障另以各自聚焦复测为准，不冒称整套在最终冻结状态运行。浏览器 Stop 与回执乱序、刷新跨实例、服务真实重启均需 P3 补证，BG-T3 不标 accepted。

### P3：标准浏览器整链（2026-10-27 进行中，环境阻断）

复用 `scripts/quality-gate/desktop-smoke/{deterministic,team-plan}.ts` 标准入口，计划串联真实批准、无任务角色待命、动态任务首次启动、身份直发/回声、v1 退回/v2 接受、Stop、保留临时 config 的真实服务进程重启、reload 保持暂停、新合法指令继续；仅 SDK transcript/成员回答模拟，不 seed 批准、启动或恢复结果。

首次实际执行 `bun run check:desktop-ui-smoke` 明确 **SKIPPED：agent-browser is not installed**，`artifacts/desktop-ui-smoke/result.json` 也以 `status=skipped` 落盘，避免退出 0 被误读为通过。主控核对 PATH 与项目两处 node_modules/.bin 均无现成入口；未安装依赖、未用 ad-hoc 浏览器替代标准 lane。

已接线内容（代码与相邻测试，非浏览器证据）：seed 仅 review_pending 与 leader，无任务/批准启动/恢复结果；批准后两名成员 standby 且无 worker boot；sandbox 子进程经 production `createTask` 动态分配；真实发送按 envelope id 关联 pending，mock worker 先用 production `readMailboxHistory` 找到真实投递记录并等待 production supervisor ACK，再生成 mock SDK 回复；v1 提交经 production `applyTaskDeliveryAction`，浏览器退回/接受走真实 UI；Stop 前另发受门控消息且先断言真实状态指示器，Stop 后要求其消失、无伪造 echo 或 ack；最后经 `stopDesktopSmokeProcess` 终止并 `await exited` 的真实进程重启，reload 不复活，新指令恢复同 session 与既有 transcript。

- 相邻测试 `team-plan.test.ts`、`team-worker.test.ts`、`deterministic.test.ts`、`execute.test.ts`：**35 pass / 0 fail / 138 assertions**；其中 loopback 用例真实 spawn mock CLI、经 loopback WS 输入并检查 ACK 前无 echo、ACK 后按精确 id echo、kill 后 `--resume` 读取同一历史。这是 mock 协议证据，不是真实服务/UI 整链。
- `check:policy` 隔离重跑退出 0（172 项，含 Docker 边界回归）；同一脚本改动 `check:impact --files` 仅路由 policy。
- **未产生**：oldPid/newPid、截图、`team-p3-evidence.jsonl`、`team-review-result.json`；lane 在 prerequisite 阶段即跳过。真实浏览器选择器、跨 tab 路径、Stop 清除状态指示器、重启与恢复仍归 env/test gap，不能标 accepted。

### P1：压缩请求与配置边界（独立可验收交付）

**目标：** 压缩保持既有请求上限、取消及显式配置，不扩大功能或成本默认值。

**范围：** BG-C1 的候选 cap 合法性；BG-C2 的 Azure 耗尽传播和 PTL full/partial 组合验收。生产落点预计为 `src/services/compact/compact.ts`、`src/services/api/claude.ts`；测试复用 `compactRequestBudget.test.ts`、`compactRequestBudget.loopback.test.ts`，Azure 选最近的现有 provider/API suite。仅实际红例证明必要时调整其他已接线调用层。

**验收：**

1. 高 thinking 边界先红后绿；fork 分发不接收低于合法 floor 的 cap，不提高 20000 默认上限。
2. 宽裕窗口仍 keep-cache-key，普通无预算对话、用户低输出上限和取消行为不退化。
3. Azure 耗尽保留结构化类型，无额外请求、不变成功；一般 provider 错误仍走原路径。
4. 从 full 与 partial 实际外层入口经历 PTL 截断、fork/fallback 和重试，loopback 观察总请求≤6；取消后无新请求，错误/耗尽/取消不提交成功 boundary。未触发的支路不凭代码存在算覆盖。

**测试方式：** 单个回归 RED→最小修正→GREEN，再运行受影响 compact/provider 子集；所有环境使用临时 HOME/config、fake key、loopback。PTL 用例若已绿只补测试，不改生产。

**执行证据（2026-10-27，用户批准 P1 后）：**

| 项 | 红例（修复前） | 最小修正 | 结果 |
|---|---|---|---|
| BG-C1 | `compact output cap > never returns a cap below the thinking floor the window would allow`：窗口 30000、显式 thinking 25000、`CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000` 时返回 `capped/20000`，会把 budget 压到 19999 | `compact.ts:getCompactForkOutputCap` 改为先算 `cappedOutputTokens = min(默认上限, 20000, 可用空间)`，再与该 floor 比较，不足则 `declined/no-room`；未提高 20000 | 44 pass / 0 fail（`compactRequestBudget.test.ts`）；同时保留“fork 上限仍满足 floor 时继续 capped 20000”的回归用例 |
| BG-C2 Azure | 新增 `claudeAzureRequestBudget.test.ts`：预算 remaining=0 时 Azure 分支把拒付改写成 assistant API-error，流正常结束 | `claude.ts` Azure catch 先 `isRequestBudgetExhausted` 再 rethrow，其余错误仍 yield assistant error | 3 pass / 0 fail；覆盖拒付零请求、同一预算第二次拒付、500 仍走原错误呈现并只扣一次 |
| BG-C2 PTL | 新增 full/partial 外层 loopback 用例 | **未改生产代码**：既有预算已贯通外层重试 | 12 pass / 0 fail（loopback 子进程）；full、partial 各 6 次真实请求后预算耗尽、无第 7 次请求；PTL 响应后取消不再发请求 |

命令与结果（均为隔离 HOME/config、fake key、loopback）：

- `bun test src/services/compact/compactRequestBudget.test.ts src/services/compact/compactRequestBudget.loopback.test.ts src/services/api/claudeAzureRequestBudget.test.ts src/services/api/withRetry.requestBudget.test.ts src/services/api/azureOpenAI.test.ts` → 76 passed / 0 failed（5 个文件）。
- `bun test src/services/compact/` → 65 passed / 0 failed（4 个文件）；loopback 主体以子进程运行，另以隔离 HOME 直跑子进程确认 12 passed。
- `bun run check:impact` → 选中 policy/desktop/server/provider-contract/chat-contract/agent-flow/adapters/native/persistence-upgrade/docs/coverage；`Blocked: yes`（CLI core 需 `allow-cli-core-change` 标签与维护者批准，与历史一致，未绕过）。
- `bun run check:server` → `files=638 passed-tests=7809 failed-tests=0`。
- `bun run check:provider-contract` → `36 deterministic suites passed`。
- 文档侧替代验证：`npm --prefix site run check`（typecheck + site check:docs + 59 tests）→ 59 passed / 0 failed；未执行官方 lane 的 `npm ci` 与 `vite build`。

未运行：真实供应商/真实模型 smoke（未授权）、`check:desktop`、完整 `check:docs`（含 ci/build）、`check:coverage`、完整 `verify`。本轮 diff 只触及 `src/services/compact/compact.ts`、`src/services/api/claude.ts` 与三处测试及本目录文档，桌面与站点正文未改；这不等于其余 lane 对整分支已通过。

**校验口径：** BG-C1/BG-C2 达 `verified-partial`——确定性单元与 loopback 请求计数通过，真实 provider 未验证；不提升整链状态。

**文档：** 在本表和证据节记录每个场景、真实命令、输出及缺口；Design 只更新被确认的合同，不回填 pass 数。

**回退：** 本交付不新增持久字段；保留请求预算基础实现，只撤回本交付差异。不通过调整上限/错误吞并来回退失败。

### P2：Teams 停止、实例和等待的纵向补缺（一个交付任务）

**目标：** 用户停下的工作跨恢复仍停下；指令不能错投新团队；成员等待与真实停止边界一致。

**范围：** BG-T1/T2/T3，以及仅在 BG-D1 决策和差异 Design 就绪后纳入的权限实现。内部顺序为暂停持久化→提交实例隔离→等待结算→权限矩阵，不把各层拆为独立交付 Todo。预计涉及 `teamPlanRuntime.ts`、既有 team schema/helpers/store、`teamService.ts`、`src/server/api/teams.ts`、`desktop/src/api/teams.ts`、`desktop/src/stores/teamStore.ts` 及相邻测试；具体字段、API 兼容与锁协议必须先由 Design 闭合。

**验收：**

1. 零任务批准→动态 ready task 首次启动；Stop 发生在 spawn 前/中/后都生效，首次启动不计崩溃。
2. Stop→实际服务子进程重启→读取/重连/旧 lead 或 peer 消息/任务变化不启动；新的合法用户/主控指令才继续且沿用原成员历史。落盘失败与并发再次 Stop 均按已批准合同处理。
3. 按 REL-003-M1 拒绝缺实例身份的 HTTP 请求及其重试，live/history 零写入，不补当前同名身份、不自动转投；客户端升级／刷新取得绑定身份后由用户重新发送。正常同实例重试幂等；完整身份的迟到 POST、验证与写入间删除重建或成员替换均不写入新实例；冲突不会自动重发到新团队。通过实际 REST→service→mailbox 及桌面失败/重新发送路径验收，核对缺身份请求前后 live/history 内容和无新增记录，不仅断言响应错误。
4. 回声前/后 Stop 或取消只结算此前对应等待；原本 stopped 成员的新唤醒消息、迟到旧快照、同文不同 ID、他人成员终态均不被误清。
5. 权限按已确认政策 A 和下列 BG-D1 矩阵验收；政策选择不再 blocked，但实施仍受 D1-F1～F4 合同闭合及实施授权阻断，不得把未运行的矩阵记作通过。
6. 旧团队可读、未知字段保留；新增持久形状有前向兼容、旧夹具和 `check:persistence-upgrade`。不能仅加 optional 就宣称迁移完成。

**测试方式：** 从现有 supervisor、Teams REST、mailbox、store/API suite 逐个红例推进；跨进程恢复使用临时数据与 fixture worker，不操作真实团队。必要 UI 文案才同步五语言；不得只测纯辅助函数而遗漏生产入口。

**文档：** Design 记录数据/错误/状态合同；Plan 记录证据和数据回退限制；需求语义经用户确认后同步 PRD。

**回退：** 新格式测试副本验证后才可写实施代码；任何保留暂停/授权状态的新字段，在旧程序可能忽略它时不能承诺直接代码回退安全。回退需先停止隔离运行、保留备份，按已批准兼容合同选择支持版本；不删除暂停/交付历史。真实数据及生产迁移不在此批授权内。

#### BG-D1 权限验收矩阵

以下均为 **planned / not run**，不是已新增测试。业务依据为 REL-009-A1～A5；算法、接口、状态和回退合同只在 Design BG-D1 维护。需先完成 D1-F1～F4，确认 proposal 后才进入 RED→GREEN；预期结果尚依赖关键裁决的行明确保留 blocked。

| 编号 | 场景与可观察结果 | 验证入口／证据 | 前置缺口 |
|---|---|---|---|
| D1-A01 | 原权限批准含待命角色→仅扩大主控→动态任务首次启动；worker 不获得超原上限权限，无重复整队审核 | 实际批准 service→supervisor→fixture worker 的启动参数及工具允许/拒绝行为 | F1/F3 |
| D1-A02 | 已运行成员面对主控扩大、刷新、恢复与新消息，不静默升权；预设 default/未指定亦相同 | WS→runtime 控制与实际工具决策记录；不能只断言配置字段 | F1/F2 |
| D1-A03 | 只对所选成员明确批准增量，其他成员上限不变；当前更严限制仍可拒绝该权限 | Teams UI→可信批准 API→磁盘→worker，正反向权限断言 | F1/F3 |
| D1-A04 | 模型请求、普通继续消息、取消、拒绝、旧页提交均不扩大；拒绝后原范围工作不被误当作全部撤销 | API/supervisor 拒绝路径与浏览器状态 | F3 |
| D1-A05 | 同请求重试一次生效；载荷不同、跨实例或过期版本拒绝；响应丢失后可查已提交结果，不重复审批/启动 | store/REST 受控并发、持久记录数量与版本 | F3 |
| D1-A06 | 写失败不应用新权限；写成功但 runtime 失败显示已批准未生效；进程重启按持久事实恢复，不重放工具 | 注入写/控制失败，独立进程重启及 UI 错误状态 | F2/F3 |
| D1-A07 | 待命成员启动前执行最新收紧；按 A5 阻止新的越界执行并立即请求取消受影响的已开始工具；终止未确认时显示正在停止/结果待确认且执行链不得继续；取消 ACK、超时或失联不伪报已停止，不自动重放或保证回滚副作用 | WS→工具准入/取消→状态 UI；受控覆盖 allow 后未开始、执行中、取消失败/超时/失联、重启后阻断和无关合法工作 | A5 政策已确认；F2 接线、终止证据及恢复合同仍 blocked；not run |
| D1-A08 | 批准后编辑预设不能改写冻结约束；新增显式限制、不可比较模式及限制解除不凭枚举排序裁决 | 成对模式/规则矩阵，经实际权限判定而非仅 helper | F1 blocked：组合裁决表未闭合 |
| D1-A09 | 增量批准与 Stop、再次收紧、spawn 并发不越界；批准不解除 Stop，合法继续仍受上限 | supervisor+持久 store 受控屏障；重启重复相同时序 | F2/F3 及 BG-T1 |
| D1-A10 | 新格式重启保留上限与批准来源；缺证据旧团队按 A4 在重新确认前零启动/恢复/新模型或工具执行且历史可读，取消/失败/重试不解锁；明确确认展示的成员和权限后可续用原会话，仍受更严限制与 Stop 约束；未知 schema 只读、未知字段及交付历史不丢失 | 合成旧/新夹具→确认 UI/API→持久记录→恢复/工具准入；persistence-upgrade，确认前后独立重启 | A4/A5 政策已确认；F2 取消执行、F3 确认一致性及 F4 迁移合同仍 blocked；not run |
| D1-A11 | UI 展示旧/新上限、目标成员、当前限制；覆盖 pending、取消、冲突刷新、失败、已批准未生效；更严限制不可被按钮绕过 | 实际浏览器，网络响应、截图及 worker 行为同场景对应 | F3；设计定稿后同步五语言 |
| D1-A12 | 旧版本不理解上限时不能宣称直接回退安全；隔离停止/备份后验证受支持版本恢复，批准记录不丢 | 临时数据副本及版本兼容检查，无真实数据操作 | F4 blocked：兼容方案未定稿 |

通过标准：每行记录真实命令、入口、fixture、结果与证据路径；blocked/not run 不计通过。初次批准、增量批准、收紧和跨重启至少各有贯穿真实入口的行为证据；UI 证据不能替代工具权限结果。全部必要行通过后才可提升权限链状态，单纯政策或文档确认不提升运行交付状态。

### P3：一条近真实整链与相关门禁（前两交付的整体验收）

**目标：** 证明用户入口到可观察结果的组合行为，而不是用 UI seed 和 supervisor 单测拼成整链完成。

**范围与验收：** 复用现有标准批准 UI、fixture runtime 和成员/交付组件，在同一个临时环境执行：创建预设/计划→用户批准（含无任务角色）→范围内动态任务→仅首次启动一次→直发消息并精确结算→v1 退回→v2 提交/独立验收→再次出现待处理工作后 Stop→终止并重启实际服务进程（保留临时数据）→reload 不复活→新合法指令才继续。权限扩大场景按已确认政策另作一个聚焦反例，不把真实模型混入确定性 smoke。

**测试方式与接线：** 将新增场景接入现有 `check:desktop-ui-smoke` 本地入口，保留无 provider 的可运行方式，不新增自动安装依赖或独立测试框架。缺浏览器工具时明确 blocked；seed 可准备输入但不得 seed 批准结果、首次启动成功或恢复状态来绕过关键链路。至少保存机器断言、关键截图、进程重启/请求计数和用户状态隔离证据。

最终差异先执行 `bun run check:impact`，再运行实际选中的检查；Teams 持久变化补 `check:persistence-upgrade`，审批/交互补 `check:desktop-ui-smoke`，真实请求路径补 provider 契约。相关检查沿用原隔离规则；全部实现冻结后才在要声明整体就绪时执行完整 `verify`，不为每个小编辑重复全套。维护者审批、未选 lane、环境阻断照实记录，不改路由/阈值，不添加假标签。未改动且未失效的结果可复用。

**文档：** 本节状态表、最终证据及 roadmap 当前状态集中同步；历史报告不删除、不把旧失败改成通过。最终报告逐对象说明能力、覆盖与验收状态。

**回退：** 测试只用可销毁临时环境；仅撤回新增场景的接线不改变 required CI 策略。若 UI smoke 不可运行，不能据此把相关实现标为 accepted。

### 本轮文档交付记录

2026-10-27：已整理上述差异设计与最小验收草案。新红例、修复、迁移、运行验证均 not run；初稿时权限政策和旧消息 API 的兼容选择未确认；后续确认分别见政策 A、A4/A5 与 M1 确认记录，不把当时的待决状态当作当前状态。未改生产代码或测试；未提交、推送、发布、调用真实模型或访问真实团队数据。文档补验：三个修改文档的本地链接、章节锚点、代码围栏及尾随空白检查 passed，`git diff --check` passed。完整 `check:docs`、独立 Design 模拟评审和产品测试 not run；不借用 2026-10-26 的运行数字证明本轮新缺口已关闭。

2026-10-27 政策确认续记：用户明确选择 A，已同步 PRD REL-009-A1～A3、Design BG-D1、P0/P2 与 roadmap；补充 D1-A01～A12 验收矩阵。只读核实初次批准身份/版本检查、落盘后启动、runtime 权限确认及活跃回合 defer，未运行权限探针。政策 decision-gap 已关闭；D1-F1～F4 及 BG-T1/T2/T3 的承重合同仍未闭合，Design Readiness=not-ready，补缺 delivery_status=planned，原整链仍 verified-partial。未改生产或测试代码；没有提交、推送或真实服务操作。独立实现模拟、产品测试与完整 check:docs 均 not run；本次四份文档的本地链接、章节锚点、围栏和尾随空白静态检查 passed，git diff --check passed；文档目录当前未跟踪，故另行直接检查四份文件，不把 git diff 的空结果当作它们已受检查。

### 2026-10-27 P0 只读取证记录（源码盘点完成，P0 未完成）

授权边界：用户明确要求 P0 只读取证、不动生产代码，取证完成后逐个提交需要用户决定的事项。本次只检索/读取仓库源码，并回填既有 Design/Plan；未修改生产或测试代码，未读取真实团队、凭据或用户历史，未运行产品测试/应用/真实供应商请求，未提交或推送。

- BG-T1、BG-T2、BG-T3 三路源码报告已回收，主会话复核暂停与恢复构造、sendInterrupt、创建/删除锁、service 发送/邮箱锁、等待结算与 WS 事件字段等关键锚点。机制只在 Design 对应小节保留，不在此复制详细报告。
- BG-D1 报告已回收，主会话复核运行时模式集合、plan/bypass 特例、WS defer、批准 schema/requestId/revision 顺序及 worker 启动时权限来源。四路源码盘点已完成，但 F1 未产出受支持组合裁决表，F2/F3 仍缺共同准入/一致性合同，F4 的旧团队续用政策已由下述 A4 确认，A5 请求立即取消政策亦已确认，但可靠取消、迁移/回退合同未闭合；因此 P0 整体未完成。只读检查不证明竞态已复现，不证明候选锁协议、停止代次或权限算法可实施。
- A4 旧团队可执行范围、A5 在途工具请求立即取消，以及 REL-003-M1 缺身份 HTTP 请求拒绝政策均已确认，见下述确认记录。本轮列出的三项业务选择不再待用户决定；其余失败状态、身份/代次、可靠取消、提交隔离与一致性合同仍由设计负责人补齐，不将全部实现选择推给用户。若后续证据揭示新的重大业务取舍，再单独说明，不把现有确认当作全局实现批准。
- 静态检查 passed：四份 feature 文档的本地链接目标、围栏、尾随空白及无本机绝对路径检查通过；`git diff --check` 通过。未宣称锚点逐项自动校验或完整站点构建通过。文档目录仍未跟踪，因此直接检查文件内容，不把 `git diff` 对该目录的空结果当作文档已被审查。独立实现模拟、Teams 红例、浏览器验收与完整门禁均 not run。P1 证据维持原有有效范围，Teams 补缺仍 planned / Design not-ready。

### 2026-10-27 A4 旧团队重新确认政策

用户明确确认：缺少历史权限上限证据的旧团队，可在用户明确重新确认展示的成员和权限后继续原团队；确认前不启动、恢复或放行新的模型／工具执行，只读历史保持可访问；在途工具处置另行决定。本次仅更新文档，不授权 P2 编码。业务规则已写入 PRD REL-009-A4，技术承接见 Design“旧团队重新确认规则”，验收更新 D1-A10；roadmap 同步该 decision-gap 已关闭，F2/F3/F4 的执行与迁移合同并未因此就绪。

本轮只修改四份 feature 文档；未改生产或测试代码，未操作真实数据、运行应用或使用供应商额度，未 commit/push。验证 passed：`git diff --check`，四份文档的本地链接目标、围栏、尾随空白、绝对路径卫生及 A4/待决状态一致性检查；目录仍未跟踪，已直接检查文件，不依赖该目录的空 diff。完整 check:docs、产品测试及浏览器验证 not run。Teams 补缺保持 planned / Design not-ready，P0 未完成，整链状态不提升。该记录时在途处置仍为未确认提案；后续选择以 A5 确认记录为准，不视为当时已经授权。

### 2026-10-27 A5 在途工具取消政策

用户明确选择请求立即取消，规则真源见 PRD REL-009-A5，执行差异见 Design“在途工具取消规则”，验收更新 D1-A07 和 D1-A10，roadmap 同步该政策决策已关闭。阻止新越界执行，立即请求取消受影响的已开始工具；终止未确认时显示正在停止／结果待确认、受影响执行链不得继续，不自动重放、不保证撤回既有副作用。确认取消政策不等于取消能力已实现或 F2 合同已就绪，未授权强杀所有工作、P2 编码或真实团队操作。

本轮只改四份 feature 文档，未改生产或测试代码，未运行应用、产品测试、真实供应商请求或执行 commit/push。静态检查 passed：`git diff --check`、四份文档的本地链接目标/围栏/尾随空白/绝对路径卫生及 A5 决策状态一致性检查。文档目录未跟踪，已直接检查内容，未将空 diff 当作文档验证；完整 check:docs、产品与浏览器测试 not run。P0 未完成，Teams 补缺保持 planned / Design not-ready。该记录时剩余用户决策为 BG-T2 缺实例身份的旧 HTTP 兼容边界，现由下述 M1 确认记录更新；锁与 schema/API 详细合同仍由设计负责人补齐。

### 2026-10-27 M1 成员消息 HTTP 兼容政策

用户接受缺实例身份即拒绝旧成员消息 HTTP 请求，live/history 零写入；不按当前同名团队补身份、不自动转投。客户端升级／刷新取得绑定身份后由用户重新发送；完整身份的提交隔离仍须设计验证。本次仅授权更新文档，不授权 P2 编码。业务真源见 PRD REL-003-M1，设计承接见 BG-T2，验收更新 P2 第 3 条，roadmap 同步该 decision-gap 已关闭。

此前列出的三项业务决策已全部确认，不等于 P0 完成：BG-T1 持久暂停/并发/失败及旧数据合同、BG-T2 完整身份与成员替换的提交隔离、BG-T3 停止事件代次、D1-F1 模式能力裁决、F2 可靠取消与终止证据、F3 批准一致性、F4 迁移/回退及独立设计模拟仍未闭合。无新证据不追加大范围扫描或重复评审；不把已知政策继续交给用户重复选择，也不把未验证技术合同写成可实施。Teams 补缺保持 planned / Design not-ready，整链仍 verified-partial。

本轮仅修改既有四份 feature 文档，保留工作区已有修改；未改生产或测试代码，未运行应用、产品测试、真实供应商请求或操作真实团队，未 commit/push。验证 passed：`git diff --check`，四份文档本地链接目标、围栏、尾随空白、绝对路径卫生及 M1 决策状态一致性检查。目录仍未跟踪，已直接检查内容，不以空 diff 代替文档校验；完整 check:docs、产品测试、浏览器验证和独立设计模拟均 not run。

## D0：文档与排除

状态：passed（文档构建、链接与发布排除）；整体交付仍受下文集成门禁约束。

- 新建本目录四份文档与局部规则，同一 REL 编号贯穿。
- `site/scripts/generate-docs-manifest.mjs` 排除内部 feature 文档。
- `site/scripts/check-docs.mjs` 检查索引、搜索、生成正文、sitemap 和本 feature 静态页面，不破坏 legacy 路由。
- 运行文档构建、内部链接检查与排除回归。

## S0：基线与来源

本轮实测：`git rev-parse HEAD` 为 `6d57b2a2d2f06f8ba511e42fe840f9f1e930c186`；初始工作树为空；`bun --version` 为 `1.3.14`；根、desktop、site 依赖目录存在。

许可状态：历史 MIT 端点对象 `755a18edb7e7519a12f5c7ee4265c9eb4f2ed508` 未在本地对象库取得，逐候选原始代码取用核验仍 blocked；本轮不复制未知许可上游代码，以既有本地实现和行为需求独立修复。未读取真实供应商/历史或更换 Bun。

## S1.1 REL-001：Bash 守护

状态：passed（macOS/POSIX 聚焦回归）；Windows、Linux 运行证据 not run。

- 旧 fd3 生命周期观察会在文件 fd 复用时误杀健康命令；改为独立 supervisor job 观察 runtime/supervisor 存活，不将观察器放进目标 shell 的 job 表。
- `parentProcessGuard.test.ts` 与 `ShellCommand.test.ts` 联合实测 9 pass / 0 fail，覆盖重复文件输出、stdin/参数/退出码、bare wait、SIGKILL、supervisor 终止与组清理。
- Windows 保留原生 spawn 分支，不宣称具有 POSIX 崩溃清理保证。

- 测试：`src/utils/shell/parentProcessGuard.test.ts`，必要时 `ShellCommand.test.ts` 和真实 Shell 文件输出 fixture。
- 固化重复文件 fd 输出、正常退出、信号、bare wait、父进程 SIGKILL、取消和组清理。
- 改 `parentProcessGuard.ts` 的生命周期观察，不扩大到所有 spawn。

## S1.2 REL-002：压缩保护

状态：passed（确定性聚焦与 loopback 请求计数）；完整门禁结果单列。

- 共享预算沿 compact→fork/query→provider 分发，普通对话不传预算行为不变；一次逻辑压缩最多 6 次实际请求，含隐藏重试与 fallback。
- 取消检查覆盖摘要后和 full/partial compact 的 post-hook 边界；取消不得落成功边界。显式 thinking/output 预算、已测输入与 4,000 token 安全余量联合决定是否限制输出或跳过 fork。
- 新回归：`withRetry.requestBudget.test.ts`、`compactRequestBudget.test.ts`、`compactRequestBudget.loopback.test.ts`，结合真实请求路径验证 fork、fallback、流恢复和取消。
- 补充整流程测试后，修复测试自身的 query/GrowthBook mock 恢复，避免污染单进程覆盖率；聚焦 8 文件 87 pass / 0 fail。loopback 仍是本机模拟供应商，不代表真实供应商验证。

## S1.3 REL-003：成员插话

状态：passed（服务端、store、组件回归；2026-10-26 实际浏览器验收）。2026-10-25 曾记为 blocked（缺少浏览器工具），该历史记录保留在本节末尾。

- 用户发送 ID 贯通 API、邮箱、supervisor/poller/运行中附件注入、transcript 批量投影及对应 pending/等待态。用户回声不再归为普通队友。
- 已覆盖延迟超过 120 秒、同文不同 ID、他人同文、批量、重连/恢复、失败/取消和无 ID 旧记录。运行中附件链路另加红例，修复认领后丢 ID 的映射。
- 末次复核另复现附件合并仍用发送者、时间戳和正文前缀：两条不同 ID、同文且同时间的消息会被合并，但均已认领，导致第二条丢失。新增红例 11 pass / 1 fail，改为有 ID 时按 ID 去重、无 ID 才用旧键；同时覆盖 mailbox/AppState 同一 ID 只注入一次。末次聚焦及门禁结果另列。
- 重试在 inbox 锁内同时检查 live/history，保留完整历史去重而不截取 256 KiB。刚生成的新 ID 无需扫描历史；该开销回归先红后绿。调用者自带 ID 仍需锁内全量读取，长期成本保留为已知风险，未引入新存储。
- `SubagentRunPage.test.tsx` 旧三参数断言更新为验证新增稳定 ID；页面/store 联合 496 pass / 0 fail；后续新增 API 测试和 unknown 组件后的聚焦结果另列。
- `check:persistence-upgrade` passed；新增字段用于内存投影，旧持久记录仍可读取，未声称引入新 schema 迁移。
- `check:desktop-ui-smoke` 输出 SKIPPED：缺少 `agent-browser`。专用浏览器工具调用也返回服务错误，未取得截图或实际成员 tab 证据；普通 agent flow 不能替代。

## S2：风险探针

状态：REL-004/005 已复现并修复；REL-006/007 完成有界探针，剩余条件未确认。

- REL-004：复现 foreground send acknowledgement 挂起时，presend mute 丢后台 `task_notification` 终态且未落盘。只放行合法终态，继续保护非终态静音、Stop 栅栏、会话隔离与去重。`websocket-handler`、持久化与 Teams 联合 6 文件 296 pass / 0 fail；真实 Telegram 与真实重连未验收。
- REL-005：按同一请求/响应范围提取最终结果，错误、取消、未完成工具和空结果不伪装成功；AgentTool、SkillTool、前台/后台 forked 斜杠命令均保留失败状态。核心联合 7 文件 63 pass / 0 fail，后补调用方聚焦 53 pass / 0 fail；两组有重叠，不相加。
- REL-006/007：详见下节有界离线探针。没有归因的资源风险保留，不做无证据的 worker 复用、Bun 升级、连接合并或重试放大。

## S3：可靠性与授权

状态（2026-10-26 更新）：S3.1 passed；S3.2 的待命角色、首次启动与审批冻结，以及 S3.3 的版本化交付验收，均有离线红绿和实际浏览器证据。2026-10-25 快照曾记为 S3.2/S3.3 not run，保留在下方。

- REL-008：复用 `teamPlanRuntime.supervisor.test.ts`，Stop→继续、主控替换、失主/重启恢复、成员退出共 27 个用例。全量检查暴露测试把 roster 的 terminated 当成通知已落盘的竞态，改为分别等待两个真实边界；未改运行时恢复策略。
- `activity:'unknown'` 曾落入 `status:'running'` 的 working 回退，导致无证据成员被计为工作中。新增独立 unknown 展示、五语言标签、中性无 pulse，不触发失败恢复；任务 `in_progress` 与成员活动继续分开。模型、Canvas、Inspector、Workbench 覆盖。
- 2026-10-25 事实（已被 2026-10-26 实施取代）：`validateTeamPlanGraph(plan, true)` 强制至少一个任务且每成员有任务；launch、首次启动和 rehydrate 又依赖已准备的 session。仅删除校验不能实现“无任务批准角色”。已有按依赖延迟指令不等于尚未启动角色。
- 2026-10-25 轮没有新增授权 schema、无任务角色启动、动态产物版本或验收返工协议（该轮快照）。2026-10-26 已补齐这些能力，契约见 [设计](design.md)，证据见下节；审批时冻结配置继续沿用。五语言待命文案与真实浏览器路径已验收；旧任务迁移有聚焦红绿，`check:persistence-upgrade` 的本次结果以最终门禁报告为准，未提前写通过。

## S4：条件能力

状态：not run，保持候选。

REL-011 并发、模型目录/换模、文档批注、协议接入只有场景成立才创建实施批次。全局 lean、分享图、立即批量换模后置。

## 检查命令与完成门槛

- `bun run check:impact` 是实际路由来源，按最终 diff 执行所选 lanes。
- 文档：`bun run check:docs`；局部指令：`check:policy`；运行时：`check:server`；协议/流：`check:provider-contract`。
- 桌面和跨进程按选中执行 `check:desktop`、`check:chat-contract`、`check:agent-flow`、`check:desktop-ui-smoke`；持久兼容 `check:persistence-upgrade`；宿主/产物变更再跑选中的 `check:native`。
- 总体可交付声明前运行 `bun run verify`；最终复核 `git diff --check`、`git diff`、`git status --short`。
- 已知失败与环境阻断不吞掉；仅有代码或构建不写成行为验收成功。实际执行结果在下节追加。

## 本轮验证记录

### 2026-10-24 第一轮完整门禁

命令统一使用临时 `HOME`/`CLAUDE_CONFIG_DIR`、禁 `.env`/terminal shell env；`PR_BASE_REF=HEAD bun --no-env-file run verify` 的报告：`artifacts/quality-runs/2026-10-24T13-41-54-666Z/report.md`。

- passed：policy、desktop（lint / 全部测试 / production build）、provider-contract、chat-contract、agent-flow（8 个场景）、docs、persistence-upgrade，共 7 条 lane。
- failed：impact 的 CLI core 策略要求 `allow-cli-core-change` 标签及维护者批准；本轮没有伪造标签或绕过策略。
- failed：server 633 文件，7,691 pass / 1 fail，失败为 supervisor 测试提前断言异步通知；已补边界等待，后续聚焦 supervisor+compact+loopback 58 pass / 0 fail，需最终全量复跑确认。
- failed：changed-lines coverage 87.66%（405/462）低于既有 90% 门槛。补桌面 Teams API wire contract、full/partial compact 边界与取消回归，不放宽阈值。最新全量结果另列，不用聚焦覆盖率替代。
- skipped：adapter/native 不在实际 impact 选择中；独立执行的 desktop-ui-smoke 因缺 `agent-browser` skipped，不计 passed。
- 新增 API/成员页面/agentTeams 聚焦：9 文件 171 pass / 0 fail；总览 unknown 红例另补，不把旧 waitingHint 当成未知。

### 后续完整门禁与独立复跑

以下报告的目录使用 UTC 时间；本节按报告标识区分，不把后续修复前的结果当作最终快照。

- `artifacts/quality-runs/2026-10-25T00-18-47-147Z/report.md`：8 passed / 2 failed / 2 skipped。policy、desktop、provider-contract、chat-contract、agent-flow、docs、persistence-upgrade、coverage 通过；impact 仍因 CLI core 审批失败；server 的 `scheduled-tasks.test.ts` 一项失败。定时任务随后独立连续三次各 95 pass / 0 fail，整套 server 独立复跑 633 文件 7,706 pass / 0 fail；该不稳定记录保留，未归因为既有问题，也未修改生产调度器。
- `artifacts/quality-runs/2026-10-25T00-39-34-656Z/report.md`：复跑 impact、server、provider-contract、chat-contract、agent-flow、persistence-upgrade、coverage 共 7 条，6 passed / 1 failed；唯一失败仍是审批策略。该轮覆盖率通过，但后面又修了 streaming 失败判定，不能当作末次改动后的证明。

### 末次压缩失败边界复核

复核确认：streaming 回退原先对非 `ok` 结果返回终态消息，调用方只凭文本前缀判断，导致无 `API Error` 前缀的合成错误或未完成 tool_use 文本可能成为摘要。

- 红例：`compactRequestBudget.test.ts` 38 pass / 4 fail，四个失败均为预期应拒绝却成功返回，覆盖普通 API 错误、无前缀合成错误、abort 错误响应和未完成工具；上下文过长（PTL）守卫保持通过。
- 修复：streaming 按结构化 outcome 判失败，保留错误原文；PTL 的文本、标记和 `errorDetails` 原样返回外层截断重试。空尾仅合并同一响应，取消不提交成功；同时修正失败日志与 6 次新增上限的注释。
- 聚焦绿例：42 pass / 0 fail；扩展 8 文件 108 pass / 0 fail，包含 compact、autoCompact、loopback、请求预算、forkedAgent、runner 与 AgentTool。主流程另跑 compact/loopback/autoCompact/请求预算/forkedAgent/邮箱及附件共 8 文件 131 pass / 0 fail。之后附件身份去重修复的附件/邮箱/poller/print 消费联合 5 文件 62 pass / 0 fail；各次数字重叠，不累计。
- 已知边界：Azure 的预算拒绝可能被转成 API 错误消息，结构化错误类型未保留；不突破请求上限且不会变成功，诊断一致性未修。完整 PTL 外层循环耗尽预算仍缺端到端回归，当前仅证明 PTL 返回契约。
- 压缩修复后启动完整 `verify`，报告目录 `artifacts/quality-runs/2026-10-25T00-57-57-854Z/`。过程中又修复附件身份去重，因此另跑最终附件改动后的整套 `check:server`：633 文件、7,720 pass / 0 fail，退出 0。完整门禁中的 provider/chat/agent-flow/persistence/coverage 在该附件改动后执行，覆盖率的最终结果另列，运行中不预写通过。
- 最终 `PR_BASE_REF=HEAD bun --no-env-file run check:impact` 报告 61 个文件、9 项必需检查，仍明确 `Blocked: yes`。该报告命令退出 0 仅代表报告生成，不能覆盖 quality gate 对 CLI core 审批的阻塞。
- 重新运行 `check:desktop-ui-smoke` 仍明确 SKIPPED：缺少 `agent-browser`；命令退出 0 不视为 UI 通过。本环境也未找到 `ego-browser` 技能/可执行程序，没有实际成员页插话或截图证据。
- 意外生成的 `fixtures/bdef83-99ffb8-5b60e1.json` 已核对为本轮合成对话的缺凭据错误录像，移到工作树外保留，不作为交付夹具，也不作为成功证据。

### 末次 AgentTool 结算复核（2026-10-25）

- 复核发现结构化提取虽能识别非成功，`finalizeAgentTool` 仍可能返回成功形状。现仅 `ok` 返回结果，API 错误、空结果、无 assistant、未完成工具均抛错，取消抛 `AbortError`；同步、直接后台、前台转后台复用既有失败/取消通道。同步已有循环错误保留原文。
- 同步面板通知原先无条件 completed，现依据同一结果分类；后续补验又复现捕获 `AbortError` 后，中间值 stopped 被映射成 failed。新增 `a sync abort reports the panel notification as stopped` 红例为 0 pass / 1 fail，实际收到 failed；修复为中间结果 cancelled 后再映射 stopped。
- 取消映射修复后的聚焦命令：`bun --no-env-file test src/tools/AgentTool/AgentTool.pinned.test.ts src/tools/AgentTool/agentToolUtils.test.ts src/utils/forkedAgent.test.ts src/tools/SkillTool/SkillTool.test.ts src/utils/processUserInput/processSlashCommand.test.ts`，使用临时 HOME/config，5 文件 71 pass / 0 fail，退出 0。
- 完整 `verify` 已启动于上述取消映射修正之前：`artifacts/quality-runs/2026-10-25T01-20-44-645Z/`。该运行不能单独证明最终快照；末次修改后的服务端补验和后执行的覆盖率、文档等结果分别记录，运行中不预写通过。
- 该完整运行的 server 为 633 文件、7,731 pass / 1 fail；唯一失败是 `workspaceWatch.test.ts` 恢复多层目录时等待文件事件超过 2 秒。随后同文件隔离连续三次均为 11 pass / 0 fail；保留整套原失败，不以单文件复跑替代服务端补验，也未修改监听器或延长超时。此项与前轮定时任务不稳定分别记录，原因尚未确认。
- 完整门禁报告最终为 7 passed / 3 failed / 2 skipped：除 impact 审批与 server 外，coverage 也失败。desktop 覆盖率执行中 `RawRequestTab.test.tsx` 的最近请求断言未等到调用，1 fail / 9,125 pass / 8 skipped；整套桌面检查此前通过。该测试带覆盖率独立三次各 4 pass / 0 fail。由于桌面覆盖率数据未被采纳，changed-lines 为 65.43%（407/622），不能引用前轮 coverage 通过替代；未改相关面板或测试，也未放宽阈值。
- 最终取消改动后，`quality:gate --mode pr --only impact-report,server-checks,docs-checks` 的报告 `artifacts/quality-runs/2026-10-25T01-39-18-869Z/report.md`：server 633 文件 7,732 pass / 0 fail、docs passed，impact 仍 blocked（2 passed / 1 failed）。该结果又早于下条循环异常修复。
- 同区复核新增红例证明：普通同步循环先产出非空文本、随后抛 `socket hang up` 时，面板虽 failed，工具仍返回 completed。旧“部分结果恢复”把进度误当完成；现在同步循环错误直接抛回原原因，不再调用成功 finalizer。红例 0 pass / 1 fail（实际 Promise resolved），同 5 文件修复后 72 pass / 0 fail，退出 0。
- 循环异常修复使正在运行的 coverage 复跑失效。已停止本轮自有进程树，退出 143，目录 `artifacts/coverage/2026-10-25T01-43-19-382Z/` 不作为完整覆盖率证据；在最终代码冻结后重启完整 `verify`，结果另列。

### 冻结代码后的完整门禁（2026-10-25）

- 最后生产代码与回归测试修改后，以临时 HOME/config 执行 `PR_BASE_REF=HEAD bun --no-env-file run verify`。报告：`artifacts/quality-runs/2026-10-25T01-48-01-620Z/report.md`；该轮开始后生产代码未再修改，命令退出 1，结果为 8 passed / 2 failed / 2 skipped。
- passed：policy；desktop（lint、547 文件、9,126 pass / 8 skipped、production build）；server（633 文件、7,733 pass / 0 fail）；provider-contract（36 个确定性套件）；chat-contract；agent-flow（8 个场景）；docs；persistence-upgrade。各套件数字有重叠，不累计。
- blocked / failed：impact 再次明确 CLI core 需要 `allow-cli-core-change` 标签与维护者批准，当前无标签；本轮未伪造批准或绕过规则。
- failed：coverage，报告 `artifacts/coverage/2026-10-25T01-57-14-238Z/coverage-report.md`。桌面覆盖率运行 9,125 pass / 1 fail / 8 skipped；唯一失败是未修改的 `desktop/scripts/build-sidecars.test.ts` 对响应体取消时长要求小于 150 ms，实测 312.56 ms。桌面覆盖率数据未被采纳，changed-lines 为 65.15%（402/617），低于 90% 门槛。其余覆盖率套件通过不能将整体 coverage 改写为通过。
- 侧车失败项带 coverage、以 `-t 'bounds a sidecar response with headers'` 隔离连续三次均 1 pass / 0 fail，其余 13 项因筛选未运行。该结果只表明独立复跑通过，不代替整套 coverage，原因仍未归因；本轮未修改侧车源码或测试、未延长超时、未放宽门槛，不再无界重复门禁等待偶然全绿。
- skipped：adapter/native 未被 impact 选中。实际成员页浏览器验收仍 blocked，独立 desktop-ui-smoke 因缺少 `agent-browser` skipped；普通 agent-flow 和组件测试不替代浏览器验收。真实供应商、Windows/Linux 与真实 IM 检查未运行。
- 交付边界：本阶段代码和内部四份文档已落地，但当前不是可合并状态；审批、coverage 和成员页浏览器证据分别保留。此前定时任务、文件监听和原始请求面板失败记录继续保留，不声称已修。REL-009/010 授权/待命角色/产物验收与未归因资源风险仍后置。
- 最终工作区为 63 个变更文件（含新增、测试、文案及内部材料），未新增交付录像夹具或公开 feature 页面；没有提交、推送、发布或调用真实模型。门禁后只补记内部文档，再单独执行 `check:docs` 与差异检查，不以文档补记触发无关生产代码重跑。
- 文档补验结果：上述完整门禁后的内部文档补记已执行 `bun --no-env-file run check:docs`，退出 0；站点构建、内部链接、公开发布排除和 59 项站点测试通过。此记录仅补充文档验证证据，完整门禁的审批与 coverage 失败、成员页浏览器验收缺口均保持原状态。

### 继续执行：侧车超时测试的计时边界（2026-10-25）

- 先核对工作区、冻结代码完整报告及本记录，再继续覆盖率阻塞；不重复实施一级修复、AgentTool 结算或文档发布排除。批准计划中的 REL-009/010 是已批准但待实施的团队授权与交付阶段，不属于“需求未触发”的可选能力；本批先收敛验证问题，后续实施需完整覆盖首次启动、审批冻结、恢复与迁移。REL-011 仍按需求触发。
- 受控失败探针：工作树外复制原测试，只在真实子进程清理前加入 200 ms 延迟。请求在 32.38 ms 已按预期失败，但原断言测到 236.38 ms 并失败，证明原计时混入清理耗时。该探针解释一个可复现的误报机制，不证明历史 312.56 ms 的每一段具体归因。
- 本次仅修订 `desktop/scripts/build-sidecars.test.ts`，生产代码保持冻结。用可控时钟断言请求在 24 ms 尚未结算且未取消、25 ms 已失败并发起取消；取消自身未完成不得阻塞调用方，晚到拒绝继续被消费。随后恢复真实时钟，仍验证真实子进程已退出、临时目录已删除及环境未变。替换混合墙钟断言，不扩大 25 ms 请求预算，不放宽覆盖率阈值。
- 反向验证均在工作树外：把请求定时器延迟 1 ms，测试因 25 ms 尚未结算失败；提前 1 ms，测试因 24 ms 已取消失败；正确实现只延迟清理 200 ms，测试通过。三项均符合预期，未将故障变异带入交付文件。
- 聚焦带 coverage 执行侧车文件为 10 passed / 4 skipped，退出 0；4 项需要原生编译或安装产物，普通单文件执行仍未运行。之后新增 24 ms 未取消断言，最终桌面与完整 coverage 补验另列，不用此前聚焦结果证明最终整套通过。
- 实际 `PR_BASE_REF=HEAD bun --no-env-file run check:impact` 检出 64 个变更文件，CLI core 审批继续 blocked；测试位于 `desktop/scripts/`，按现行路由新增选择 `check:native`。该完整原生检查包含真实签名身份枚举与打包；当前测试授权禁止读取真实钥匙串，尚无隔离签名环境，故完整 native 为 blocked / not run，不以普通 Vitest 代替，也不修改路由或签名策略。
- 重新核查后仍无 `ego-browser` 技能或可执行程序，且无 `agent-browser`；实际成员页浏览器验收继续 blocked。本次不重复启动已知缺工具的浏览器检查，不把组件测试或普通 agent flow 当作替代证据。
- 复用未改动服务端、provider/chat 契约、agent flow、持久兼容和 policy 的冻结快照通过结果；补跑 `quality:gate --mode pr --only impact-report,desktop-checks,coverage`，不把选择性补验称为新的完整 `verify`。报告 `artifacts/quality-runs/2026-10-25T02-42-06-210Z/report.md`：2 passed / 1 failed，退出 1；desktop 与 coverage passed，唯一所执行失败为 impact 审批策略。
- 最终测试修订后的 desktop 包含 lint、547 个文件、9,126 passed / 8 skipped 与 production build；完整 coverage 的 desktop 同为 547 文件、9,126 passed / 8 skipped，两个运行有重叠，不累计。侧车超时用例在整套普通和带 coverage 执行中均通过。
- 完整覆盖率报告 `artifacts/coverage/2026-10-25T02-44-53-794Z/coverage-report.md`：5 个覆盖率范围通过，变更行 94.96%（528/556），既有门槛 90%，Failures 为 none。本次恢复了桌面有效覆盖率数据，执行行口径与前次缺数据回退口径不同，不能直接把 65.15%→94.96% 当作新增测试覆盖的增长。根目录单进程 instrumentation 仍退出 1，沿用现有门禁对完整 LCOV 与逐文件正确性验证分离的规则；不能把它改写为全部断言通过，服务端正确性沿用冻结快照 633 文件、7,733 passed / 0 failed。
- 交付状态更新：覆盖率执行阻塞已有修订后的完整通过证据；CLI core 审批、完整 native 的隔离签名环境和实际成员页浏览器验收仍未关闭。真实供应商/平台、Windows/Linux 仍 not run；此前定时任务、文件监听和原始请求面板的不稳定记录继续保留。批准但未实施的 REL-009/010 已在 design 补齐下一批源码边界，不把调查写成实现。
- 本批交付文件仅为侧车测试和内部四份文档；总 diff 共 64 文件（包含前批改动）。未提交、推送、发布、替换应用或消耗真实模型额度。文档补记后已实际执行 `bun --no-env-file run check:docs`，退出 0：站点构建、110 个文档页面、341 个本地链接及图片检查与 59 项站点测试通过；内部文档发布排除检查通过。该文档验证不改变维护者审批、完整 native 和实际成员页浏览器验收的阻塞状态。

### 2026-10-26：S3.2/S3.3 交付协议、待命成员与浏览器验收

- 交付边界红例（`taskDelivery` 聚焦）：13 pass / 5 fail。5 个失败均按预期方向复现：2 个是错误原因文案不够具体（期望“已评审”“版本已变”，实际统一返回“交付已变化，请刷新”），2 个是取消后仍提交验收回执，1 个是提交后依赖被重新打开仍被接受。红例与绿例的命令输出保存在工作树外的临时证据目录，不随仓库分发，本文不写本机绝对路径。
- 首次修复后聚焦 4 文件 45 pass / 0 fail：`src/tools/TaskDelivery.test.ts`、`src/utils/taskDelivery.test.ts`、`src/tools/TaskGetTool/TaskGetTool.test.ts`、`src/server/services/teamService.deliveryProjection.test.ts`。
- REST 红例：已取消的验收请求原先返回 200，原因是路由没有把请求 signal 传入交付动作，期望 409 的断言为 0 pass / 1 fail。修复为把 `req.signal` 传入同一 `applyTaskDeliveryAction` 路径；该用例随后进入绿例。
- 修复后 2 文件 41 pass / 0 fail，覆盖 submit/accept/return、版本递增、requestId 幂等与指纹冲突、并发评审只落一次、hook 否决与取消、依赖复查、退出释放 owner、返工改派和删除守卫。
- 当前 S3 快照：8 文件 116 pass / 0 fail，退出 0，包含 `tasks.test.ts`、supervisor、`teamPlanService`、`teamPlanStore` 与交付投影。该快照采集于 REST 一行修复之前；REST 用例的单文件结果只作补充，两者不互相替代。
- 实际浏览器验收：`artifacts/desktop-member-smoke/evidence-20261026-unsupported-readonly/` 的 `exit.txt` 为 0，`summary.json` 为 passed，记录 16 条断言、15 张截图。运行使用真实浏览器、真实本地 server 和合成成员 runtime，临时 HOME/config，`user-state-guard.json` 无真实配置写入。覆盖同文重复插话各自结算、整页 reload 按原顺序重放、v1 待验收、空原因退回被拒、带原因退回后 v2 重新提交、accept 后历史保留、待命成员显示“未启动 · 按需启动”、归档团队只读、未知 schema 只读且原字节与 mtime 不变、原始记录不泄漏到 workbench 响应或页面。
- 此前 `artifacts/desktop-member-smoke/evidence-20261026-s33-task-delivery/` 的 12 条断言、13 张截图继续保留；新证据是其超集，不改写旧结果。
- 原生检查旧快照（2026-10-25）：完整 `check:native` 在隔离签名环境按 6 个阶段执行（swift、build-sidecars、compiled sidecar smoke、electron、package dir、package smoke），最后 `[stage 7] full-check-native exit=0`。产物是目录开发包；记录明确未验证 Gatekeeper 启动审批、发布归档/更新元数据和 live GUI。该结果早于当前 S3 生产变化，只作原生链路历史快照，不证明当前代码。
- 首轮 S3 完整门禁报告 `artifacts/quality-runs/2026-10-26T04-37-34-184Z/report.md` 保留为失败记录：隔离 PATH 缺少 Node、npm 和 ripgrep，不能作为产品回归或成功证据。补齐可执行路径后重新运行，报告 `artifacts/quality-runs/2026-10-26T04-51-51-566Z/report.md` 为 8 passed / 3 failed / 1 skipped，退出 1。通过项为 policy、provider/chat 契约、agent flow、native、docs、持久兼容和完整 coverage；失败项为 impact 审批、桌面字体规则、conversation 设置夹具被并发读取半截 JSON。native 本次是完整 `check:native`，不是仅构建侧车；完整 coverage 五个范围通过，无失败项。
- 后续修复：交付面板不再对仅含 400 字重的等宽字体请求加粗；conversation 测试的 8 处设置写入/恢复改为同目录临时文件加 rename 原子替换，新增写完临时文件但尚未 rename 时并发读取的回归，保护读取方不隔离正常夹具。supervisor 夹具按 leader/member 区分脚本响应，防止主控通知消耗成员预设失败；新增受控回归，不靠无界重跑规避竞态。
- 缺失依赖的运行时红绿：首次启动、已启动空闲唤醒和主控阻塞说明不再把不存在的 `blockedBy` 当成已完成，统一复用任务工具/认领的 `findUnsatisfiedBlockers`；未知交付记录也不得作为可执行任务启动成员。新定向回归先为 4 fail（其中一项随后改为无任务成员的显式主控指令正控），修复后定向 4 pass；最后一次源码编辑后的 supervisor 全文件为 43 pass / 0 fail、223 次断言、退出 0，包含 Stop→继续→服务恢复的完整生命周期。交付协议、工具、TaskGet 和服务端投影在最终树另跑 4 文件，51 pass / 0 fail、282 次断言、退出 0，各组数字不累计。
- 桌面最终修改后再次执行实际浏览器通道，证据 `artifacts/desktop-member-smoke/evidence-20261025-rerun-unsupported-readonly/` 为 16 条断言、15 张截图、退出 0（目录日期仅是命名）。未知记录原字节和 mtime 不变，原始 payload 不出现在响应和 DOM，配置守卫无真实用户状态写入；该结果不以合成模型代表真实供应商验收。
- 最终完整 `PR_BASE_REF=HEAD bun --no-env-file run verify` 在隔离签名环境执行结束，报告 `artifacts/quality-runs/2026-10-26T05-33-58-066Z/report.md`：10 passed / 1 failed / 1 skipped，真实退出码 1。唯一失败是 impact 要求 CLI core 的 `allow-cli-core-change` 标签与维护者批准；policy、desktop、server、provider-contract、chat-contract、agent-flow、native、docs、persistence-upgrade、coverage 共 10 项通过。adapter 未被路由选中，明确 skipped，不算通过。
- 本次完整 server 637 文件，7,804 passed / 0 failed；desktop 含 lint、548 文件 9,156 passed / 8 skipped 及 production build。首次执行报告的两项正确性失败已经在修复后的完整检查中关闭，不用独立重跑覆盖旧报告。native 为完整 6 阶段 `check:native`，最终 package smoke `result=PASS`；只验证目录开发包，Gatekeeper、GUI 启动、发布归档/更新元数据不在本次证据内。
- 完整覆盖率报告 `artifacts/coverage/2026-10-26T05-43-53-889Z/coverage-report.md`：5 个范围 passed，门禁变更行覆盖率 95.98%（1,219/1,270），既有最低 90%，Failures 为 none。报告同时明确根目录单进程 instrumentation 退出 1，正确性由本次逐文件 server gate 负责；不得将 instrumentation 改写为全部断言通过。Agent tools/utils 仍低于非阻断目标值；覆盖率工具的变更行表按当前 Git 差异口径，未列入的未跟踪新增文件不得凭此表宣称覆盖率，新增交付协议和组件以实际聚焦测试、组件测试及浏览器证据补充。未修改阈值、路由或策略。
- 完整门禁之后仅补记本目录四份文档和外部批准计划，生产代码保持不变。补记后已实际执行 `bun --no-env-file run check:docs`，退出 0：59 项站点测试、110 个文档页面、341 个本地链接及图片检查均通过，内部 feature 发布排除保持有效；`git diff --check` 通过，21 个新增文件无尾随空白或 CRLF，浏览器脚本 `bash -n` 通过。原计划的 `s4-conditional-handoff` 标为 completed 只表示本次证据交接完成；S4 候选功能仍为 not run，不表示已实现。此补验不改变完整 `verify` 的退出码或维护者审批阻断。
- 修复前 S3 快照的 `PR_BASE_REF=HEAD` impact 检出 91 个变更文件，最终完整门禁检出 92 个，均要求 10 项本地检查且 `Blocked: yes`；原因是 CLI core 改动需要 `allow-cli-core-change` 标签和维护者批准。报告生成命令退出 0 不代表门禁通过；最终完整门禁因此退出 1，没有伪造标签或审批。
- 未运行：真实模型供应商、真实 IM 平台、Windows/Linux；S2 的 sqlite 首屏空列表、worker 退出顺序和 MCP 运行时凭据隔离仍未归因。

历史报告的 27/200 误杀、历史 Teams 测试及旧纯函数红例均不计作本轮结果。各聚焦数字有交集，禁止相加作为全项目总数。

## S2.3 有界离线探针（2026-10-24）

公共前缀（下文命令省略）：`env -i PATH="$PATH" HOME="<临时目录>/home" CLAUDE_CONFIG_DIR="<临时目录>/config" CC_HAHA_DISABLE_TERMINAL_SHELL_ENV=1 bun --no-env-file`。未读真实用户目录、未连公网/模型、未改生产代码、未提交。

- 索引 worker：`bun test src/server/services/localIndex/searchContentCommitWorker.test.ts` 2 pass；覆盖单飞预算、8 个等待上限、取消移出队列、`bun --compile` 内联 worker。复用/退出屏障的先后顺序仍未测。
- trace：`bun test src/services/api/traceCapture.bounds.test.ts src/services/api/traceCapture.performance.test.ts` 14 pass；实测窗口上限 `TRACE_WINDOW_BYTES_LIMIT=64MiB`、`TRACE_WINDOW_RECORD_LIMIT=10000` 条、单记录 `2MiB`、流切片 `1MiB`、冷读块 `256KiB`，扫描字节与 read 次数被断言。真实并发/崩溃下的锁释放未测。
- 档案成本：`bun run scripts/perf/session-open-benchmark.ts --transcript "<临时目录>/synthetic-session.jsonl" --rounds 1 --sidebar` 实测 4.4MiB/2000 条 → `messages?mode=full` 0.26s、0 个 cursor 页；合成 22.2MiB/10000 条 → 0.77s、仍 0 个 cursor 页，`turn-checkpoints` 返回 413，总 burst 0.9s。分页不随字节增长，字节成本与“档案帧数”无关。
- 索引基准：`bun run scripts/perf/local-index-benchmark.ts --sessions 40 --entries-per-session 6 --large-transcript-mib 8 --runs 2 --warmup-runs 1 --mode shadow` → ready 146ms、DB 6.4MB、WAL 6.0MB、会话列表中位 30.3ms、RSS +15MB；`--mode file` 中位 29.3ms、RSS +28MB。`--mode sqlite` 两次（40/60 会话）均以 `immediate sessions HTTP did not return useful content` 退出，首屏空列表；归因未定，标为观察失败而非已复现缺陷。
- usage：`bun test src/server/__tests__/proxy-transform.test.ts` 124 pass（含缓存包含/互斥、total 推导、NaN/负值、嵌套缓存上限）；`bun test src/server/__tests__/session-inspection-usage-only.test.ts src/utils/usageAccounting.test.ts` 24 pass（usageOnly 只发一次 control、跳过 MCP 状态）。真实网关语义未测。
- MCP：`bun test src/server/__tests__/mcp.test.ts src/server/services/mcpHostPreflight.test.ts -t "another project|failed connection|replacement connection|cannot be edited|unknown scope|plugin-scoped|preflight"` 13 pass（20 filtered）。覆盖跨项目 toggle 不串、失败后重试不缓存失败、旧探针失败不丢弃替换连接、scope 拒绝；`.mcp.json` 重写保留 `Authorization: Bearer ${MY_MCP_TOKEN}` 仅为配置文本保留。运行时凭据隔离与真实晚启动未测。
- 回收：`bun test src/server/__tests__/websocket-handler.test.ts -t "keeps the last disconnected client session alive|bounds an active turn waiting on permission|starts the permission cleanup bound|failed remote archive retryable|keeps disconnected sessions alive longer"` 5 pass（108 filtered），断言 31 分钟审批/后台任务边界与终态投递。该文件当前含他人改动，结果只算该快照。
- 仍未知：worker 退出/替换顺序、真实崩溃锁释放、sqlite 首屏空列表根因、MCP 凭据按项目/scope 的运行时隔离、后台通知在真实重连下的投递。