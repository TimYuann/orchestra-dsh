# 首批交付报告（2026-10-04）—— Executor → Oracle

> 制品（本轮，**全路径 + 本次 sha256**）：`~/Developer/orchestra-dsh/orchestra-dsh-0.6.1.tgz`
> sha256 `094aef71722c0d50c7480844e28860b8bf84011852ec6ea2b6b96d4a380d3cf7`（84 files，`@deepseek-ai` 条目 0，`dependencies` 仅 `js-yaml`，version 0.6.1）
> 仓库根目录另有历史包 `orchestra-dsh-0.4.0/0.4.1/0.5.0/0.6.0.tgz`：**引用制品一律写全路径 + 当次 sha256**（本轮 D1 归属翻车就是拿错包引起的）
> **Reviewer 复核：`PASS`，附 1 项必改**（D5 的"未解决优先"被说过头）——已修，见 §9；本报告其余口径按 Reviewer 建议修订（D2 证明位置后移、红/回归钉分开陈述）
> HEAD：`6e419b7`，共 8 个 commit：`669bdd3` `3ffa3d2` `14bf342` `72953e1` `cefce8f` `2ddc945` `7f1862f` `6e419b7`；**未 push**，未跟踪 docs 均未 commit
> 本文件由 Oracle 明确授权新增，**保持未跟踪、不 commit、不 push**
> 证据来源：本仓 Oracle 运行记录 `docs/live-run-2026-10-04-first-batch.md`（未跟踪）、任务书 `docs/taskbook-2026-10-04-d5-d2.md`（未跟踪），以及 Oracle 于 2026-10-04 19:10 前后的真机复验
> **引用授权（2026-10-04）**：Oracle 正式授权本报告引用其运行记录，可全篇引用（含 D1/D5 前后对照原文、G1/G2、D3 二次复现、以及「拿记忆当状态」那条教训）。该记录是 Oracle 的记录而非本报告作者的交付物：**只引用其内容与路径，不 commit、不修改它**

## 1. 一句话交付
**在 Session 后端上，一次携带真实委托、固定输入与实际方法/Profile 正文的派发，可以被推进到"报告提交 → 待通知事实 → 通知恢复 → Driver 后续处理"，且故障后不丢事、不重复创建派发记录。** 交付的是"带真实委托的可恢复派发与交接"，**不是**"实例委托系统"。

## 2. 改动清单（文件 + 关键行，HEAD `6e419b7`）

**新增 `src/orchestra-dispatch.ts`**：`DISPATCH_BINDING_REVISION=1`（:31，标注"首批无消费者、第二批占位"）；记录/通知类型（:33-150）；`noticeIdFor`/`dispatchIdempotencyKey`（:152-160）；`computeDispatchPayloadDigest`（:191，工具算、规范 JSON、不含 dispatchId）；`normalizeDispatches`/`normalizeHandoffNotices`（:228/:300）；`dispatchIsHandedBack`/`openDispatchesFor`/`blockingDispatchFor`/`openDispatchForSession`（:357-390）；`roleDeliveryStallPrompt`（:393）；`dispatchLedgerRows`/`handoffNoticeRows`/`dispatchBoardTextFromRows`（:415-470）；`BOARD_RENDER_LIMIT=5`（D5）；**截断行按类拆分计数**（D5 修订，`6e419b7`）：`… N open + M closed not shown (…)` / `… N awaiting the driver + M settled not shown (…)`。

**`src/orchestra-state.ts`**：`TeamReportEntry`（`dispatchId?`/`binding?`/`contentHash?`/`outcome?`，:164-186）；`TeamState.dispatches?`/`handoffNotices?`（:211/:220）；`normalizeReports`；legacy team.json 迁移（缺失即无账本，不伪造，:679/:750）。

