# P0 · D1「预期组合」记录线归因与最小落点（analyzer 第 1 任）

> **作者**：analyzer（第 1 任，只读分析）。
> **依据**：`docs/review-rounds-ledger.md` §23 裁定 U / 裁定 V（F-N7-1…F-N7-4）+ `docs/plan-0.8.0-execution.md` §1 D1 行 / §4.7 / §2.2 + `docs/plan-0.8.0-delivery-layer.md` §3-P0 / §2-S1·S3。
> **候选 commit（分析对象）**：`39df903a4e3c262171e9f0e3864854222ec7ef67`（HEAD，docs-only；工作树干净，`git status --porcelain` 空）。
> **本轮边界（如实声明）**：**产品代码零改动**；未起 4600 / 未做任何活体；未改 `orchestra_E2E` / `orchestra_N7` / `~/.dsh/` 下任何文件；未改 ADR / 计划 / 契约 / 台账；未向 Owner 提问。只跑了只读命令、既有测试、以及**写在 `/tmp` 里的 team.json 副本**（Q4 的输入构造，不碰 fixture 本体）。
> **锚点纪律**：全部用 **commit + 符号**；行号只作辅助，会漂。

---

## ① 结论（一句话，可判真假）

**D1 ③「blueprint 记录写预期组合（行 id 集 + 工具名集）」在持久化记录上未兑现，且根因不是"写失败"而是"唯一会写的那段代码在产品里跑不到"**：

1. **`orchestra/blueprints/` 这条 marker 写入链在真实运行里是通的** —— 控制项 `~/Documents/agentWorkspace/orchestra/blueprints/` 有 2 份 v0.5.0 时代的 governed marker 落盘（mtime `Sep 16 19:59`），同一个 `ctx.get("fs")` 在同一目录还写了 `charter/records.json` 与 `state/team.json`。
2. **N7 / E2E / `orchestra-e2e` 三个 fixture 都没有该目录，因为写入从未被调用**：三个 fixture 的**每一个角色会话**都带着"未经 governed setup"的事件签名（read-only 角色的 `sandbox/mode: read-only` 落在 `session/title` **之后**、`approval/policy` 恒为 `ask`），而 marker 只由 `prepareGovernedBlueprint` 的 `setup` 写。
3. **三路径里唯一写 marker 的"首波"路径在产品里不可达**：`provisionGovernedPlans`（`src/orchestra.ts:2412`）在 `src/` 内**只有定义、没有调用点**（调用点全在 `scripts/test-governed-provisioning.mjs`）；本仓自己的 `scripts/test-role-blueprint-single-prepare.mjs` 已把这件事写成**会失败的 tripwire 断言**（`governedBlueprint:` 计数必须 = 1）。
4. **`verify-role-identity.mjs` 的 cross-check 恒不触发有两条独立的恒假守卫**（不止 F-N7-1 记的那条）：`compositionRowIds` 在 `TeamRoleBlueprintFacts` 里**不存在**；且 `orchestraTools` 的真实形状是 `{names,count}` 对象，过不了 `Array.isArray`。**且 `recordedTools` 被读出来后没有任何断言用它**（已用 7 元素错值实测：仍 exit 0）。
5. **行 id 集今天就能派生，且三路径一致**：`resolveRolePresetFile` 对 roster（`dsh`）源**已经返回 `composition.rowIds`**（实测），`resolvePresetFile` 已经把它映射成 `compositionRowIds`，只是**没有线接进 `roleBlueprintFacts`**。
6. **另外查出两条 B 类缺陷**（不在 F-N7-1…4 里）：(a) `--self-test` 在**替换未被检出时返回 exit 0**，与"必须 exit 1"的期望码相反（实测复现）；(b) `orchestra_activate` 的**替换分支**（step 5c）把 `presetFile` 直接传给 `buildRoleSession`，`createSession` 的共享预设分支会无条件把它变成 `overrideFile` ⇒ roster 预设在**重激活替换路径上仍按文件挂载**，正是 `src/role-preset-mount.ts` 文件头声明"已关闭"的那个形状，且 `scripts/test-recovery.mjs` 注入 `createSession` 缝把这条路径遮住了。

---

## ② Q1 记录面：`orchestra/blueprints/<sessionId>.json` 在真实运行里走到哪一步

### 2.1 写入链本身是通的（控制项，先立对照）

`blueprintStoreFor`（`src/session-blueprint.ts:1124`，commit `39df903`）→ `resolveRecordFileSystem(ctx)`（`src/orchestra-records.ts:61`）→ `ctx.get("fs")`；非空且 `cwd` 非空 ⇒ `createFsBlueprintStore(fs, cwd)`（`:1088`）⇒ `writeRecordJson(fs, "<cwd>/orchestra/blueprints/<sessionId>.json", …, {kind:"createIfAbsent"})`。

**真实运行的控制项**（第三个工作区，与两个 fixture 同机、同宿主、同插件）：

```
$ ls -la ~/Documents/agentWorkspace/orchestra/
drwxr-xr-x@ 7 yuantian staff 224 Sep 16 20:16 .
drwxr-xr-x@ 38 yuantian staff 1216 Sep 18 14:04 ..
drwxr-xr-x@ 3 yuantian staff 96 Sep 16 20:16 archive
drwxr-xr-x@ 4 yuantian staff 128 Sep 16 19:59 blueprints
drwxr-xr-x@ 3 yuantian staff 96 Sep 16 19:52 charter
drwxr-xr-x@ 6 yuantian staff 192 Sep 16 20:15 reports
drwxr-xr-x@ 3 yuantian staff 96 Sep 16 20:16 state

$ ls -la ~/Documents/agentWorkspace/orchestra/blueprints/
-rw------- 1 yuantian staff 966 Sep 16 19:59 orchestra-team-4b21c7ee-5ff33ff5-da92-481d-8e6b-46118e87b3de.json
-rw------- 1 yuantian staff 942 Sep 16 19:59 orchestra-team-4b21c7ee-88d613d1-12d2-4720-8826-755cfbb323f8.json
```

marker 原文（节选，证明它只能是 `prepareGovernedBlueprint` 的 `setup` 写的）：

```json
{
  "schemaVersion": 1,
  "mode": "governed",
  "teamId": "team-4b21c7ee",
  "roleId": "implementer",
  "topologyId": "trio",
  "topologySource": "global",
  "agentPreset": "orchestra-implementer",
  "presetSource": "file",
  "presetPath": "~/.dsh/orchestra/catalog-presets/orchestra-implementer/agent.cordis.yml",
  "presetTrust": "system",
  "approval": "ask",
  "sandbox": "workspace-write",
  "cwd": "~/Documents/agentWorkspace",
  "title": "implementer · 在 artifacts/w… · agentWorkspace",
  "compositionTools": ["tool-bash","tool-fs","tool-fs-search"],
  "orchestraTools": ["orchestra_report"],
  "createdAt": 1789559991419
}
```

