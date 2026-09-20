# P0 · S1a 报告（统一建会话入口：`buildRoleSession` 已引入）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **依据**：driver 判定「下一步 S1」（2026-09-20）+ 三条约束（一轮一个 S 项 / S1 判据 ② 分两步判 / 不动 §7）。
> **锚点**：commit + 文件；行号仅辅助。
> **本文件的状态：S1a 部分完成 —— 只完成"引入"，**未**完成"三条路径都经它"。** 下节第一栏即写明。

---

## 1. 结论

| S1 判据 | 状态 | 说明 |
|---|---|---|
| **判据 ①** 三条路径的 setup 执行的是同一函数 | ⬜ **未达成** | `buildRoleSession` 已引入并导出，但**三条路径尚未改走它** |
| **判据 ②（本轮形态）** 三条路径全部经 `buildRoleSession`，且 `agents.resume(` 只出现在该函数内部（一处） | ⬜ **未达成** | 当前 `agents.resume(` 仍在 `src/orchestra.ts` **两处**（`materializeRole` 的显式兜底、`resumeRoleSession` 包装）与 `src/a2a-transport.ts` **一处**（`tryResume`，属 S2 范围） |
| **判据 ③** 三条路径产出的 blueprint 记录字段集完全相同 | ⬜ **未达成** | 依赖 ① ② |
| `scripts/test-role-session-single-path.mjs` | ⬜ **未创建** | 三条断言现在都**不成立**，建脚本只会得到一个恒 FAIL 的脚本 |

**已完成的部分**：`src/a2a.ts` 新增并导出 `buildRoleSession(ctx, spec)` / `BuildRoleSessionSpec` / `BuildRoleSessionResult`——**单一入口的载体已经存在、类型已闭合、`tsc` 通过、已确认可从 `lib/a2a.js` 导入**。

**未完成的部分**：把三条调用点改成走它。这是**改三处调用方**（不是改入口），已在下节逐处写明改法。

---

## 2. 未做 / 未验证（如实，含改法）

### 2.1 三条路径当前的实际形态（已实测，不是转述）

| 路径 | 位置（文件 + 函数） | 当前做法 | 与其余两条的差别 |
|---|---|---|---|
| **首波** | `src/orchestra.ts` `materializeRole`（`createRoleSession(ctx, {mode:"governed", governedBlueprint: plan.blueprint, returnHandle: true, ...})`） | `createSession(mode:"governed")` | **唯一带 blueprint** ⇒ 唯一钉了 `setApprovalPolicy(session,"never")`；**唯一需要 handle** |
| **懒加载** | `src/orchestra.ts` `materializeRole`（`createSession(...)` 失败落到 `ctx.agents.resume({resumeSessionId, agentOptions})`） | 先 `createSession`，`/already exists/i` 时裸 `agents.resume` | **无 blueprint、无 `setup`** ⇒ DSH 以"空全局层"发布（`docs/dsh-native-capabilities.md` 禁忌 1） |
| **重激活** | `src/orchestra.ts` `resumeRoleSession` 包装 + 两条分支；`materializeRole` 外的 `orchestra_activate` 循环 | 缺失 ⇒ `createSession`；可读 ⇒ `agents.resume({..., setup})` | `setup` **仅当 `presetFile` 解析成功**才存在；`agentOptions` 在这里**单独重算**了一遍（与 `createSession` 内的算法**是两份实现**） |

### 2.2 逐处改法（下一轮直接照做）

1. **首波**：`createRoleSession(ctx, {mode:"governed", ...})` → `buildRoleSession(ctx, {kind:"create", mode:"governed", sessionId, cwd, governedBlueprint: plan.blueprint, createdBySessionId: exec.agent?.id, signal: exec.signal})`。
   ⚠️ **需要给 `BuildRoleSessionResult` 补 `handle?: AgentHandle`**（首波是唯一收集 handle 做回滚/清理的路径；`SessionCreateResult` 已有 `handle`）。这一处**当前未补**。
