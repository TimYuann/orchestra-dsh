# v0.5.1 UX 对齐记录（2026-09-19，用户 × agent 逐条对齐）

这份文档是 v0.5.1 落地前的**唯一口径**。实现、文案、发布说明都对着这里做；
与 README / STATE.md / 旧 spec 冲突时，以本文为准（那些文档仍停在 v0.5.0 的说法，需要同步）。

背景：v0.5.0 / v0.5.1 主要在 Gemini 侧开发。闭环走得通，问题集中在 corner case
与"代码做的事"和"文案教模型做的事"之间的漂移。以下每条都是与用户当面确认过的结论，
不是推测。

---

## 一、团队唯一性（已确认）

**一个工作目录同时只有一个 team。** 理由不是技术洁癖，而是产品语义：
driver 是整张图的唯一决策者与 closure 所有者，两个 driver 就没人有资格宣布"整个项目完成了"。

**但 team 必须是动态的**：新目标要能融进正在跑的那张图里（新增串行/并行的车道），
而不是逼用户去开第二个 team。只要能做到这点，用户就不需要第二个 team——
用户原话："只要能往里加任务，这个 team 是动态的，事实上也就不需要第二个 team 了。"

实现约束（给写代码的人）：`orchestra_create` 在已有活跃 team 时抛错
（`src/orchestra.ts:2968`），`orchestra_activate` 同样拒绝，底层
`activeTeamState.create` 再拦一道（`active_exists`）。**这三处检查本身是对的，
要放开的是"往图里加东西"的能力，不是"多开一个 team"的能力。**

### 1.1 加车道的形态（待实现，本轮最高价值项）

- 走**轻确认（B 档）**：driver 给一行"我要加一条车道做 Y，角色是 Z，模型是 W"，
  用户回一句"行"就加。**不走完整章程草案重审**（太重），也不是静默添加。
- driver 必须自己判断：新任务在图里的位置、串行还是并行、以及需要哪几个节点完成它。
- 这是 v0.5.1 之后的主要新工作，不在"修 bug"范围内。

## 二、重入与归档（已确认，本轮实现）

用户在一个已有活跃 team 的工作目录里再打 `/team` 时，**正确的行为只有两件事**：

1. agent 先判断：新目标与旧 team 的 mission objective **是不是同一件事**。
   - 是 → 提示用户是否重新激活旧 team 继续做。
   - 不是 → 告诉用户当前有一个活跃 team，需要先归档它；同时说明它以后还能被找回并激活。
2. 然后给用户一个**二选一**：继续旧目标 / 开始新目标。

**`/team force-archive` 必须从代码里删除**——用户原话："这个东西是一定不能出现的。"
理由是它把一个应该由 agent 解释、用户判断的决策，退化成了一个需要用户记住的逃生命令。

### 2.1 archive → 重新激活（本轮实现话术与入口）

机制已齐备，缺的只是入口和话术。四步：

1. driver 列出候选归档（归档摘要里已有 `goal` / `topology` / `dismissedAt`，可真的按目标搜，不用翻文件）；
2. 报出当时的原始目标；
3. 问用户要不要修改；
4. 确认后再 `orchestra_activate`。

典型场景（用户原话）：开了一个大目标 → 发现优先级不高 → 让 driver 停掉并归档 →
开下一个 team → 某天这个 mission 又要做了 → 跟 driver 说"帮我看看 orchestra 里有没有
这样的 team" → 激活并继续。

**归档快照的充分性已核对**：`ArchiveSnapshot` 是整份 `TeamState`（mission、document、
graphRuntime、roles、reports），激活时做 controller takeover、活着的会话复用、
持久化的 resume、确实没了的按 `sessionHistory` 重建并补恢复包。

### 2.2 许可要做薄（已确认）

中断全部角色 + 归档，**必须经过用户许可，但不要做成厚重的确认流程**：
那次二选一本身就是许可。顺序固定为 **先全停（cancel + 退休通知）→ 再落归档 → 最后清 team.json**；
反过来会出现"已归档但角色还在跑"。

角色发起的归档请求同样要拦（不能因为消息来自角色就跳过许可）。

## 三、懒加载舰队（已确认，本轮实现）