**这个控制项同时证明三件事**：①`ctx.get("fs")` 在**写侧 ctx** 上取得到（否则不可能落盘）；②marker 落在 `<marker.cwd>/orchestra/blueprints/`，**没有去别处**；③marker **本来就带行 id 集**（`compositionTools` 是行 id 数组）—— 也就是说"预期组合"这个字段在 marker 里从来就有，缺的是 team 记录那一份。

### 2.2 N7：①从未写出 —— 懒加载路径根本没有 blueprint

`materializeRole`（`src/orchestra.ts:2954`）建会话的那一支：

```js
created = await buildRoleSession(ctx, {
  kind: "create",
  sessionId: role.sessionId,
  cwd,
  createdBySessionId: controller.id,
  ...(role.preset === null ? {} : { presetId: role.preset }),
  ...(presetFile !== undefined ? { presetFile } : {}),
  title: roleSessionTitle(...),
  ...
});
```

**没有 `mode`，也没有 `governedBlueprint`** ⇒ `buildRoleSession`（`src/a2a.ts:320`）走 `createSession` 的**共享预设分支**（`src/a2a.ts` 的 `else if (options.presetFile !== undefined || (options.presetId …))`），其 `setup` 只做 `mountRolePreset` + `installModelOverride`，**不写 marker、不 `setApprovalPolicy`、不 `setSandboxMode`**。

N7 reviewer 会话日志（`readStoredEvents` 解出，路径 `~/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_N7--/orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f`）前 6 条：

```
0:permission/preset  1:sandbox/mode=workspace-write  2:approval/policy=ask  3:session/title  4:sandbox/mode=read-only  5:agent/inbox/spliced
```

判定（版本无关）：`prepareGovernedBlueprint` 的 `setup`（`src/session-blueprint.ts:862-905`）顺序是 `permissionService.set` → `setSandboxMode(session, sandbox)` → `setApprovalPolicy(session,"never")` → **然后才** `session.append("session/title")` → **然后才** marker 写。read-only 角色若走过 governed setup，`sandbox/mode: read-only` 必然落在 `session/title` **之前**、且必有 `approval/policy: never`。实测两者都不成立；seq 4 的 `sandbox/mode: read-only` 正是 `materializeRole` 的 belt-and-braces（`if (role.sandbox === "read-only") session.append("sandbox/mode", …)`），seq 3 的 `session/title` 正是 `createSession` 的 title 块。

fixture 磁盘（F-N7-3 的复核，我实测）：

```
$ find ~/Documents/agentWorkspace/artifacts/projects/orchestra_N7/orchestra -maxdepth 2
…/orchestra_N7/orchestra
…/orchestra_N7/orchestra/state
…/orchestra_N7/orchestra/state/team.json
…/orchestra_N7/orchestra/charter
…/orchestra_N7/orchestra/charter/records.json
```

### 2.3 E2E：①从未写出 —— 六个角色一个都没走过 governed setup

同一判据跑在 E2E 全部 active 角色上（`team-f01da153`）：

```
implementer          recordedSandbox= workspace-write | 0:permission/preset  1:sandbox/mode=workspace-write  2:approval/policy=ask  3:session/title  4:agent/inbox/spliced  5:turn/start
reviewer             recordedSandbox= read-only      | 0:permission/preset  1:sandbox/mode=workspace-write  2:approval/policy=ask  3:session/title  4:sandbox/mode=read-only  5:agent/inbox/spliced
difficulty-architect recordedSandbox= read-only      | 0:permission/preset  1:sandbox/mode=workspace-write  2:approval/policy=ask  3:session/title  4:sandbox/mode=read-only  5:agent/inbox/spliced
difficulty-implementer recordedSandbox= workspace-write | 0:permission/preset  1:sandbox/mode=workspace-write  2:approval/policy=ask  3:session/title  4:agent/inbox/spliced  5:turn/start
e2e-verifier         recordedSandbox= read-only      | 0:permission/preset  1:sandbox/mode=workspace-write  2:approval/policy=ask  3:session/title  4:sandbox/mode=read-only  5:agent/inbox/spliced
```

三个 read-only 角色的 `sandbox/mode: read-only` **全部**落在 `session/title` 之后 ⇒ 全部是 `materializeRole` / `orchestra_activate` 替换分支的形状，**没有一个是 governed setup**。

第三个独立 fixture（`~/Documents/agentWorkspace/orchestra-e2e`，`team-a594dc8e`，Sep 17）复现同一签名：

```
implementer recordedSandbox= workspace-write | 0:permission/preset  1:sandbox/mode=workspace-write  2:approval/policy=ask  3:session/title  4:agent/inbox/spliced  5:turn/start
reviewer    recordedSandbox= read-only      | 0:permission/preset  1:sandbox/mode=workspace-write  2:approval/policy=ask  3:session/title  4:sandbox/mode=read-only  5:agent/inbox/spliced
```

它的 `orchestra/` 也只有 `charter reports state`（无 `blueprints/`）。

**这条判据为什么版本无关**：`git show f5dfb73:src/session-blueprint.ts`（v0.5.0，marker 写入首次出现的提交）里 governed setup 的顺序同样是 `permissionService.set` → `setSandboxMode` → … → `session/title` → marker 写；`setApprovalPolicy` 是 `6bd8d9b`（v0.5.1）才加进 setup 的，所以"没有 `approval/policy: never`"在 v0.5.0 时代不构成证据，**但 "read-only 的 `sandbox/mode` 落在 `session/title` 之后"在两个版本都构成证据**。

### 2.4 排除②（写去了别处）与③（写侧退化成 memory store）

