# P0 · S3 报告（预设进名册 —— 代码侧完成）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **基线**：`69b62d8`（G-P0 ⑤ 已绿）。
> **锚点**：commit + 符号；**断言全部锚在符号与行为上，不锚计数**。

---

## 1. 结论

**S3 完成。** 单一挂载函数落地、四处调用点全部改走它、名册来源不再生成 path、三条断言已建并绿。

| 产出 | 状态 |
|---|---|
| ① 单一挂载函数 `mountRolePreset(agentCtx, input)` | ✅ `src/role-preset-mount.ts`（新模块） |
| ② `resolvePresetFile` 降级为 override 读取器（`project`/`global`）；名册来源不再生成 path | ✅ 见 §3 |
| ③ 四处挂载调用点改走 `mountRolePreset` | ✅ **实际 5 处**（见 §3.1，比 driver 点的 4 处多一处 `a2a.ts`） |
| ④ `scripts/test-role-preset-roster.mjs` 三条断言 + 挂进 `npm test` | ✅ 5 用例 |
| ⑤ `npm test` 全绿 | ✅ **266 pass / 0 fail**（261 + 新脚本 5） |
| G-P0 ⑤ `verify-role-presets-roster.mjs` | ✅ 仍绿（`12/12 … warnings=0`，exit 0） |

**G-S**：`npm run typecheck` **0**；`npm test` → **266 pass / 0 fail**。

---

## 2. 证据（`npm run build` 之后单跑）

```
$ npm run build && node --test scripts/test-role-preset-roster.mjs
# tests 5
# pass 5
# fail 0

$ node scripts/verify-role-presets-roster.mjs
# presets healthy=12/12 roots=1 default="standard" agent_presets_rows=1 warnings=0
exit=0

$ npm run typecheck && npm test
# tests 266
# pass 266
# fail 0
```

**接线证据（原始 grep）**：

```
$ grep -rn "await mountRolePreset(" src/*.ts
src/a2a-transport.ts:224
src/a2a.ts:444
src/orchestra.ts:3638
src/session-blueprint.ts:641
src/session-blueprint.ts:869

$ grep -rln "mountPreset" src/*.ts
src/role-preset-mount.ts        ← 只有决策模块导入引擎的文件挂载 API
```

`session-blueprint.ts` 里仅剩一处**注释**提到 `mountPreset`，无调用。

---

## 3. 关键改动

### 3.1 实际是 **5 处**调用点，不是 4 处

driver 点的是"四处挂载调用点"。实测 `mountPreset` 直调有 **5 处**：`a2a-transport.ts`、`a2a.ts`、`orchestra.ts`、`session-blueprint.ts` ×2。**第 5 处是 `a2a.ts`**（lightweight 协作者的 preset 分支）——它不在 driver 的清单里，但它**同样**是"用 `mountPreset(手工三件套)` 挂一个可能属于名册的预设"，正是 S3 要收的那类。**我把它一并改走入口**，并在测试里断言"只有决策模块可导入引擎的文件挂载 API"，使这条不会再漂。

### 3.2 `a2a.ts` 的两个分支合并为一个

改前：

```ts
} else if (options.presetFile !== undefined) {      // 走 mountPreset(手工三件套)
} else if (options.presetId !== undefined && …) {   // 走 presets.mount(resolved.id)
```

改后：**一个分支**，因为"用文件还是用 id"是**预设来源的属性**，不是"调用方碰巧怎么描述它"的属性：

```ts
} else if (options.presetFile !== undefined || (options.presetId !== undefined && options.presetId !== "")) {
  …
  setup = async (agentCtx) => {
    await mountRolePreset(agentCtx, {
      presetId,
      ...(presets === undefined ? {} : { roster: presets }),
      ...(file === undefined ? {} : { overrideFile: { id: file.id, trust: file.trust, path: file.path } }),
    });
    installModelOverride(…);
  };
}
```

### 3.3 `orchestra.ts`（重激活）—— 这是真正修掉缺陷的那一处

改前它**无条件**走文件挂载：

```ts
await mountPreset(agentCtx, { id: presetFile.id, trust: presetFile.trust, path: presetFile.path });
```

一个**名册已知的预设**被按字节组装：没有 discovery、没有 standing mount、没有可被恢复路径再次找到的身份。**这正是"重启后角色会话丢掉组合"那条发布阻断项的一个机制级成因。**

改后按来源分流：

```ts
await mountRolePreset(agentCtx, {
  presetId: presetFile.id,
  ...(presetFile.source === "project" || presetFile.source === "global"
    ? { overrideFile: { id: presetFile.id, trust: presetFile.trust, path: presetFile.path } }
    : {}),                                       // ← dsh / builtin：不传文件 ⇒ 按 id 挂
});
```

### 3.4 ② 的落地形态：`resolvePresetFile` 只服务于 override

