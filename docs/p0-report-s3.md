# P0 · S3 报告（预设进名册 —— 部分完成：G-P0 ⑤ 已建并绿；代码侧收敛未做）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **基线**：`27445a2`。
> **锚点**：commit + 符号；**计数只作诊断，不作断言**（driver §11 的更正）。
> **本文件第一栏即写明本轮做到了哪一半。**

---

## 1. 结论

| S3 产出 | 状态 |
|---|---|
| **G-P0 ⑤ `verify-role-presets-roster.mjs`** | ✅ **已建并绿**（`12/12`、恰好一行、`roots` 含该项、`trust: system`、`default === "standard"`、0 warning、exit 0） |
| **① 单一挂载函数 `mountRolePreset(agentCtx, presetId)`** | ⬜ **未做** |
| **② `resolvePresetFile` 降级为 project/global 读取器** | ⬜ **未做** |
| **③ `scripts/test-role-preset-roster.mjs` 三条断言** | ⬜ **未建**（依赖 ①②） |

**G-S**：`npm run typecheck` **0**；`npm test` → **261 pass / 0 fail**（无回归；本轮的脚本不进 `npm test`，它是 G-P0 闸脚本，按各自期望码单独判）。

---

## 2. 证据（可独立复跑）

### 2.1 G-P0 ⑤

```
$ node scripts/verify-role-presets-roster.mjs
# presets healthy=12/12 roots=1 default="standard" agent_presets_rows=1 warnings=0
exit=0
```

**它怎么判**（不是重读 YAML）：

- 用**宿主自己的** `dsh-app-boot`，按它自己的 `readProfilePatches` 同序拼四层：
  `profile.layers.flatMap(patch)` → profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → overlays；
- 两个半边都用宿主的 loader 读（`loadProfileDirectory(..., {userLayer:false})` 与 `loadOptionalPatches`）⇒ **本脚本没有第二份 YAML 读取器**可漂移；
- 断言落在**合成结果**上：`id: agent-presets` 恰好一行、`config.default === "standard"`、`config.roots` 里 `~/.dsh/orchestra/catalog-presets` 恰好一项且 `trust === "system"`；
- 12 个目录逐个 `stat` `agent.cordis.yml`；
- `composeEntries` 的任何 "not found / unknown" warning 也算失败（"文件对但没应用上"就是这样浮出来的）。

**默认只验 dev**；`web` 既不默认也不顺带（U9 边界）。`--profile web` 需显式传。

### 2.2 断言不是恒真 —— 四种形态实测

`rosterFailures()` 已导出为**纯函数**（脚本被直接运行时才跑 `main()`），所以失败分支可被真正执行：

```
$ node --input-type=module -e "import { rosterFailures } from './scripts/verify-role-presets-roster.mjs'; ..."
happy path failures: []
two-hop      -> ["composed entry list has 2 rows with id \"agent-presets\"; exactly one is required (two rows means the patch was written as a two-hop insert, which overrides nothing — plan §7.4 probe C)"]
no default   -> ["composed agent-presets config.default is undefined; expected \"standard\" (a `config` override is a shallow per-key replacement, so writing it without `default` drops the bundle's value)"]
wrong trust  -> ["the catalog root trust is \"user\"; expected \"system\""]
```

**三种已知错法全部被拒**（两跳、漏 `default`、trust 写错），happy path 通过。

**为什么把断言抽成纯函数**：只跑脚本只能证明"当前部署是对的"，也就是 happy path；把断言导出后，三个失败分支才有可执行的证据。这是本仓 `--self-test` 纪律的同一种做法。

### 2.3 用法与前置缺失

```
$ node scripts/verify-role-presets-roster.mjs --profile nope
verify-role-presets-roster: profile directory not found: /Users/yuantian/.dsh/profiles/nope
usage: ...
exit=2
```

`dsh-app-boot` **不是本仓依赖**（它是 app 的 boot 层，不是 plugin peer），所以脚本从**宿主安装**借引擎（`--dsh` / `DSH_INSTALL` / 全局位置三级回退），找不到就 **exit 2**。**未改 `package.json` 依赖面**（按约束）。

---

## 3. 为什么代码侧 ①② 没做（如实，含已完成的前置调查）