- **②排除**：控制项 2.1 显示写入目标是 `<marker.cwd>/orchestra/blueprints/`；两个 fixture 的 `marker.cwd` 就是 fixture 自身（`team.json` 的 `role.blueprint.cwd` = fixture 绝对路径，会话 `header.cwd` 同值，均已实测）。全 `agentWorkspace` 范围内 `find -maxdepth 5 -type d -name blueprints` **只有一个命中**，就是控制项那一个 ⇒ 不存在"写到第三个目录"。
- **③排除（写侧）**：写侧的 ctx 是 **orchestra 插件的 ctx**（`prepareGovernedRolePlan(ctx, …)` ← `orchestra_create` / `orchestra_add_lanes` 工具处理器），而 `src/orchestra.ts:430` 的 `inject` 含 `"fs"`；控制项 2.1 用同一个 ctx 形状把 charter / state / blueprints 三类记录写进了同一个目录 ⇒ 写侧不是 memory store。
- **"写失败被吞"排除**：`writeRecordJson`（`src/orchestra-records.ts`）在失败时抛 `RecordError("write_failed", …)`；`createFsBlueprintStore.write` 在 `createIfAbsent` 命中 `FS_NOT_OBSERVED` 时还会抛 `composition_mismatch`；两者都从 `setup` 冒出来，而宿主 `agents.create` 的契约是"creation/setup fails ⇒ rejects"（`node_modules/@deepseek-ai/dsh-agent/lib/index.js` `create()` 的 docblock）。⇒ 若写入被调用过且失败，角色会是 `failed` 而不是 `active`。三个 fixture 的角色都是 `active`。

### 2.5 ③真正成立的地方：**读侧**（这一条只能由 live 轮判定）

`transportStores(ctx, cwd)`（`src/a2a.ts:1136`）⇒ `blueprintStoreFor(ctx, targetCwd)`，这里的 `ctx` 是 **a2a 插件的 ctx**，而 `src/a2a.ts:75` 的 `inject = ["agents","sessions","timer","tools","sandboxPolicy"]` —— **不含 `"fs"`**。Cordis 的代理守卫对未申报服务抛 `cannot get property "<name>" without inject`（`node_modules/@deepseek-ai/cordis/lib/index.js:675`），`resolveRecordFileSystem` 用 try/catch 接住并返回 `undefined` ⇒ **memory store**。

**同一 ctx 的 charter-store 能落盘怎么解释**：`charterRecordStoreFor`（`src/charter-store.ts:152`）**只在 `src/orchestra.ts` 被调用**（`:1550` / `:1571`）—— 也就是**声明了 `fs` 的那个插件的 ctx**。所以"charter 能落盘、blueprint 读不到"不是矛盾，是**两个不同的 ctx**：写侧与 charter 侧 = orchestra 的 ctx（有 `fs`）；a2a 传输的 marker 读侧 = a2a 的 ctx（无 `fs` 声明）。

**我不能从代码定死运行期结果**：Cordis 的 `internal/get` 会沿 fiber 父链向上找 `fiber.store[prop]`，宿主若在根 fiber 注册了 `fs`，理论上有机会被解析到。⇒ **只能由一次活体实验判定**，判据与对照项见 §8 落点 R-6。

---

## ③ Q2 三路径：何时写、写哪一刻的 readiness、行 id 能否派生

### 3.1 逐路径现状（commit `39df903`）

| 路径 | 入口符号 | 建会话调用 | 走哪个分支 | 写 marker？ | 写哪一刻的 readiness |
|---|---|---|---|---|---|
| **首波** | `orchestra_create` → `provisionGovernedPlans`（`src/orchestra.ts:2412`） | `buildRoleSession({kind:"create", mode:"governed", governedBlueprint})`（`:2498`） | `createSession` 的 governed 分支 → `prepareGovernedBlueprint.setup` | **会写**（`setup` 内、`commit()` 之前） | 两处：`reservedRole` 在**预留时**快照（**恒空**）；首波成功后又 `updateTeamRole(…, blueprint: roleBlueprintFacts(blueprint.receipt))`（`:2525`）—— 这一刻 `commit()` 已跑，** readiness 是实的**。**但整条路径在产品里不可达**（见 3.2） |
| **懒加载** | `orchestra_dispatch` → `materializeRole`（`:2954`） | `buildRoleSession({kind:"create", sessionId, cwd, presetId/presetFile, title, model…})` —— **无 mode、无 governedBlueprint** | `createSession` 共享预设分支 | **不写** | 成功分支只写回 `{...r, phase:"active"}`（`src/orchestra.ts:3111`），**不刷新 blueprint** ⇒ 记录停在预留那一刻（三 readiness 恒 `{names:[],count:0}`） |
| **重激活** | `orchestra_activate`（`:3540` 起） | 5a live→复用；5b/5d `resumeRoleSession` → `buildRoleSession({kind:"resume", setup})`；5c 缺失→`createRoleSession` → `buildRoleSession({kind:"create", presetFile})` | resume 分支的 `setup` 只 `mountRolePreset`；create 分支走共享预设分支 | **都不写** | 同懒加载：记录不被刷新 |

### 3.2 首波路径在产品里不可达（本条是 Q2 的根因）

```
$ grep -rn "provisionGovernedPlans" src/ scripts/
src/orchestra.ts:2412:export async function provisionGovernedPlans(
scripts/test-governed-provisioning.mjs:6:import { … provisionGovernedPlans … } from "../lib/orchestra.js"
scripts/test-governed-provisioning.mjs:404:  const result = await provisionGovernedPlans(…)
…（其余 5 处全在同文件的用例里）
```

`src/` 内**只有定义行**。`orchestra_create` 现在是 reserve-only（`roles: plans.map(reservedRole)`，`src/orchestra.ts:2710`；只 `activeTeamState.create` 后返回，不 provision）。

**本仓自己的测试已经把这件事钉成 tripwire**（`scripts/test-role-blueprint-single-prepare.mjs:151`，用例名 `S1b: criteria 1 and 3 are BLOCKED on D2 — two of the three paths build no blueprint at all`）：

```js
const specsWithBlueprint = code.filter((line) => line.includes("governedBlueprint:"));
assert.equal(specsWithBlueprint.length, 1,
  `exactly one buildRoleSession spec passes a governedBlueprint today (the first wave); found ${specsWithBlueprint.length}. ` +
  "More than one means D2 has landed — criteria 1 and 3 should now be written.");
```

（这条用例当前是**通过**的，因为它断言的是"今天只有 1 处"；它与我的独立读码结论一致。）

⇒ **S1 退出判据的第 ③ 条（"三条路径产出的 blueprint 记录字段集完全相同"）与 D1 ③ 在当前 HEAD 上都是不可判定的**，因为三条路径里两条根本不产 blueprint 记录。

### 3.3 「行 id 集 + 工具名集」在三路径上的可派生性

**行 id 集：今天就能派生，且三路径一致。** `resolvePresetFile`（`src/orchestra.ts:433`）→ `resolveRolePresetFile`（`src/orchestra-role-presets.ts:974`）。roster（`dsh`）源那条分支：

