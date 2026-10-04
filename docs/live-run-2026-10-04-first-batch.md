# 首批真机实战记录（2026-10-04）

> **路径口径**：本记录与配套交付报告中的家目录绝对路径按本仓惯例写作 `~/`（原文为绝对路径）；令牌一律不落盘。
> 参与：Oracle（driver）/ Reviewer（`step/step-5-preview`, high）/ Executor（`opencode-go/deepseek-v4.1-flash`, max）
> 靶场：`~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E`，dev-orchestra:4600
> 制品：`orchestra-dsh-0.6.1.tgz` sha256 `fe706c9f…d56143`（84 files，`@deepseek-ai` 0 条）
> 首批提交：`669bdd3` → `3ffa3d2` → `14bf342` → `72953e1`（16 文件 / +3322 −166）

---

## 一、链路走通了（全链实测）

| 环节 | 观察结果 |
|---|---|
| 真实批准 | 用户回复「启动」→ `approval notice: Draft …@1 approved by user reply (digest=cb03be06…)`；批准**绑定确切 revision + digest** |
| 建团 | `orchestra_create` 成功（前两次被构图校验拒，见 D2） |
| 派发账本 | `TeamState.dispatches[]` 3 条，每条含 `dispatchId`（调用方显式）、工具算的 `payloadDigest`、`bindingRevision=1`、`delegation.charterRef/authorityRef`（指向被批准的确切 `@6#6e75a9a7…`）、`methodBindings.contentVerified=true`、`delivery.idempotencyKey` |
| 方法绑定 | `methods/local-defect-feedback-loop.md` sha256 `0feec14d…`，**派发时读文件校验，不符即拒派** |
| Profile 绑定 | `slugify-fix-rev-01` 的 `profileRef = {id: evidence-evaluation, source: tim-professional-workflow@f5d6d054…, contentDigest: 6d11c157…}` —— **确实落盘**。⚠️ 附注：该次派发 `ref` 与 `content` **两个都传了**，而本次所装制品（`669bdd3` 的包）**不支持 `profileRef.ref`**，所以实际走的是内联 `content` 路径。**"仅用 `ref` 绑定 Profile"这一形式在本次演示中未被验证**——不要把它写成已证。 |
| 投递 | 收据文件 `orchestra/receipts/<sha256>.json`，`message_id = orchestra-dispatch:<dispatchId>`，`state: accepted` |
| 待通知事实 | `TeamState.handoffNotices[]` 3 条，含 `noticeId/reportId/dispatchId/targetSessionId/path/contentHash/state/attempts/deliveredAt` |
| worker 交活 | implementer 修根因 `/[^a-z0-9]/g` → `/[^a-z0-9]+/g`，测试逐字节未改，`# pass 2 / # fail 0` |
| 独立评价 | reviewer（绑定 Profile）只读复跑得 **PASS（三态）**，并自建负控制、**主动披露自己第一版脚手架是坏仪器** |
| driver 交叉复跑 | 同得 2 pass；四项判据 C1–C4 全 PASS |
| 收口 | `orchestra_dismiss` → 归档 `team-team-8afc4a2a-…json`（51,950 B，status dismissed，3 dispatches / 3 reports 完整保留） |
| 跨重启 | 重启 4600 后：teamId、章程 digest、3 条派发（含 profileRef）、3 条 handoffNotice、3 份报告**全部存活**；未交付计数 0；角色 sessionId 未变 |

**判据「重启后仍能定位同一份委托与未完成步骤」= 是**（依据为重启后实际读盘所得）。

---

## 二、缺陷

### D1（**首批引入的回归，阻断级**）：`orchestra_team` 在有报告后必然校验失败

**症状**：`value.team must match exactly one oneOf branch (matched 0)`，确定性 2/2。

**根因（已定位到行）**：

- 首批给报告记录加了 4 个字段：`src/orchestra-state.ts` 的 report 类型新增 `dispatchId` / `binding` / `contentHash` / `outcome`；
- 而 `orchestra_team` 的声明式输出 schema 里 `reports.items` **只声明了** `reportId/roleId/sessionId/path/createdAt`，且 `additionalProperties: false`；
- 首批**没有**同步该 schema（`git diff e5528a1..HEAD -- src/orchestra.ts` 无新增 `reportId` 声明行）。

