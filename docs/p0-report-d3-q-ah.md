# P0 · 批 1 收尾三件：D3（先停后记）+ 裁定 Q（留痕指向被抛弃的会话）+ 裁定 AH（`pinnedApproval`）

> **作者**：repair（第 3 任，只按 driver 方案实现）。
> **任务书**：`docs/review-rounds-ledger.md` §29（测试文件夹纪律）+ §30（裁定 AG/AH/AI）+ `docs/plan-0.8.0-execution.md` §1 的 **D3 行**、§4.6 N6、§4.7；裁定 Q 原文 = `docs/p0-report-materialization-failure-fix.md` §5。
> **实现 commit**：`<见本节末尾 git log>`。
> **锚点纪律**：全部用 **commit + 符号**，不用行号。
> **本轮边界（如实声明）**：**不产生任何 fixture**（§29 纪律：测试一律落在 `orchestra_E2E/` 或其子目录，本轮三项全是进程内单测，无 fixture 需求）；未起 4600 / 未碰 4599 / 未做任何活体；未改 ADR / 计划 / 契约 / 台账；未向 Owner 提问。

---

## ① 结论（一句话，可判真假）

**归档事务已重排为 cancel → notify → 落快照 → 写 archived marker（终态旧队同序），重入归档会再发一次退休通知并返回 `already_archived`；物化失败的留痕现在指向被抛弃的那个会话（并落在 Team 的 `noticeFailures` 上 —— 原先写在 role 上、被 `normalizeTeam` 丢掉，那条断言因此是空转的）；记录层新增 `pinnedApproval` 声明每条路径钉成的策略，且不覆盖权限预设的声明值。**

可复跑的四条判真假：

| 判项 | 命令 | 实际 |
|---|---|---|
| D3 三用例 | `node --test scripts/test-orchestra-archive.mjs` | **exit 0**，14/14，三条 D3 用例逐条在 |
| 裁定 Q | `node --test scripts/test-materialization-failure-history.mjs` | **exit 0**，4/4，breadcrumb 指向 provider 生成的 child id |
| 裁定 AH | `node --test scripts/test-role-session-single-path.mjs` | **exit 0**，5/5，记录同时带 `approval:"ask"` 与 `pinnedApproval:"never"` |
| 基线 | `npm test` | **284 pass / 0 fail**（279 基线 + 5 新增，既有项零失败） |

---

## ② 证据

### 2.1 闸门

```
$ npm run typecheck   → EXIT=0
$ npm run build       → EXIT=0
$ npm test
# tests 284
# pass 284
# fail 0
EXIT=0
```

**基线**：279 → **284**（+3 D3、+1 裁定 Q、+1 裁定 AH）。既有 279 项零失败、零断言改动。

### 2.2 D3｜归档事务重排 + 重入 + 终态

**符号**（commit 见文末）：

| 项 | 符号 | 改动 |
|---|---|---|
| 事务重排 | `src/orchestra.ts` 的 `dismissGovernedTeam` | 顺序由「快照 → marker → notify+cancel」改为 **cancel → notify → 落快照 → 写 marker**；CAS 失败的报错文案同步（"roles were already retired… re-run to complete it"） |
| 抽出共用步 | `src/orchestra.ts` 的 `retireTeamRoles(ctx, controller, roles, cwd)`（新，私有） | 先 `cancel({kind:"hook"}, {keepInbox:false})`，再 `deliverMessage(wake:false)` 投退休通知；子代理走 `releaseSubagentNodeDefault` |
| 重入归档 | `src/orchestra.ts` 的 `dismissAlreadyArchived(...)`（新，私有） | 状态文件已是 archived marker ⇒ 不再落第二份快照；从 archive 列表取最新一份快照拿 roles，**再发一次退休通知**，返回 `status: "already_archived"` |
| 终态旧队 | `src/orchestra.ts` 的 `handleTeamCommandInvocation` 的 `isTerminal` 分支 | **先** `retireTeamRoles` **再** `archiveStore.create` + `activeTeamState.archive`（原来直接清活跃状态，一声不响） |
| 通知文案 | `src/orchestra.ts` 的 `roleRetirementNotice()`（新，导出） | 退休通知**不再带 archive id/path** —— 通知发在快照之前，那一刻还不存在 archive 身份；id 是给 driver 的记账，工具返回值与 `orchestra_team` 的 archive 列表都有 |
| 工具面 | `src/orchestra.ts` 的 `orchestra_dismiss` | description 按新顺序改写；output schema 增 `status: {enum:["dismissed","already_archived"]}`（**不加就会被 `additionalProperties:false` 打回** —— D4 那类事故的同一形态）；render 分支 |
| 幂等 | — | cancel 对非运行态 agent 是宿主 no-op；快照 `createIfAbsent` + collision 失败响亮；marker 是 CAS。**刻意不给通知加 idempotency key**：按 archive 身份去重会把重入那次通知一起消掉，而 driver 要求重入仍要发 |

