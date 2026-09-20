# P0 执行报告 · 阶段一：D4（工具边界）+ E4（角色预设校验）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **基线**：`66cfc20`（开工闸 G-PRE 全绿 10/10）。**本文件只写已发生的实测**；凡未跑过的一律写「未验证」。
> **口径**：记录锚点用 **commit + 文件**；行号只作辅助定位（裁定 §2.2b：`file:line` 单独不构成固定版本来源）。
> **依据**：`docs/plan-0.8.0-execution.md` §1「D4」/「E4」、§4.7（N7 口径）、§11 G-P0 ⑦⑧、`docs/p0-scope-ruling.md` §1-4（V7）。

---

## 1. 结论

| 项 | 结论 | 判据 |
|---|---|---|
| **E4** | ✅ 已实现并实测通过 | 两条断言新增到 `scripts/test-orchestra-role-presets.mjs`；变异测试证明非恒真 |
| **D4** | ✅ 已实现并实测通过（**17/18 工具走到真实成功值，1 个按设计走类型化拒绝**） | `node --test scripts/test-tool-schemas.mjs` → `# pass 8 # fail 0` |
| **D4 的 `fault_ref`** | ✅ **已定位到机制并修复**（不是"计划要防的成类回归"，是**两个正在发生的真实缺陷**） | 见 §3 |
| **回归** | ✅ 无回归 | `npm run typecheck` 0；`npm test` → **254 pass / 0 fail**（基线 248 + E4 1 + D4 5） |

**两个真实缺陷（D4 首轮运行即抓到，均已修复）**：

- **P0-D4-1** `a2a_list` 返回值含 `undefined` 字段 ⇒ DSH 在工具边界把它判为"非无损 JSON"，**整个调用返回错误而不是数据**。
- **P0-D4-2** `a2a_read` 同上（`returned_turns`）。

---

## 2. 证据

### 2.1 E4 · 角色预设校验器拒绝危险默认值

**改动**：`scripts/test-orchestra-role-presets.mjs`（新增一条用例、两条断言 + import `validateRolePresetSpec`）。

**实测（原始输出）**：

```
$ node --test scripts/test-orchestra-role-presets.mjs
1..10
# tests 10
# pass 10
# fail 0
```

**变异测试（证明断言不是恒真）**：把 `src/orchestra-role-presets.ts` 里两条校验各注释掉后重建：

```
not ok 2 - E4: role preset validator refuses danger-full-access and any non-workspace-write permission default
# tests 10
# pass 9
# fail 1
```

**适用边界（R-creep 声明）**：本条只约束 **`validateRolePresetSpec`（角色预设默认值校验器）**。它**不**约束 `orchestra_add_lanes` 的工具面校验——那是另一个函数，已由 `scripts/test-add-lanes.mjs:343` 覆盖。**不得**由"角色默认不得 `danger-full-access`"反推"所有 spec / 所有入口都适用"。

### 2.2 D4 · 工具边界守卫

**改动**：`scripts/test-tool-schemas.mjs`（重写；从"由 schema 生成样本再验 schema"改为"调用真实 handler + 校验实际返回值"，V7）。

**守卫做什么（三条，全部走真实路径）**：

1. 用两个**分别按各自 `inject` 列表门控**的上下文注册两个 plugin half，捕获**全部 18 个**真实注册定义（11 `orchestra_*` + 7 `a2a_*`）；断言枚举数 == 18。
2. 对每个工具：用 DSH 自己的 `validateJsonSchemaValue(tool.parameters, args, "arguments")` 校验入参 → **真实调用 `tool.execute`** → 对**实际返回值**依次跑 DSH 自己的两步：
   `snapshotJsonValue(value) !== undefined`（`dsh-tools` `createSuccessResult` → `snapshotToolValue` 的真实路径）→ 再 `validateJsonSchemaValue(tool.output.schema, value, "value")`。
3. 上下文代理**只暴露 `inject` 列表里的服务**，读其余服务抛 `cannot get property "…" without inject`——与 `@deepseek-ai/cordis@4.0.2` `lib/index.js:675-681` 同一条消息、同一种行为（含"`?.` 吞不掉它"）。

**实测（原始输出）**：

```
$ node --test scripts/test-tool-schemas.mjs
# tests 8
# pass 8
# fail 0
```

**18 个工具的结果分类**：17 个走到**真实成功值**并通过两道校验；`a2a_create(execution:"subagent")` 在本 harness 未挂 subagent 后端，按设计走**类型化拒绝**（`refusals` 断言要求它必须是类型化前置条件，不是 schema 失败、不是崩溃）。

**变异测试（三条，证明守卫不是恒真）**：