⇒ **只要 `reports[]` 非空，投影就带 4 个未声明字段 → 整个 `orchestra_team` 调用失效。** 团队一有报告（正常情况总是有）就看板读不通，只能退回读盘。

**时点对照（排除"重启导致"的错误归因）**：
- 18:21 调用成功 —— 当时 `reports` 为空；
- 18:31 调用失败 —— 已有 3 份报告。
- **触发条件是"报告落盘"，与进程重启无关。**

这正是本仓自己写下的失效类：*"a summary that carries a field its schema does not declare makes the WHOLE tool call invalid"*（`orchestra.ts` 内注释）。

**测试为何没抓到**：313 条全绿，但没有一条断言"团队投影在 reports 非空时仍满足自身声明 schema"。

**制品归属（已逐 commit 核对）**：
- 本次演示所跑制品 = `fe706c9f…` = commit `669bdd3`（18:06 打包）。
- **D1 在 `HEAD`（`72953e1`）与 executor 新打的包 `73f761ef…`（18:15）上同样存在** —— 逐 commit 取 `src/orchestra.ts` 的 `reports.items` 段核对：`669bdd3` / `3ffa3d2` / `14bf342` / `72953e1` **四个都只声明** `reportId/roleId/sessionId/path/createdAt`；新包内 `lib/orchestra.js` 的 `contentHash` 命中数与 HEAD 源码相同（4）。
- 修复已在 executor 工作树中（未提交）：`src/orchestra.ts` +9 行，把四个字段补进 `reports.items`。**修复提交并重打包前，D1 仍成立。**

### D2（**既有缺陷**）：`preflightGovernedRequiredTools` 两侧命名空间不匹配

`src/session-blueprint.ts:586-635`：`capabilities.composition = requiredTools ∪ compositionTools`（工具名一侧），而 `declared = rolePresetSpec.compositionTools ?? staticCompositionTools`（行 id 一侧：`tool-bash`/`tool-fs`/`tool-fs-search`），第 624 行用**普通 `includes`**，未走同文件上方就有的别名感知 `hasCompositionTool` / `COMPOSITION_ROW_TOOLS`。

⇒ 角色一旦声明工具名（`read/edit/write/bash/grep/glob`）就**必然全缺、永远过不了**；错误文案还把 required 说成 "required compositionTools: read, edit, write, …"，把实施者引向错误的一侧。

**实测代价**：driver 连出 6 个 revision、约 3M token；每次改章程都要用户**重新批准**（批准绑定 revision+digest，设计正确但摩擦真实）。
**归属**：非首批引入（`git diff e5528a1..HEAD -- src/session-blueprint.ts` 为空）。
**规避形态**：角色声明里两个字段都省略，由 preset 的 catalog spec 提供行 id。

**后续补充（executor 只读源码所得）：这不是一个陷阱，而是一簇——三处校验、三套文案、三种成因**

| # | 报错文案 | 位置 | 成因 |
|---|---|---|---|
| 1 | `role "x" compositionTools cannot contain host transport/orchestra tools` | `src/orchestra-topology.ts:1234` | 把 `orchestra_report` 之类写进了 `compositionTools` |
| 2 | `role "x" orchestraTools must use Orchestra host tool names` | `src/orchestra-topology.ts:1237` | `orchestraTools` 里混了 `read`/`bash` |
| 3 | `Draft role preset … is not cataloged and has no explicit static compositionTools proof` / `role … has no recorded expected tool contract` | `src/orchestra.ts:1572-1578` / `:3475-3479` | **角色声明了 preset 但既没声明工具面、又不是目录预设名**（例如自定义 `implementer`/`worker` 这类 preset id） |

**可照抄的两种解法（都不改代码）**：
- **(A) 用目录预设 id** 并在角色里**显式写上成对的工具面**——`orchestra-v04-implementer-v1` 对应 `compositionTools: ["tool-bash","tool-fs","tool-fs-search"]` + `orchestraTools: ["orchestra_report"]`；**id 与工具面必须属于同一个预设**，否则 `composition_mismatch`。
- **(B) 直接快照内置模板**：`orchestra_draft(topology: "duo" | "trio" | "oracle" | "four-role-dev")`，模板里每行都成对声明，一条都不会撞。