```js
if (typeof resolved.path !== "string" || resolved.path === "") {
  return { id: resolved.id, trust: resolved.trust, path: "", source: "dsh", spec };   // 防御性死分支
}
const candidate = { path: resolved.path, trust: resolved.trust, source: "dsh", text: await readFile(resolved.path, "utf8") };
return { …, path: resolved.path, source: "dsh", spec, composition: validateCandidate(spec, candidate) };
```

`path === ""` 是死分支（台账 §12 裁定 D 已实测：名册 `AgentPreset.path` 是必需绝对路径），**真实名册一定走到下面那行并带回 `composition`**。实测（探针用宿主的 `discoverPresets` 造 roster，喂给 `lib/orchestra-role-presets.js` 的 `resolveRolePresetFile`）：

```
== orchestra-v04-reviewer-v1 source= dsh path= "~/.dsh/orchestra/catalog-presets/orchestra-v04-reviewer-v1/agent.cordis.yml" hasComposition= true
   rowIds= ["persona","agent-instructions","tool-fs","tool-fs-search","tool-bash","skill-filesystem","tool-skill","compaction","compaction-basic","command-compact","tool-result-pruner"]
== orchestra-implementer source= dsh path= "~/.dsh/orchestra/catalog-presets/orchestra-implementer/agent.cordis.yml" hasComposition= true
   rowIds= ["persona","agent-instructions","tool-fs","tool-fs-search","tool-bash"]
```

而 `resolvePresetFile` 已经做了映射：`...(resolved.composition === undefined ? {} : { compositionRowIds: resolved.composition.rowIds })`（`src/orchestra.ts:440`）。

⇒ **`prepareGovernedRolePlan` 在预留时手里就有 `presetFile.compositionRowIds`**（`src/orchestra.ts:845` 的 `const presetFile = await resolvePresetFile(ctx, options.cwd, presetId)`），只是**没有传进 `roleBlueprintFacts`**。

**工具名集**：`capabilityTools(input)`（`src/session-blueprint.ts`）在 `prepareGovernedBlueprint` **body** 里就算好了 `composition` / `orchestra` 两个名字数组，receipt 的 `compositionTools` / `orchestraTools` 两个字段初始指向的却是 `compositionReadiness` / `orchestraReadiness` 这两个**只在 `commit()` 里被填**的对象 —— 这就是 F-N7-2 的机械成因。

**第三个字段 `tools`**（= `visibleToolNames(agentCtx)`）**只能**在 setup 窗口内取，任何"预留时"方案都给不出它。见 §8 落点 R-2 的处置。

### 3.4 最小且三路径一致的记录方案（设计，不实现）

**字段**：给 `TeamRoleBlueprintFacts` 加**一个**可选字段 `compositionRowIds?: string[]`（`src/orchestra-state.ts:52`）。语义 = 预留时从预设文档解析出的**行 id 集**，与 marker 的 `compositionTools`（行 id 数组）同源同义。**不**把行 id 塞进现有的 `compositionTools`（那字段的语义是工具名，混用即造假）。

**写入时机**：**预留时一次写定**，由 `reservedRole` → `roleBlueprintFacts`（`src/orchestra.ts:718`）负责。理由：
- 三路径都经 `prepareGovernedRolePlan` → `reservedRole`（`orchestra_create` 与 `orchestra_add_lanes` 都是），是唯一的三路径公共点；
- 预留时刻就是" driver 批准的那一份组合"被钉住的时刻，事后刷新反而会丢掉"批准时 vs 现在"的对比能力——而 D1 ③ 要的正是这个对比；
- 行 id 集是**预设文档的静态属性**，不依赖 setup 窗口，三路径取值完全一致。

**不做的**：不给 `tools`（live scope 可见工具全集）填值。它在预留时不可得，而在 setup 窗口可得的三路径里两条没有 setup。若要"实际挂载面"，落点应是 D2 给三条路径补 blueprint 之后的事（`test-role-blueprint-single-prepare.mjs` 的 tripwire 会提示那一刻）。

**要同时做的**：`materializeRole` 成功分支目前写回 `{...r, phase:"active"}` 不刷新 blueprint —— 这是**对的**（不应刷新，见上），但必须在代码注释里写明"不刷新是刻意的"，否则下一个人会当漏项补上。

---

## ④ Q3 恢复面：marker 缺失时的回退链（逐符号）

`orchestra/blueprints/` 不存在时，冷恢复有**两条**独立回退链，都**不读 marker**：

### 4.1 链 A：a2a 传输冷恢复（`a2a_send` / `a2a_reply` 打到冷会话）

`deliverMessage` → `tryResume`（`src/a2a-transport.ts:178`），逐符号：

1. `ctx.get("agentPresets")` / `ctx.get("sessionQuery")` —— 任一缺失即抛 `a2a transport: cannot resume … — sessionQuery/agentPresets services unavailable`；
2. `query.readSession(SID(sessionId))` → `snapshot`；
3. `assertSubagentTargetReachable(snapshot.session, sessionId, senderSessionId)`；
4. `options.resolveBlueprintStore?.(snapshot.session.cwd)` → `blueprintStoreFor(ctx, targetCwd)`（a2a ctx，见 §2.5）→ `store.read(sessionId)`；
5. `presetId = governed?.agentPreset ?? lightweight?.agentPreset ?? presetFromSnapshot(snapshot.session, snapshot.events)` —— **marker 缺失 ⇒ 落到 `presetFromSnapshot`**，即 `agentPresetProjectionDefinition.init(header)` + 逐个事件 `apply`（`agent-preset/selected` 后来者胜）；
6. `presetId` 为空串 ⇒ 抛 `session … has no recoverable Agent Preset`；
7. `marker?.presetSource === "file" && marker.presetPath !== undefined` ⇒ 造 `presetFile`；marker 缺失 ⇒ `presetFile === undefined` ⇒ `presets.resolve(presetId)`；
8. `ctx.agents.resume({ resumeSessionId, agentOptions, setup })`，`setup` 里 `mountRolePreset(agentCtx, { presetId, roster: presets })`（无 `overrideFile`）⇒ **按 id 挂载**；
9. `installModelSelection(...)` 用 `governed?.provider ?? lightweight?.provider ?? selection?.*` —— marker 缺失 ⇒ 回落 `agentDefaultModel.currentSelection()`。

⇒ **"恢复后组合完整"在链 A 上的代码条件**：(a) 会话 `header.agentPreset` 非空；(b) 该 id 能被 §7 的 roster 根解析（`presets.resolve` 不抛、不 `broken`）；(c) `mountRolePreset` 的 by-id 分支找得到 roster（否则 `RolePresetMountError("preset_roster_unavailable")`）。**marker 是否存在不影响链 A 的结果** —— 它只是"provider/model/effort 从哪来"的一个优先源。