建会话只该在第一次派活时发生——这符合设计意图，已经实现。

**建会话失败时**：
- 不静默重试；
- 报清楚哪个角色、什么原因、原始错误；
- 把该角色的"座位"清回未建状态；
- **driver 可以自己换一个默认模型把角色拉起来**（用户明确肯定这条，因为自主运行的
  workflow 需要它），并事后向用户反馈；
- 把当前大图里这个角色配的 provider / model 摆出来，问用户要不要换别的。

**已知缺陷（必须修）**：`dispatchRoleTask` 只在 `phase === "reserved"` 时物化。
若 `reserved → provisioning` 的 CAS 成功、紧随的 `createSession` 失败，角色永久停在
`provisioning`：下次派活走"已激活"分支，向一个从未创建的 session 投递并硬报错。
代码注释却写着 "already active (or provisioning)"。**没有恢复路径。**

## 四、拓扑与角色的定位（已确认，本轮实现）

**用户原话（要点）**：我们提供 topology 预设，但 driver 不该生搬硬套地给每个 lane 套一个
预设；它必须主观判断每个任务怎么拆、包括 review 与 implement 之间的循环次数。**角色才是这个
plugin 的价值**——角色携带 persona，以后要打磨的就是 persona。

现状（核代码确认）：
- 已发角色预设 **7 个**：implementer / reviewer / investigator / verifier / architect /
  researcher / hardening-auditor，各自带 persona、工具白名单、交接契约
  （`expectedRoleHandoff` 连交付字段都定义了）。
- driver 起草时只能 `orchestra_draft(topology: <预设id>)` 整套端走，或手写
  `.orchestra/topologies/*.json`。**没有"从角色库里挑几个拼一张图"的入口。**
- `maxRounds`（每角色轮数上限）与 loop 定义内部已支持配置，机器是有的，缺的是入口。

本轮决定：
1. 起草时允许 driver 直接给角色清单：用哪个角色预设、轮数上限、写盘权限、模型。
   预设拓扑降级为"起手式"。
2. **暂不允许 driver 现场造新角色**（persona 是要打磨的资产，不能随手生成）。
3. 补两个角色：`planner`、`oracle`（代码里已被引用，但缺 v0.4 版本；oracle 目前只有 legacy 只读兼容）。

## 五、模型偏好（已确认，本轮实现）

现状问题（核代码确认）：
- `readPreferences` / `writePreferences` 都有，但**没有任何工具或命令会写它**，
  `~/.dsh` 与 E2E 项目下都不存在该文件，于是永远走硬编码 `DEFAULT_PREFERENCES`
  （provider `deepseek` / `deepseek-reasoner` / `deepseek-chat`）。
- 你们 4600 那次 E2E 是显式传 `provider: minimax / model: minimax-m3` 才跑通的，
  真实默认路径从未被验证。
- 优先级为：角色 runtime > CLI 覆盖 > 偏好文件 > 部署默认（`agentDefaultModel`）。
  **即只要项目里出现这个文件，全体角色的模型就被它接管**，可以悄悄改掉整队算力。

本轮决定：
1. 偏好文件**可选**：项目级 `orchestra/preferences.json` 优先，全局
   `~/.dsh/orchestra-preferences.json` 兜底。
2. **没有偏好文件时，不再套硬编码 deepseek，而是回落到该部署真正配置的默认模型**
   （`agentDefaultModel`）。这是避免"一次自选模型悄悄改掉全队算力"的唯一办法。
3. driver 可以为单个角色**临时升配**，只影响这一次、**不写回用户的配置**，事后告知。
4. 文件存在时，草案表必须显示"这些模型是从哪来的"，让用户批准时看得见算力阶梯。

## 六、Task Card（已确认，本轮实现）

事实（核代码确认）：architect 是只读角色，唯一写通道 `orchestra_report` 把路径写死在
`orchestra/reports/` 下；但 architect 欢迎词、`orchestration-principles.ts`、driver 提示
三处都要求它把 Task Card 写到 `orchestra/tasks/<phase>-<lane>.md`。
**没有任何代码会产生 `orchestra/tasks/` 文件，这条能力目前是空转的散文。**