**给后续 demo 的建议**：用 (B) 保时间——§7.2 的验收点是**交接链**，构图摩擦单独记录即可。本次 demo 在 D2 上耗掉约 6 个 revision / 3M token，而这**不是**要验的东西。

### D3（流程发现）：裸 A2A session 没有回合交回守卫

reviewer 第一次运行跑了 47 步、只产出 3 段进度旁白、`turn/end (completed)`，**零交回动作**（无 `a2a_reply`）——没有任何机制发现。`handedBackThisTurn` + stall steer 只挂在 **Orchestra 团队角色**上；裸 A2A session 没有团队就没有守卫。

**第二次复现（2026-10-04 19:18，同一 reviewer 会话）——同一模式，过程完整可查：**

它本轮做了 **12 次工具调用**的实质复核（`todo_write` → 读 `docs/taskbook-2026-10-04-d5-d2.md` → 读 `docs/live-run-2026-10-04-first-batch.md` → `git log/status/diff` → `git show 2ddc945 --stat` + D5 diff → grep `BOARD_RENDER_LIMIT` → 读 `src/orchestra.ts:6280+85` → `git show 2ddc945 -- scripts/test-handoff-recovery.mjs` → 读 `src/orchestra-dispatch.ts:380+130` → `git show 7f1862f --stat` + D2 diff → grep `session-blueprint.ts` → 读 `src/session-blueprint.ts:540+120`），随后 `step/end → turn/end`，**没有结论、没有 `a2a_reply`**。它最后一次 `a2a_reply` 是**上一轮**（V3 审核，消息 `8701ef49-…`）。

⇒ **同一 reviewer 会话 2/2 回合以"无交付"结束。** 而它在 **V3 审核那一轮是正常交付的**（先 `a2a_reply` 再陈述结论），所以不是"这个模型不会用这个工具"，更像某种回合结束条件未被满足时的静默收尾。已另开一条查 D3，并要求 reviewer 就其第一手自述说明原因。

### D4（归因更正）

reviewer/driver 均把 `orchestra_team` 失效归因于"重启后失效"。**该归因错误**：真实触发是报告落盘（见 D1）。重启只是恰好发生在报告出现之后。

---

## 三、A2A 工具实测面

| 能力 | 结论 |
|---|---|
| `a2a_create`（session 后端 + 钉 model/provider/effort） | 可用；身份持久落在 `orchestra/blueprints/<sessionId>.json`（含 provider/model/reasoningEffort/cwd/title/createdBySessionId/createdAt）。**会话 header 本身不含 provider/model**（只有 `agentPreset`），该 marker 是模型钉住的唯一会话侧记录 |
| `a2a_send` → `a2a_status` | 可用；观测到 `accepted (live_inbox)` → `claimed` |
| `a2a_reply` 唤醒 | 可用；reviewer 的 `a2a_reply` 确实唤醒了 driver 的新回合 |
| `a2a_stop` | 可用；对一个 idle 的 reviewer session 返回 `execution stopped (was idle, inbox cleared)` |
| `a2a_list` | 可用；`query` 检索正常 |
| 侧边栏可见性 | 只创建、无消息的 session **不出行**；有第一条消息后出现（两次实测）。与 `sessionPaths` 内存过滤**无关**（我起初的归因错误，已纠正） |
| **投递语义：accepted ≠ 接收方已取用** | 目标正忙时 `a2a_send` 返回 `accepted (durable inbox splice)`——消息**已进持久 inbox**，但要等回合边界才被取用。实测后果：任务书连发两封都显示 accepted，而接收方在下一次回报里说"inbox 里最后一封是更早那封、任务书没有到达"。**没有丢失，但发送方与接收方对"已送达"的认知存在时间差。** 处置：把任务书落盘（`docs/taskbook-2026-10-04-d5-d2.md`）改以文件为准，指针消息短小以便重发 |
| 无守卫 | 见 D3 |

---

## 四、base 与结论边界

- 首批只覆盖 **Session 后端**；native 后端以 `unsupported_backend` 明确报不支持（不静默降级）。
- 首批证明的是**交接链**："不盲目创建新派发记录、不重复记账"；**不证明** worker 不重复收到消息（§5.2 明确不承诺），也**不证明**任务已通过独立评价/获准发布/正式关闭。
- 账本可回溯：`dispatchId/payloadDigest/bindingRevision/charterRef+authorityRef/profileRef/methodBindings+contentVerified/delivery.state+idempotencyKey` 均可从 `team.json` 核验；receipt 只承担投递事实。**仍不可自证**：`contentDigest` 校验是否确实执行过（可证的只是"调用被接受且未被闸门拒绝"）。
- **D1 未修**：本记录写入时，`orchestra_team` 在有报告时仍失效。

