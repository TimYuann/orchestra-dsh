# P0 · S1b 报告（`prepareRoleBlueprint` 收敛 —— 单一名 `prepare*` 入口）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **依据**：driver 判定「下一轮做 S1b」+ 约束（目标 = 判据 ①③ 可判并转绿 / 判据 ② 全仓口径留到 S2 / 报告逐条列 `agentOptions` 差异 / 不动 §7·`.npmrc`·依赖面·契约·两份裁定）。
> **基线**：`978c2fb`。
> **锚点**：commit + 符号。**计数一律只作诊断，不作断言**（driver §1 的更正）。

---

## 1. 结论

**S1b 的口径目标达成了一半，另一半被实测挡住，而挡住它的不是 S1b。**

| S1 判据 | 状态 | 说明 |
|---|---|---|
| **判据 ①**（三路径 setup 是同一函数） | ⬜ **不能转绿 —— 被 D2 挡住** | 见 §3。**两条路径根本不产出 blueprint**，没有 setup 可比。 |
| **判据 ③**（三路径 blueprint 记录字段集相同） | ⬜ **不能转绿 —— 同一个原因** | 同理，没有记录可比。 |
| **S1b 自己该做的收敛** | ✅ **达成** | 准备阶段现在**只有一个名字、一个派发点**：`prepareRoleBlueprint`。 |

**为什么这不是"没做完"，而是"S1b 做完了、判据却不可判"**：判据 ①③ 的前提是**三条路径都产出 blueprint**。实测只有**首波**产出——懒加载与重激活 replacement 走的是「resolve 出 preset 文件 → 直接 `buildRoleSession({kind:"create"})`」，`createSession` 在那两个形态下**原样挂载 preset、不发布 receipt**。

**给那两条路径补上 blueprint 正是 D2 的活**（blueprint 就是携带 `approval: "never"` 的那个东西）。所以 ①③ **留到 D2**。现在声称它们成立，就是本项目反复点名的那种"形式完备、实际不完备"。

**S1b 交付的是那两条判据需要的前置**：D2 落地时，那两条路径**只有一个函数可调**。

**G-S**：`npm run typecheck` **0**；`npm test` → **261 pass / 0 fail**（基线 257 + 本脚本 4）。

---

## 2. 证据（可独立复跑，含 build 后单跑）

```
$ npm run build && node --test scripts/test-role-blueprint-single-prepare.mjs
# tests 4
# pass 4
# fail 0

$ node --test scripts/test-role-session-single-path.mjs
# tests 3
# pass 3
# fail 0

$ npm run typecheck && npm test
# tests 261
# pass 261
# fail 0

$ grep -n "prepareRoleBlueprint(" src/a2a.ts src/orchestra.ts src/session-blueprint.ts | grep -v "export function\|export async function"
src/a2a.ts:401:    const blueprint = await prepareRoleBlueprint(ctx, {
src/orchestra.ts:869:  const blueprint = await prepareRoleBlueprint(ctx, {

$ grep -n "prepareLightweightBlueprint(\|prepareGovernedBlueprint(" src/a2a.ts src/orchestra.ts
（无输出）
```

**实现了什么**（`src/session-blueprint.ts`）：
- 新增 `PreparedRoleBlueprint = PreparedLightweightBlueprint | PreparedGovernedBlueprint`（判别式联合，`mode` 是判别键）。
- 新增 `prepareRoleBlueprint(ctx, input)`，**重载签名按 `mode` 收窄返回类型**；实现按 `mode` 派发到既有两个 plane 函数。
- **未删**两个 plane 函数：它们各有多处外部 caller（`scripts/test-session-blueprint.mjs` 8 处、`scripts/test-governed-provisioning.mjs` 3 处、`scripts/test-orchestra-role-presets.mjs` 2 处），删掉会打断既有覆盖。**测试脚本不在本轮可动范围**。

**为什么不是把两个函数体真合并成一个带 `if (mode===...)` 的函数**：`diff` 实测两边差异是**规则差异**而非重复——governed **拒绝**预设继承并**要求**显式 preset、governed 解析 permission **SPEC** 并拒绝空 approval、governed 校验 presetFile 必须带 id。**共用部分早已抽掉**（`resolvePresetOrThrow` / `explicitModel` / `requiredTools` / `currentModel`）。把两套规则塞进一个函数体**不减少任何重复**，只会让两套规则更难读、更容易被后续改动糊在一起。计划 §1 S1 的原话是"差异由 `spec.mode` 参数化"——**参数化已发生在派发点上**。