本轮决定：**概念保留、落地简化。**
- 只读角色继续只走 `orchestra/reports/` 通道，不开任意写盘的口子；
- 若确实要写任务卡，给同一个工具开第二个落点（例如 `kind: "task"`），而不是放宽沙箱；
- 三处文案与实现对齐，不留空转承诺。

## 六点五、停摆兜底（2026-09-19 真实 E2E 现场发现，本轮实现）

**现场事实**：E2E 里 implementer 把 11779 词的词表改完、自检全过、报告用 `write` 工具直接落盘，
然后**既没有调 `a2a_reply` 也没有调 `orchestra_report`，就结束了回合**。
结果：driver 那一边收不到任何唤醒信号，整个团队静默停摆（UI 上看不出任何异常）。
同一份会话日志里的工具计数是 `bash:45 / read:8 / write:6 / edit:4`，
`orchestra_report` 一次都没有被调用——而它明明在角色的工具清单里。

**这是模型行为，运行时不能靠"提醒"解决**（v0.5.1 已经因为"只靠提示词纪律"吃过一次亏）。
本轮加的是运行时兜底，落在 `ctx.on("agent/status")`：

- 只在 **running → idle** 的转变上触发（从没干活的角色不算停摆）；
- 该角色**已有待处理输入**时跳过（它本来就会唤醒 driver，别重复打扰）；
- 每次停摆只发一条，按"安静下来的那个 session"去重；
- 通知内容明确告诉 driver：这个角色**没有交报告也没有回话**，它可能用文件工具直接写了东西，
  请自己去 `orchestra_team` / reports 里看，或者 `a2a_send` 把它要回来。

**已实测**：该通知真的投递到了 driver 会话（`agent/inbox/spliced` 里能看到原文），
driver 据此自己读文件、独立核验并继续推进，团队从停摆恢复。



"派发后不要 `orchestra_wait` 阻塞回合"这条**已由真实 E2E 验证有效**（0.5.1 的两次
Trio 交付全程无排队消息）。

但要看清本质：**这是行为修复，不是机制修复。** `orchestra_wait` 本体仍然整回合阻塞最长
20 分钟，唯一护栏是提示词纪律 + 工具描述。成因还在代码里，只是被劝住了。

**后续补充（同日，长跑 E2E 之后）**：真正的机制兜底是随后加的
**停摆兜底**（§六点五 / §六点九）——它监听 `agent/status`，在角色干完活却没交报告、
没回话时主动唤醒 driver。所以现在不是"只靠纪律"：
纪律负责让角色正常交付，兜底负责在角色不交付时不让整条链路停死。
长跑实测里兜底触发 ≥6 次，每次都把团队救回来。

已核实的机理（DSH 侧）：空闲 agent 收到 wake 消息会**同步开一个新回合**；
`orchestra_report` 落盘后还会走 `notifyDriverMilestone` 作为第二路信号。

## 六点六、只读角色的写通道与审批挂起（2026-09-19 真实 E2E 发现，本轮实现）

**现场事实**：只读角色需要落一份报告到 `orchestra/reports/`，它用的是**通用 `write` 工具** →
只读沙箱拒绝 → 工具结果里带着 "escalation available" → 它**发起权限升级审批** →
**无人值守没人能回答** → 角色回合永不结束 → **整个团队挂在一个没人听得见的问题上**。
更糟的是，这种挂起**连停摆兜底都抓不到**（角色始终是 `running`，从不进入 `idle`）。

**三处修正**：

1. **角色纪律写进 persona**：持久化证据只用 `orchestra_report` **工具**（它在只读沙箱下也能写，
   因为 escrow 走的是显式 workspace-write 策略）；不要用通用 `write`/`edit` 写报告；
   被拒就在回复里说明，**不要升级沙箱**。
2. **纪律跟着派发消息走**：即使角色用的是 legacy 预设（persona 早于这条规则），
   派发消息里也会读到"用 `orchestra_report` 交报告 + 用 `a2a_reply` 回话 + 不要升级沙箱"。
3. **运行时钉死审批策略**：治理角色会话一律 `setApprovalPolicy(session, "never")`，
   把"静默挂起"变成"当场明确拒绝"（新增 **peer** 依赖 `@deepseek-ai/dsh-user-approval@0.1.5-rc.2`）。

