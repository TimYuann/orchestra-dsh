# P0 · D1「预期组合」记录线修复（repair 第 1 任）

> **作者**：repair（第 1 任，只按 driver 方案实现）。
> **任务书**：`docs/review-rounds-ledger.md` §24 裁定 W / X / Y；施工图 `docs/p0-analysis-d1-composition-record.md` §5.1 / §5.2 / §5.4 / §8（R-1…R-7）。
> **实现 commit**：`861aef7`（代码 + 测试；`git show --stat` 可核，工作树干净）。
> **锚点纪律**：全部用 **commit + 符号**；行号只作辅助。
> **本轮边界（如实声明）**：产品语义只变了 R-2 的**一个可选字段**；未起 4600 / 未做任何活体；未写任何 fixture 与 `~/.dsh/`（三个新测试把 DSH home 重定向到 `mkdtemp`  Scratch 目录）；未改 ADR / 计划 / 契约 / 台账 / 两个 fixture；未向 Owner 提问。`/tmp` 与 `/private/tmp` 下只写了 team.json 副本与脚本变异副本（可弃）。

---

## ① 结论（一句话，可判真假）

**`compositionRowIds` 现在在预留时被写进 team 记录，`verify-role-identity.mjs` 的 cross-check 从"恒不触发"变成"可真失败"，且 `--self-test` 有了记录侧扰动 + 未检出返回 exit 2 —— 判据 ① 在旧记录（N7）上由"假绿 exit 0"转为"诚实红 exit 1"（失败行 `recorded composition is absent`），在带行 id 的新记录上为 exit 0。**

可复跑的三条判真假：

| 判项 | 命令 | 实际 |
|---|---|---|
| 旧记录不再假绿 | `node scripts/verify-role-identity.mjs --repo <N7> --team <N7>/orchestra/state/team.json` | **exit 1**，失败行 `recorded composition is absent` |
| 新记录形态可绿 | 同一会话 + `/tmp` 副本填 11 条行 id | **exit 0** |
| 校准不会假绿 | blindspot 副本 + `--self-test` | **exit 2**、`detected=NO` |

---

## ② 证据

### 2.1 闸门（脚本类产物判定前已先 build；`npm test` 自身也先 build）

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.client.json
EXIT=0

$ npm run build
> tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsdown
EXIT=0

