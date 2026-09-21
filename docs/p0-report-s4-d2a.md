# P0 · S4 第一手信号 + D2-a「永不询问」全路径钉死（repair 第 2 轮）

> **作者**：repair（第 2 任，只按 driver 方案实现）。
> **任务书**：`docs/plan-0.8.0-execution.md` §1 的 **S4 行**与 **D2 行**、**§4.8 的 D2-a / D2-c**、§11 G-P0 的 ③ 行；宿主前提表 = `docs/review-rounds-ledger.md` §27（裁定 AA/AB/AC + S4 表）。
> **实现 commit**：`856a13c`（`src/` 3 个文件 + 2 个测试脚本 + 1 个新判据脚本 + 本报告；`git show --stat` 可核，工作树干净）。
> **锚点纪律**：全部用 **commit + 符号**；宿主类型行号已漂过一次（`agent/turn-stopping` 的计划 `:396-400` 实测在 `runtime-types.d.ts:387-395`），故不引行号。
> **本轮边界（如实声明）**：未起 4600 / 未碰 4599 / 未做任何活体；未写两个 fixture（只读运行）；未改 ADR / 计划 / 契约 / 台账；未向 Owner 提问。

---

## ① 结论（一句话，可判真假）

**`agent/status` 的 running→idle 推断已整段删除，停摆兜底改走两条宿主第一手信号（ awaited `agent/turn-stopping` + `approval/asked`/`approval/decided` 审计对），`approval: "never"` 现在钉在 `buildRoleSession` 这一个入口的全部四条建/恢复路径上（含 lightweight 与裸 resume），并且 `scripts/verify-d2-approval.mjs` 能在**真实悬挂日志**上报出 `dangling 1`、在已钉 `never` 的日志上报 `hanging 0 dangling 0`。**

可复跑的三条判真假：

| 判项 | 命令 | 实际 |
|---|---|---|
| 停摆兜底换信号 | `node --test scripts/test-node-stall.mjs` | **12/12 pass**，三条 S4 断言逐条在；三条变异各自让对应断言失败 |
| 全路径钉死 | `node --test scripts/test-role-session-single-path.mjs` | **4/4 pass**，四条路径各恰好一条 `approval/policy: never` |
| ③ 判据脚本 | `node scripts/verify-d2-approval.mjs --self-test` | **exit 1** 且报 `dangling_approval`；真实悬挂日志 **exit 1**、`dangling 1` |

---

## ② 证据

### 2.1 闸门

```
$ npm run typecheck   → EXIT=0
$ npm run build       → EXIT=0
$ npm test
# tests 279
# pass 279
# fail 0
EXIT=0
```

**基线**：272 → **279**（+7 新增：`test-node-stall.mjs` +6、`test-role-session-single-path.mjs` +1）。既有 272 项零失败。`test-node-stall.mjs` 是**增补**而非删旧（原 5 条健康投影用例仍在，删它们会让基线掉数 = 回归）；文件头已写清这个分工。

### 2.2 S4｜删推断 + 两条第一手信号

**符号**（commit 见文末）：

| 项 | 符号 | 改动 |
|---|---|---|
| 删除 | `src/orchestra.ts` 的 `ctx.on("agent/status", …)` 段（原 `runningRoles` + running→idle 推断 + `stalledRoleNotice` 投递） | **整段删除**，全仓不再有该监听 |
| 新增 | `src/orchestra.ts` 的 `createRoleTurnGuard(options)` / `roleTurnStallPrompt()` / `handedBackThisTurn()` / `HANDOFF_TOOL_NAMES` / `PendingApprovalFact` | 一个可测的 guard：两条信号、一张悬空表、一组按回合去重的 steer |
| 接线 | `src/orchestra.ts` 的 `apply()` | `ctx.on("agent/turn-stopping", …)` 订阅；`ctx.on("session/event", …)` 增加对 `approval/asked` / `approval/decided` 的分派（**同一个监听**，保持它"两次属性读就返回"的预算） |
| 通知链 | `notifyDriverMilestone` + `noticeRecorderFor`（既有） | 悬空审批的通知走既有三级降级链：投递 → 失败则记 `noticeFailures` → 再失败才 warn。**未新增 team.json 字段**（裁定 O 纪律） |