**测试怎么锚**（回应 driver §1）：
- 断言落在**符号与行为**上：`prepareRoleBlueprint` 是函数、未知 mode **必须抛** `SessionBlueprintError`（行为）、两处调用点**拼写的是派发器**、源码里**零 plane 函数直调**。
- **计数只打印、不断言**（`census` / `receiptBranches` 只是诊断变量）。上一版我正是因为用计数当断言、又让正则锚在 `await buildRoleSession(ctx, {` 上而少数了一处，driver 已经指出。

---

## 3. 挡住判据 ①③ 的实测事实（这是本轮最重要的发现）

```ts
// src/orchestra.ts · buildRoleSession 的四条 spec（三条路径）
2497  首波          governedBlueprint: plan.blueprint,   ← 唯一带 blueprint
3069  懒加载 create  （无 blueprint）
3090  懒加载 resume  （kind:"resume"，无 blueprint —— resume 本来就不建）
3517  重激活 resume  （kind:"resume"，无 blueprint）
3575  重激活 replace（无 blueprint）
```

`createSession` 在**没有 blueprint** 时的行为（`src/a2a.ts`）：走 `options.presetFile` 分支 → `mountPreset(...)` + `installModelOverride(...)`，**不产出 `receipt`**。

⇒ 两条路径上：
- **没有 `setup` 函数可比**（判据 ① 的比较对象不存在）；
- **没有 blueprint 记录可比**（判据 ③ 的比较对象不存在）。

**另一层同源事实**：团队记录工厂 `reservedRole`（`src/orchestra.ts`）是**首波与重激活共用的**，它自己写着
`...(receipt === undefined ? {} : { blueprint: roleBlueprintFacts(receipt) })` —— **记录形状本身今天就带条件分支**。所以判据 ③ 想说的"字段集完全相同"，在 D2 之前**连记录的骨架都不满足**。

**测试把这个 blocker 钉成了 tripwire**：`verify` 断言"恰好一条 spec 带 `governedBlueprint`"。**D2 一落地这条断言就翻**，那时才该写判据 ①③ —— 这是**带绊线的 TODO**，不是"声称已成立"。

---

## 4. 重激活那段 `agentOptions` 重算：差异逐条 + 保留哪一侧

driver 要求：若合并构成行为改动，**逐条列出两份算法的差异**，并用测试**钉住我选择保留的那一侧语义**。我**没有合并**，两侧语义**都原样保留**（未改动重激活那段）。差异如下：

| # | 维度 | 重激活那段（`resumeRoleSession` 调用点） | `createSession` 内 |
|---|---|---|---|
| 1 | **override 的判定条件** | `role.model !== undefined && (provider !== undefined \|\| model !== undefined \|\| reasoningEffort !== undefined)` | `options.provider !== undefined \|\| options.model !== undefined \|\| options.reasoningEffort !== undefined` |
| 2 | **override 存在时的取键** | 逐键 `override.provider === undefined ? {} : {provider}` —— **逐键回退到"无"** | 逐键 `options.provider !== undefined ? {provider} : {}`，**但** 若只给了一个（如只给 provider），`overrideModel = options.model ?? selection?.model`，**另一键回退到部署默认** |
| 3 | **无 override 时** | 整体回退到 `selection`（部署默认），`selection === undefined` ⇒ `{}` | 同（`selection === undefined ? {} : {provider, model}`） |
| 4 | **`reasoningEffort` 的去向** | **当 override 的触发条件之一**，但**没有**被放进 `agentOptions`（它走 `setup` 里的 `installModelOverride`） | 同样只作触发条件，放进 `setup` |

**真正的语义差在 #2**：重激活**逐键独立回退**，`createSession`**整体配对回退**。同一个"只给了 provider"的输入，两条路会得到**不同的模型路由**。

**保留哪一侧**：**两侧都保留、不合并**。理由：
- 合并必然选一侧 ⇒ 必然改变另一侧的行为，而**两侧都有既有测试覆盖**（`test-recovery.mjs` 走重激活那条，`test-session-bridge`/`test-session-blueprint.mjs` 走 `createSession` 那条）；
- 计划 §1 S1 要求的"差异由 `mode` 参数化"**已经通过派发点达成**（§2），`agentOptions` 的算法差**不是准备阶段的差异**，是**恢复路径与创建路径**的差异；
- **是否有意为之无法从代码判定** ⇒ 按"规则一"，**不替它做决定**，登记为待裁项。