$ npm test | grep -E "^# (tests|pass|fail)"
# tests 272
# pass 272
# fail 0
EXIT=0
```

**基线**：269 → **272**（+3 新增用例：`test-governed-provisioning.mjs` 的 "a reserved role records the EXPECTED composition row ids, and no observed tool facts"、`test-add-lanes.mjs` 的 "an added lane records the composition row ids resolved at reservation"、`test-orchestra-state.mjs` 的 "a reserved blueprint's recorded composition row ids survive normalization and a store round trip"）。**既有 269 项零改动、零失败**（用例名与断言逐条未动，diff 只有 import 行与追加块）。

### 2.2 R-2｜记录里补行 id 集（符号 + 判据）

**符号**（commit `861aef7`）：

| 层 | 符号 | 改动 |
|---|---|---|
| 记录层类型 | `src/orchestra-state.ts` 的 `TeamRoleBlueprintFacts` | 加**一个**可选字段 `compositionRowIds?: string[]`（含语义注释：预留时解析、可选因为旧记录没有、**不是**工具名集） |
| 计划层 | `src/orchestra.ts` 的 `GovernedRolePlan` | 加 `compositionRowIds?: string[]`（driver 选型：不让 `roleBlueprintFacts` 直接收 `presetFile`，解析层类型不 leak 进记录层） |
| 解析→计划 | `src/orchestra.ts` 的 `prepareGovernedRolePlan` | `...(presetFile.compositionRowIds === undefined ? {} : { compositionRowIds: presetFile.compositionRowIds })` —— 值来自 `resolvePresetFile`（`:433` → `resolveRolePresetFile` 的 `composition.rowIds`），**不重新解析、不编造、不用工具名冒充** |
| 计划→记录 | `src/orchestra.ts` 的 `roleBlueprintFacts` / `reservedRole` | `roleBlueprintFacts(receipt, plan.compositionRowIds)`，receipt 存在时 spread 进去 |
| 首波同一字段集 | `src/orchestra.ts` 的 `provisionGovernedPlans`（`roleBlueprintFacts(blueprint.receipt, plan.compositionRowIds)`） | 首波那条不可达路径也带同一字段，避免两条路径字段集漂移 |

**判据 + 对照 + 防恒真**：

```
$ node --test scripts/test-governed-provisioning.mjs
ok 20 - a reserved role records the EXPECTED composition row ids, and no observed tool facts
# tests 20 / pass 20 / fail 0
```

该用例的**对照项**是"独立解析一次同一预设"（`resolveRolePresetFile(runtime.context, cwd, "orchestra-v04-reviewer-v1", root)`），记录值必须与它 `deepEqual`；并断言长度 **= 11**（driver 给定值）。

**变异证明（R-2）** —— 让 `prepareGovernedRolePlan` 在传下去之前丢掉一条：

```
$ # MUTATION: compositionRowIds: presetFile.compositionRowIds.slice(0, -1)
$ node --test scripts/test-governed-provisioning.mjs scripts/test-add-lanes.mjs
not ok 4  - an added lane records the composition row ids resolved at reservation
not ok 24 - a reserved role records the EXPECTED composition row ids, and no observed tool facts
# tests 24 / pass 22 / fail 2
```

（已还原：`git status --porcelain` 空，`npm test` 回到 272/272。）

### 2.3 R-1 + R-4｜判据脚本的自检与 cross-check（按裁定 X）

**符号**：`scripts/verify-role-identity.mjs` 的 `main()` 里 (a) `--self-test` 分支、(b) 记录侧 cross-check 块、(c) docstring 的 exit-code 行。

| 裁定 X | 落地 |
|---|---|
| ① 检出 ⇒ exit 1 | 未变（G-P0 ② 的期望码不动） |
| ② **未检出 ⇒ exit 2** | `if (!substitutionDetected) return 2;` —— 不再是 `return detected ? 1 : 0` |
| ③ 加记录侧扰动 | 内存里 `recordedRows.slice(0, -1)`，要求 cross-check 命中（`recorded composition has N-1 row(s)…`）；**任一已施加的扰动未命中 ⇒ exit 2**（`if (recordPerturbation !== undefined && !recordDetected) return 2;`） |
| ④ 有 blueprint 缺 `compositionRowIds` ⇒ 记为问题 | `problems.push("recorded composition is absent")`（不再只印一行尾巴） |
| ⑤ docstring 同步 | "0 = every role verified; 1 = a role failed, or the calibration detected what it injected; 2 = usage / precondition unreadable / **the calibration detected nothing**" |

**检测按扰动各自的信号判，不按"这次跑挂了没有"判**：替换的信号是 `NOT_A_ROLE_SESSION…` 或 `the session log names no preset…`；记录侧扰动只认**被扰动后的那个行数**（`remainingRows`），所以"记录本来就不对"不会被误当成校准命中。输出因此多一行：

```
# self-test substitution=detected|NOT-DETECTED record-side=detected|NOT-DETECTED|not-applicable
# self-test detected=yes|NO
```

**判据 ②（N7 fixture，exit 1 = 诚实红，不是回归）**：

```
$ node scripts/verify-role-identity.mjs --repo ~/Documents/agentWorkspace/artifacts/projects/orchestra_N7 --team ~/Documents/agentWorkspace/artifacts/projects/orchestra_N7/orchestra/state/team.json
IDENTITY_MISSING reviewer orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f preset=orchestra-v04-reviewer-v1 rows=11 tools=11
          recorded composition is absent
# roles 1 ok 0 missing 1
EXIT=1
```

**判据 ③（同上 + `--self-test`）**：

```
$ node scripts/verify-role-identity.mjs --repo <N7> --team <N7>/orchestra/state/team.json --self-test
# self-test: role "reviewer" sessionId orchestra-team-33be3b56-… -> session-4289d06b-dc9c-4c7b-9659-e2a2b8b0c8d3 (a real, non-role session)
# self-test: role "reviewer" has no recorded compositionRowIds to perturb
IDENTITY_MISSING reviewer session-4289d06b-… preset=standard rows=32 tools=32
          NOT_A_ROLE_SESSION: the session log names preset standard, the role records orchestra-v04-reviewer-v1
          recorded composition is absent
# roles 1 ok 0 missing 1
# self-test substitution=detected record-side=not-applicable
# self-test detected=yes
EXIT=1
```

**判据 ④（§5.4 blindspot 副本，只改角色 `blueprint.agentPreset` 使替换不可判别）**：

```
$ node scripts/verify-role-identity.mjs --repo <N7> --team /tmp/d1-repair/team-blindspot.json --self-test
# self-test: role "reviewer" sessionId orchestra-team-33be3b56-… -> session-4289d06b-… (a real, non-role session)
# self-test: role "reviewer" has no recorded compositionRowIds to perturb
IDENTITY_MISSING reviewer session-4289d06b-… preset=standard rows=32 tools=32
          recorded composition is absent