**`src/orchestra.ts`**：`singleFlightDispatch`（:3063，同 ID 并发共享一次投递，加入者回报 `reused`）；`delegationBasisOf`（:3100，委托依据取自本 Team 自己的 frozen charter）；`resolveMethodBindings`（:3121，cwd 相对 `ref` 真读 + sha256 比对）；`buildDispatchNotice`（:3181）；`dispatchRoleTask`（:3710，**一次 CAS 内查重+创建** → 投递 → 记账）；`reconcileDispatchDelivery`（:4139，先对账，只有 `not_delivered` 才允许重投，`unknown` 保留）；`recordDispatchDelivery`（:4240，native 子节点实际 session id 覆盖 seat）；`bookRoleReport`（:4336，报告索引 + 待通知事实**同一次 CAS**）；`deliverHandoffNotice`/`settleHandoffNotice`/`scheduleHandoffRetry`（:4512/:4562/:4597）；`reconcileHandoffNotices`（:4628）；turn-stop 只以**已提交事实**判定（`createRoleTurnGuard` :437 起）；`dismissGovernedTeam` pendingTasks 读账本（:4824）；工具面 `orchestra_dispatch`（:5838）、`orchestra_team`（:6092，输出 schema :6154 起含 D1 四字段）、`orchestra_report`（:6507）；系统提示与角色协议文本。

**`src/orchestration-document.ts`**：`documentSummary` 增 `currentCharterRef`（:348/:364）。

**`src/session-blueprint.ts`（D2，首批外）**：`preflightGovernedRequiredTools` 两面分开 + 同面别名感知 + 报错文案（:~612-660）；新增 `compositionRowsProvide`（行→工具名方向）。

**测试**：新增 `scripts/test-dispatch-harness.mjs`、`test-dispatch-contract.mjs`(12)、`test-handoff-recovery.mjs`(5)、`test-composition-proof.mjs`(4)、`e2e-fixture/local-defect/**`；改造 5 个既有测试文件；`package.json` 注册三个新文件。

**D5+D2 的 diff 规模**：`cefce8f..HEAD` = 5 文件 / +364 −18（Oracle 独立复核一致）。

## 3. 反例 1–7 红→绿证据

**红（实现前，`e5528a1` 构建）**
```
$ node --test scripts/test-dispatch-contract.mjs scripts/test-handoff-recovery.mjs
SyntaxError: The requested module '../lib/orchestra.js' does not provide an export named 'bookRoleReport'
# tests 2 / pass 0 / fail 2      EXIT=1
```
行为级探针（`node /tmp/red-probe.mjs`，只用当时已存在的 API）：
```
E7: both dispatches returned successfully; the team records 0 dispatch records (expected: the second call refuses)
E1: both calls succeeded (dispatched, dispatched); no dispatchId/payloadDigest is recorded anywhere
E2: the dispatch delivery wrote no receipt
E5: bookRoleReport missing
E3: team.handoffNotices=null
E4: the progress message was accepted as a handoff
E6: pendingTasks=[{"roleId":"worker","phase":"active","reportCount":0}]
```
**绿（HEAD）**：`node --test test-dispatch-contract.mjs test-handoff-recovery.mjs test-composition-proof.mjs` → **21/21 ok**
E1/r1 复用/冲突/新意图 · E1/r2 并发只落一条且只投一次 · E2 回执写失败→对账恢复 · E2/b 无法对账→显式 unknown 且不重投 · E5 他体冒报被拒+旧结果不能满足新任务 · E7 忙 role 明确拒绝 · E7/b 从未落地被 supersede 后释放 · authority 缺/错引用与非控制器主体拒派且不落记录 · authority/b 方法正文缺失或 digest 不符拒派 · profile binding（ref 读取 + digest 校验 + 陈旧 digest 被拒）· unsupported backend · board and migration（旧 team.json 仍可读、旧报告保持未绑定）· E3 提交点=CAS+重启接管+账目不重复 · E4 进度消息不算交付+通知 pending 不再 steer · E6 归档/恢复不掩盖未交付+不宣称专业关闭 · tool boundary（真 handler + 真 schema）· D5 有界性 · D2/a-b-c-d。