本轮预算花在 G-P0 ⑤（它自足、且在批 1 清单里），代码侧收敛**未开工**。但**调查已做完**，下一轮可直接落笔：

### 3.1 一个必须先说的实测更正

计划 §1 S3 与 §4.7 步骤 4 都写：名册来源的解析结果 **`path === ""`**。**实测不是这样。**

```
$ grep -n -A24 "interface AgentPreset" node_modules/@deepseek-ai/dsh-agent-presets/lib/types/preset.d.ts
export interface AgentPreset {
    readonly id: string;
    readonly trust: PresetTrust;
    /** Absolute path of the preset's agent composition file. */
    readonly path: string;          ← 必需字段，不是可空
    ...
}
```

`resolve(id)` 返回的是 `Promise<AgentPreset>`（`lib/types/index.d.ts:165`），`path` 是**必需的绝对路径**。当前 `src/orchestra-role-presets.ts` 里那个 `if (resolved.path === "") return { path: "", source: "dsh" }` 分支是**防御性代码**，真实名册**不会**走到它。

⇒ **别照字面写"roster 来源 `path === ""`"这条断言**——它会在真实名册上失败。正确的可判形态见 3.2。

### 3.2 更关键的发现：`mountPreset` 本来就吃「已解析的预设对象」

```
$ grep -n -A16 "declare function mountPreset" node_modules/@deepseek-ai/dsh-agent-presets/lib/types/mount.d.ts
export declare function mountPreset(agentCtx: Context, preset: AgentPreset): Promise<void>;
```

`mountPreset(ctx, preset)` 收的是 **`AgentPreset` 对象**，不是 `{id, trust, path}` 三件套。现有 4 处调用点传的是**手工造的** `{id, trust, path}`（`session-blueprint.ts` ×2、`orchestra.ts`、`a2a-transport.ts`）——**形状恰好够用，只是因为 `AgentPreset` 的其余字段可选**。

⇒ **"名册来源不再生成 path"其实在类型层已经成立**：名册路径拿到的就是 `resolve()` 的返回值，直接喂 `mountPreset` 即可；需要"生成 path"的**只有 project/global 两个覆盖来源**（本地目录里的自定义预设文件）。

**这使 S3 的最小改法比计划字面更小**：

```ts
// 单一挂载函数（下一轮的落点）
export async function mountRolePreset(agentCtx: Context, presetId: string): Promise<void> {
  const presets = agentCtx.get("agentPresets");            // 与 U3 的 sessionController 同规格：可选服务用 get
  if (presets === undefined) throw new RolePresetError("preset_unavailable", ...);  // 类型化，不静默回退
  const resolved = await presets.resolve(presetId);        // ← 名册来源在这里就对了
  await mountPreset(agentCtx, resolved);                   // ← 不再需要 path
}
```

### 3.3 需要 driver 裁一处口径（我不自行决定）

计划把 `resolvePresetFile` **降级为"仅用于 project/global 覆盖来源的读取器"**。但 `resolveRolePresetFile` 的优先级是
`project → global → dsh(名册) → builtin(catalog 目录)`，**`builtin` 也会产出一个真实 path**（它把 `spec.cordisYml` 物化到 `~/.dsh/orchestra/catalog-presets/<id>/agent.cordis.yml`）。

⇒ 两种读法，**影响 S3 的形态**：

| 读法 | 含义 | 后果 |
|---|---|---|
| **(a) 只降级 `dsh` 来源** | "名册来源不再生成 path"字面成立：`dsh` 走 `resolve()+mountPreset`；`project`/`global`/`builtin` 仍走 path | 保留 `builtin` 的物化路径 ⇒ **名册认这个根（§7 已做）之后，`builtin` 其实是多余的**：同名预设会先被 `dsh` 命中 |
| **(b) `builtin` 也改成名册解析** | 物化仍做（首次安装），但**解析走名册** | 与 §7 的部署意图一致，代码更简单；但**前提是名册一定认那个根**——而 G-P0 ⑤ 现在正是这条前提的闸 |

**我的判断倾向 (b)**，理由是 §7 做完之后 `builtin` 分支在解析顺序上**永远不可达**（`dsh` 先命中），留着它就是一条死分支——正是 S 组要清的那种。**但这是语义决定，按规则一交 driver 裁**，我不自行选边。