# roles 1 ok 0 missing 1
# self-test substitution=NOT-DETECTED record-side=not-applicable
# self-test detected=NO
EXIT=2
```

**判据 ⑤（§5.2 表 A 三形态，同一会话、同一 roster）**：

```
--- correct（11 条，与名册一致）---
IDENTITY_OK    reviewer orchestra-team-33be3b56-… preset=orchestra-v04-reviewer-v1 rows=11 tools=11
# roles 1 ok 1 missing 0
EXIT=0

--- stale（10 条）---
IDENTITY_MISSING reviewer … preset=orchestra-v04-reviewer-v1 rows=11 tools=11
          recorded composition has 10 row(s), the resolved preset declares 11
# roles 1 ok 0 missing 1
EXIT=1

--- empty（0 条）---
IDENTITY_MISSING reviewer … preset=orchestra-v04-reviewer-v1 rows=11 tools=11
          recorded composition has 0 row(s), the resolved preset declares 11
# roles 1 ok 0 missing 1
EXIT=1
```

`stale` 的失败行**逐字**含 `recorded composition has 10 row(s), the resolved preset declares 11` ✓。

**记录侧扰动真的会命中（correct 副本 + `--self-test`）**：

```
# self-test: role "reviewer" recorded composition 11 -> 10 row(s) (one row dropped in memory)
IDENTITY_MISSING reviewer session-4289d06b-… preset=standard rows=32 tools=32
          NOT_A_ROLE_SESSION: the session log names preset standard, the role records orchestra-v04-reviewer-v1
          recorded composition has 10 row(s), the resolved preset declares 32
# roles 1 ok 0 missing 1
# self-test substitution=detected record-side=detected
# self-test detected=yes
EXIT=1
```

### 2.4 变异证明（每条新机制各一次，均贴原始输出）

**变异 1｜把未检出的 exit 2 改回 0** ⇒ blindspot 用例必须失败：

```
$ # MUTATION 1: if (!substitutionDetected) return 0;
$ node <mutant>/verify-role-identity.mjs --repo <N7> --team /tmp/d1-repair/team-blindspot.json --self-test
# roles 1 ok 0 missing 1
# self-test substitution=NOT-DETECTED record-side=not-applicable
# self-test detected=NO
EXIT=0          ← 未检出却返回 0：与"干净通过"无法区分（修前正是这个形态）
$ # 对照：N7 原 team.json 仍是 EXIT=1（变异只影响未检出分支）
```

**变异 2｜去掉记录侧扰动** ⇒ 对应用例必须失败（`/tmp/d1-repair/team-quotient.json`：记录 33 行，扰动后 32 行恰好等于被替换会话那份预设的 32 行 ⇒ 扰动**不可观测**，是唯一能抓住"扰动被去掉"的输入）：

```
$ # 未变异：
# self-test: role "reviewer" recorded composition 33 -> 32 row(s) (one row dropped in memory)
# self-test substitution=detected record-side=NOT-DETECTED
# self-test detected=yes
EXIT=2
$ # MUTATION 2: if (false && recordedRows !== undefined && recordedRows.length > 0) { …
$ node <mutant>/verify-role-identity.mjs --repo <N7> --team /tmp/d1-repair/team-quotient.json --self-test
# self-test: role "reviewer" has no recorded compositionRowIds to perturb
IDENTITY_MISSING reviewer session-4289d06b-… preset=standard rows=32 tools=32
          NOT_A_ROLE_SESSION: the session log names preset standard, the role records orchestra-v04-reviewer-v1
          recorded composition has 33 row(s), the resolved preset declares 32