**三处定点红（各自装回即绿）**
1. 工具边界（摘掉 D1 修复）→ 与真机**逐字相同**：`orchestra_team returned a value its declared schema rejects` / `"value.team" must match exactly one oneOf branch (matched 0)`。
2. D2（回退 `session-blueprint.ts`）→ 与真机**逐字相同**：`catalog composition does not declare required compositionTools: read, edit, write, bash, grep, glob`（`# pass 2 / fail 2` → 装回 4/4）。
   **红/绿要分开陈述（Reviewer 建议）**：D2 的 4 条里，**只有 `D2/a`（工具名声明应通过）与 `D2/d`（诊断文案）在基线上是红的**；`D2/b`（真缺能力仍拒）与 `D2/c`（相邻拓扑守卫不回归）**基线本来就绿**，它们钉的是"不许回归"，不是红→绿。
3. D5 截断计数（Reviewer 必改 1，`6e419b7`）→ 回退 `src/orchestra-dispatch.ts` 重跑：`not ok 5`（未匹配 `… 2 open + 2 closed not shown …`）与 `not ok 6`（新测试），`# pass 4 / fail 2` → 装回 `# pass 6 / fail 0`。
3. D5（回退渲染）→ 未匹配 `- dispatch tool-boundary-1 → role worker [delivery=delivered] handed back report=`；`pass 3/fail 2` → 装回 5/5。

## 4. typecheck / build / test（HEAD `6e419b7`）
```
$ npm run typecheck   → 0 errors（tsconfig.json + tsconfig.client.json）
$ npm run build       → 通过（tsc → build-role-presets → tsc(client) → tsdown）
$ npm test            → # tests 321 / # pass 321 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0，EXIT=0
```
基线 `e5528a1` 299/299；首批 +16 → 315；D5 +1、D2 +4 → 320（**Oracle 独立复跑得到 320/320，exit 0**）；Reviewer 必改 1 的截断计数 +1 → **321**。

## 5. 真机演示链观察（§7.2）

### 5.1 首轮演示（制品 `fe706c9f…` = commit `669bdd3`，D1 当时存在）
| 环节 | 观察 |
|---|---|
| 真实批准 | 用户回复「启动」→ `approval notice: Draft …@1 approved by user reply (digest=cb03be06…)`，批准绑定确切 revision + digest |
| 建团 | `orchestra_create` 成功（前两次被构图校验拒 → D2；driver 共 6 个 revision） |
| 派发账本 | `TeamState.dispatches[]` 3 条：调用方显式 `dispatchId`、工具算 `payloadDigest`、`bindingRevision=1`、`delegation.charterRef/authorityRef` 指向被批准的确切 `@6#6e75a9a7…`、`methodBindings.contentVerified=true`、`delivery.idempotencyKey` |
| 方法绑定 | `methods/local-defect-feedback-loop.md` sha256 `0feec14d…`；**派发侧**读文件并按 sha256 校验通过；**worker 侧亦实读**（见 §5.4 一手证据） |
| Profile 绑定 | `slugify-fix-rev-01` 的 `profileRef = {id: evidence-evaluation, source: tim-professional-workflow@f5d6d054…, contentDigest: 6d11c157…}` 落盘。**该次 `ref` 与 `content` 都传了，而所装制品不支持 `profileRef.ref`，实走内联 `content` 路径 ⇒ 这一次不能作为 `ref` 形式的验证** |
| 投递 | 收据 `orchestra/receipts/<sha256>.json`，`message_id = orchestra-dispatch:<dispatchId>`，`state: accepted` |
| 待通知事实 | `handoffNotices[]` 3 条（noticeId/reportId/dispatchId/targetSessionId/path/contentHash/state/attempts/deliveredAt） |
| worker 交活 | 根因修复 `/[^a-z0-9]/g` → `/[^a-z0-9]+/g`，测试文件逐字节未改，`# pass 2 / # fail 0` |
| 收口 | `orchestra_dismiss` → 归档 51,950 B，status dismissed，3 dispatches / 3 reports 完整保留 |
| D1（首批引入的回归） | 有报告后 `orchestra_team` 必然 `matched 0`；**触发条件是报告落盘，与重启无关**（18:21 成功时 `reports` 为空，18:31 失败时已有 3 份）。修复 `cefce8f` |

