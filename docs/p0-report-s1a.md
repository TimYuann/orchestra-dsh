# P0 · S1a 报告（统一建会话入口 —— 三条路径已全部经 `buildRoleSession`）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **依据**：driver 判定「下一步 S1」+ 三条约束（一轮一个 S 项 / 判据 ② 分两步判 / 不动 §7）。
> **基线**：`a8ee40e`（依赖面已迁到 `0.1.6-alpha.2`；typecheck 0、254 pass）。**本轮工作前已重读 §0.1 / §0.2 / §4.8 / §7 / §11 的 U1–U9 改动**（含 B-5、R-15、R-18、S2 落点更正）。
> **锚点**：commit + 文件；行号仅辅助。

---

## 1. 结论

**S1a 完成并按本轮形态绿。** S1 判据 ② 的**本轮形态**达成；①③ 见 §4（未做，如实）。

| 项 | 状态 |
|---|---|
| **① 首波** → `buildRoleSession({kind:"create", mode:"governed", ...})` | ✅ 达成 |
| **`BuildRoleSessionResult` 补 `handle?: AgentHandle`** | ✅ 达成（首波仍收集 handle 做回滚） |
| **② 懒加载** → `try` 走 `buildRoleSession({kind:"create",...})`；`catch` 走 `{kind:"resume",...}` | ✅ 达成 |
| **③ 重激活** → `buildRoleSession({kind:"resume",...})`；`resumeRoleSession` 包装已删除 | ✅ 达成 |
| **④ `a2a-transport.ts` 的 `tryResume` 保留** | ✅ 未动（S2 的位置） |
| **⑤ `scripts/test-role-session-single-path.mjs` + 挂进 `npm test`** | ✅ 已建（3 用例）、已挂 |
| **判据 ② 本轮形态**：三条路径全经入口，`agents.resume(` 只在入口内一处 | ✅ 达成（见 §2.1 原始输出） |
| **判据 ① / ③** | ⬜ **未做**（依赖 S1b 的 `prepareRoleBlueprint` 收敛）—— 见 §4 |

**G-S**：`npm run typecheck` **0**；`npm test` → **257 pass / 0 fail**（基线 254 + 本脚本 3）。

---

## 2. 证据（可独立复跑）

### 2.1 判据 ② 的本轮形态 —— 原始 grep

```
$ grep -n "await ctx.agents.resume(" src/a2a.ts
322:    await ctx.agents.resume({

$ grep -n "await ctx.agents.resume(" src/a2a-transport.ts
213:  await ctx.agents.resume({

$ grep -c "agents\.resume(" src/orchestra.ts
1
$ grep -n "agents\.resume(" src/orchestra.ts
3512:  // `agentCtx.agents.resume(...)` inline; that call now lives in      ← 注释，不是调用

$ grep -n "await buildRoleSession(ctx, {\|await createRoleSession(ctx, {" src/orchestra.ts
2497:      const created = await buildRoleSession(ctx, {     ← 首波（governed create）
3069:      created = await buildRoleSession(ctx, {           ← 懒加载 create
3090:      await buildRoleSession(ctx, {                     ← 懒加载 resume 兜底
3575:        const created = await createRoleSession(ctx, {  ← 重激活 replacement create

$ grep -c "await createSession(ctx, {" src/orchestra.ts
0
```

**读法**：
- `orchestra.ts` **不再直接调 `agents.resume`**（唯一 grep 命中是注释）——懒加载兜底与重激活 resume 都已汇入入口。
- `a2a.ts` 的 `agents.resume` **只剩一处调用**，就在 `buildRoleSession` 的 `kind:"resume"` 分支里。
- **四条**调用点是**三条路径**：懒加载那条有两个（create + `already exists` 的 resume 兜底）。这也是我在测试里把期望值从 3 改成 4 的原因（首版断言写 3、实测 4 ⇒ 已更正）。
- `a2a-transport.ts` 那处**故意保留**（S2）。**全仓「只剩一处」的形态尚未成立**，测试文件里有一条专门的用例把这个边界钉住，防止它被读成已满足。

### 2.2 新脚本

```
$ node --test scripts/test-role-session-single-path.mjs
# tests 3
# pass 3
# fail 0
```

三个用例，**行为 + 结构两半**（理由写在文件头注释里）：

1. **行为半**：用 recording context 驱动入口的三种 spec 形态，断言每种形态到达哪个引擎原语（`kind:"resume"` ⇒ `agents.resume`；`kind:"create"+governed` ⇒ `agents.create`，且 receipt **与 handle 都带出来**；不给 `returnHandle` ⇒ **不产生 handle**，懒加载/重激活的契约不被悄悄改变）。
2. **结构半**：读 `src/orchestra.ts` / `src/a2a.ts` 源码，断言四条调用点、`orchestra.ts` 零 resume、`a2a.ts` 恰好一处、且 `createRoleSession` seam **默认实现是 `buildRoleSession`**（不是 `createSession`——那是"汇入"与"曾经汇入"的区别）。
3. **S2 边界**：断言 `a2a-transport.ts` 仍有自己的 resume，**并把这个事实写进断言文字**，使"全仓一处"不可能被静默当成已成立。