### 4.2 链 B：`orchestra_activate`（step 5b/5d resume）

`resolvePresetFile(ctx, cwd, role.preset)` → roster 源返回 `{path:<真实路径>, source:"dsh"}`（**非 undefined**）⇒ 构造 `setup`：

```js
await mountRolePreset(agentCtx, {
  presetId: presetFile.id,
  ...(presetFile.source === "project" || presetFile.source === "global"
    ? { overrideFile: { id: presetFile.id, trust: presetFile.trust, path: presetFile.path } }
    : {}),
});
```

⇒ roster 源**按 id 挂载**（正确）；`project`/`global` 覆盖源按文件挂载。整段在 `try { … } catch { degraded = true; results.push({action:"failed"}) }` 里 ⇒ `resolvePresetFile` 抛错时该角色记 `failed`、team 降级 `degraded`，**不静默丢组合**。

### 4.3 链 C：`materializeRole` 的"会话已在盘上"幂等分支（**这是发布阻断项的形态**）

```js
await buildRoleSession(ctx, {
  kind: "resume",
  sessionId: role.sessionId,
  ...(role.model === undefined ? {} : { agentOptions: { provider, model } }),
});
```

**没有 `setup`** ⇒ `ctx.agents.resume({ resumeSessionId, agentOptions })` ⇒ 组合是否回来**完全取决于宿主自己的 resume 行为**，插件不参与。这正是 `src/role-preset-mount.ts` 文件头描述的阻断项形态，也是 N7 段 B 想取而没取到的那一层。

**宿主侧可用的外部信号（live 轮判据）**：`node_modules/@deepseek-ai/dsh-agent-presets/lib/index.js` 的 `ctx.on("agent/created", …)` 在 `this.composedPreset(agent.ctx) === void 0` 时打

```
agent "<id>" was published without joining an agent preset; its tools, prompt sections, and skill catalog resolve against the empty global layer
```

⇒ **重启后唤醒一个冷角色会话，宿主日志里出现这条 warning = 组合没回来**（外部可核、不问会话自己）。

### 4.4 顺带查出的候选缺陷（不在 F-N7-1…4 内）

**F-D1-5（代码级，未在 fixture 上观测到）｜`orchestra_activate` 的替换分支（step 5c）仍按文件挂载 roster 预设。**

`src/orchestra.ts` step 5c：

```js
const presetFile = role.preset === null ? undefined : await resolvePresetFile(ctx, cwd, role.preset);
const created = await createRoleSession(ctx, {
  kind: "create", sessionId: role.sessionId, cwd,
  ...(presetFile === undefined ? {} : { presetFile }),
  …
});
```

`presetFile` 对 roster 源是**有值**的（`{path:<真实路径>, source:"dsh"}`），于是 `createSession` 的共享预设分支执行：

```js
const file = options.presetFile;
…
setup = async (agentCtx) => {
  await mountRolePreset(agentCtx, {
    presetId: agentPreset as string,
    ...(presets === undefined ? {} : { roster: presets }),
    ...(file === undefined ? {} : { overrideFile: { id: file.id, trust: file.trust, path: file.path } }),   // ← 无条件
  });
```

⇒ `mountRolePreset` 拿到 `overrideFile` ⇒ 走 **by-file** 分支（`mountPreset`），**绕开名册**。对比：`materializeRole` 用 `if (resolved.source !== "dsh" && resolved.path !== "")` 过滤过；activate 的 **resume 分支**也用 `source === "project" || "global"` 过滤过；**只有 create 分支没过滤**。

覆盖缺口：`scripts/test-recovery.mjs` 的 `activateDeps()` 注入 `createSession` / `resumeAgent` 两个缝（`:305` / `311`），真实 `createSession` → `mountRolePreset` 的决策在测试里**从不执行**。

后果的诚实边界：by-file 仍会把行挂上（`mountPreset` 用 `preset.path` 组树），丢的是名册的 standing mount / `bindings` 登记与 `resolveMountable` 的未知-id 校验。**我不宣称它是发布阻断项**；它是"与 S3 设计意图不一致 + 测试遮罩"的一条，需 live 轮判严重度。

---

## ⑤ Q4 判据面：cross-check 修好之后的可失败形态 + `--self-test` 覆盖清点

### 5.1 cross-check 恒不触发有**两条**独立恒假守卫

`scripts/verify-role-identity.mjs:327-329`：

```js
const recordedRows  = Array.isArray(role.blueprint?.compositionRowIds) ? role.blueprint.compositionRowIds : undefined;
const recordedTools = Array.isArray(role.blueprint?.orchestraTools)    ? role.blueprint.orchestraTools    : undefined;
const crossChecked  = recordedRows !== undefined || recordedTools !== undefined;
```

- **守卫 1**：`TeamRoleBlueprintFacts`（`src/orchestra-state.ts:52`）**没有 `compositionRowIds` 字段**（它有 `compositionTools` / `orchestraTools` / `tools` 三个 `{names,count}`）。
- **守卫 2**：`orchestraTools` 的真实形状是 `{names: string[]; count: number}` —— **过不了 `Array.isArray`**。实测（`/tmp` 里的 team.json 副本，只把 `orchestraTools` 换成插件真实形状）：

```
--- objtools ---
IDENTITY_OK    reviewer … preset=orchestra-v04-reviewer-v1 rows=11 tools=11 (no recorded composition to cross-check)
# roles 1 ok 1 missing 0
EXIT=0
```

- **守卫 3（更糟）**：`recordedTools` 被读出来以后**没有任何断言消费它**，只影响 `crossChecked` 这个布尔（进而只影响那行尾巴的文案）。实测（`orchestraTools` 换成 7 元素错值数组）：

```
--- arrtools-wrong ---
IDENTITY_OK    reviewer … preset=orchestra-v04-reviewer-v1 rows=11 tools=11
# roles 1 ok 1 missing 0
EXIT=0
```

⇒ 即使把字段补上，**只补 `orchestraTools` 仍然零判据**；必须补的是 `compositionRowIds`，或者给 `recordedTools` 补上真正的断言。

### 5.2 可失败形态与输入构造方式（全部不碰产品代码、不碰 fixture 本体）

判据 = `problems.push(...)` + `missing += 1` + 末尾 `return missing === 0 ? 0 : 1`。**可失败形态（按断言列）**：