**未修的残留**：已经产生的 `approval/asked` 会**持久化在会话日志里并跨进程存活**，
重启也不会自动作废；E2E 里那个 architect 会话因此永久卡住。

## 六点七、归档 / 重激活 / 重新派活 这条链上的三个缺陷（2026-09-19 二次 E2E 发现，本轮修）

用户点名要补测的三个 corner case（中途停掉并归档 → 新会话找回并重开 → 观察角色是否被提前拉起）
跑出了一串真缺陷：

1. **旧 controller 离线时团队永远归档不掉。**
   重入仲裁的「继续」分支有 controller 接管，「归档」分支**没有**。controller 一离线（重启就会），
   用户说「新目标」时没有任何 session 有权归档，团队卡死。
   **修正**：归档分支先做一次 `transferOrchestrationControl`（记进 `controllerHistory`），
   再停角色、落归档、清状态。
2. **重激活会把 `reserved` 的车道误物化。**
   激活流程对每个角色都走「活着的复用 / 丢了的重建」，**完全不看 `phase`**：
   一个从未派过活的 reserve 座位被当成"丢失的会话"重建，并写进 `sessionHistory`。
   **修正**：`phase === "reserved"` 直接跳过，动作记为 `kept-reserved`，不建会话、不写历史。
   （旧归档快照里已经带上的历史无法追溯清理。）
3. **派活物化对"座位 id 已被占用"不幂等。**
   懒加载用预分配 id 建会话，只要该 id 的会话存在（上次物化建过、或激活时重建过），
   `createSession` 就报 `session ... already exists`，且重试永远同样失败——车道被永久卡死。
   **修正**：物化先看该 id 上有没有活着的 agent（有 → 当作成功，清诊断、投递首轮）；
   再对 create 的 "already exists" 兜底 `agents.resume`（会话在磁盘上但进程没加载，重启后就是这种）。
   **已实测**：修复后那条原本必然失败的车道派活成功并真的开始干活。

**同一轮发现但未定位根因的一条（只登记现象，不编解释）**：某个新加车道的角色（preset 为 legacy 的
`orchestra-implementer`）会话只有 24 个工具、**一个文件工具都没有**（无 read/write/edit/glob/grep/bash），
而同队正常建队的 implementer 有 31 个工具含全部文件工具；后果是该角色读不了任务卡、改不了代码。
单测探针**未能复现**（探针里 legacy 与 v0.4 预设都能解析到 catalog 文件）。

## 六点八、给用户看的卡片不许出现技术标识（2026-09-19 用户当场指出）

用户看到重入仲裁卡片写着 `team-f01da153`、一长串 64 字原始目标、`implementer(active)` 这种 phase 代码，
当场指出："过了几天我根本不记得这个 team 是干嘛的。" —— 这是对的，那张卡片是给人做决定的。

**修正**：卡片改成自然语言：

```
它要做的事：<目标的第一句话，截断到 80 字>
什么时候建的：9 hours ago
做到哪一步了：1 of 5 roles delivered (reviewer); never started: difficulty-implementer…; 1 report(s) on disk
现在有没有人在干活：暂时没有角色在跑
```

配套新增 `teamGoalLabel` / `describeTeamAge` / `describeTeamProgress` 三个纯函数，
归档消息也从 "Archived team team-xxx" 改成 `Archived "<目标>" — … can be found and resumed later (archive …)`。
测试补了反向守卫：仲裁卡片与归档消息里**不得出现 team id、也不得出现 `(reserved)` 这类 phase 代码**。

## 六点九、长跑验证：停摆兜底在真实长任务里反复生效（2026-09-19）

第一次是"两条车道各跑一小段"，这一次是**一次真正的长跑**（约 1 小时、5 个角色、8 份报告）。
结论：

- **停摆兜底在这轮触发了至少 6 次**（13:49、13:50、14:35 两次、14:36 两次），
  每一次都是某个角色干完活却没交报告/没回话，运行时把它识别出来并唤醒 driver；
  driver 据此自己读文件、独立核验、继续推进。