**两条信号的分工**（互不替代）：`turn-stopping` 管"回合空手关闭"（steer 续一步）；approval 看门狗管"问了没人答"（该回合即使交了报告也照报，因为停摆的审批不会因为一份报告而变无害）。

**去重的必要性**（宿主契约原文）：`agent/turn-stopping` 的注释写明 "a listener that objects steers (`agent.steer(...)`) and the machine re-reads its inbox: fresh steering runs another step" ⇒ steer 之后**同一 turn** 会再跑一步、边界再触发一次。所以键必须是 `session#turn`，且在 steer **之前**入表。

**"既未交报告、也未交回 driver"的实现口径**：按 `tool/call` 事件的 **`data.turn`** 判（宿主给每个 tool/call 打了 turn 号），而不是扫最后一个 `turn/start`。回合 N 里出现过 `orchestra_report` / `orchestra_send` / `a2a_reply` / `a2a_send` 即算交回。上一回合交过不算——`S4 1b` 用例钉住这一点。

### 2.3 S4 三条断言（`node --test scripts/test-node-stall.mjs`）

```
ok 1 - nodeStall answers ok, stalled, and unknown from the facts it is given
ok 2 - a Loop's declared stallGraceMs reaches the verdict instead of sitting in the schema
ok 3 - the health projection derives stall and Attempt timing for one role
ok 4 - openAttemptFor matches on the Attempt's own role, and stamps a deadline on every Loop row
ok 5 - nodeIsWorking counts a running turn and parked inbox work, but not a cold node
ok 6 - a notice failure is recorded on the Team, never as an invented graph node
ok 7 - S4 1: a role closing its turn empty is steered once for that turn, and once only
ok 8 - S4 1b: handedBackThisTurn reads the turn stamp, not a scan for the last turn/start
ok 9 - S4 2: an approval question is held until its own decided arrives
ok 10 - S4 2b: a dangling approval is reported to the driver at the turn boundary
ok 11 - S4 2c: an undeliverable dangling-approval notice lands durably on the Team
ok 12 - S4 3: the plugin subscribes to agent/turn-stopping and to no agent/status listener
# tests 12 / pass 12 / fail 0
EXIT=0
```

断言 ③ 是**运行时 + 源码双层**：用最小 ctx 驱动真实 `apply()`，读回它订阅的事件名（实测 `["session/event","agent/turn-stopping","internal/service"]`，**无 `agent/status`**），再加源码级断言（`ctx.on("agent/status"` 零命中、`runningRoles` 零命中）。

### 2.4 S4 三条变异证明（各让对应断言失败）

**变异 1｜去掉按回合去重**（`steeredTurns.add(key)` → `void key`）：

```
$ node --test scripts/test-node-stall.mjs
not ok 7 - S4 1: a role closing its turn empty is steered once for that turn, and once only
  error: |-
    the same turn must not be steered twice — the host reruns a step after a steer, which re-enters this boundary with the same turn number
    2 !== 1
# tests 12 / pass 11 / fail 1
```

**变异 2｜不销账**（`approval/decided` 不再 `pending.delete(key)`）：

```
$ node --test scripts/test-node-stall.mjs
not ok 9 - S4 2: an approval question is held until its own decided arrives
  error: |-
    its own answer closes it — `unavailable` is an answer too, and it ends the turn
    + actual - expected
    + [
    +   {
# tests 12 / pass 11 / fail 1
```

**变异 3｜把 `agent/status` 监听加回来**：

```
$ node --test scripts/test-node-stall.mjs
not ok 12 - S4 3: the plugin subscribes to agent/turn-stopping and to no agent/status listener
  error: |-
    no listener infers liveness from agent/status
    1 !== 0
# tests 12 / pass 11 / fail 1
```