### 3.4 三条退出判据的可判形态（按实测改写后）

| 计划原文 | 实测后的可判形态 |
|---|---|
| ①三来源各解析一次，`source` 正确且 **roster 来源 `path === ""`** | `project`/`global` 解析出真实 path 且 `source` 正确；**名册来源**解析出 `source === "dsh"` **且其 `path` 指向名册根下的真实文件**（不是 `""`）——**且该 path 不被 `mountRolePreset` 使用**（这一条用行为断言：`presets.mount` 被调用、`readFile(preset.path)` 未被调用） |
| ②`readySnapshotAfterWrite` 后 `compositionInventory` 有该 preset 的行 | 不变（这条与实测一致） |
| ③全仓不存在 `presetSource === "file"` 的调用点 | 不变（grep 断言写进测试） |

---

## 4. 未做 / 未验证

| 项 | 状态 |
|---|---|
| **`mountRolePreset`** | ⬜ 未实现（落点见 §3.2；待 §3.3 口径裁定） |
| **`resolvePresetFile` 降级** | ⬜ 未做（待 §3.3） |
| **`scripts/test-role-preset-roster.mjs` 三条断言** | ⬜ 未建（断言词已按实测改写，见 §3.4） |
| **S3 的四处挂载调用点改造**（`session-blueprint.ts` ×2、`orchestra.ts`、`a2a-transport.ts`） | ⬜ 未做 |
| **S4** | ⬜ 未做（driver 说可搭车，本轮预算不足） |
| **次要项：G-BUDGET 输入可达性探针** | ⬜ **未做**（见 §5 —— 本轮预算耗尽，未读 `orchestra-state.ts` 的持久化面，**不猜结论**） |
| **D1 / D2-a / D2-c / D3 / E1** | ⬜ 未做 |
| **S2** | ⬜ 未做；判据 ② 全仓口径**未提前宣布** |
| **§7 / `.npmrc` / 依赖面 / 契约 / 两份裁定** | ✅ 均未动 |
| **R-18** | ⬜ 未核 |

---

## 5. G-BUDGET 输入可达性探针 —— **未做，如实标注**

driver 要求：判 `per_round.delivery.new` 这类**逐节点逐轮**归集**能否只靠 `team.json` + 会话事件流**算出（不需要 P2-2 的节点记录）。

**本轮未做这个判定。** 理由：它是一个需要读 `orchestra-state.ts` 的队形持久化结构 + 会话事件流归集路径的独立调查，而我把本轮预算用在了 G-P0 ⑤（它自足、且是批 1 清单里的具名项）。**我不在没有证据的情况下给结论**——按 brief"没有代码 + 没有实测输出，不得写成已实现"，这里只能写**未验证**。

**下一轮我把它当第一件事做**，判据形态：读 `orchestra-state.ts` 的 `TeamState`/`TeamRole` 结构 + 现有会话读取路径（`scripts/check-session-readable.mjs` 的 zstd 解码形状、`test-tool-schemas.mjs` 的 session double），回答
①`per_round`（轮）能否从 `turn/start`…`turn/end` 区间切出来；
②每个区间里的工具调用能否归集到 `nodeId`（若 `team.json` 里没有 sessionId→nodeId 的映射，这一步就是**不能**）。
若 ② 不成立 ⇒ **G-BUDGET 标"延后（landing = 批 2 / P2-2）"**。

---

## 6. 下一跳

**优先序建议**（S3 未完成 + 两个具名闸脚本尚未建 + S4 未做）：

1. **G-BUDGET 可达性探针**（driver 点名的次要项，可独立收口）；
2. **S3 代码侧**——但**先需要 §3.3 的口径裁定**（`builtin` 是否也走名册解析），否则 `resolvePresetFile` 的降级形态定不下来；
3. **S4**（无前置，且必须在 D2 之前）。

**我需要 driver 两个输入**：
- **§3.3 的口径裁定**：`resolvePresetFile` 的降级是"只降级 `dsh`"还是"`builtin` 也走名册"？
- **§3.4 的判据改写是否接受**：计划原文的"roster 来源 `path === ""`"与实测冲突，我改成"`path` 指向真实文件但不被 `mountRolePreset` 使用（行为断言）"——这属**判据措辞变更**，不由我自己落定。