| 变异 | 期望 | 实测 |
|---|---|---|
| `orchestra_topologies` 返回值加一个未声明键 `bogusKey` | D4-3 失败 | ✅ `'orchestra_topologies: "value.bogusKey" is not a declared property (additionalProperties: false)'` |
| 在 `a2a_status` handler 里读未声明的 `ctx.sandboxPolicy` | D4-3 + D4-5 失败 | ✅ `'a2a_status: expected a value, handler threw Error: cannot get property "sandboxPolicy" without inject'` 且 `# fail 2` |
| 把上下文代理改成暴露全部服务 | D4-4（自测）失败 | ✅ 该变异首先暴露了**守卫本身是死代码**（见 §4），修好后 D4-4 直接断言 trap 是活的 |

### 2.3 回归

```
$ npm run typecheck && npm test
# tests 254
# pass 254
# fail 0
```

**数字构成**：基线 248 + E4 1 + D4 5（8 条 D4 用例中有 3 条替换了原先 2 条的等价覆盖）= 254。**既有 248 项 0 回归**。

---

## 3. 两个真实缺陷（`fault_ref`）+ 修法

`docs/gate-round2-fixes.md:70` / `STATE.md` 登记的 `fault_ref` 原文是 `a2a_send` 报 `cannot get property "sandboxPolicy" without inject`。**本轮实测得到的结论比登记更具体**：

| # | 缺陷 | 机制（实测） | 为什么此前没被发现 |
|---|---|---|---|
| **P0-D4-1** | `a2a_list` 对"无事件且 header 无数字 `createdAt`"的会话返回 `lastActivityMs: undefined` / `lastActivity: undefined` | DSH 对每个工具结果先跑 `snapshotJsonValue`；**值为字面 `undefined` 的字段通不过 JSON 往返**，`snapshotToolValue` 随即抛 `ToolOutputError: value is not lossless JSON` | 既有测试全部给插件**普通对象上下文**，且**从不过工具边界**——值对不对从来不校验 |
| **P0-D4-2** | `a2a_read` 在零回合时返回 `returned_turns: undefined`（`src/a2a.ts` 原文即 `returnedTurns > 0 ? returnedTurns : undefined`） | 同上 | 同上 |
| **`fault_ref`（登记于 `docs/gate-round2-fixes.md` §5.2）** | `src/a2a.ts` 的 `inject` 列表**不含 `sandboxPolicy`**，而同文件以 `(ctx as any).sandboxPolicy?.resolve?.()` 读它 | **欠账已核实（grep 可核）并已修**；但**"是否会真的抛"未复现**——`cordis@4.0.2` 的守卫在找到真实 provider 时返回而不抛（见 §3 第 3 条的诚实边界） | 既有测试的上下文**没有 inject 守卫**（普通对象），生产里才有 |

**修法（三处，各自最小）**：

1. `src/a2a.ts` `listThreads`：两个可选字段改为**按需展开**（`...(lastTime === undefined ? {} : { lastActivityMs: lastTime })`）——**沿用该函数自己已经在用的写法**（`title` / `role` / `createdAt` 三处）。输出 schema 里这两个键本就是可选。
2. `src/a2a.ts` `readSessionText` 返回值：`returned_turns` 改为**按需展开**；其缺席已有的语义就是"没有返回任何回合"。
3. **`fault_ref` 本身得到处置**：`src/a2a.ts` 的 `inject` 列表补上 `sandboxPolicy`。同文件 `sendRawA2A` 一直在读 `ctx.sandboxPolicy.resolve(...)`，而它此前**未被声明**——**该文件的服务依赖是欠账的**。

**关于第 3 条的诚实边界**：我**未能把 `cannot get property "sandboxPolicy" without inject` 复现成线上故障**。本机装了 `@deepseek-ai/cordis@4.0.2`，其守卫源码（`lib/index.js:675-681`）会按 `service provide → isolate key → 父 fiber` 逐级查找，**找到一个真实 provider 就返回**；实测「提供该服务后再读」不抛错。因此**正确的表述是**：

- **已证实**：`src/a2a.ts` 读了一个自己没声明的服务（grep 可核）。
- **已修复**：补上声明，依赖从"偶然可读"变成"显式承重"。
- **未复现**：该欠账**在当前 DSH 0.8.0 部署下是否真的会抛**——文档里那句"调用失败并报 …"本轮**无法在仓库内复现**。
- **保留价值**：声明是**低风险且可核**的（见下），且 D4-4 自测现在**直接断言这条声明**，删掉它测试即失败（实测：`not ok 4 … error: 'a2a must declare the sandboxPolicy it reads'`）。