三个变异都在 `src/orchestra.ts` 上做、`npm run build` 后跑单文件，**已全部还原**（还原后 279/279）。

### 2.5 D2-a｜"永不询问"钉到唯一入口

**落点**：`src/a2a.ts` 的 `buildRoleSession`（S1a 的统一入口）与 `createSession`（它委托的真实创建），共用 `src/session-blueprint.ts` 新导出的 `pinApprovalNever()` / `effectiveApprovalPolicy()`。

- **create 路径**：`createSession` 里把该分支算出的 `setup` **包一层**（`pinnedSetup`），先跑原 setup 再钉策略。三条 create 分支（governed / lightweight / 纯 preset）因此全覆盖。
- **resume 路径**：`buildRoleSession` 的 `kind:"resume"` 臂把调用方的 `setup` **组合**进来（不替换），再钉。裸 resume（无 setup）也钉。
- **幂等**：`pinApprovalNever` 先按宿主的折叠规则读最后一个 `approval/policy`，已是 `never` 就不写 ⇒ governed 路径不会出现两条相同事件（实测：`["never"]` 恰好一条）。
- **失败要响**：会话在 setup 期取不到 ⇒ 抛 `SessionBlueprintError("approval_pin_unavailable")`。**不静默跳过**——"建会话路径没钉"正是 D2 的成因（部署把 `workspace-write` 的 approval 配成 `ask`，无人值守时问了没人答，回合永不结束）。
- **解析面加宽**：`pinApprovalNever` 除了 `sessionFrom`（prepared agent → scoped sessions → owner ctx）还兜底 `ctx.sessions` / `ctx.agents`。理由写进注释：这条钉子是另两条没有 Blueprint 的路径第一次碰会话注册表，一个只发布 `ctx.sessions` 而不发布 `sessions` 服务的组合不该变成"没钉的角色"。（**这是被测试逼出来的**：`test-add-lanes.mjs` 的 double 正是那个形状。）

**证据**（`node --test scripts/test-role-session-single-path.mjs`，双覆盖四条路径 + governed 不重复钉）：

```
ok 1 - S1: buildRoleSession routes each spec shape to the engine primitive it declares
ok 2 - S1 (now-form): the three role-session paths call buildRoleSession, and orchestra.ts owns no resume
ok 3 - S1: the S2 boundary is stated, not silently assumed
ok 4 - D2-a: every build path pins approval to never, and the governed path pins it once
# tests 4 / pass 4 / fail 0
```

**D2-a 变异证明**（把传入记录层的行 id 截断一类的老套路换成本轮机制：让 `pinApprovalNever` 变成 no-op）：

```
$ # MUTATION: pinApprovalNever returns before setApprovalPolicy
$ node --test scripts/test-role-session-single-path.mjs
not ok 4 - D2-a: every build path pins approval to never, and the governed path pins it once
# tests 4 / pass 3 / fail 1
```

（已还原。）

### 2.6 ③ `scripts/verify-d2-approval.mjs`

**输入 = 会话日志目录（可多个）+ 期望 approval 值**（计划 §4.8 的输入形态）；`--self-test` 自带合成日志，不依赖任何 fixture 与实例。

**判据**（§4.8 D2-a 步 3/4 + D2-c 步 1/3）：
1. 每条 `approval/asked` 必有同 `id` 的 `approval/decided`，且在**同一个 `turn/start`…`turn/end` 区间**内；
2. `outcome ∈ {allowed-once, rejected, cancelled, unavailable}`——**不断言 `never` 必为 `rejected`**（宿主的 `signal?.aborted` 判断在策略判断之前，预中止时是 `cancelled`）；
3. 含该 ask 的回合**存在 `turn/end`** 且**在 `decided` 之后**；
4. 汇总行 `# sessions N ok K missing M hanging H dangling D problems P`；**exit 0 = 全通过，1 = 有悬挂 / 不成对 / outcome 越界 / 策略不符，2 = 用法或日志读不出**；
5. `--self-test`：先证明"已钉 + 已配对"的基线绿，再删掉一条 `decided` ⇒ 必须报 `dangling_approval` 且**非 0**；什么都检不出 ⇒ **2**（不是 0）。