**为什么必须有两半**：只做行为半，一棵"根本没人调入口"的树也能通过；只做结构半，入口路由错了也发现不了（那正是 D4 抓到的形态）。

### 2.3 回归

```
$ npm run typecheck && npm test
# tests 257
# pass 257
# fail 0
```

**既有 254 项 0 回归。**

---

## 3. 过程中发现并修掉的一处**同类缺陷**（第三例）

懒加载路径原来这样传参：

```ts
created = await createSession(ctx, {
  ...
  presetId: role.preset ?? undefined,
  provider: role.model?.provider,
  model: role.model?.model,
  reasoningEffort: role.model?.reasoningEffort,
  ...
});
```

`provider` / `model` / `reasoningEffort` 在**缺失时也被当作键传了过去**（值为 `undefined`），于是**打不中 `createSession` 自己的 `options.provider !== undefined` 分支判断**——"没给模型"与"给了空模型"在下游看起来一样。`presetId`（`?? undefined`）同理。

修法沿用**同一函数里已经在用的写法**：`...(x === undefined ? {} : { x })`。

**这是与 D4 抓到的缺陷同一个类**：D4 那次是工具**返回值**里的 `undefined` 打穿 DSH 的 `snapshotJsonValue`；这次是**入参**里的 `undefined` 打穿下游的 `!== undefined` 判据。**两处都只改本地几行，没有建立"全局禁止 undefined 字段"的通用机制**——那会是 fix-scope creep（R-creep）。

---

## 4. 未做 / 未验证（如实）

| 项 | 状态 | 说明 |
|---|---|---|
| **S1 判据 ①**（三路径 setup 是同一函数） | ⬜ **未做** | 需要 S1b：两个 `prepare*Blueprint` 收敛为一个 `prepareRoleBlueprint`。**现在写这条断言会失败**（governed 走 `prepareGovernedBlueprint`、lightweight 走 `prepareLightweightBlueprint`）。 |
| **S1 判据 ③**（三路径 blueprint 记录字段集相同） | ⬜ **未做** | 同上，依赖 S1b。 |
| **S1b** | ⬜ 未开工 | 两个 `prepare*Blueprint` 收敛 + `spec.mode` 参数化。 |
| **重激活里单独重算 `agentOptions` 的那段** | ⬜ **按约束保留** | driver 同意我的判断：合并它是**行为改动**（两份算法边界不同：重激活看 `role.model` 的**部分**字段，`createSession` 看 `provider`/`model` 是否给全），属 S1b，**本轮没顺手合并**。 |
| **S2** | ⬜ 未做 | `a2a-transport.ts` 的 `tryResume` 原样保留。依赖面已就位（`resolveAgent` + `prompt`，U3 已把落点更正进计划 §1 S2）。 |
| **§7** | ✅ **未碰** | 按约束；dev 侧已由 Owner 完成。 |
| **S3** | ⬜ 未做 | driver 说 §7-dev 就位后 S3 前置已清 ⇒ 可在 S1b 之后直接进。 |
| **D1 / D2-a / D2-c / D3 / E1（批 1 剩余）** | ⬜ 未做 | |
| **批 1 G-P0 清单的 7 条待建脚本** | ⬜ 未做 | `verify-role-identity.mjs`(+`--self-test`)、`verify-d2-approval.mjs`(+`--self-test`)、`verify-role-presets-roster.mjs`、`test-orchestra-archive.mjs` 扩展、`test-tier0-predicate.mjs`、`verify-agent-budget.mjs`。 |
| **R-15 / R-18（U1 / U7 的新待核项）** | ⬜ **未核** | 计划自己标"⚠️ 待核"的两条实测项（`patchReload` 依据失效；`dsh-subagent` 的 `maxDepth: 1` 与本插件拓扑的交互）。**本轮没碰**。⚠️ R-15 的核实测需要改 patch 文件 + 观察是否生效，**属 §7 邻域**——按约束我不动 §7，**建议明确它归谁**。 |
| **跨重启 / 浏览器验证** | 不适用 | 本轮无部署改动、无 client 改动。 |

---

## 5. 下一跳

**S1b**（收敛 `prepareRoleBlueprint`），做完后 S1 判据 ①③ 才能写；随后 **S3**（前置已清）。**再然后**才是批 1 剩下的 D1 / D2-a / D2-c / D3。

**一个建议**：批 1 G-P0 清单里的 **`test-tier0-predicate.mjs`** 与 **`verify-agent-budget.mjs`** 不依赖 S 组，可与 S1b 并行开一轮——尤其 `test-tier0-predicate.mjs` 是 driver 已认定的 **G-PRE 漏项**，且 `check-p0-preconditions.mjs` 的 V3 只验了"计划文本提到它"、没验文件存在。要不要下一轮先把它补上？