- **两条并行车道最终都跑到了终局**：
  `verify-guesses-implementer-wordle-r1.md`（GUESSES 核对）与
  `build-difficulty-selector-implementer-wordle-r1.md` + `review-difficulty-selector-reviewer-wordle-r1.md`
  （难度选择器 + 评审）。
- **`difficulty-reviewer` 从头到尾保持 `reserved`**——跨"归档 → 重激活 → 长跑"三个阶段都没被误拉起，
  这是懒加载语义的一次强验证。
- 结论：**"角色不交报告导致静默停摆"这条缺陷，在长任务里是被兜底接住的**；
  没有兜底的话，这次长跑至少会在 6 个点上永久停住。

## 六点十、本轮未完成的验证（诚实清单，2026-09-19）

用户点名要补测三项，第 1 项完成，第 2、3 项**卡在模型额度上，不是卡在代码**：

| 项 | 状态 | 原因 |
|---|---|---|
| (1) 两条车道跑到终局 + 停摆兜底观察 | ✅ 完成 | 见 §六点九 |
| (2) 加一条真正串行的验收车道，验证"不提前起步" | ✅ 已完成（见 §六点十一） | — |
| (3) 声明 phase/lane 的拓扑上真浏览器验证 10 列表格 | ✅ 完成（见 §六点十三） | DOM 里实测到 10 列表头 |

**模型路由当时的可用性（实测）**：
`minimax-cn`（MiniMax-M3 / M2.7 / M2.7-highspeed）→ 429 "已达到 Token Plan 用量上限"（换模型无效，是账号级额度）；
`deepseek-official`（DeepSeek-V4-Pro）→ `no API key`（缺 `DEEPSEEK_API_KEY`）；
`Command` 路由实际落到 `opencode-go/deepseek-v4.1-flash` → "Weekly usage limit reached. Resets in 1 day"。

**恢复后照着跑即可（步骤已定死，不需要重新设计）**：

*先决条件*：4600 dev 实例在跑（`scripts/dev-instance.sh 4600`），浏览器用 ego-browser 打开它的 token URL，
driver 会话的模型切成一条可用路由。

**第 2 项（串行验收车道，验证"不提前起步"）**
1. 让 driver 调用 `orchestra_add_lanes`，`roles` 里给 `{ roleId: "e2e-verifier", preset: "orchestra-v04-verifier-v1",
   sandbox: "read-only", phase: "acceptance", lane: "e2e-acceptance", purpose: "<一句话职责>" }`，
   **第一次不要带 `confirm`**，把返回的 plan 给用户看。
2. 用户点头后带 `confirm: true` 再调一次。
3. **当场核对**：`orchestra/state/team.json` 里 `e2e-verifier` 必须是 `reserved`，
   且该工作区**没有**为它新建任何 `session-*` 目录 —— 这一步就是"不提前起步"的证据。
4. 等两条并行车道各自的报告都在 `orchestra/reports/` 落盘后，再 `orchestra_dispatch` 给 `e2e-verifier`；
   核对它的 phase 变成 `active`、并且它真的产出一份验收报告（`reportCount` +1）。

**第 3 项（10 列草案表：phase/lane 列）**
1. 让 driver 调 `orchestra_draft`，带上 `draftId` + `expectedRevision`，
   并且用 `inlineTopology` 声明 `phases` 与 `lanes`，角色清单里至少有一个角色带 `phase`/`lane`
   （例如 `phase: "acceptance", lane: "e2e-acceptance"`）。
2. 渲染出来的角色蓝图表格应该变成 **10 列**：
   `角色 | 阶段/车道 | backend | preset | sandbox | permission | model | reasoningEffort | compositionTools | orchestraTools`；
   没有任何角色带 phase/lane 时应该回落成 9 列。
   —— 判定依据是浏览器里真实渲染的表格，不是单测断言（单测只证明了函数输出）。

**恢复办法（任一即可）**：给 `DEEPSEEK_API_KEY` 配好凭证、或给 opencode-go 开余额/等周额度重置、
或补充 MiniMax 的积分。之后这两项可以直接接着做——步骤已经写死在会话里，driver 会用。

## 六点十一、串行车道的"不提前起步"实测通过（2026-09-19）