**(a) `--self-test`（自足，无外部输入）**：

```
$ node scripts/verify-d2-approval.mjs --self-test
# self-test: baseline log /tmp/verify-d2-approval-oxyOf7/session-calibration-paired
APPROVAL_OK    /tmp/verify-d2-approval-oxyOf7/session-calibration-paired hanging 0 dangling 0
# self-test: perturbed log /tmp/verify-d2-approval-oxyOf7/session-calibration-unpaired (one approval/decided removed)
          dangling_approval: ask-calibration for tool bash was asked at seq 5 in turn 1 and never decided
# self-test dangling=detected
EXIT=1
```

**(b) 真实悬挂日志（只读，driver 点名的那条）**：

```
$ ls -d ~/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_N7--/orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f
/Users/yuantian/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_N7--/orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f
$ stat -f "%Sm  %z bytes" <上>/session.v3.jsonl.zstd
Sep 21 19:30:37 2026  103858 bytes
$ node scripts/verify-d2-approval.mjs --session <上>
APPROVAL_MISSING <上> hanging 0 dangling 1
          dangling_approval: 09ecc459-0155-476b-9910-5d64016869c7 for tool bash was asked at seq 64 in turn 1 and never decided
          approval policy is "ask", expected "never"
# sessions 1 ok 0 missing 1 hanging 0 dangling 1 problems 2
EXIT=1
```

⚠️ **与 brief 的一处实测差异（如实记）**：brief 写"整个会话无 `turn/end`（进程被杀）"，但当前日志是 **71 事件**、`turn/start@6` / `turn/end@69{kind:"interrupted"}` / `session/end-seed@70` ⇒ `hanging 0`、`dangling 1`。**driver 要的"退出码非 0 + 汇总行给出非零的 hanging/dangling"由 `dangling 1` 满足**；真实数据在 brief 之后又被追加过（§23 记的是 67 事件）。这条日志同时证明策略检查不是装饰：它的 `approval/policy@2` 是 **`ask`**（当年没钉死的实证）。

**(c) 已钉 `never` 的合成日志（主模式）⇒ 0**：

```
$ node scripts/verify-d2-approval.mjs --session /tmp/d2a-logs/pinned-paired
APPROVAL_OK    /tmp/d2a-logs/pinned-paired hanging 0 dangling 0
# sessions 1 ok 1 missing 0 hanging 0 dangling 0 problems 0
EXIT=0
```

（合成日志由 `/tmp/d2a-logs/build.mjs` 生成：真实 session header + `zstd` 压缩，与宿主解码路径同一条。）

**另外三条自定对照**（证明各断言非恒真，全部原始输出）：

```
--- outcome 越界（"denied"）---
APPROVAL_MISSING /tmp/d2a-logs/pinned-bad-outcome hanging 0 dangling 0
          dangling_approval: ask-paired carries outcome "denied", which is not one of allowed-once, rejected, cancelled, unavailable
# sessions 1 ok 0 missing 1 hanging 0 dangling 0 problems 1
EXIT=1

--- 回合永不关闭（删掉 turn/end）---
APPROVAL_MISSING /tmp/d2a-logs/pinned-hanging hanging 1 dangling 0
          turn 1 opened at seq 2 and never closed
# sessions 1 ok 0 missing 1 hanging 1 dangling 0 problems 1
EXIT=1

--- ask 与 decided 跨回合 ---
APPROVAL_MISSING /tmp/d2a-logs/pinned-cross-turn hanging 0 dangling 0
          dangling_approval: ask-cross was asked in turn 1 but decided in turn 2
# sessions 1 ok 0 missing 1 hanging 0 dangling 0 problems 1
EXIT=1
```