**判据 + 对照 + 防恒真**（`node --test scripts/test-orchestra-archive.mjs`，exit 0）：

```
ok 12 - D3 1: dismissing twice notifies both times and the second call reports already_archived
ok 13 - D3 2: a terminal team's roles are told before the active slot is cleared
ok 14 - D3 3: after the marker lands, orchestra_team reports no team and lists the archive
# tests 14 / pass 14 / fail 0
```

三条用例各自带对照：①断言 `cancel` 先于 `notice`、`notice` 先于**最后一次** state 写（marker），且第二次调用 `status === "already_archived"`、archive 目录仍只有 1 份；②断言 notice 先于 marker 写（用 `lastIndexOf` 取 marker 那次写，不是 seed 那次）；③驱动**真实** `orchestra_team` handler，断言 `team === null` 且 `archives[0].archive_id` 命中。

**变异证明**（每条新断言各一次）：

**变异 1｜终态路径改成"先清活跃状态、后通知"** ⇒ 用例②失败：

```
$ node --test scripts/test-orchestra-archive.mjs
not ok 13 - D3 2: a terminal team's roles are told before the active slot is cleared
  error: "a terminal team's roles are told before the active slot is cleared"
  expected: true
  actual: false
# tests 14 / pass 13 / fail 1
```

**变异 2｜重入归档不再发通知** ⇒ 用例①失败：

```
$ node --test scripts/test-orchestra-archive.mjs
not ok 12 - D3 1: dismissing twice notifies both times and the second call reports already_archived
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
    + []
    - [
    -   'notice:session-reviewer'
    - ]
# tests 14 / pass 13 / fail 1
```

（两次变异均已还原，还原后 14/14。）

### 2.3 裁定 Q｜留痕指向被抛弃的会话

**顺带抓到的既有缺陷（不是本轮引入，driver 应知道）**：那条 breadcrumb 原本写在 **role 对象**上（`...r, noticeFailures: [...]`），而 `TeamRole` 没有这个字段 ⇒ `normalizeTeam` 在下一次 read 时就把它丢掉 ⇒ **留痕从来没有落上盘**。原有测试里对应那段是 `for (const entry of after.noticeFailures ?? [])`，数组恒空 ⇒ **循环体一次都没执行**（空转断言）。本轮把 breadcrumb 移到 **Team 级** `noticeFailures`（与 `noticeRecorderFor` 同一处、`orchestra_team` 同一出口），Q 才真的可判。

**符号**：`src/orchestra.ts` 的 `materializeRole` —— `let createdSessionId: string | undefined` 提升到外层 try 之前；subagent 分支记 `receipt.childId`，session 分支记 `created.sessionId`；catch 里 `const abandonedSessionId = createdSessionId ?? role.sessionId`，**探活与留痕都用它**。

**判据 + 对照 + 防恒真**（`node --test scripts/test-materialization-failure-history.mjs`，exit 0）：

```
ok 4 - 裁定 Q: the abandoned-attempt breadcrumb names the session the attempt created
# tests 4 / pass 4 / fail 0
```

用例构造的是**两个 id 真的会分叉**的形状：`subagent` 角色，`startContinuable` 返回 provider 自己的 child id（`native-child-9f8e7d6c` ≠ 预留 seat id），随后发布那次 state 写失败 ⇒ 落进 catch。断言 `targetSessionId === childId` 且 `!== RESERVED_SESSION`。**对照组**：child 未注册为 live agent 时 `noticeFailures` 为空（探活为假，不写）。

**变异证明（把留痕改回 `r.sessionId`）** ⇒ 用例失败：

```
$ node --test scripts/test-materialization-failure-history.mjs
not ok 4 - 裁定 Q: the abandoned-attempt breadcrumb names the session the attempt created
  error: |-
    the abandoned attempt is recorded once
    0 !== 1
# tests 4 / pass 3 / fail 1
```

（已还原，还原后 4/4。）

### 2.4 裁定 AH｜`pinnedApproval`