| # | 断言（脚本内的 push 文案） | 构造方式 | 实测 |
|---|---|---|---|
| A | `recorded composition has N row(s), the resolved preset declares M` | 复制 fixture 的 `team.json` 到 `/tmp`，给某角色 `blueprint.compositionRowIds` 填**行 id 集**（对 = roster 解析出的 11 条；错 = 少一条 / 空数组） | 见下 |
| B | `the session log names no preset (expected X)` | `--self-test` 自动构造（换成真实无 preset 会话）；或手改副本把 role 指向一个无 preset 的真实会话 | 见 5.3 |
| C | `NOT_A_ROLE_SESSION: the session log names preset P, the role records Q` | `--self-test` 自动构造；或副本里改 `blueprint.agentPreset` | 见 5.3 |
| D | `NOT_A_ROLE_SESSION: no session directory for <id> under <store>` | 副本里把某角色 `sessionId` 改成一个不存在但合法的 id | 未构造（E2E 真实数据已自然覆盖 history 那一侧） |
| E | `preset P is NOT resolvable through the roster` / `resolves BROKEN` | 需要一个"日志里写着名册解析不了的 preset id"的真实会话 —— **当前两个 fixture 都没有**，只能由专用 fixture 会话提供 | **未构造** |
| F | `the preset's composition could not be read` | 需要一个组成文件不可读的 preset —— 同上 | **未构造** |
| G | `preset P resolves but declares no composition rows` | 需要一个 0 行 preset —— 同上 | **未构造** |
| H | `sessionHistory lists the CURRENT session id as a replaced one` | 副本里把某条 `sessionHistory[].sessionId` 改成当前 `role.sessionId` | 未单独构造（E2E 真实数据已覆盖，见 5.4） |
| I | history 条目指向盘上不存在的目录 | 副本里给 `sessionHistory` 加一条假 id | 未单独构造（E2E 真实数据已覆盖） |

A 的实测（三条对照，同一会话、同一 roster）：

```
--- correct（11 条，与名册一致）---
IDENTITY_OK    reviewer orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f preset=orchestra-v04-reviewer-v1 rows=11 tools=11
# roles 1 ok 1 missing 0
EXIT=0

--- stale（10 条）---
IDENTITY_MISSING reviewer … preset=orchestra-v04-reviewer-v1 rows=11 tools=11
          recorded composition has 10 row(s), the resolved preset declares 11
# roles 1 ok 1 missing 0
EXIT=1

--- empty（0 条）---
IDENTITY_MISSING reviewer … preset=orchestra-v04-reviewer-v1 rows=11 tools=11
          recorded composition has 0 row(s), the resolved preset declares 11
# roles 1 ok 1 missing 0
EXIT=1
```

⇒ **cross-check 分支不是"坏的"，是"没被喂到"**：字段一补上就能失败，输入构造只是一份 `/tmp` 里的 team.json 副本。

### 5.3 `--self-test` 现在覆盖什么 / 没覆盖什么

**机制**：从会话存储里挑一个**有可读日志的、非角色**真实会话（`realSessionIds`，`:215`），`candidates.sort()[0]`，替换到第一个 `phase === "active"` 的角色上。

**实测输出（N7 fixture）**：

```
# self-test: role "reviewer" sessionId orchestra-team-33be3b56-… -> session-4289d06b-dc9c-4c7b-9659-e2a2b8b0c8d3 (a real, non-role session)
IDENTITY_MISSING reviewer session-4289d06b-… preset=standard rows=32 tools=32
          NOT_A_ROLE_SESSION: the session log names preset standard, the role records orchestra-v04-reviewer-v1
# roles 1 ok 0 missing 1
# self-test detected=yes
EXIT=1
```

**实测输出（E2E fixture，同一跑法命中另一条分支）**：

```
# self-test: role "implementer" sessionId orchestra-team-f01da153-6d44a378-… -> 18459551-d2a1-4319-834b-2890e919ab3f (a real, non-role session)
IDENTITY_MISSING implementer 18459551-… preset=(none) rows=0 tools=0
          the session log names no preset (expected orchestra-implementer)
# roles 6 ok 3 missing 3
# self-test detected=yes
EXIT=1
```

**已覆盖**：B（`names no preset`）、C（preset 不匹配）。另外**意外覆盖**了 H 与 I —— 但靠的是 E2E **已被写坏的真实数据**（`difficulty-implementer` 的 history 把当前 id 记成被替换的、以及一条指向不存在目录的 history id），**不是 self-test 的本意**；换一个干净 fixture 这两条就都没有覆盖。

**未覆盖**：A（cross-check，恒假）、D（无会话目录）、E（名册解析不了 / BROKEN）、F（组成读不出）、G（0 行 preset）、H/I 的**确定性**构造、`IDENTITY_SKIP`（`phase !== "active"`）、以及"替换**未**被检出时必须非 0"这条本身（见 5.4）。

### 5.4 ★ 新缺陷：`--self-test` 未检出时返回 **exit 0**