**为什么补声明是低风险的（先做内存/文件实测，不靠推断）**：`sandboxPolicy` 这一行由 **`@deepseek-ai/dsh-base` 的 bundle 层**插入（`dsh-base/cordis.patch.yml:208-212`），而 `dsh-base` 是**每一个** CLI profile 的底座（`~/.dsh/profiles/{web,dev}/package.json` 的 `dsh.profile.bundles`）；`orchestra.ts` **本来就已经注入它**（`src/orchestra.ts:430`），两个 half 在同一条组合里加载 ⇒ 不可能出现"orchestra 有、a2a 没有"的部署。`npm test` 全绿亦确认无回归。

**适用边界（R-creep 声明）**：修法 1、2 **只作用于这两个 handler 的这两个字段**。本轮**没有**建立"所有工具返回值都要过滤 `undefined`"的通用机制——那是一类**可以在实现中逐步收敛的写法**，不是 P0 的新义务。D4 守卫会持续看住这一类，但**不声称**它覆盖了全部未跑到的分支（`capability-boundaries.md` #4）。修法 3 **只作用于 `a2a.ts` 这一个 half 的 inject 列表**，不构成"所有插件都要重新声明依赖"的义务。

---

## 4. 过程中的一次自我更正（必须留痕）

**D4-4（"没有 handler 读未声明的服务"）最初的写法是恒真的。** 第一版守卫的上下文把**全部服务**都当属性暴露，于是 `ctx.sandboxPolicy` 永远能读到 ⇒ 该用例**无论代码怎么错都通过**。这一点是**用变异测试（去掉一个声明）实测发现的**，不是审出来的。

**改法**：上下文代理改为**只暴露 `inject` 列表里的服务**（`ctx.get(name)` 保持不门控，因为生产也不门控——那是读可选服务的官方途径）；并**新增一条自测用例**（D4-4），直接断言 trap 是活的：
- 声明的服务可读；
- 未声明的服务抛 `cannot get property "…" without inject`；
- **`?.` 吞不掉它**；
- 每次访问都被记账。

**这条自测的存在理由与 `scripts/check-session-readable.mjs` 的 `--self-test` 同源**：没有自测的核对脚本等于一个永远说 OK 的脚本（`docs/plan-0.8.0-execution.md` §4.7 步骤 5 已立此先例）。

---

## 5. 未做 / 未验证（如实）

| 项 | 状态 |
|---|---|
| **N7（重启后外部核对角色身份）** | **未做**。依赖 S1/S3/§7，属后续阶段。 |
| **D2-a / D2-b / D2-c** | **未做**。依赖 S1/S3/S4。`verify-d2-approval.mjs` / `verify-d2-decision.mjs` 尚未创建。 |
| **D3** | **未做**。 |
| `verify-role-presets-roster.mjs` | **未创建**。属 §7 部署步骤。 |
| S1–S6 | **未做**。计划把 S 组排在 P0 之前；本轮先做**零依赖**的 D4/E4（两者都不依赖 S 组），S 组仍未开工。**这一点与计划 §3 的顺序不一致，理由写在 §6。** |
| `a2a_send` 的 `sandboxPolicy` 缺陷 | **已修**（`src/a2a.ts` 的 `inject` 补上 `sandboxPolicy`）。**但未能复现成线上故障**——见 §3 的诚实边界。 |
| G-P0 整闸 | **未跑**（9 个脚本里只有 2 个存在）。 |
| 浏览器验证（G-CLIENT） | **不适用**：本轮**无 client 改动**（`git diff --stat src/client/` 为空）。 |

---

## 6. 与计划 §3 顺序的偏离（显式声明，不是遗漏）

计划 §3 的顺序是 `B-1..B-4 → S1..S6 → §7 部署 → P0`，即 S 组整体先做完。**本轮先做 D4 + E4**，理由：

1. **D4 / E4 的前置依赖为空**。计划 §3 的依赖表里，S 组是 D1/D2/D3 的前置（"D2 | S1 + S3 + S4"、"D1/N7 | S1 + S3 + §7"），但 **D4 与 E4 不在那张表里**——它们只改 `scripts/` 下的测试，不碰 S 组收敛的三条建会话路径。
2. **D4 是 P0 的**直接工具边界测试**（裁定 §5），且它的 `fault_ref` **已经是一起付过成本的真实故障**。先把它建成，S1–S6 的每一步改动就都有一道现成的工具边界闸——**顺序反过来会让 S 组在无守卫的情况下改 5286 行的 `orchestra.ts`**。
3. **E4 明文"零实现增量"**（`p0-scope-ruling.md` §5），任何时候做都一样。

**边界**：这只调整了 **P0 内部两项（D4/E4）与 S 组之间的先后**，**没有**扩大 P0 范围，**没有**跳过任何 S 项——S1–S6 仍是 D1/D2/D3 的前置，仍未开工。