**符号**：`src/orchestra-state.ts` 的 `TeamRoleBlueprintFacts` 增 `pinnedApproval?: string`；`src/session-blueprint.ts` 新增导出常量 `PINNED_APPROVAL = "never"`（**钉子的写入值与记录的声明值同一个常量**，二者不可能漂移）；`src/orchestra.ts` 的 `roleBlueprintFacts` 写入 `pinnedApproval: PINNED_APPROVAL`，**`approval: receipt.approval` 一字未动**。

**判据 + 对照 + 防恒真**（`node --test scripts/test-role-session-single-path.mjs`，exit 0）：

```
ok 5 - 裁定 AH: a reserved record declares the pinned approval without overwriting the preset's declared value
# tests 5 / pass 5 / fail 0
```

对照项：`permissionPresets` 的 fake 声明 `approval: "ask"` ⇒ 记录里 **两个字段同时在、且值不同**（`approval:"ask"` / `pinnedApproval:"never"`）⇒ 证明不是把一个字段复制成另一个。同一条用例再驱动四条路径各自建会话，断言日志里恰好一条 `approval/policy: "never"` ⇒ 声明不是装饰。

**变异证明（去掉 `pinnedApproval`）** ⇒ 用例失败：

```
$ node --test scripts/test-role-session-single-path.mjs
not ok 5 - 裁定 AH: a reserved record declares the pinned approval without overwriting the preset's declared value
  error: |-
    the record declares what the plugin pins
    + actual - expected
    + undefined
    - 'never'
# tests 5 / pass 4 / fail 1
```

（已还原，还原后 5/5。）

### 2.5 善后（§29 硬要求）

本轮**不产生 fixture**（三项全是进程内单测），因此无需清理；仍按纪律贴证据：

```
$ ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/orchestra/state/
total 0
drwxr-xr-x@ 2 yuantian  staff  64 Sep 22 00:36 .
drwxr-xr-x@ 7 yuantian  staff  224 Sep 19 04:26 ..
$ ls -d ~/Documents/agentWorkspace/artifacts/projects/orchestra_N7* 2>/dev/null || echo "(none — nothing to clean up)"
(none — nothing to clean up)
```

**`npm test` 前后对 `~/.dsh/orchestra` + `~/.dsh/sessions` + `orchestra_E2E` 的全量 `find -exec stat` 比对**（各 911 个文件）：

```
$ diff <before> <after> && echo "NO CHANGE ..."
NO CHANGE to ~/.dsh/{orchestra,sessions} or orchestra_E2E across a full npm test
```

**实例**：4600 `000`（未运行，本轮未起）；4599 `401`（在跑、未被登录使用，与 §27/§30 的取证口径一致）。**未向 4599 发过任何业务请求。**

---

## ③ 未做 · 未验证（如实列举）

| 项 | 状态 |
|---|---|
| **⑨ `test-tier0-predicate.mjs`** | **未做**，裁定 AI：档 0 谓词在 `src/` 零命中，其约束对象（节点记录 / 摄入 / 胶囊 / 租约）全是批 2/3 产物 ⇒ 此刻建脚本四条断言恒真（弱 fixture 假绿）。**landing = 批 2 / G-P2**。 |
| **G-BUDGET** | **未做**，裁定 AI：判据是对真实节点生命周期的测量，缺 P2-2 节点记录与 E2/E3 决策记录 ⇒ 测不出来。**landing = P2-2 + E2/E3 落地之后，最迟 G-P2/G-P4**；`verify-agent-budget.mjs` 随之创建。 |
| **D2-b** | **未做**（延后，landing = 批 2 / G-P2）。 |
| **D2-c 步骤 2**（节点记录留 `approvalFacts[]`） | **未做**，裁定 AA：`orchestra/nodes/<node-id>.json` 是 P2-2 产物，批 1 不可满足。 |
| **D2-a 步骤 3 / 步骤 5** | **未做**：步骤 3（`asked`/`decided` 成对）在新鲜数据上没被喂到（上一轮 live 的 `approval/asked = 0`，写入被 read-only 沙箱挡下）；步骤 5（把一条路径改回 `ask` 跑反例校准）要临时改产品码。**landing = 下一轮 live**（与 S4 steer 实证、R-6 修正配方合成一趟）。 |
| **S4 steer 实证**（steer 是否真让宿主续一步） | **未做**（需活体）。landing = 同上那一趟 live。 |
| **R-6 修正配方** | **未做**（裁定 AC 给的配方：marker 必须逐字段过 `parseGovernedBlueprint` + 阳性对照 + 基线）。landing = 同上那一趟 live。 |
| **R-5（F-D1-5）** | **未做**（候选缺陷，landing = 批 2 或下次动 a2a 时）。 |
| **D3 的活体验证** | **未做**：三条 D3 用例全是进程内单测（驱动真实 `dismissGovernedTeam` / `handleTeamCommandInvocation` / `orchestra_team` handler + 假 ctx）。"重入归档在真实工作区上再发一次通知"没有在活体验证。 |
| **原有一条空转断言（既有，未改）** | `scripts/test-materialization-failure-history.mjs` 用例 1 里 `for (const entry of after.noticeFailures ?? [])` 那段：breadcrumb 落在 role 上被丢 ⇒ 数组恒空 ⇒ 循环体从不执行。本轮已把 breadcrumb 移到 Team 级（新用例 4 覆盖了真实落盘），但**既有那段断言按"不改既有断言"的要求原样保留**，仍是空转。建议 driver 下一轮把它改成非空转（或删掉循环、由用例 4 承担）。 |
| **通知文案少了 archive id** | 如实登记：退休通知不再带 `archive_id=`/`path=`（重排的必然结果，通知发在快照之前）。若 driver 认为角色需要知道 archive 身份，那是**下一轮的一条显式决策**，不是本轮自选。 |