2. **懒加载**：`createSession(...)` 的 `try` 段 → `buildRoleSession(ctx, {kind:"create", sessionId, cwd, presetId, presetFile, title, provider, model, reasoningEffort, createdBySessionId, signal})`；`catch` 内的 `ctx.agents.resume({...})` → `buildRoleSession(ctx, {kind:"resume", sessionId, agentOptions})`。
   ⚠️ **这条路径的蓝图缺口就是 D2 的成因**：它建出来的会话没有 blueprint ⇒ 没有 `approval: never`。S1a 只负责**让它经同一入口**；**真正补上 blueprint 是 D2 的活**（driver 已把 E1 判为 D2 的启动器）。
3. **重激活**：`resumeRoleSession(ctx, {...})` 包装 → 直接 `buildRoleSession(ctx, {kind:"resume", ...})`；随后**删掉 `resumeRoleSession` 包装**（它现在是多余的间接层），使 `agents.resume(` 在 `src/orchestra.ts` 归零。
   ⚠️ 重激活里那段**单独重算 `agentOptions` 的逻辑**（`override` / `modelSvc.currentSelection()`）与 `createSession` 内的算法重复。**本轮不合并**——合并它属于 S1b 的"差异由 mode 参数化"，且它是**行为改动**（两份算法的边界不同：重激活看 `role.model` 的**部分**字段，`createSession` 看 `provider`/`model` 是否给全）。**先记录，不顺手改**。
4. **`a2a-transport.ts` 的 `tryResume`**：保留到 **S2**（那是 driver 明确划给 S2 的那一处；本轮判据 ② 只要求"`agents.resume(` 只出现在 `buildRoleSession` 内部"这句话在 **S2 落地后**才全仓成立）。

### 2.3 为什么本轮没有硬做完

改三处调用方 + 补 `handle` + 建三条断言的脚本，是一轮**改 4 个文件**的改动。我在本轮实测推翻了一个前置假设（`sessionController.resume` 不存在）、落地了一条依赖面改动（peer+dev）、并写了三份记录；余下预算不足以把 S1a 做到"可提交 + 可验证收尾"。

按 driver 的**注意力**拆分纪律（"若 S1 一轮内无法以可提交+可验证状态收尾，按注意力拆分"），这里停在**已可提交的那一半**：入口本身。**不把半成品调用点提交上去**——那会让 `npm test` 与你独立复跑的结果对不上，属于我不该制造的状态。

---

## 3. 本轮的证据（可复核）

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.client.json
（无输出 = 通过）

$ npm run build && node --input-type=module -e "import * as a2a from './lib/a2a.js'; console.log(typeof a2a.buildRoleSession)"
function
```

**`buildRoleSession` 的设计要点（写进代码注释，供下一轮核对）**：
- 签名按计划 §1 S1 的 `spec`：`{kind, mode, sessionId, cwd, presetId, presetFile, permissionPreset, provider, model, reasoningEffort, title, requiredTools, caller, createdBySessionId, governedBlueprint, setup, agentOptions, signal}`。
- `kind: "resume"` 分支是**本模块唯一的 `ctx.agents.resume(`**——S1 判据 ② 的落点就是它，S2 替换的也是它。
- `mode: "governed"` **必须**带 `governedBlueprint`（缺则 `createSession` 自己抛 "governed createSession requires a prepared Governed Session Blueprint"），与既有行为一致。

---

## 4. 下一跳

**S1a 收尾（下一轮第一件事）**：按 §2.2 的四步改调用方 → 建 `scripts/test-role-session-single-path.mjs`（三条断言）→ 挂进 `package.json` 的 `test` → `npm test` 应保持 254 全绿且新增脚本全绿。

**然后**：S1b（两个 `prepare*Blueprint` 收敛为 `prepareRoleBlueprint` + `spec.mode` 参数化）。

**仍未做**：D1/D2-a/D2-c/D3/E1；§7（**已判给 Owner，我不动**）；`verify-role-identity.mjs` / `verify-d2-approval.mjs` / `verify-role-presets-roster.mjs` / `test-tier0-predicate.mjs` / `verify-agent-budget.mjs`（driver 的批 1 清单里，**2 条已绿，7 条待建**）。