**钉住两侧语义的测试**：`scripts/test-role-session-single-path.mjs` 的行为半已经把 `buildRoleSession` 的 `kind:"resume"` 分支钉在"**原样透传我给的 `agentOptions`，不自己重算**"上（断言 `calls[0].options.agentOptions` 与传入值 `deepEqual`）。即：**入口不引入第三份算法**——这是本轮真正需要保证的不变量。#2 的两份算法差异**留待裁定**，见 §6。

---

## 5. 缺陷类第四次扫描（driver 要求）

扫 `?? undefined` 与"把可选链结果当键传"两处：

| 位置 | 判定 |
|---|---|
| `src/a2a-transport.ts:174` `return state ?? undefined;` | **不是同族**：`?? undefined` 与直接返回 `state` 等价，是**空操作**，不影响任何下游判据 |
| `src/orchestra.ts:797-799` `ownership/routes/completion: plan.protocol?.x` | **不是同族**：写进的是 `TeamRole` 记录（内部状态，不过 DSH JSON 边界、不做 `!== undefined` 分支） |
| `src/orchestra.ts:2504` `createdBySessionId: exec.agent?.id` | **不是同族（已核）**：下游是 `typeof options.currentSessionId === "string"` 与 `asString(...)`，**两者对"键缺席"与"键为 undefined"行为一致** —— 与 `provider`/`model` 的 `!== undefined` 判据**不同** |

⇒ **未发现第四处**。**没有为它建任何机制**（不建全局"禁止 undefined 字段"的守卫），与 driver 的克制要求一致。

---

## 6. 未做 / 未验证

| 项 | 状态 |
|---|---|
| **S1 判据 ①③** | ⬜ **被 D2 挡住**（§3）。测试里已留 tripwire。 |
| **`agentOptions` 两份算法的合并（差异 #2）** | ⬜ **未做，登记待裁**：合并是行为改动，且无法从代码判定哪一侧是有意为之。**建议交 Owner 或 D2 一并裁**——它直接影响"重激活后角色的模型路由与首次创建是否一致"，属产品语义。 |
| **删除两个 plane 函数** | ⬜ 未删（有 13 处外部 caller，含测试脚本；删它需先改那些脚本，不在本轮范围） |
| **S2** | ⬜ 未做；`a2a-transport.ts` 的 `tryResume` 未动；**判据 ② 全仓口径仍未成立、未提前宣布** |
| **S3** | ⬜ 未做（driver 说前置已清） |
| **D1 / D2-a / D2-c / D3 / E1** | ⬜ 未做。**D2 现在是判据 ①③ 的前置**，优先级应上调。 |
| **批 1 的 7 条待建脚本** | ⬜ 未做（driver 决定搭到 S3 那轮） |
| **R-15** | ⬜ 归 Owner（driver 已答），未碰 |
| **R-18** | ⬜ 未核（`dsh-subagent` 的 `maxDepth: 1` 与本插件拓扑的交互） |
| **§7 / `.npmrc` / 依赖面 / 契约 / 两份裁定** | ✅ 均未动 |
| **跨重启 / 浏览器** | 不适用（无部署改动、无 client 改动） |

---

## 7. 下一跳

**建议：S3 或 D2，而不是继续留在 S1。**

理由：
1. **判据 ①③ 已实测证明被 D2 挡住** —— 留在 S1 没有可转绿的东西了；
2. **D2 在发布阻断项的关键路径上**，且它一旦落地，判据 ①③ 就会变成**可写**（tripwire 会翻）；
3. **S3 前置已清**（driver 确认 §7-dev 就位），且它顺带能建那两条独立脚本（`verify-role-presets-roster.mjs` / `test-tier0-predicate.mjs`）。

**我需要 driver 一个决定**：**下一轮做 D2 还是 S3？**
- 若 **D2**：顺带把 §6 的 `agentOptions` 差异一并裁掉，①③ 当轮即可转绿；
- 若 **S3**：批 1 的出口项推进更快，但 ①③ 继续挂着。