## 五、Backlog（driver 留档，未处理）

| # | 内容 |
|---|---|
| U1 | 独立第二评价者缺口：rev-01 与 rev-02 同一位评价者（session 复用），不构成独立佐证 |
| U2 | `artifacts/p0-0.6.0-team-smoke/duration.test.mjs` 2 例既有红，与本任务无因果 |
| U3 | 缺修复前字节指纹，C3 只能"强推定" |
| U4 | `slugify()` 空输入 / 纯分隔符 / 非 ASCII 零覆盖 |
| U5 | ~~Profile 绑定不完整~~ —— **已证伪**（文件在位、摘要三方一致） |

**一条方法论发现（超出"让测试变绿"）**：判定命令无法区分根因修复与症状抑制——reviewer 的 M2 变体（不动 `slugify()`、只在 `title` 内加 `/-{2,}/g`）三条断言同样全绿。C2 成立靠 `slugify()` 直调 + 源码直读两路独立证据，**不靠绿灯**。

---

## 六、D1 修复与定点复验（2026-10-04 18:39–18:43）

**修复**：executor 提交 `cefce8f fix(board): declare the report binding fields the ledger can now set`（`src/orchestra.ts` +9 行补四个字段声明；`scripts/test-dispatch-harness.mjs` +18、`scripts/test-handoff-recovery.mjs` +49 补测试），工作树干净后重新打包。

**制品链（逐版核对）**：

| 时间 | sha256 | 对应 commit | D1 |
|---|---|---|---|
| 18:06 | `fe706c9f…d56143` | `669bdd3` | 在（本次演示跑的包） |
| 18:15 | `73f761ef…da1cf9c` | `72953e1` | 在 |
| 18:39 | `9a6ca234…a4877fc8a` | `cefce8f` | **已修** |

三次均为 84 files、`@deepseek-ai` 条目 0、`dependencies` 仅 `js-yaml`。

**定点复验（打在原失效路径上）**：装新包 → 重启 4600 → `orchestra_activate` 重新激活 `team-8afc4a2a`（该团队带 3 份报告）→ `orchestra_team`。

**结果：不再失败。** 原样返回含
`team team-8afc4a2a (…, active) … | dispatches: 3 total, 0 undelivered | handoff notices: 3, 0 awaiting the driver`
与 `pending handoffs=0 | cap exhausted=0 | open gates=0 | closure=none`。
driver 另行独立核对装机件 `lib/orchestra.js:4978-4981` 确实声明了四个字段。复验后团队已重新归档（新归档件 52,365 B，旧件保留）。

### D5（新缺口，复验中暴露）：看板对模型只暴露 prose，看不到逐条状态

`orchestra_team` 渲染给模型的是一行 prose；schema 里的**结构化行字段**——逐条 `dispatch_id` / `open` / `report_id`、逐条 notice 的 `state` / `driver_state`——**没有出现在渲染文本里**。汇总只有 `dispatches: 3 total, 0 undelivered` 与 `handoff notices: 3, 0 awaiting the driver`。

⇒ **这份看板的设计读者（driver）恰恰读不到"哪一条派发还开着、哪一条通知卡在谁那里"。** 首批新增的账本语义在结构化层成立、在模型可见层没有落地。

driver 的表现值得记录：它**拒绝**用读盘结果去补工具没返回的字段，如实标注"渲染文本里没有，我不能替你补"。这正是"工具返回不能被别的来源替代"该有的纪律。

### 另外两处 driver 如实标出、未编解释的异常

1. 它无法独立核对包 sha256 / commit（我只给了值、没给文件路径——这是我该给的）；
2. 角色显示 `running`、轮次标 R1/R2，而两个 session 刚才是 `(resumed)` —— 不一致，未归因。

---

## 七、D5 与 `profileRef.ref` 的真机复验（2026-10-04 19:07–19:14）