```js
if (options.selfTest) {
  const detected = missing > 0;
  process.stdout.write(`# self-test detected=${detected ? "yes" : "NO"}\n`);
  return detected ? 1 : 0;          // ← 未检出 ⇒ 0
}
```

脚本自己的 docstring 写着 "1 = a role failed **or the calibration detected nothing**"，代码却在未检出时返回 **0** —— 文档与代码不一致，且**未检出的校准与一次干净通过无法区分**，正是这个脚本存在理由（"没有负例的核对脚本等于一个永远说 OK 的脚本"）要防的那件事。

**实测复现**（`/tmp` 副本，只把角色的 `blueprint.agentPreset` 改成被替换那个会话自己的 preset，使替换不再可判别）：

```
# self-test: role "reviewer" sessionId orchestra-team-33be3b56-… -> session-4289d06b-… (a real, non-role session)
IDENTITY_OK    reviewer session-4289d06b-… preset=standard rows=32 tools=32 (no recorded composition to cross-check)
# roles 1 ok 1 missing 0
# self-test detected=NO
EXIT=0
```

按协议 §2.2 分类表属 **B 类（机制未命中自己的期望码）**，不是争议。修法：未检出时返回非 0（建议 1，与"检出"同码但语义相反；或 2 并保留 1 给"检出"）。**这一条不依赖 D1 任何改动，可独立先修。**

---

## ⑥ Q5 成本/边界：加字段的必要性证明与影响面

### 6.1 必要性：现有三个字段为什么不够

| 现有字段 | 语义 | 为什么不能承担"行 id 集" |
|---|---|---|
| `compositionTools?: {names,count}` | **组合工具名**（`tool-bash`/`tool-fs`/`tool-fs-search`） | 是**行的导出子集**，不是行集。实测：`orchestra-v04-reviewer-v1` 有 **11 行**但只有 **3 个组合工具**；`orchestra-implementer` 有 **5 行**、同样 3 个工具。两个行数不同的预设可以有相同的工具名集 ⇒ 记录无法表达行数差异，也就无法发现"预设被换成了行数不同的另一份" |
| `orchestraTools?: {names,count}` | orchestra 宿主工具名 | 同上，且与行集正交 |
| `tools: {names,count}` | **live scope 可见工具全集**（`visibleToolNames(agentCtx)`） | 只能在 setup 窗口内取；三路径里两条没有 setup（§3.1）⇒ 预留时不可得，今天恒空 |

而且 D1 ③ 的退出判据原文就是"**行 id 集 + 工具名集**"，`verify-role-identity.mjs` 也已经按 `compositionRowIds` 这个名字在读 —— **字段名已经是既定契约，不需要新发明**。控制项 2.1 进一步证明 marker 里从来就有这个数组，缺的只是 team 记录这一份投影。

### 6.2 影响面（谁读 `TeamRoleBlueprintFacts`）

| 读者 | 是否受影响 |
|---|---|
| `src/orchestra-state.ts:100`（`TeamRole.blueprint` 类型）+ `:554`（`normalizeTeam`） | 类型加一个可选字段；`:554` 是 `asRecord(role.blueprint) ? { blueprint: role.blueprint } : {}` **整体透传** ⇒ 新字段自然存活，无需改 |
| `src/orchestra.ts:718` `roleBlueprintFacts` | **唯一写入点**，加一行 spread |
| `scripts/verify-role-identity.mjs:327` | **已经在读它**；补上字段即从"恒不触发"变成"可失败"（5.2 已实证） |
| 工具输出 schema（`orchestra_team` / `orchestra_create` / `orchestra_add_lanes` / `orchestra_dispatch` / `orchestra_activate`） | **零影响**：`roleStatus`（`src/orchestra.ts:3850`）构造角色行时**不含 `blueprint`**；`roleItem` schema（`:3957`，`additionalProperties:false`）也没有它 ⇒ 不触发 D4 那类"返回值过 schema"问题 |
| `orchestra_draft` 的 `role_blueprint_preview` | 走 `DraftRoleFacts`（`preparseDraftRoleFacts`，`:1196`），**另一个类型**，不含 team 记录的 blueprint ⇒ 不受影响。若要让提案卡也显示行数，是独立增量，**不建议本轮做** |
| 测试 | `test-role-blueprint-single-prepare.mjs:151` 的 tripwire 不受影响（它数的是 `governedBlueprint:`）；`test-governed-provisioning.mjs` / `test-orchestra-state.mjs` / `test-add-lanes.mjs` 需各加一条"预留记录带 `compositionRowIds` 且长度 = roster 行数"的断言（**新增，不修改既有断言**） |
| 归档快照 / 旧 team.json | 字段可选 ⇒ 旧记录读出来是 `undefined`，脚本的 `Array.isArray` 守卫已经处理（打印 `(no recorded composition to cross-check)`）⇒ **无迁移成本** |

---

## ⑦ 未做 · 未验证（如实列举）

| 项 | 状态 |
|---|---|
| **任何活体验证** | **完全未做**（未起 4600、未驱动任何会话、未跑跨重启）。本报告全部结论来自读码 + 盘上既成事实 + 进程内探针 |
| **段 B（跨重启后角色组合是否完整）** | **未判定**。§4.3/§4.4 给出的是代码级回退链与 live 轮判据，不是证据 |
| **`ctx.get("fs")` 在 a2a 插件 ctx 上的运行期结果** | **未判定**（§2.5）。Cordis 的 fiber 父链查找使"声明缺失"不等于"一定取不到"；只能由 §8 R-6 的活体实验定 |
| **E2E 团队创建时（`2026-09-19T04:43:41Z`）跑的是哪个构建** | **未核实**。`6bd8d9b`（v0.5.1）提交于 `Sep 19 15:45 +0800`，晚于该时刻；dev profile 当时可能是 v0.5.0 或未提交的工作树构建。**这不影响 §2.3 的结论**（该结论用的判据版本无关），但影响"E2E 是否曾经跑过首波路径"的历史陈述 —— 我不做这个陈述 |
| **F-D1-5（activate 替换分支按文件挂载）的运行时后果** | **未判定**。只核到代码级 + 测试缝遮罩；未在 fixture 上观测到（两个 fixture 都没做过重激活替换） |
| **E/F/G 三类 cross-check 分支（名册解析不了 / BROKEN / 0 行）** | **未构造输入**：需要专用 fixture 会话或改 `~/.dsh`（越界），留给 live 轮 |
| **`~/.dsh/` 与两个 fixture 的字节级未改动** | 已核：`orchestra_E2E/orchestra/state/team.json` mtime `Sep 19 15:18`、N7 `team.json` 只读解析；本轮只写了 `/tmp/d1-analysis/*.json` 与本报告 |
| **`npm test` 基线** | 复跑通过：`# tests 269 / pass 269 / fail 0`（与本轮改动无关，作为"读Code 期间无回归"的对照） |

---

## ⑧ 修复落点清单（按最小改动排序；逐条给符号 + 判据）

> 排序原则：**不依赖 D2、不依赖活体、可独立判真假的排在前面**。

### R-1｜`verify-role-identity.mjs`：`--self-test` 未检出必须非 0
- **符号**：`scripts/verify-role-identity.mjs` 的 `main()` 末尾 `if (options.selfTest)` 分支。
- **改法**：`return detected ? 1 : 0` → 未检出返回非 0；docstring 的 exit-code 行同步。
- **判据**：`/tmp/d1-analysis/team-blindspot.json`（本报告 §5.4 已构造）跑 `--self-test` ⇒ 必须 exit ≠ 0 且印 `detected=NO`；`orchestra_N7` 原 team.json 跑 `--self-test` ⇒ 仍 exit 1 且 `detected=yes`。**防恒真**：把改回 `0` 应当让前者失败。

### R-2｜`TeamRoleBlueprintFacts` 加 `compositionRowIds?: string[]`，并在预留时写定
- **符号**：`src/orchestra-state.ts` 的 `TeamRoleBlueprintFacts`（`:52`）；`src/orchestra.ts` 的 `roleBlueprintFacts`（`:718`）；调用方 `prepareGovernedRolePlan`（`:804`，它已在 `:846` 持有 `presetFile`）。
- **改法**：类型加一个可选 `string[]`；`prepareGovernedRolePlan` 把 `presetFile.compositionRowIds` 随 plan 传下去（或让 `roleBlueprintFacts` 直接收 `presetFile`）；`roleBlueprintFacts` 在 receipt 存在时 spread 进去。
- **判据**：①`orchestra_N7/orchestra/state/team.json` 的 `roles[].blueprint.compositionRowIds` 长度 = roster 解析出的行数（reviewer = 11，实测值见 §3.3）；②`node scripts/verify-role-identity.mjs --repo <fixture> --team <fixture>/orchestra/state/team.json` 输出行尾**不再有** `(no recorded composition to cross-check)`；③R-4 的负例必须 exit 1。**不改 `materializeRole` 的 `{...r, phase:"active"}`**（不刷新是刻意的，补注释说明）。

### R-3｜`compositionTools` / `orchestraTools` / `tools` 的恒空：显式记为"预留时不可得"，不要用假值填
- **符号**：`src/session-blueprint.ts` 的 `compositionReadiness` / `orchestraReadiness` / `readiness`（`prepareGovernedBlueprint` body）与 `roleBlueprintFacts`。
- **改法**：纯注释 + 一条单测，断言"预留快照的三个 readiness 恒为 `{names:[],count:0}`"且"这不是漏填"。**不填值** —— 填了就等于用预期冒充实际（`capability-boundaries.md` #4 同族）。
- **判据**：新增用例；把 readiness 改成填预期值必须让该用例失败。

### R-4｜cross-check 的负例校准（判据自身的防恒真）
- **符号**：`scripts/verify-role-identity.mjs` 的 `recordedRows` 分支。
- **改法**：**不改产品代码**；在测试里用 §5.2 表 A 的三形态（correct / stale / empty）各跑一遍，断言 exit 0 / 1 / 1。
- **判据**：三条各命中期望码；`stale` 的失败行必须逐字包含 `recorded composition has 10 row(s), the resolved preset declares 11`。

### R-5｜`orchestra_activate` 替换分支：roster 预设改按 id 挂载（F-D1-5）
- **符号**：`src/orchestra.ts` step 5c 的 `presetFile` 传递；`src/a2a.ts` `createSession` 共享预设分支的 `overrideFile` 无条件展开。
- **改法（二选一，driver 裁）**：(a) 在 activate step 5c 复用 `materializeRole` 的过滤 `resolved.source !== "dsh" && resolved.path !== ""`，roster 源改传 `presetId`；(b) 在 `createSession` 的共享分支里按 `file.source` 决定是否给 `overrideFile`（与 activate resume 分支同款）。
  **(b) 更根本**（它是唯一共享点），但会同时影响 lightweight 路径，需连 `test-role-session-single-path.mjs` 一起看。
- **判据**：`scripts/test-recovery.mjs` **停止注入 `createSession`**（或新增一个不注入的用例），断言 roster 预设走 `mountRolePreset` 的 by-id 分支（`mountedBy === "id"`）。**改前不得声称已修** —— 当前没有任何测试覆盖这条决策。

### R-6｜marker 读侧的 live 判定（§2.5 的唯一收敛方式）
- **实验**：在**测试 workspace**（不是 E2E / N7）里，对一个已存在的角色会话，**手工**在 `<cwd>/orchestra/blueprints/<sessionId>.json` 写一份 marker，`agentPreset` 指向一个**真实存在但与 header 不同**的 roster 预设，`presetSource:"file"`、`presetPath` 指向一个**不存在的路径**。
- **判据**：对该会话 `a2a_send` ⇒ 若投递失败且错误含 `agent-preset/invalid` / `failed to mount` ⇒ **marker 被从盘上读到了**（读侧有 fs）；若投递成功且该会话随后用的是 header 的预设 ⇒ **读侧是 memory store**，冷恢复永远走 header 投影。
- **对照项**：同一 marker 但 `presetPath` 指向**真实**预设文件 ⇒ 必须成功挂上那个预设（证明 marker 确实被消费，不是被忽略）。
- **边界**：只能在新 workspace 做；不得改 `orchestra_E2E` / `orchestra_N7`。

### R-7｜D1 ③ 的三路径一致性（依赖 D2，排最后）
- **符号**：`scripts/test-role-blueprint-single-prepare.mjs:151` 的 tripwire。
- **判据**：D2 给懒加载 / 重激活补上 blueprint 后，该断言从"= 1"翻成"= 3"，同时 S1 判据 ③（三条路径 blueprint 记录字段集相同）才可写。**在此之前不得声称 D1 ③ 已在三路径上兑现。**

---

## ⑨ 下一跳建议（driver 定夺）

1. **R-1 与 R-2 是本轮可独立收口的两条**，都不依赖 D2、不依赖活体、判据都已实测构造好（§5.4 的 blindspot 副本 + §5.2 的三形态副本）。R-2 落地后 `verify-role-identity.mjs` 的 cross-check 从"恒不触发"变成"可真失败"，F-N7-1 的诚实性问题才闭合。
2. **R-4 与 R-2 必须同一批**：只加字段不加负例校准，等于把一条从未失败过的断言升格为判据。
3. **R-5 请 driver 裁 (a)/(b)**，并注意它**不是**发布阻断项的已证成因（我没在任何 fixture 上观测到它跑过），登记为候选缺陷更稳妥。
4. **R-6 是唯一能收敛 §2.5 的实验**，建议与 D1 的 live 轮**同一趟**做（裁定 V 的原意：记录侧与恢复侧一趟取）。
5. **F-N7-3 的表述建议更正为**：不是"未归因"，而是"**写入从未被调用**（N7/E2E/`orchestra-e2e` 三个 fixture 的全部角色会话都未经 governed setup，判据版本无关）；写入链本身有真实运行的控制项证明是通的；真正未定的是**读侧**在 a2a ctx 上是否取得到 `fs`（§2.5 / R-6）"。
6. **F-N7-2 的表述建议同时更正**：`materializeRole` 成功分支"不刷新 blueprint"在当前形状下是**正确的**（预留时刻才是批准时刻）；要让它变正确的前提是先有 R-2 的字段，再决定要不要在 setup 窗口刷新 `tools`（那是 D2 之后的事）。

---

**报告完毕，原样回 driver。** 产品代码零改动；未起实例；未动两个 fixture 与 `~/.dsh/`；未改台账 / 计划 / ADR / 契约。本轮唯一写入是本文件与 `/tmp/d1-analysis/*.json`（后者的内容已全文贴在本报告里，可弃）。