---

## ④ 下一跳建议（driver 定夺）

1. **live 轮（test runner）**，四小项一次取完、每项只跑一次：**D2-a 步骤 3**（明确要求角色带 `sandbox_permissions` 重试写入 ⇒ 预期即时 `rejected` + 成对 + 正常 `turn/end`）、**步骤 5**（把一条路径临时改回 `ask` 跑反例校准 ⇒ `turn/end` 不出现）、**S4 steer 实证**、**R-6 修正配方**（marker 逐字段过形状校验 + 阳性对照 + 基线）。落点 = `orchestra_E2E/test-a/`（§29 纪律 1），跑完**文件级清理**并贴终态 `ls`（纪律 2）。
2. 之后出**批 1 交付报告**（判据 ①②③⑤⑥⑦⑧ 各自命中 + ④/⑨/G-BUDGET 三项显式延后各带 landing）。
3. **两条可登记候选**：① 上面那条空转断言；② `verify-d2-approval.mjs` 的 durable 化（形态 = 把合成日志夹具收成 `scripts/test-verify-d2-approval.mjs`）。`fault_ref` 均为本报告 §③。

---

## ⑤ 文件级改动清单

| 文件 | 改动 | 属哪条 |
|---|---|---|
| `src/orchestra.ts` | ① `dismissGovernedTeam` 重排为 cancel → notify → 快照 → marker ② 新增 `retireTeamRoles` / `dismissAlreadyArchived` / `roleRetirementNotice` ③ `DismissGovernedTeamResult.status` 增 `"already_archived"` ④ `orchestra_dismiss` 的 description / output schema / render ⑤ `handleTeamCommandInvocation` 终态分支先通知后清 ⑥ `materializeRole` 提升 `createdSessionId`、breadcrumb 移 Team 级并指向它 ⑦ `roleBlueprintFacts` 写 `pinnedApproval` | D3 + Q + AH |
| `src/orchestra-state.ts` | `TeamRoleBlueprintFacts` 增 `pinnedApproval?: string`（含语义注释） | AH |
| `src/session-blueprint.ts` | 新增导出 `PINNED_APPROVAL = "never"`，`pinApprovalNever` 改用它 | AH |
| `scripts/test-orchestra-archive.mjs` | 新增 `dismissHarness`（共享 fs + 记录型 agent registry）+ 3 条 D3 用例；`TemporaryArchiveFs` 增加有序 events（既有测试不读它，零影响） | ⑥ |
| `scripts/test-materialization-failure-history.mjs` | 新增 `subagentDivergenceHarness` / `failPublishWrite` + 1 条裁定 Q 用例 | Q |
| `scripts/test-role-session-single-path.mjs` | 新增 `memoryFs` + 1 条裁定 AH 用例；`publishingContext` 的 tools 列表加宽（既有用例不受影响） | AH |
| `docs/p0-report-d3-q-ah.md` | 本报告 | — |

**未改**：两个 fixture、`~/.dsh/`、ADR / 计划 / 契约 / 台账、4599 / 4600、`package.json`（无新依赖）、任何既有断言。

---

**报告完毕，原样回 driver。** 本地 commit，未推送（等 Owner）。