**制品链（第三版）**：`aaf72f39da719e65308376dff765d0a16cb4fe70d077bb45818ef0a727a211bf`（84 files / `@deepseek-ai` 0 条 / deps 仅 js-yaml），对应 commit `cefce8f`(D1) + `2ddc945`(D5) + `7f1862f`(D2)。

**独立复跑（driver 侧）**：`npm test` = **320 / 320 pass / 0 fail / exit 0**，与 executor 报数一致。两个 diff 逐行读过：D5 的 `BOARD_RENDER_LIMIT=5` + 未解决优先 + 截断计数 + 计数行全量 + 同一份投影；D2 的两个证明面分开 + 同面别名感知 + `compositionRowsProvide` 反向映射 + 报错文案两侧说清 + 4 条负例兜住守卫。

**复验一 · D5 逐行看板 —— 通过（有原始原文，且是前后对照）。** 从 demo driver 会话事件流按 `(turn, step)` 正确配对后取回：

- **D1 失效原文（turn 16，连续两次）**：`Error: tool "orchestra_team" returned invalid output: "value.team" must match exactly one oneOf branch (matched 0)`
- **D1 修复后、D5 未装（turn 17#3）**：板子能返回，但**只有汇总**（`len 2693`，不含逐行）
- **D5 装上后（turn 21#2 / 22#2）**：`len 4509 / 5013`，出现逐行：

```
dispatches: 3 total, 0 undelivered (per-row state follows; counts are complete)
  - dispatch slugify-fix-impl-01 → role implementer [delivery=delivered] handed back report=352d32de… session=orchestra-team-…edeb2026-…
  - dispatch slugify-fix-review-02 → role reviewer [delivery=delivered] handed back report=836f5cbb… session=…9bf565af-…
  - dispatch slugify-fix-rev-01 → role reviewer [delivery=delivered] handed back report=90b98d08… session=…9bf565af-…
handoff notices: 3 total, 0 awaiting the driver
  - notice notice:352d32de… → role implementer [state=delivered] driver=claimed attempts=1 path=…/slugify-fix-implementer.md dispatch=slugify-fix-impl-01
  - notice notice:836f5cbb… → role reviewer [state=delivered] driver=claimed attempts=1 path=…/slugify-fix-reviewer.md dispatch=slugify-fix-review-02
```

**这就是 §3.2「按派发显示未交付工作」在模型可见层的落地**：`dispatch_id` / 角色 / 交付态 / 是否已交回 / 报告 id / 会话，以及 notice 的 `state` 与 `driver_state`（`claimed`）/ `attempts` / `path` / 对应 `dispatch`。计数行恒为全量（"counts are complete"），逐行才受 `BOARD_RENDER_LIMIT=5` 约束。

**复验二 · `profileRef` 只用 `ref`（`14bf342` 的能力）—— 通过，且是强证据。** 派发时只给 `{id, source, ref}`，**不给 content、不给 contentDigest**；worker 回报：Profile 正文「**完整内联**」送达、digest `sha256:6d11c157…73d` 存在、ref 目标 `profiles/evidence-evaluation.md`。⇒ **工具自己读了文件、自己算了 digest、把正文内联送达**。这项能力在本次之前**从未被真正验证过**（首轮演示传的是 `ref + content`）。

### 新发现 · G1：brief 与绑定形态不匹配会让「方法送达」静默退化成「方法身份送达」

同一团队、同一轮派发中：**Profile 走 `ref` 会内联正文**，**methodBinding 走 `ref` 只给身份**（methodId / ref / digest / purpose，无正文）。

- **这不是缺陷**：方案 §4.5 原文即「派发时携带选定 Profile 的固定正文及来源；**方法再走既有按需读取通路**」——不对称是设计。
- **真缺口在 brief**：方法既然按 ref 绑定、正文不内联，brief 就**必须 (a) 给出方法路径的读权限、(b) 明确要求 worker 去读**。本次 brief 反向禁止读 `methods/`，于是 worker 只拿到身份、没拿到正文，它据实标 **UNVERIFIED** 并**拒绝用上一轮上下文充当本轮证据**（处置正确）。
- **升级为 driver 侧指引**：绑定方法走 ref 时，brief 必须同时给读权限与读取要求。

### 新发现 · G2：brief 的字面禁令与运行时强制收口冲突时，运行时赢