### 2.7 判据脚本自身的两条变异证明

**变异 A｜不成对不再计数**（`if (answer === undefined)` 直接 `continue`）：

```
--- 未变异：--self-test ---
          dangling_approval: ask-calibration for tool bash was asked at seq 5 in turn 1 and never decided
# self-test dangling=detected
EXIT=1
--- 变异后：--self-test ⇒ 用例失败 ---
# self-test: baseline log … APPROVAL_OK … hanging 0 dangling 0
# self-test: perturbed log … (one approval/decided removed)
# self-test dangling=NOT-DETECTED
EXIT=2
```

**变异 B｜不校验 outcome 词表**：

```
--- 未变异：pinned-bad-outcome ---
          dangling_approval: ask-paired carries outcome "denied", which is not one of allowed-once, rejected, cancelled, unavailable
EXIT=1
--- 变异后 ⇒ 用例失败 ---
APPROVAL_OK    /tmp/d2a-logs/pinned-bad-outcome hanging 0 dangling 0
# sessions 1 ok 1 missing 0 hanging 0 dangling 0 problems 0
EXIT=0
```

（变异副本在 `/private/tmp/d2a-mut/`，仓库树未受影响。）

---

## ③ 未做 · 未验证（如实列举）

| 项 | 状态 |
|---|---|
| **G-P0 ③ 未判绿** | **不得声称已绿**。③ 的真绿要在**真实实例**上按三条路径各建一次会话（首波 / 懒加载 / 重激活）后判定：本轮**未起 4600、未建任何会话**，所以只有"判据仪器就绪 + 真实反例被抓到 + 合成正例通过"。③ 的 landing = live 轮。 |
| **D2-a 步 2（派一个必然触发沙箱写入的动作）** | **未做**（需要活体：驱动角色真的去写仓库外文件）。本轮只做到"策略已钉"（静态 + 单测）。 |
| **D2-a 步 5 反例校准**（把某条路径改回 `ask` 重跑 ⇒ `turn/end` 不出现） | **未做**：需要活体。仪器侧已具备（`hanging` 计数正是抓这个的）。 |
| **D2-b** | **延后**（landing = 批 2 / G-P2），本轮不判、未碰。 |
| **D2-c 步骤 2**（读节点记录留 `approvalFacts[]`） | **延后**（裁定 AA：`orchestra/nodes/<node-id>.json` 是 P2-2 批 2 产物，`grep -rn "orchestra/nodes\|nodeRecord\|approvalFacts" src/` 零命中 ⇒ 批 1 不可满足）。本轮交付 D2-c = 步骤 1 + 步骤 3（脚本的配对/outcome/turn 断言 + `--self-test` 删一条 `decided`）。 |
| **S4 的 steer 是否真的让宿主续一步** | **未在活体验证**（单测只证明"我们调了一次 `agent.steer`"）。宿主契约（`runtime-types.d.ts` 的 `agent/turn-stopping` 注释）写明 steer 会令机器重读 inbox 再跑一步，但**本插件没有实测过**。landing = live 轮。 |
| **`turn-stopping` 在真实 agent scope 上的过滤/串行行为** | **未实测**（单测用结构相同的假 payload）。 |
| **R-5（F-D1-5）/ R-6** | **未做**（R-5 landing = 批 2；R-6 的修正实验配方见台账 §27 裁定 AC，landing = 下一次 live 轮）。 |
| **`~/.dsh/` 与两个 fixture 的写入** | **本轮零写入**：E2E fixture `shasum -a 256` = `5b8efdf9fcf5179a8ac6a55c8e8086bf1aebf5190ba2fa4b646a30a7abe2749a`（与台账 §23 记录一致）、mtime `Sep 19 15:18:47`；N7 fixture mtime `Sep 21 04:21:02`（本轮之前）。**但如实登记一件观察**：本轮进行期间，`~/.dsh/orchestra/catalog-presets/` 下**全部 12 个** `agent.cordis.yml` 的 mtime 变成 `Sep 21 20:25:29`，`orchestra_N7b` 下三个文件 mtime 为 `20:10`–`20:24`。**不是本轮改动所致**：完整 `npm test` 前后对 `~/.dsh/orchestra` + N7b 全量 `find -exec stat` 比对**零变化**，裸 `apply()` 也不改 mtime，且 reviewer 预设内容仍解析出 **11 行**。归因未定（怀疑是并行的 driver 独立复跑会话）。 |
| **合成日志的位置** | 写在 `/tmp`（`scratchBase()` 刻意避开 `TMPDIR`——本环境 `TMPDIR` 指向 `~/.dsh/tmp`，那会在被禁写的状态树里落文件）。 |