`resolvePresetFile` 的 path **只在 `source === "project" | "global"` 时被使用**（即被当作 `overrideFile` 传下去）。`dsh` / `builtin` 来源下它算出的 path **不被任何挂载路径使用** —— 这就是"仅用于 project/global 覆盖来源的读取器"的可判形态。**没有为它伪造 `path: ""`**（裁定 D）。

### 3.5 一个设计决定：名册的**优先级**

`mountRolePreset` 取名册的顺序是 **调用方传入的 `roster` 优先，`agentCtx.get("agentPresets")` 兜底**。

理由（这是实现中实测逼出来的）：`a2a-transport` 在 setup 窗口**之前**就已捕获名册，而它的测试给的 `agentCtx` 是**刻意的极简对象**（没有 `get`）。若先查 `agentCtx`：
- 会向每个挂载询问一个调用方已经提供的服务；
- 更糟，可能用**另一个名册**合成 agent，而那个名册并非解析出该 id 的那一个。

我第一次实现时正是先查 `agentCtx`，被测试抓到（`ctx.get is not a function` ⇒ 修成防御式读取 ⇒ 仍然是先查、被断言抓到"不应询问上下文"）⇒ 改为 roster 优先。**这条是测试逼出来的，不是设计时想到的。**

---

## 4. 一处测试断言的**收窄**（我改了 driver 给的判据措辞，说明理由）

driver 裁定 ③ 是"全仓不存在 `presetSource === "file"` 的调用点"。**实测全仓有两处该字符串，且都不该被删**：

| 位置 | 它在做什么 | 该不该拦 |
|---|---|---|
| `a2a-transport.ts` | `marker?.presetSource === "file" && marker.presetPath !== undefined` —— 从**持久化 marker** 重建一个 override 文件 | ❌ 不该拦：它读的是**已存记录**，不是"选择挂载 API" |
| `session-blueprint.ts` | 校验 marker 的 file 字段是否自洽 | ❌ 不该拦：**记录校验** |

**我的处理**：把断言收窄为它真正要禁的东西 —— **"任何**选择挂载 API**的分支不得基于 `presetSource === "file"`"**（即同一行里同时出现 `presetSource === "file"` 与任一挂载符号）。两处 marker 读取**不命中**，因此保留。

**理由必须写明**：若照字面断言，将来某个维护者会**为了让测试变绿而删掉一段 marker 校验**——那是把测试变成了破坏来源。我在测试里逐字写了这个理由。**若 driver 认为该按字面执行，我需要被告知**，因为那会要求删掉两处校验。

---

## 5. 未做 / 未验证

| 项 | 状态 |
|---|---|
| **G-BUDGET 可达性探针** | ⬜ **未做**（driver 本轮明确划出，移到 S3 之后单独收口） |
| **S4** | ⬜ 未做（driver 说下一轮） |
| **`builtin` 分支处置** | ✅ **按裁定 E 未动**（保持现状，登记 S6 候选） |
| **判据 ② 全仓口径** | ⬜ **未提前宣布**（留 S2） |
| **跨重启实测** | ⬜ **未做**。S3 改的正是"重启后身份"，但**真正的证明是重启后派活**（N7）。本轮只做到"挂载路径按来源分流 + 单元级行为断言"，**没有**声称冷恢复已经修好。**这是本轮最重要的一条未验证。** |
| **`dsh` 来源的实际可达性** | ⚠️ **部分未验证**：`source === "dsh"` 要求 §7 的根被名册认到（G-P0 ⑤ 已证**合成结果**正确），但"进程内 `presets.resolve(id)` 真能解析到这 12 个 id"要到**重启后的真实实例**才能证。**单元测试用的是注入的 roster double，不是真名册。** |
| **§7 / `.npmrc` / 依赖面 / 契约 / 两份裁定 / 计划文件** | ✅ 均未动 |
| **R-18** | ⬜ 未核 |

---

## 6. 下一跳

按 driver 的排序：**① G-BUDGET 可达性探针**（独立小项）→ **② S4** → ③ D2（S3 已完成，D2 的 `S1+S3+S4` 前置只差 S4）。

---

## 7. 我建议一并实测的一项（防止"闸绿了但缺陷没修"）

S3 的改动**在机制上**对准了发布阻断项（角色重启后丢组合），但**本轮的证据只到"挂载 API 选对了"**。要证明缺陷真的修好，需要一次**真实实例的跨重启**：

1. dev 实例（4600）建一个名册预设的角色会话；
2. 重启进程；
3. 从**外部**核对恢复后的实际组合（`agentPresets.compositionInventory` / 会话 header 的 `agentPreset` 投影），并**用一次真实角色工具调用校准**。

这正是 **N7 / `verify-role-identity.mjs` 的形状**，也正是 D1 的验收。**我倾向把它作为 S4 之后、D1 之前的独立一轮**，而不是等到 D1 才第一次跑——否则 S3 与 D2 的改动会一起堆到那一步才被检验。