在 `team-f01da153` 上追加一条**串行验收车道** `e2e-verifier`（preset `orchestra-v04-verifier-v1`，
`phase: acceptance`、`lane: e2e-acceptance`），验证它在前置车道完成前不会被物化。

**追加时的证据（关键）**：

| 检查点 | 实测结果 |
|---|---|
| `orchestra_add_lanes` 第一次调用 | 只返回计划（角色/预设/沙箱/phase/lane/职责），磁盘无变化 |
| `confirm: true` 之后 | 返回 `1 lane(s) added… as reserved`，无报错 |
| `team.json` 里该角色 | `phase: "reserved"`、`reportCount: 0`、`sessionHistory: []` |
| 是否被分配了座位 | `sessionId: orchestra-team-f01da153-fe90ca5d-…`（预分配，符合懒加载设计） |
| **是否创建了会话** | **没有**——`~/.dsh/sessions/<cwd>/` 下不存在任何 e2e-verifier 的会话目录 |
| `addedLanes` 审计轨迹 | `('e2e-verifier', 'acceptance', 'e2e-acceptance')` 已记录 |

**前置车道完成度**：`verify-guesses-implementer-wordle-r1.md`（13:47）、
`build-difficulty-selector-implementer-wordle-r1.md`（14:34）、
`review-difficulty-selector-reviewer-wordle-r1.md`（14:36）三份报告都在盘上。

**完成后被拉起**：两条前置车道都完成后再 dispatch，`orchestra_dispatch` 返回
`dispatched to role 'e2e-verifier' (session orchestra-team-f01da153-fe90ca5d-…, newly provisioned)`，
角色 phase 由 `reserved` 变 `active`，**用的正是当初预留的 session id**，
并在 `orchestra/reports/e2e-verification-wordle-r1.md`（15:18）交出了验收报告：
**结论 PASS** —— GUESSES 实测 11779 词（≥5000 ✔）、CRANE/SLATE/STARE/AROSE 全部在列、
难度选择器三档真实存在。

至此，"串行车道：完成前不物化 → 完成后能被拉起并出报告"这条链**全链验证通过**。

**顺带验证到的一条**：`difficulty-reviewer` 从归档前到重激活再到长跑，始终 `reserved`——
跨三个阶段都没被误拉起。

**第 3 项的如实说明**：带 phase/lane 的表在真实浏览器里**渲染出来了**，
形态是 `角色 | 阶段/车道 | backend | preset | sandbox | permission | model | reasoningEffort | compositionTools | orchestraTools`
（`add_lanes` 的计划卡 + 对话表格）。但**没有**验证 `orchestra_draft` 的 10 列蓝图卡本身——
本次未能让 controller 会话成功发起一次带 `inlineTopology` 的草案修订，原因见 §六点十二。

## 六点十二、重激活后的 controller 修订不了自己的章程（2026-09-19 发现并修复，但未端到端验证）

**现象**：团队被"归档 → 重激活"之后，新 controller 调 `orchestra_draft` 修订章程，被拒：
`cannot revise the charter draft: permission_denied (author Session required)`——
原 author session 是重激活前那个 driver，早已不在线。

**这是真缺陷**：重激活后新 controller 无法修订自己的章程，直接堵死"加车道走章程修订"这条路。

**修复**：两处授权检查从"必须是发起人"改成"必须是当前 controller"——
`orchestra_draft` 的 draft-author 检查、以及 amendment 的 semantic-writer 检查
（semantic writer 按构造就等于 controller，文档初始化时写入、每次接管都会重绑）。

**未验证的部分（诚实记录）**：修复已编译、`npm test` 247/247 通过、已部署到 4600，
但**没有端到端跑通**——因为我需要那个 controller 会话本身来调用，而我在 Web UI 里
一直没能可靠地打开它（它不在会话搜索的索引里）。修复后旧会话的报错文案确实变了
（从 "author Session required" 变成 "current controller required"），说明新逻辑在生效。
下一轮若要收尾：在那个 controller 会话里发起一次 revision ≥ 2 的 `orchestra_draft` 即可。

## 六点十三、第 3 项完成：10 列蓝图表格在真浏览器里实测通过（2026-09-19）