### 5.2 复验（Oracle 驱动，制品 `aaf72f39…`，2026-10-04 19:10 前后）
| 项 | 结果（归属：Oracle 复验） |
|---|---|
| **D1** | 装 `9a6ca234…` → 重启 4600 → `orchestra_activate` 复活**带 3 份报告**的 `team-8afc4a2a` → `orchestra_team` **不再报 `matched 0`**；复验后重新归档（52,365 B） |
| **D5** | 同一路径下，`orchestra_team` 的**工具返回逐行可见**：未解决优先、截断有显式计数、计数行全量 ⇒ **D5 真机通过**。**前后对照原文**（Oracle 从 demo driver 会话事件流取回）：D1 未修（turn 16，两次）`"value.team" must match exactly one oneOf branch (matched 0)` → D1 修好、D5 未装（turn 17）能返回但**只有汇总**（2693 字符）→ **D5 装上后（turn 21/22）逐行出现**（4509 / 5013 字符），形如 `- dispatch slugify-fix-impl-01 → role implementer [delivery=delivered] handed back report=352d32de… session=…` 与 `- notice notice:352d32de… → role implementer [state=delivered] driver=claimed attempts=1 path=… dispatch=…` |
| **`profileRef.ref`（仅给 ref、不给 content）** | dispatchId `live-ref-check-01`，`profileRef = {id: evidence-evaluation, source: tim-professional-workflow@f5d6d054…, ref: profiles/evidence-evaluation.md}`（未给 `content`、未给 `contentDigest`）；worker 回报（`orchestra/reports/live-ref-check-01.md`）写明 Profile 正文**完整内联送达**、digest `sha256:6d11c157…73d` ⇒ **工具自己读文件、自己算 digest、正文内联送达**。**`14bf342` 的能力至此才真正验证过**（首轮那次 `ref + content` 不算） |

### 5.3 未观察到的项（**不得按预期补写**）
| 项 | 状态 |
|---|---|
| `orchestra_dispatch` 的**工具返回对象** | **未观察到**。在手的是账本记录（`TeamState.dispatches[]`）与收据文件；被拒那次的错误文案（`missing required property "brief"`）来自 GUI 转录，不是返回对象 |
| worker **读取方法文件的那次调用** | ~~未观察到~~ → **已观察到（2026-10-04 19:20，只读解压该会话日志）**，一手证据见 §5.4；账本侧证据（`contentVerified: true`）仍是派发侧的独立一半 |
| `orchestra_report` 的**工具返回对象** | **未观察到**。在手的是账本报告条目（reportId/contentHash/outcome）与 `handoffNotices[]` |
| driver 收到的**通知消息正文** | **未观察到**。在手的是通知记录 |
| **重启后逐条看板字段**（`open=false`、`report_id`、notice 的 `state`/`driver_state`） | **首轮从未观察到**：重启后那次 `orchestra_team` **直接失败**（`matched 0`，即 D1），D1 修好后的复验**只拿到汇总行**（`dispatches: 3 total, 0 undelivered | handoff notices: 3, 0 awaiting the driver`）。**逐条字段在首轮渲染里从未出现过——这正是 D5 的证据**；D5 修好后的逐行可见见 §5.2 |
| 跨重启存活 | **是观察，来源是读盘**（team.json / 归档）：teamId、章程 digest、3 条派发（含 profileRef）、3 条 notice、3 份报告存活、未交付计数 0、sessionId 未变 ⇒ §7.2「重启后仍能定位同一份委托与未完成步骤」= **是**；**定位手段是读盘，不是看板渲染** |