---

## ④ 下一跳建议（driver 定夺）

1. **live 轮（test runner）**：新 fixture create → 懒加载物化 → 重启 → 唤醒，**三条路径各建一次**后跑 ③：`verify-d2-approval.mjs --session <三个会话目录>` 期望 `hanging 0 dangling 0` + `--self-test` 期望 1。这一趟同时取 D2-a 步 2/5 与 S4 的 steer 实证。
2. **D2-c 步骤 2 与 R-6** 分别落在批 2（P2-2 节点记录落地后）与下一次 live 轮（marker 修正配方，台账 §27 裁定 AC）。
3. **一个可登记候选**：`verify-d2-approval.mjs` 的负例校准是**自足**的（自带合成日志），但"真实悬挂日志"这条对照依赖盘上历史会话；若要 durable 化，形态 = 把 `/tmp/d2a-logs/build.mjs` 收成 `scripts/test-verify-d2-approval.mjs`（自带夹具 + `zstd` 压缩）。**fault_ref** = 本报告 §2.6；**landing = 下次改动该脚本时**。

---

## ⑤ 文件级改动清单

| 文件 | 改动 | 属哪条 |
|---|---|---|
| `src/orchestra.ts` | ① 删 `ctx.on("agent/status", …)` 整段 ② 新增 `createRoleTurnGuard` / `roleTurnStallPrompt` / `handedBackThisTurn` / `HANDOFF_TOOL_NAMES` / `PendingApprovalFact` / `TurnStoppingLike` / `RoleTurnGuardOptions` ③ `apply()` 接线 `agent/turn-stopping` + `session/event` 的审批分派 + 通知走 `notifyDriverMilestone`/`noticeRecorderFor` | S4 |
| `src/a2a.ts` | ① `createSession` 用 `pinnedSetup` 包住分支 setup ② `buildRoleSession` 的 resume 臂把 pin 组合进调用方 setup | D2-a |
| `src/session-blueprint.ts` | 新增 `effectiveApprovalPolicy` / `pinApprovalNever` / `liveSessionOf`（私有）+ `BlueprintErrorCode` 增 `approval_pin_unavailable` | D2-a |
| `scripts/test-node-stall.mjs` | 保留原 5 条，新增 3 条 S4 断言（+2 条辅助：`handedBackThisTurn` 的 turn 语义、看门狗通知与 durable 记账） | S4 判据 |
| `scripts/test-role-session-single-path.mjs` | 新增 `publishingContext()` + 1 条 D2-a 用例（四条路径各恰好一条 `never`；governed 不重复；caller setup 不被替换） | D2-a 判据 |
| `scripts/verify-d2-approval.mjs` | **新文件**：③ 的判定脚本（配对 / outcome 词表 / 回合闭合 / 策略 / 汇总行 / `--self-test` 自带合成日志） | ③ |
| `docs/p0-report-s4-d2a.md` | 本报告 | — |

**未改**：两个 fixture、`~/.dsh/`、ADR / 计划 / 契约 / 台账、4599 / 4600、`package.json`（无新依赖）。

---

**报告完毕，原样回 driver。** 本地 commit，未推送（等 Owner）。