# roles 1 ok 0 missing 1
# self-test substitution=detected record-side=not-applicable
# self-test detected=yes
EXIT=1          ← 记录侧不再被校验，退化成一个永远"检出了"的自检
```

**变异 3｜去掉 `recorded composition is absent`** ⇒ 判据 ② 必须失败（这条不是 driver 点名要的，是 ② 自身的防恒真）：

```
$ # MUTATION 3: if (false) { problems.push("recorded composition is absent"); }
$ node <mutant>/verify-role-identity.mjs --repo <N7> --team <N7>/orchestra/state/team.json
IDENTITY_OK    reviewer orchestra-team-33be3b56-… preset=orchestra-v04-reviewer-v1 rows=11 tools=11 (no recorded composition to cross-check)
# roles 1 ok 1 missing 0
EXIT=0          ← 旧记录重新变回假绿
```

**变异 4｜把 readiness 改成填预期值** ⇒ R-3 用例必须失败（driver 点名）：

```
$ # MUTATION 4: readiness.names = visibleToolNames(ctx); compositionReadiness/orchestraReadiness 同理
$ node --test scripts/test-governed-provisioning.mjs
not ok 20 - a reserved role records the EXPECTED composition row ids, and no observed tool facts
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected
      {
    +   count: 1,
    +   names: [
    +     'tool-fs'
    +     ]
    -   count: 0,
    -   names: []
      }