### 5.4 §7.2「方法正文真的到达 worker」——一手证据（只读解压会话日志）
- 会话：`orchestra-team-8afc4a2a-edeb2026-ad3e-42c8-a48c-73c40db6d066`（implementer，承担 `slugify-fix-impl-01`）
- 来源：`~/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_E2E--/orchestra-team-8afc4a2a-edeb2026-ad3e-42c8-a48c-73c40db6d066/session.v4.jsonl.zstd`（`zstdcat` 解压，157 行事件；**只读**，未改任何文件）
- **那次读取调用（`seq=15`，原样）**：
```json
{"type":"tool/call","seq":15,"time":1791109342195,"data":{"turn":1,"step":1,
 "callId":"call_function_fgqxdv479axu_2","name":"read",
 "arguments":"{\"file_path\":\"~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/methods/local-defect-feedback-loop.md\"}"}}
```
- **对应结果（`seq=18`）**：`tool/result` 返回 19,279 字节正文，开头 `<path>…methods/local-defect-feedback-loop.md</path>` / `1: # Local defect feedback loop · M4 accepted reference`，并含 `Source anchors` 段 ⇒ **正文（非仅身份）确实到达 worker**。
- **归属**：这条原始调用由 Oracle 从该会话事件流取回；本报告作者亦**独立只读解压同一日志复核**得到同一条（`seq=15` 调用 / `seq=18` 结果），两者一致——证据本身按 Oracle 取回记，复核过程按作者记，不合并成「作者亲验」。
- **同会话调用构成**（两轮合计 18 次）：`read×4` / `bash×4` / `edit×3` / `orchestra_report×2` / `a2a_reply×5`（与 Oracle 的独立清点一致）。
- **worker 从收到派发到提交报告的工具调用序列**（turn.step:name）：
```
t1.s1:read → t1.s1:read → t1.s1:read → t1.s2:bash → t1.s3:edit → t1.s4:edit → t1.s5:edit
→ t1.s6:bash → t1.s7:read → t1.s7:bash → t1.s8:orchestra_report → t1.s9:a2a_reply
→ t2.s1:a2a_reply → t3.s1:bash → t3.s2:a2a_reply → t4.s1:a2a_reply → t4.s3:orchestra_report → t4.s4:a2a_reply
```
（t1.s1 的三次 read 依次为 `src/slugify.mjs`、`methods/local-defect-feedback-loop.md`、`test/slugify.test.mjs`；t1.s8 的 `orchestra_report` 带 `dispatchId="slugify-fix-impl-01"`。）
- 边界：这条只证明"该 worker 那次**读到了**方法正文"；**不证明**它按方法完成、更不证明结论正确。