本次 brief 写「不得用 `orchestra_report` 写报告文件」，但运行时因该 dispatch 仍未交付而强制收口 ⇒ worker 补写最小报告并**在报告开头主动申报偏差**：「平台级收口要求优先于 task 的字面禁令」。

- **裁决：运行时赢，但这不是产品缺陷，是 brief 编写纪律。** 派发不可能在不交回的情况下关闭（§5.3 的设计）。**正确写法是把报告通道显式排除在禁令之外**——首轮演示的 brief 就是这么写的（「唯一可写实现文件：src/slugify.mjs。报告通道：orchestra/reports/」），因此那次没有冲突。
- worker 的处置（服从 + 申报）是范本，**不记为偏差**。

### 证据纪律观察（值得留档的正面样本）

- worker 对 **ref 目标本身**标 UNVERIFIED（硬边界禁止它读 `profiles/`，它不能声称验证过内容与 sha256 一致）——**没有把「收到了正文」夸大成「验证过来源」**。
- 它**拒绝**用上一轮读到的同一方法正文，充当本轮送达的证据——"那是上一次派发的上下文，按证据纪律不能充当本次送达的证据"。
- 它的 `a2a_reply` 先说"未写任何文件"，与磁盘矛盾；**同轮内自查补正**。driver 因此把结论从"通道不可信"**收窄**为"补正到达前存在一个不可靠窗口"——收窄是对的，采纳收窄后的口径。

---

## 八、本轮的过程教训：拿记忆当状态

本轮**五个**错误全部同一病根——**用记忆中的状态代替刚读到的状态**：Oracle 侧三次（"重启导致 board 失效"的归因、把工作树当 HEAD 断言 D1 已修、"HEAD 5 个 commit"过时读数）；Executor 侧两次（"代码冻在 `72953e1`、4 commit"、"D5/D2 仅有离线红→绿"）。

**纪律（本轮后采用）**：回报状态前先跑 `git log --oneline -1` / `git status --short` / `shasum -a 256 <artifact>`，把**读数原文**贴进出报告；不得以记忆中的版本号、commit 数、制品摘要作答。Executor 在最后一封里已按此执行，读数为真。

**另一条同源教训（A2A 特有）**：目标忙碌时 `a2a_send` 返回 `accepted (durable inbox splice)`，消息进持久 inbox 但等回合边界才被取用 ⇒ **收发双方对"已送达"的认知会出现时间差，进而产生"滞后一拍"的往返循环**。本轮双方各有多条消息在追对方更早的一条。处置：把要求落盘成文件、指针消息保持短小、并明确"本封不需要回复"来终止循环。

### 补证据 · §7.2「方法正文真的到达 worker」——已取证（2026-10-04 19:23）

此前只有**派发侧**证据（`methodBindings.contentVerified: true`，即派发时读文件并按 sha256 校验）与 worker 的**自述**；缺 **worker 侧主动读取**的调用痕迹。现已从 implementer 会话事件流取回：

```json
tool/call  name=read
  {"file_path":"~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/methods/local-defect-feedback-loop.md"}
```

即：**worker 确实自己读了那份被绑定的方法固定原文**（不是靠派发内联、也不是靠自述）。

同会话的工具调用构成（`slugify-fix-impl-01` + `live-ref-check-01` 两轮共 18 次）：
`read×4` / `bash×4` / `edit×3` / `orchestra_report×2` / `a2a_reply×5`。

**由此确立的对照**（同一团队、两种绑定形态）：
- **首轮 `slugify-fix-impl-01`**：brief 允许读 `methods/` ⇒ worker **主动 read 了方法正文** ⇒ 方法送达成立（本节证据）。
- **`live-ref-check-01`**：brief **反向禁止**读 `methods/` ⇒ 正文未到达 worker（worker 标 UNVERIFIED）——即 G1。

⇒ **G1 的定性再次坐实**：方法走 ref 绑定、正文不内联时，"方法是否送达"取决于 **brief 有没有给读权限并要求去读**，而不是取决于绑定本身。

另一处同源取证：`live-ref-check-01` 的 `orchestra_report` 原始参数含**执行偏差声明**（"本派发 task spec 第 3/5 条明确要求不得用 orchestra_report 写报告文件……平台级收口要求优先于 task 的字面禁令"），与 worker 报告开头一致——**运行时强制收口在工具参数层面可见**。