# tests 20 / pass 19 / fail 1
```

（四个变异全部已还原；还原后 `git status --porcelain` 空、`npm test` 272/272。）

### 2.5 R-3｜防恒真单测 + 两处注释

- **新用例**（`test-governed-provisioning.mjs`，与 R-2 同一条）：断言预留快照的三个 readiness 恒为 `{names: [], count: 0}`，并把"填预期值必须让它失败"写成变异 4（见 2.4）。
- **注释 1**（`src/orchestra.ts` 的 `materializeRole` 成功分支）："The Blueprint record is deliberately NOT refreshed here… `{...r, phase:"active"}` is that decision, not an omission — do not 'fix' it by writing the receipt's readiness objects back."
- **注释 2**（`src/session-blueprint.ts` 的 `prepareGovernedBlueprint` body、三个 readiness 声明处）："They are UNAVAILABLE at reservation time… They must stay empty rather than be filled with the predicted/expected values: an expected value presented as an observed one is a fabricated fact (capability-boundaries #4)."

---

## ③ 未做 · 未验证（如实列举）

| 项 | 状态 |
|---|---|
| **D1 ③ 的"工具名集"半边** | **本轮未兑现**（裁定 Y 明示）。理由：`compositionTools` / `orchestraTools` / `tools` 三个 readiness **只在 setup 窗口内可观测**（`visibleToolNames(agentCtx)`），而三条 provisioning 路径里两条（懒加载 / 重激活）根本没有 setup 窗口；在预留时填它们 = 用预期冒充实际（`capability-boundaries.md` #4）。**landing = R-7 / D2**（D2 给三条路径补 blueprint 之后，由 `test-role-blueprint-single-prepare.mjs` 的 tripwire 提示那一刻）。本轮只把"预留时不可得"写进注释 + 单测。 |
| **G-P0 ① 在旧记录上现在 exit 1** | **这是期望结果，不是回归**（裁定 X ⑤）。N7 / E2E 两个 fixture 的记录都没有 `compositionRowIds`（写在字段存在之前）⇒ ① 由"假绿"转为"诚实红"。**① 只有在修复后新物化的 fixture 上才可能真的绿 ⇒ 属 live 轮。** |
| **R-5（F-D1-5，activate 替换分支按文件挂载）** | **未做**（裁定 W：OUT）。已登记为**候选缺陷**，`fault_ref` = analyzer 报告 §4.4 + 符号 `orchestra_activate` step 5c / `createSession` 的 `overrideFile` 无条件展开；**landing = 批 2 或下次动 a2a 时**。理由：从未在 fixture 上观测到、且改共享点会牵连 lightweight 路径，属无 `fault_ref` 的范围增长。 |
| **R-6（marker 读侧的 live 判定）** | **未做**（裁定 W：OUT → live 轮）。`ctx.get("fs")` 在 a2a 插件 ctx 上的运行期结果仍未判定； analyzer §2.5 的实验（新 workspace 手写 marker + `a2a_send`）**没有跑**。 |
| **R-7（D1 ③ 三路径一致性）** | **未做**（裁定 W：OUT → D2 之后）。`test-role-blueprint-single-prepare.mjs` 的 tripwire 仍断言"今天只有 1 处 `governedBlueprint:`"，本轮未动它。 |
| **任何活体验证** | **完全未做**：未起 4600、未驱动任何会话、未跑跨重启、未新建 fixture。本轮全部结论来自单测 + 对 N7 fixture 的**只读**运行 + `/tmp` 副本。 |
| **端到端（记录带行 id → 重启 → 唤醒）** | **未判定**。R-2 只证明"预留时记录带行 id"（进程内）；新 fixture 上 `orchestra_dispatch` 物化后记录是否仍带、以及重启后 cross-check 是否绿，**只能由 live 轮判**。 |
| **E / F / G 三类 cross-check 分支**（名册解析不了 / BROKEN / 0 行 preset） | **未构造输入**：需要专用 fixture 会话或改 `~/.dsh`（越界）。 |
| **`~/.dsh/` 与两个 fixture 字节级未改动** | 已核：三个新测试把 `DSH_HOME` 指向 `mkdtemp` Scratch 目录并在 `finally` 还原；N7 `team.json` 只被读。 |
| **E2E fixture 当前不在盘上** | 只找到 N7（`~/Documents/agentWorkspace/artifacts/projects/orchestra_N7`）与一份已归档 marker（`~/Documents/agentWorkspace/orchestra/state/team.json`，`archived: true`、无 `roles[]`）⇒  analyzer 报告里 E2E 那组对照**本轮无法复跑**，未复跑。 |
| **4600 仍是 v0.5.1 旧构建** | 未 pack、未同步 profile（Owner 决定：押到"这一波"做完之后）⇒ 本轮改动**没有任何运行期实例在跑**。 |

---

## ④ 下一跳建议（driver 定夺）

1. **live 轮（一趟取两边）**：新 fixture（`orchestra_N7b/`）create → `orchestra_dispatch` 懒加载物化 → 外部核 `verify-role-identity.mjs`（**期望 exit 0**，因为记录现在带 11 条行 id）→ 重启 dev(4600) → 唤醒（段 B）→ **同一趟做 R-6**（marker 读侧判定）。这是 ① 从"诚实红"变"真绿"的唯一路径，也是 R-2 的端到端证明。
2. **R-5 建议裁 (b) 之外的第三条**：driver 若不愿在批 1 动共享点，可在 live 轮**先取证**（重激活一次 roster 预设的角色，看 `mountRolePreset` 走 file 还是 id 分支、`mountedBy` 是什么），把"候选缺陷"升级为"带 fault_ref 的缺陷"或降级为"不可达"，再决定 landing。
3. **D2 之后**：R-7（三条路径 blueprint 字段集一致）+ D1 ③ 的"工具名集"半边（setup 窗口内可观测的那三个 readiness 是否值得在 D2 落成记录字段）。

---

## ⑤ 文件级改动清单（commit `861aef7`）

| 文件 | 改动 | 属哪条 |
|---|---|---|
| `src/orchestra-state.ts` | `TeamRoleBlueprintFacts` 加 `compositionRowIds?: string[]` + 语义注释 | R-2 |
| `src/orchestra.ts` | ① `GovernedRolePlan` 加 `compositionRowIds?: string[]` ② `prepareGovernedRolePlan` 从 `presetFile.compositionRowIds` 带入 ③ `roleBlueprintFacts(receipt, compositionRowIds?)` spread ④ `reservedRole` / `provisionGovernedPlans` 两个调用点传 `plan.compositionRowIds` ⑤ `materializeRole` 成功分支加"不刷新是刻意的"注释 | R-2 + 注释 1 |
| `src/session-blueprint.ts` | 三个 readiness 声明处加"预留时不可得、不得用预期冒充"注释（**零行为改动**） | R-3 + 注释 2 |
| `scripts/verify-role-identity.mjs` | ① `recorded composition is absent` ② `--self-test` 双扰动 + 未检出 exit 2 + docstring exit-code 行同步 | R-1 + R-4 |
| `scripts/test-governed-provisioning.mjs` | 新增 1 用例（行 id 集 = 独立解析值、长度 11、三个 readiness 恒空） | R-2 + R-3 |
| `scripts/test-add-lanes.mjs` | 新增 1 用例（加车道预留记录带 11 条行 id） | R-2 |
| `scripts/test-orchestra-state.mjs` | 新增 1 用例（行 id 集过 `normalizeTeam` 与 store 往返；旧记录无该字段 ⇒ `undefined` 而非 `[]`） | R-2 |

**未改**：`materializeRole` 的 `{...r, phase:"active"}`、`compositionTools` / `orchestraTools` / `tools` 的填充逻辑、两个 fixture、`~/.dsh/`、ADR / 计划 / 契约 / 台账、4599、4600。

---

**报告完毕，原样回 driver。** 实现 commit `861aef7`，本地未推送（等 Owner）。