在 controller 会话（`4c6fee44`）里新建草案（`draft-61d827db-1149-40c4-a8b7-d4188b4918af@1`），
`inlineTopology` 声明了 `phases: design/build/acceptance` 与
`lanes: fix-guesses/difficulty-lane/e2e-acceptance`，6 个角色每个都带 `phase` + `lane`。

**判定依据是从浏览器 DOM 里读到的真实渲染表格**（不是 driver 转述的文本）：

```
header(10) = 角色 | 阶段/车道 | backend | preset | sandbox | permission
             | model | reasoningEffort | compositionTools | orchestraTools
rows = 7（表头 + 6 个角色）
firstRow = implementer | "build / fix-guesses" | session | orchestra-implementer
           | workspace-write | workspace-write | minimax-cn/MiniMax-M2.7 | - | ... | orchestra_report
```

带 phase/lane 时渲染 **10 列**、缺席时回落 9 列，这与 `renderDraftBlueprintTable` 的实现一致，
**功能已在真实浏览器中确认**。

### 为了走到这一步，本轮又修了两个缺陷

1. **`inlineTopology` 从不校验**：畸形配置一路传到远处才炸成
   `topology.config.roles is not iterable`——既没点名哪个字段错，也没说怎么改。
   修正：在入口处调 `validateTopology` 并抛出带问题清单与正确形状的报错。
2. **`inlineTopology` 只认一种形态**：参数声明为无类型 JSON，模型可能传对象、
   也可能传 JSON 字符串，而旧的实现只接受后者之外的那一种，于是"同一个值的两种拼写"
   有一种必然失败。修正：`parseInlineTopologyArgument` 两种都吞（字符串则 JSON.parse），
   其余形态给出说明性报错；并有单测覆盖。

### 仍未跑通的一处（诚实记录）

**修订既有草案**（`orchestra_draft` 带 `draftId` + `expectedRevision`）仍然报
`revision_conflict: … base charter is stale`。授权问题已经解决（不再报 permission_denied），
解析问题也已经解决（拓扑校验通过），剩下的疑似是"改旧草案 vs 团队当前基线"的版本语义——
本轮**未定位根因**，只登记现象。绕开方式是新建草案（本次验证就是这么做的）。

## 八、必须删掉的旧说法（口径同步清单）

- `package.json` description 仍把 "orchestra_wait with 20m heartbeat" 当卖点；
- README.md 两处仍在教 "dispatch 后 orchestra_wait 睡心跳"；
- STATE.md / UPDATE-v0.5.0.md / `docs/spec-v0.5-refactor-and-slimming.md` /
  `docs/alignment-consensus-2026-09-16.md` 同上；
- `orchestra_dispatch` 工具描述里仍写 ".orchestra/ 状态" 旧路径，且声称"会自动创建 session"
  （本轮已封死"无 team 就 dispatch"）。

这类"代码改了、教模型的文案没改"的漂移，在 v0.5.0 发布复核时已经修过一轮，v0.5.1
又原样复发——**以后每次改动都要把文案当代码一起改。**

## 九、本轮另需修的技术债（核代码确认，非设计问题）

1. **`attachSessionToWorkspaceStorage` 直接改写 `~/.dsh/storages/workspace.json`**。
   对照 DSH 自身契约（`dsh-workspace/lib/types/types.d.ts:60-70`）：`attachSession` 走领域写链、
   校验 session header 的规范 cwd 必须等于工作区 path、拒绝未知 id 与不匹配、做 `updatedAt`
   戳记与无效账号剪枝。磁盘回退全都不做，且非原子读改写、忽略 `DSH_HOME`、`catch {}` 静默吞错。
   → **删除该回退，或降级为显式告警。**
2. **`role.phase/lane` 不做交叉校验**：`validateTopology` 只校验它们是字符串，
   从不校验是否指向已声明的 `phases` / `lanes`。
3. **`renderDraftBlueprintTable` 的 10 列布局是全新的 UI 变更**，按项目硬规则
   （`tsc` 全绿不算数）必须在真浏览器里看过。
4. **`orchestra_dismiss` 与 force-archive 的清理不对等**：force-archive 归档后不发退休通知、
   不 cancel 角色。（force-archive 本身要删，但"归档必须带上全停"这条纪律要保留。）