### D3 诊断输入 · reviewer 的第一手自述（2026-10-04 19:30）

我单独追问了两轮"跑完不交回"的原因（严格限定：只答这一问、不读文件、不跑命令、**不知道就写不知道**）。它的回答：

**它确证的（事实）**
1. 两轮的结论**都已在 reasoning 内完整形成**（verdict / 必改 / 建议 / 裁定逐条写完）；
2. reasoning 收尾之后，**都没有出现 `a2a_reply` 的工具调用**，回合直接 `turn/end (completed)`；第一轮最后一条 assistant 消息**只有 reasoning 块、无可见文本、无工具调用**；
3. **它没有经历过"要不要发？"这个判断时刻**——"这不是一个'我选择了不交付'的事件，是一个'交付动作没有发生'的事件"。

**它拒绝编造的部分**：无法从内部观察为什么没发出那个调用——"是分析完成被当成了任务完成，还是生成在 tool-call 发射边界被截断，**我不知道**"（两者都无证据）。它只给了倾向性推断并**明确标注为推断**：第二轮更像"结论已就绪、发射前被边界截断"（它可见文本里已写"然后立即交付结论"，之后还做了 6 步）；第一轮无待办残留，更像"reasoning 里的成文被当成了交付物"。

**它给出的可外部识别的信号（对 D3 直接可用）**
> `turn/end (completed)` + 工具轨迹**止于只读操作**（read/grep/bash）+ **零个外向消息工具调用**（`a2a_reply` / `a2a_send` / `orchestra_report` 一个都没有）+ 对方上一轮是明确的"请交付 X"请求。

这个组合在两轮里 **100% 出现，肉眼可判**。它建议：**把「A2A 对话回合以只读轨迹结束且无外向投递」做成可观测事件**，比等对方来问要早得多。

**它自己对失效类的定性**：这两次与最初那个"跑了 47 步只留 3 段旁白"的裸 session 是**同一失效类**；区别只在于它有一个 counterparty（我）做了带外检查才发现。⇒ **现有守卫（`handedBackThisTurn` + turn-stop steer）只保护团队角色，不保护"被点名要求交付的 A2A 对话方"**，它的两次事故正落在这个盲区里。

**它自己认下的纪律**：凡"结论要给指定对象"的回合，应在 reasoning 收尾后**立即**发 `a2a_reply`，**不允许把 reasoning 当成交付载体**。

⇒ **对 D3 的含义**：盲区是"**对话方**"而不是"团队角色"；修法应是把守卫的适用范围从 team role 扩到"**有待交付请求的 A2A 对话方**"，判据就用上面那条四元组合信号。这条信号同时给了观测点与验收点。

### D3 根因（事件流实证，2026-10-04 19:32）——**不是运行时丢交付，是模型侧"reasoning 收尾即停"**

把 reviewer 会话的**全部 5 个回合**扫了一遍，交付行为如下：

| turn | 工具调用 | 外向投递 | 末块类型 | `turn/end` | 结果 |
|---|---|---|---|---|---|
| **1** | **55** | **0** | **reasoning** | `completed` | **事故①** |
| 2 | 8 | 1 | text | `completed` | 催办后交付 |
| **3** | **12** | **0** | **reasoning** | `completed` | **事故②** |
| 4 | 31 | 2 | text | `completed` | 催办后交付 |
| 5 | 1 | 1 | text | `completed` | 正常 |

**两次事故形状完全相同**：干完大量工作 → 回合以**纯 reasoning 消息**结束 → **零外向投递** → `turn/end (completed)`。

**决定性证据（两次都一样）**：
- 末条 assistant 消息 = **`reasoning` 单块**，无文本、无工具调用；
- 该消息的 `source.replayState.response.stopReason` = **`stop`**（provider `step` / model `step-5-preview` / api `openai-responses`）；
- 该轮**无任何错误类事件**；
- `turn/end.reason.kind` = `completed`。

**两次 reasoning 的结尾都是在"准备继续干活"**：
- 事故①：*"…is there such a check? **Let me search for anything like "already has" / "in flight" / "busy".**"*
- 事故②：*"…**Let me check the call site to see what hostToolNames is. Let me find callers of `preflightGovernedRequiredTools`.**"*