### 5.5 G1：同一团队、两种绑定形态的对照（"方法是否送达"取决于 brief，不取决于绑定）
| 派发 | brief 对 `methods/` 的处置 | 实际结果（一手） |
|---|---|---|
| `slugify-fix-impl-01`（首轮） | **允许**读；brief 给出 ref + sha256 | worker **主动 read 了方法正文**（§5.4 的 `seq=15` 调用 + `seq=18` 19,279 字节正文）⇒ **方法正文送达成立** |
| `live-ref-check-01`（ref 复验） | **反向禁止**：派发文本原文「不得读写 src/、test/、profiles/、**methods/** 下任何文件」 | 方法侧只有**身份**（methodId / ref / sha256 `0feec14d…`）到达；正文未到达（它未读、也被禁止读）⇒ "方法送达"退化为"**方法身份送达**" |

同一派发里的 Profile 侧恰好相反：Profile 正文**按设计内联**送达（派发文本里可见 `# Evidence Evaluation · 证据与验证（F）` 全篇 + `sha256:6d11c157…`），而 worker 仍把"ref 目标 `profiles/evidence-evaluation.md` 的存在性与内容一致性"标为 **UNVERIFIED**——因为 brief 禁止它读 `profiles/`。它同时指出 brief 第 4 条写的"未内联 Profile 正文"与它实际收到的内联正文不符，**没有拿不一致当一致**。

⇒ 结论（写入运行记录的是 Oracle 的裁定，此处只记事实）：**方法走 ref 绑定、正文不内联时，"方法是否送达"取决于 brief 有没有给读权限并要求去读，而不取决于绑定本身。** 这条属 **driver 侧 brief 编写指引**，不是产品缺陷。

### 5.6 运行时强制收口在工具参数层面可见（同源取证）
`live-ref-check-01` 那次 `orchestra_report` 的**原始参数**（`seq=142`，`tool/call`，keys = `content, dispatchId, path`）开头即为执行偏差声明，原文：

> **执行偏差声明**：本派发 task spec 第 3/5 条明确要求「不得用 orchestra_report 写报告文件」「只用 a2a_reply 回复 driver 一条消息即可」。我最初即按该边界执行，**未写任何报告文件**。但运行时向本角色发出强制收口指令：dispatch `live-ref-check-01` 仍为 undelivered，必须用 orchestra_report 绑定该 dispatch 后再回复，否则本轮静默结束会卡住整个 run。**平台级收口要求优先于 task 的字面禁令**，故本文件按最小化原则仅记录身份核对结果，不含任何实施内容。

⇒ 运行时的强制收口（§5.3 的三段解耦）在**工具参数层面**可见，不只是 worker 的转述。

## 6. 未完成项 / 已知缺口
1. **D3 未做**（裸 A2A session 无回合交回守卫：reviewer 曾跑完 47 步、`turn/end completed`、零交回动作而无人发现）——按任务书本批不做，另开一条。
2. **D2 只有单测级验证**：先红后绿，**且红色报错与真机同一错误串逐字相同**；**没有真机 `/team` 建队验证**，不得写成"真机已验"。
3. **native 后端**：以 `unsupported_backend` 明确报不支持（任务仍投递，不宣称投递保证），不静默降级。
4. **无取消/放弃派发入口**：`unknown` 的派发会阻塞该 role 的新意图，只能同 ID 对账；`not_delivered` 可被新意图显式 supersede。
5. **`bindingRevision` 无消费者**（固定 1，占位）。
6. **通知重试是"至少一次"**：同一条 notice 若已 accepted 但未记账即崩溃，重启后可能重复通知一次（报告账目不重复）；§5.2 已允许"通知重试"重复。
7. **报告文件本身仍是无条件覆写**：账目不重复 ≠ 文件字节不被改写。
8. `noticeFailures` 仍 20 条上限的诊断 breadcrumb；待办事实另存 `handoffNotices`（无该上限）。
9. 真机侧遗留（Oracle 运行记录）：U1 第二次评价与第一次同一 session（独立性不成立）、U2 E2E 工作区 2 例既有红（与本任务无因果）、U3 缺修复前字节指纹（C3 属强推定）、U4 `slugify()` 边界用例零覆盖；driver 记录的两处未归因异常（包身份无路径可自核；角色 `running`/轮次显示不一致）。

## 7. §7.1 证明边界（如实声明）
- 首批反例与测试只证明**不盲目创建新派发记录**与**不重复记账**；**不证明 worker 不重复收到消息**（§5.2 明确不承诺）。
- **账目不重复 ≠ 文件字节不被改写**。
- **`contentDigest` 校验是否确实执行，不可自证**——可证的只是"调用被接受且未被闸门拒绝"。
- "工具可写但无动作授权"只声称**实际实现**的部分：缺有效引用、引用指向别的 Team、调用主体不符、方法正文缺失/失真 → 拒绝派发；**不宣称**已理解或强制执行任意自然语言授权边界。
- 首批**没有**证明跨后端 exactly-once、传递失效传播、`decisions[]` 新语义、通用接受/授权/关闭引擎。
- **D2** 是既有缺陷（`git log -1 -- src/session-blueprint.ts` = `b658f9f`），**不计入首批交付声明**；它只证明**发布前**"声明的行能供给该工具名，或宿主作用域暴露该名"，**不证明**发布后会话真的挂载，也**没有真机建队验证**（见 §6.2）。
  **证明位置后移（Reviewer 建议，必须显式记载）**：`hostToolNamesForPreflight(ctx)`（`src/session-blueprint.ts:707-720`，调用点 `src/orchestra.ts:1218`）取的是**宿主/控制器当前可见的工具名**，**不是该角色发布后的组合作用域**。因此 read-only 角色若声明 `requiredTools: ["write"]`，**preflight 会放行**（控制器的作用域里确实有 `write`），真正的拒绝**推迟到发布时**——`commit()` 内的发布后核对（`src/session-blueprint.ts:1157-1163` 一带，`names = visibleToolNames(agentCtx)` 取自已发布组合）会以 `required_tools_missing` / `composition_tools_missing` / `orchestra_tools_missing` 拒绝。这不是本轮引入的错（Oracle 的裁定 (b) 原文即"可见工具名 / hostToolNames"），但**不得**让读者以为 preflight 已覆盖发布后。
- **D5** 证明"账本逐行状态**对模型可见且渲染有界**"（含真机复验）；**不证明** driver 会据此作出正确处置。
  修订后的准确表述（Reviewer 必改 1）：**未解决项排在前面是优先级，不是保证**——未解决行数超过 `BOARD_RENDER_LIMIT` 时，未解决块的**尾部同样会被截断**；因此截断行**按类给出未显示计数**（`N open + M closed` / `N awaiting the driver + M settled`），使"被藏的条目里有多少仍未解决"从文本即可读出。**不再声称"截断不可能藏住未解决项"**（`2ddc945` 的 commit message 与旧测试注释里的该表述已被 `6e419b7` 取代并留档说明）。

## 8. 纪律遵守
**一条过程教训（本轮双方各犯两次，留档）**：本轮出现过**用记忆中的状态当事实**的错误——Oracle 侧三次（「重启导致 board 失效」的误归因、把工作树当 HEAD、「8 个 commit」），作者侧两次（「代码冻在 `72953e1`（4 commit）」「五份未跟踪 docs」）。它们都靠**回报前先读一次新鲜状态**（`git log --oneline -1`、`git status --short`、`ls`/`wc` 实测）纠正。这条与产品无关，但属本轮证据纪律里最容易被忽略的一条：**状态类断言必须来自刚读到的读数，不能来自记忆或上一轮结论。**

`@deepseek-ai/*` 只在 peer/dev；tgz 内 `dependencies` 仅 `js-yaml`；未动 `desktop`/`web` profile 与 4599；未 push / 未发布 / 未 bump；未跟踪 docs（含本文件）一律未 commit；未复活 `openGate`/`startLoop`/`recordVerdict`/`recordClosure`/`startAttempt`（各只剩 import）；`team.graphRuntime` 保留原样（读路径仍 sweep、`/team decide` 仍可达、迁移只新增字段）；`STATE.md` 未改（driver 的板子）；未自行操作任何 profile 或全局宿主。

## 9. Reviewer 复核后的修订（`6e419b7`，单项）
**必改 1｜D5「未解决优先」被说过头了**（Reviewer 抓、Oracle 确认）：`2ddc945` 的 commit message 写"unresolved rows are listed FIRST, so truncation can never hide what is still owed"，测试注释写"every open row is inside the bound here"——**它自己的夹具就是反例**（9 条、7 条 open、上限 5 ⇒ 显示 5 条 open，**d-7/d-8 两条 open 被截断**），而截断行只给一个总数（`… 4 more dispatch(es) not shown`），读者无法看出"被藏的 4 条里有 2 条未交付"。
**处置（按 Reviewer 推荐的 (a)）**：
1. 截断行**按类拆分**：`… 2 open + 2 closed not shown (bounded render; counts above are complete)`；notice 平面同理 `… 0 awaiting the driver + 3 settled not shown (…)`。
2. 去掉不实表述：模块注释改为"未解决项优先；未解决块的尾部同样可能被截断，这正是计数要分类的原因"；旧 commit message 与旧测试注释**不改写历史**（`2ddc945` 已被独立复核并以 commit id 引用），由本 commit 的正文与报告承接更正。
3. **补测试**：原测试改为断言分类计数（`2 open + 2 closed`、`0 awaiting + 3 settled`）；新增一条"**被截断的全部都未解决**"用例（10 条 open / 9 条 awaiting，上限 5 ⇒ `3 open + 0 closed`、`4 awaiting the driver + 0 settled`），钉住分类计数这一行为。
4. 未采用 (b)（未解决项不设上限）：那会改变渲染的有界性语义，且"有界"是 Reviewer 已判达成的四项之一。
**红→绿**：回退 `src/orchestra-dispatch.ts` → `not ok 5` / `not ok 6`，`# pass 4 / fail 2`；装回 → `# pass 6 / fail 0`。全套 `npm test` = **321/321 pass，EXIT=0**。
**边界**：本次只修"截断计数不可辨类"与随之而来的不实表述；**未**改变逐行可见、有界、同一份投影这三项已判达成的性质。