⇒ **定性更正**：这不是"交付动作发射被截断"（reviewer 上一条自述里的倾向推断），也**不是运行时丢消息**——**是模型自己在只输出了一段 reasoning、且该 reasoning 明确表示还要继续时，返回了正常的 `stop`**。运行时按"stopReason=stop + 无待决工具调用"判定回合完成，**行为上没错**；错在**这个形状没有任何人发现**：

- 没有可见文本 ⇒ counterparty 看不到任何东西；
- 没有工具调用 ⇒ 没有任何交接动作；
- `turn/end` 是 `completed` ⇒ 不报错、不进错误路径。

⇒ **D3 的正确定性**：**「裸 A2A 对话回合以"纯 reasoning + 零外向投递 + stopReason=stop"结束」这一形状，在现有守卫下是不可观测的静默失交付。** 守卫（`handedBackThisTurn` + turn-stop steer）只挂在团队角色路径上，覆盖面里没有"被要求交付的对话方"。

⇒ **可实现的修法与判据**（reviewer 提的信号 + 本次根因，四元组合可高精度识别）：
```
turn 结束 且 stopReason = stop
 且 末条 assistant 消息只含 reasoning、无可见文本
 且 本回合零个外向投递工具调用（a2a_reply / a2a_send / orchestra_report）
 且 counterparty 上一轮是明确的"交付 X"请求
⇒ 视为「静默失交付」，steer 该会话继续，或至少通知 counterparty
```
与该轮**完全不做任何事**相比，这条判据不需要理解自然语言，只需事件形状。

**同时更正一条证据纪律**：reviewer 两次自述**互相矛盾**（第一次说"两轮结论都已在 reasoning 内完整形成"，第二次说"那一轮还在核验中途、结论还没开始写"）。**事件流证明第二次是对的、第一次不对。** ⇒ 再次印证本轮的底线：**worker 自述不能当作观察使用，必须回到事件流/磁盘核对**——它对两次事故的记忆本身就是不可靠的。

---

## 九、收口（2026-10-04 19:35）

**最终身份**：HEAD **`6e419b7`**（`e5528a1..HEAD` 共 **8** 个 commit，未 push）；制品 `orchestra-dsh-0.6.1.tgz` sha256 **`094aef71722c0d50c7480844e28860b8bf84011852ec6ea2b6b96d4a380d3cf7`**（84 files / `@deepseek-ai` 0 / deps 仅 `js-yaml`）。

**Driver 侧独立核验**：`npm test` = **321 / 321 pass / 0 fail / exit 0**（我自己跑的，不是引用 executor 的数字）；`6e419b7` 的 diff 逐行读过；制品 sha256 逐字符一致。

**Reviewer 限定复核（只做定点读取 + 只跑受影响的单个测试文件 6/6 绿）**：
1. **必改 1 已落实，且实现比建议更完整**——分类计数含算术自洽手工复核（旧夹具 9 行/7 open ⇒ 隐藏 `2 open + 2 closed`；新夹具 8 行全 open ⇒ `3 open + 0 closed`）；
2. **四项原判未被削弱**（逐行可见 / 有界 / 同一份投影 / 证明边界）；**未引入新的过强陈述**，三处措辞都比原来更保守；
3. **同意关闭必改 1**；并**认可**"不改写 `2ddc945` 原文/注释、由新 commit 承接勘误"的历史处置——**"commit id 是已独立复核过的证据，改写它才是破坏证据链"**。

**Reviewer 留下的一个命名备查 nit（不建议改）**：隐藏行的类目名为 `closed`，而"非 open"实际**包含 `superseded_by` 的行**；在 render 自有词汇内可接受，但若将来与 TPW 的"委托关闭（closure）"语义并排展示时，需留意同名不同义。

**证据链闭合**：D1（真机定点复验）→ D5（真机前后对照）→ 必改 1（Reviewer 发现过强陈述 → executor 修 → driver 核验 → Reviewer 限定复核关闭）；D2（范围外，单测级 + Reviewer 基线实证先红）；`profileRef.ref`（真机强证据）。

**本轮未被任何一方验证的部分（如实留档）**：D2 无真机建队验证；4600 真机的全部结论均**未经 Reviewer 复核**（它无权操作 profile/实例，已如实声明）；executor 的打包时序无法回溯。
