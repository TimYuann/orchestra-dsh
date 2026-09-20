# 审查轮次台账（开发平面）

> **依据**：`docs/ruling-d1-d5-oracle.md` §3.3 的责任附件（**"P0 不建 schema" ≠ "轮次计数可以不记"**）。
> **纪律**：自该裁定起，**每一轮次都以 `docs/` 下的记录文件落盘**（轮次编号 + 问题 id + 裁定 + 落点行号）。
> **口径**：**换版本不清零**（裁定 §4.6）——计数对象是**问题**（问题 id），不是文档 id。契约升 v1.2.1 **不**让任何问题从 0 重新计。
> **字段口径（裁定 §3.3）**：下表是**台账**，**不是** P2 的节点记录 schema。P2 落地时 **`reviewRounds` 是必填字段**。

---

## 1. 轮次台账（可核：git + 文件内容）

| 轮 | 内容 | 条数 | 记录文件 |
|---|---|---|---|
| 计划门 1 | F1–F23 | 23 | `docs/gate-round1-fixes.md`（§A/§C/§E） |
| 计划门 2 | 六处修订（H-1…H-6） | 6 | `docs/gate-round2-fixes.md` |
| 计划门 3 | P-1…P-12（Pro 二审否掉 PASS 后派生） | 12 | `docs/gate-round3-pro-findings.md` §P-1…P-12 |
| 计划门 4 | R3-1…R3-5（**终判 PASS**） | 5 | `docs/gate-round3-pro-findings.md` 末节 |
| **第 5 轮** | **V1–V10（编辑任务，非审查轮；由独立裁定给出）** | 10 | `docs/ruling-d1-d5-oracle.md` §4.4 + 本文件 §2 |
| 外部复审 | Pro 第 1/2/3 轮 | — | **原文不在仓库**（`.gitignore:23` 忽略 `reports/`） |

**计数更正（裁定 §4.1 / §6 #3）**：提问所写"第 3 轮 4 条、第 4 轮 5 条"**不成立**——第 3 轮实为 **12 条**（P-1…P-12），第 4 轮 **5 条**（R3-1…R3-5）。以文件内容为准。

## 2. 问题 id 级计数（换版本不清零）

**每条问题以 id 计次**，跨文档版本连续计数：

| 问题 id | 首次提出 | 后续提出 | 当前计数 | 状态 |
|---|---|---|---|---|
| **档 0 谓词 / 小用法零成本** | 计划门 3 · P-1 | 计划门 4（PASS）→ **第 5 轮 V1**（同一问题的**第 3 次提出**） | **3** | 已落（§0.4 + V1 收窄 + `test-tier0-predicate.mjs`） |
| **修复范围蔓延（fix-scope creep）** | `docs/p0-scope-ruling.md:11` | 裁定 §3.1 追认为**上一级根因** | 2 | 已按 §3.1 处置（V5/V6 削去两处普遍化） |
| **`refusalTest` 普遍义务** | 计划门 3 · P-9 | 裁定 §3.1 例 ② | 2 | 已落（V5：降为工具实现测试） |
| **"行数 == 用例数"覆盖代理** | 计划门 3 · P-10 | 裁定 §3.1 例 ① | 2 | 已落（V6：改为用例存在性 + 前缀可解析） |
| **B-4 交付依赖缺席拖停 A2A** | `docs/p0-scope-ruling.md` §1-2 | 裁定 §4.3 ② | 2 | 已落（V2） |
| **有限审查出口缺失** | `docs/p0-scope-ruling.md:27` | 裁定 §4.3 ③ | 2 | 已落（V4 → 计划 §0.1a） |

## 3. 本台账自身的适用（自我示范）

裁定 §4.6 明确：**本裁定的自我适用**就是按"同一问题不因换版本清零"做的——V1 的问题最早出现在第 3 轮（P-1）、第 4 轮记为 PASS，`p0-scope-ruling.md` §1-1 再次提出**同一问题**，故按**第 3 次**计，而非因契约升 v1.2.1 重新从 0 开始。

## 4. 执行轮次（P0 收窄版；开工闸 G-PRE 全绿于 `66cfc20`）

> **口径**：本节记的是**执行期**的轮次与问题 id，与 §1 的**开发平面审查轮**分开计。锚点 = **commit + 文件**（行号仅辅助）。

| 轮 | 阶段 | 问题 id | 结论 | 落定位置（commit + 文件） |
|---|---|---|---|---|
| E-1 | **D4 工具边界** | **P0-D4-1** `a2a_list` 返回值含 `undefined` ⇒ DSH 判"非无损 JSON"、整调用失败 | **已核实并修复** | `src/a2a.ts`（`listThreads` 两个可选字段改按需展开）；`docs/p0-report-d4-e4.md` §3 |
| E-1 | **D4 工具边界** | **P0-D4-2** `a2a_read` 同因（`returned_turns`） | **已核实并修复** | `src/a2a.ts`（`readSessionText` 返回值改按需展开）；同上 |
| E-1 | **D4 工具边界** | **P0-D4-3** `src/a2a.ts` 读未声明的 `sandboxPolicy`（登记于 `docs/gate-round2-fixes.md` §5.2 的 `fault_ref`） | **欠账已核实并补声明**；**"是否会真的抛"未复现**（诚实标注，见报告 §3） | `src/a2a.ts` `inject`；`docs/p0-report-d4-e4.md` §3 第 3 条 |
| E-1 | **D4 守卫自身** | **P0-D4-4** D4-4 用例首版**恒真**（上下文暴露全部服务 ⇒ trap 是死代码） | **已用变异测试发现并修复**；新增 liveness 自测 | `scripts/test-tool-schemas.mjs`（`guardedContext` + D4-4 自测）；`docs/p0-report-d4-e4.md` §4 |
| E-1 | **E4 角色预设校验** | **E4**（`validateRolePresetSpec` 两条断言，零实现增量） | **已实现并变异验证非恒真** | `scripts/test-orchestra-role-presets.mjs`；`docs/p0-report-d4-e4.md` §2.1 |
| E-1 | **闸口径** | **P0-F1** G-P0 的**具名脚本表**（`docs/plan-0.8.0-execution.md` §11）仍列 `test-decision-queue.mjs`(E2/E3) 与 `test-design-gate.mjs`(F1′)，而**同一行的退出判据 ⑧ 已按 V1 把它们移出 P0** ⇒ 表与判据**自相矛盾** | **按判据执行、表留待修订**；已登记 | `docs/p0-report-gate-p0-inventory.md`；**未改计划文件**（属开发平面编辑任务，非执行者可自行决定） |
| E-2 | **D2-b / 判据 ④** | **P0-F2** G-P0 判据 ④（`verify-d2-decision.mjs` 六用例）与 V1 冲突：六用例全落在 E2/E3/P3-5，而 V1 明令这三项退出 P0 | **已由 driver 裁定（选项 1 的改归属形态）**：①P0 可交付 = **D2-a + D2-c**；②判据 ④ **不删、标"延后（landing = 批 2 / G-P2）"、编号不动**；③六用例随 E2/E3 进批 2 并成为 **G-P2** 判据项；④口径优先级规则：**V 条目与未同步的计划行冲突时以 V 条目为准**，落败行标延后 + 写明 landing，不许静默删除 | `docs/p0-report-gate-p0-inventory.md` §4；本文件 §5 |
| E-2 | **S2 落点** | **P0-F3** 计划 §1 S2 / §3 写的 `sessionController.resume(...)` **在本版 API 上不存在**（`resume`/`resumeObserved` 是 `AgentService` 私有方法） | **已按实测更正落点**：改用公开的 `resolveAgent(sessionId)`；依赖按 driver 授权加 peer+dev | `docs/dsh-native-capabilities.md` §1 + §5 |
| E-2 | **依赖面** | **P0-F4** `@deepseek-ai/dsh-api-session-controller` 原本不在 peer/dev 面，S2 无法编译 | **已按 driver 授权落地并实测**：peer+dev 各一条 `^0.1.5-rc.2`；tgz 内 `@deepseek-ai` 条目 **0**；两个 profile 的 `@deepseek-ai/` 仍只有 `cosmokit`+`schemastery`（无新增目录） | `package.json`；`docs/dsh-native-capabilities.md` §5 |
| E-2 | **S2 落地形态** | **P0-F5** driver 约束：不得把 `sessionController` 写进 `inject`（硬依赖 ⇒ 服务缺席会让**整个 a2a 插件** waiting、`a2a_*` 全套工具消失） | **采用 `ctx.get("sessionController")` + 调用点抛类型化错误**（二者都满足"类型化失败、不静默回退"，但失败面小一个数量级；也是 Cordis 官方规则） | 本轮为**已记录的决定**，S2 代码尚未写 |

**E-1 的 G-S 回归**：`npm run typecheck` 0；`npm test` → **254 pass / 0 fail**（基线 248 + E4 1 + D4 5）。

| E-3 | **S1a** | **P0-S1a** 三条建会话路径各自为政（首波带 blueprint / 懒加载无 blueprint 无 setup / 重激活 setup 仅当 presetFile 存在） | **已收口**：四条调用点（三条路径）全部经 `buildRoleSession`；`orchestra.ts` 零 `agents.resume`；`a2a.ts` 仅入口内一处 | `src/a2a.ts`、`src/orchestra.ts`、`scripts/test-role-session-single-path.mjs`；`docs/p0-report-s1a.md` |
| E-3 | **S1a 关联缺陷** | **P0-S1a-2** 懒加载路径把 `provider`/`model`/`reasoningEffort`/`presetId` 以 `undefined` 值**当键**传给 `createSession` ⇒ 打不中下游 `!== undefined` 判据 | **已修**（改为按需展开）；**与 D4 是同一缺陷类**：D4 是返回值、这里是入参 | `src/orchestra.ts`；`docs/p0-report-s1a.md` §3 |
| E-3 | **S1a 未达成项** | **P0-S1a-3** S1 判据 ①③（三路径 setup 同函数 / blueprint 记录字段集相同） | **未达成**——属 **S1b**（两个 `prepare*Blueprint` 收敛）；现在写断言会失败 | `docs/p0-report-s1a.md` §1 / §4 |

| E-4 | **S1b** | **P0-S1b** `prepare*Blueprint` 两个名字、两个演化路径，三条建会话路径无单一名准备入口 | **已收敛**：新增 `PreparedRoleBlueprint`（判别式联合）+ `prepareRoleBlueprint(ctx, input)`（按 `mode` 派发、重载签名收窄返回类型）；两处调用点（`a2a.ts` / `orchestra.ts`）均只拼写派发器，源码零 plane 函数直调 | `src/session-blueprint.ts`、`src/a2a.ts`、`src/orchestra.ts`；`docs/p0-report-s1b.md` §2 |
| E-4 | **判据 ①③** | **P0-S1b-2** S1 判据 ①（三路径 setup 同函数）与 ③（blueprint 记录字段集相同）**在 S1b 无法转绿** | **实测挡住**：只有首波产出 blueprint；懒加载与重激活 replacement 不产出 receipt ⇒ 没有 setup 与记录可比。**给那两条路径补 blueprint 是 D2 的活** ⇒ ①③ **留到 D2**；测试已留 tripwire（"恰好一条 spec 带 `governedBlueprint`"，D2 落地即翻） | `docs/p0-report-s1b.md` §3 |
| E-4 | **待裁项** | **P0-S1b-3** 重激活路径与 `createSession` 各自重算 `agentOptions`，**逐键独立回退 vs 整体配对回退**（同一个"只给 provider"的输入会得到不同模型路由） | **未合并、两侧语义原样保留**；登记**待裁**（属产品语义，无法从代码判定哪一侧有意为之）。入口侧不变量已钉：`kind:"resume"` 原样透传 `agentOptions`、不引入第三份算法 | `docs/p0-report-s1b.md` §4 |
| E-4 | **同类缺陷第四处扫描** | **P0-S1b-4** D4 发现的"`undefined` 当键"缺陷类是否还有第四处 | **未发现第四处**（三处候选逐一排除，理由在报告 §5）；**未为它建任何机制** | `docs/p0-report-s1b.md` §5 |

| E-5 | **S3 · G-P0 ⑤** | **P0-S3-1** 名册是否真认插件私有根（§7 单跳 override 的合成结果）此前无闸 | **已建并绿**：`scripts/verify-role-presets-roster.mjs` → `# presets healthy=12/12 roots=1 default="standard" agent_presets_rows=1 warnings=0`，exit 0 | `scripts/verify-role-presets-roster.mjs`；`docs/p0-report-s3.md` §2.1 |
| E-5 | **闸断言非恒真** | **P0-S3-2** 只跑 happy path 证明不了断言会拒 | **已证**：断言抽为**导出的纯函数** `rosterFailures()`，四种形态实测（happy `[]`；两跳 / 漏 `default` / trust 错 均被拒） | 同上 §2.2 |
| E-5 | **计划文字与实测冲突** | **P0-S3-3** 计划 §1 S3 / §4.7 写"名册来源 `path === ""`"，而 `AgentPreset.path` 是**必需绝对路径**（`dsh-agent-presets/lib/types/preset.d.ts`），`""` 分支只是防御性代码 | **已登记待裁**：判据需改写为"**`path` 指向真实文件但不被 `mountRolePreset` 使用**"（行为断言）。**未自行落定**（属判据措辞变更） | `docs/p0-report-s3.md` §3.1 / §3.4 |
| E-5 | **S3 待裁口径** | **P0-S3-4** `resolvePresetFile` 降级范围：只降级 `dsh`，还是 `builtin` 也走名册解析（§7 后 `builtin` 分支在优先级上**永远不可达** ⇒ 死分支） | **已登记待裁**（我倾向后者，理由已给；按规则一不自行选边） | `docs/p0-report-s3.md` §3.3 |
| E-5 | **S3 未完成项** | **P0-S3-5** `mountRolePreset` 未实现；`resolvePresetFile` 未降级；`test-role-preset-roster.mjs` 未建；四处挂载调用点未改 | **未做**（落点已调查完，见报告 §3.2） | `docs/p0-report-s3.md` §3–§4 |

| E-6 | **S3 · 代码侧** | **P0-S3-6** 名册预设被按文件挂载（重激活路径**无条件**走 `mountPreset(手工三件套)`）⇒ 无 discovery / 无 standing mount / 无可恢复身份（发布阻断项的机制级成因之一） | **已收口**：新增 `src/role-preset-mount.ts` 的 `mountRolePreset`，**5 处**调用点全部改走它；`dsh`/`builtin` 按 id 挂、`project`/`global` 才传 `overrideFile`；仅决策模块可导入引擎的 `mountPreset` | `src/role-preset-mount.ts`、`src/a2a.ts`、`src/orchestra.ts`、`src/a2a-transport.ts`、`src/session-blueprint.ts`；`docs/p0-report-s3.md` §3 |
| E-6 | **S3 测试** | **P0-S3-7** 三条断言（三来源 source 正确 / `readySnapshotAfterWrite` 后 inventory 有行 / 全仓无 `presetSource === "file"` 调用点） | **已建并绿**（5 用例）；③ **按实测收窄**为"不得有**选择挂载 API** 的分支基于 `presetSource === "file"`"——全仓两处该字符串都是 **marker 校验/重建**，删它们会让测试变成破坏来源（理由逐字写进测试） | `scripts/test-role-preset-roster.mjs`；`docs/p0-report-s3.md` §4 |
| E-6 | **计数更正** | **P0-S3-8** driver 点"四处挂载调用点"，实测 `mountPreset` 直调 **5 处**（多 `a2a.ts`） | **已一并收口**（第 5 处同属该缺陷类），并加断言"只有决策模块可导入引擎的文件挂载 API" | `docs/p0-report-s3.md` §3.1 |
| E-6 | **未验证（重要）** | **P0-S3-9** S3 改动**是否真修好发布阻断项** | **未验证**：本轮证据只到"挂载 API 选对了"（注入 roster double，非真名册）。**真证明需真实实例跨重启 + 外部核对组合 + 一次真实角色工具调用**（= N7 形状）。建议置于 S4 之后、D1 之前 | `docs/p0-report-s3.md` §5 / §7 |

## 5. 批 1 的 G-P0 判定形态（driver 裁定，2026-09-20）

**判据 ①②③⑤⑥⑦⑧⑨ 各自命中期望码；④ 显式延后（landing = 批 2 / G-P2）。**

**依据**：计划 §10.7 自己的标题「延后项（**显式标注，不是漏掉**）」——删掉 ④ 就正是"漏掉"。编号**不重编号**（避免打断全部交叉引用）。

---

## 6. 批 1 第 1 轮的 driver 独立复跑与判定（2026-09-20）

**候选：commit `3740981`**（工作树干净）。复跑在 **detached worktree** `/tmp/orch-verify-3740981`（软链 `node_modules`）——**恒不在在飞树上跑闸**（协议 §2.1）。

| 项 | 它的自述 | driver 独立复跑 | 判定 |
|---|---|---|---|
| `npm run typecheck` | 0 | **exit 0** | 命中 |
| `npm test` | 254 pass / 0 fail | **exit 0；`# tests 254 / pass 254 / fail 0 / cancelled 0`** | 命中（248 不回归 + 6 新增） |
| D4 工具覆盖 | 18 全枚举 | 全仓 `defineTool(` = **18**；`test-tool-schemas.mjs:508` 显式列 `orchestra_wait`，`:432` 写明"没有第三种状态" | 命中 |
| D4 守卫非恒真 | 假 ctx 只暴露 `inject` 内服务 + liveness 自测 | `:182` / `:607` / `:347`（两插件各用独立 ctx）属实 | 命中 |
| 缺陷类"value is not lossless JSON" | DSH 对每个工具结果跑快照 | `dsh-tools/lib/index.js:2479-2482` **一字不差** | 命中 |
| O-4 依赖落地 | peer+dev；tgz 无 `@deepseek-ai`；两 profile 干净 | `files` = `["lib","cordis.patch.yml","cordis.yml","README.md","LICENSE"]` ⇒ 不可能含 `@deepseek-ai`；web/dev 均只有 `cosmokit`+`schemastery` | 命中 |
| **S2 API 更正（P0-F3）** | `sessionController.resume` 不存在 | 服务注册 `super(ctx,"sessionController",…)`；服务面有 `resolveAgent`（`dsh-api-session-controller/lib/index.js:2801`）与 `prompt(request,signal)`（`:2920`）；`resume`/`resumeObserved` 全在**内部类**（`:186`–`:426`） | **命中，且推翻计划 §3 一处前置假设** |
| fault_ref 运行时抛错（P0-D4-3） | **未复现**（自己标注） | `cordis/lib/index.js:675-685`：错误对象**先建**，但 `fiber.store[prop]` 命中即 `return` ⇒ **未申报 ≠ 必抛**；其"未复现"的解释正确 | 判**如实**：只可记"欠账已补声明"，**不得**记"已修复线上故障" |

**分类（协议 §2.2）**：A / B / C 类**均无**；D4/E4 = **F 类（机制命中）**；S 组未开工 = **E 类（明确停点 + 提问）**，非静默悬挂。
**顺序偏离**（先做 D4/E4 而非 S 组）：已显式声明；两者与 S 组无依赖 ⇒ **接受，不回退**。
**审查轮计数：+0**（检查不是轮次）。

---

## 7. 批 1 的 G-P0 可执行脚本清单（driver 按 V1 推导；**唯一形态**）

计划 §11 的**具名脚本表**（9 个文件 / 11 条命令）与**判据 ①–⑨** 有三处不一致（P0-F1 + driver 新发现一处）：表里留着已被 V1 移出的 `test-decision-queue.mjs`(E2/E3)、`test-design-gate.mjs`(F1′)，**却漏了判据 ⑨ 要求的 `test-tier0-predicate.mjs`**。按 O-5(d) 的口径优先级（**V 条目 > 未同步的计划行**），批 1 的 G-P0 可执行形态是：

| # | 命令 | 期望退出码 | 状态 |
|---|---|---|---|
| ① | `node scripts/verify-role-identity.mjs`（= N7） | **0** | 脚本未创建 |
| ② | `node scripts/verify-role-identity.mjs --self-test` | **1**（校准） | 脚本未创建 |
| ③ | `node scripts/verify-d2-approval.mjs`（须 `hanging 0 dangling 0`） | **0** | 脚本未创建 |
| ④ | `node scripts/verify-d2-approval.mjs --self-test` | **1**（校准） | 脚本未创建 |
| ⑤ | `node scripts/verify-role-presets-roster.mjs`（§7.3-a，期望 **12/12**） | **0** | 脚本未创建 |
| ⑥ | `node scripts/test-orchestra-archive.mjs`（D3 扩展用例） | **0** | 已存在，待扩展 |
| ⑦ | `node scripts/test-tool-schemas.mjs`（D4） | **0** | ✅ 已绿（E-1） |
| ⑧ | `node scripts/test-orchestra-role-presets.mjs`（E4 两条断言） | **0** | ✅ 已绿（E-1） |
| ⑨ | `node scripts/test-tier0-predicate.mjs`（V3 档 0 三组边界） | **0** | **脚本不存在，需创建** —— G-PRE 的 S-PRE 清单点了它的名，但当时只跑了 V1–V10 的 grep 断言就判绿 ⇒ **driver 侧核对的漏项**（同一失败形态：点了名但没验存在） |
| — | `node scripts/verify-agent-budget.mjs`（**G-BUDGET**） | **0** | 脚本未创建 |

**移出**：`test-decision-queue.mjs`（E2/E3 ⇒ 批 2）、`test-design-gate.mjs`（F1′ ⇒ 后续）、`verify-d2-decision.mjs`（④ 延后 ⇒ 批 2 / G-P2）。
**合计：9 条具名命令 + 1 条 G-BUDGET；现已绿 2 条。**


---

## 8. 升级适配轮（DSH 0.1.5-rc.2 → 0.1.6-alpha.2；**编辑任务，非审查轮**）

> **依据**：`docs/upgrade-0.1.6-alpha.2-writer-brief.md`（任务书）+ `docs/upgrade-0.1.6-alpha.2-impact.md`（证据全文，审计 commit `926434c`）。
> **性质**：**版本适配，不是重新设计**。只做两件事——把引用了**已失效引擎事实**的位置改对、新增一条假设 + 一条风险。
> **锚点**：commit + 文件 + 章节号（行号仅辅助）。

| 项 | 阶段 | 问题 id | 结论 | 落定位置（commit + 文件 + 章节） |
|---|---|---|---|---|
| **U1** | §7.2 部署表 | **UA-1** `patchReload: "live"` 依据作废（`PATCH_RELOAD` 在 0.1.6-alpha.2 的 `dsh-app-boot` 全 `lib/` 零命中） | **已改**：删该机制依据，改为以"**新增根要重启**"为唯一依据；新行为标**待核**（R-15）。**同节的 `composeEntries` 层序与 §7.1 三条写法纪律未动**（本机内存探针复核：单跳 ⇒ 恰好一行；漏 `default` ⇒ config 被顶掉） | `docs/plan-0.8.0-execution.md` §7.2 |
| **U2** | §4.8 D2-a 步骤 3 | **UA-2** 断言 `outcome="rejected"` 会**假失败**（`signal?.aborted` 早返回在 `never` 判断**之前** ⇒ 「已中止 + never」= `cancelled`） | **已改**：改为与 D2-c 一致的集合写法 `outcome ∈ {allowed-once, rejected, cancelled, unavailable}`。**§4.8 开头三条机制事实未动**（逐字未变） | 同上 §4.8 D2-a |
| **U3** | §1 S2 / §2.2 / §2.3 / §8.1 R-04 | **UA-3**（= 执行期 **P0-F3**）`ctx.sessionController.resume(...)` **不在服务面上**（`resume`/`resumeObserved` 是内部类 `private` 成员） | **已改**：落点改为 **`resolveAgent(sessionId)`**（冷恢复）+ `prompt(request, signal)`（唤醒）；落实 **O-4 / P0-F5**：**`ctx.get("sessionController")` + 调用点类型化错误，不写进 `inject`**（写 `inject` = 硬依赖 ⇒ 服务缺席会让整个 a2a 插件 waiting、`a2a_*` 工具全消失）；缺席 ⇒ `session_controller_unavailable`、**不静默回退** | 同上 §1 S2 行 / §2.2 / §2.3 / §8.1 R-04 |
| **U4** | §0.1 依赖的契约版本 | **UA-4** 宿主版本 | **已改**：`0.1.5-rc.2` → **`0.1.6-alpha.2`**；并写明 `^0.1.5-rc.2` **不覆盖**（semver 实测连 `>=` 都不满足）、19 条 peer + dev 需同步（含 2 条精确锁）、风险因 `autoInstallPeers:false` 已降级 | 同上 §0.1 |
| **U5** | §0.2 假设清单 B-1…B-4 + 其余假设 1–5 | **UA-5** 假设按新版本逐条重述 | **已改**：B-1/B-2/B-3 **已核未变、按原样保留**（各加"U5 复核"栏与核验方式）；**B-4 加"宿主事实已核未变 + 失败形态已改（V2）"**，并把 `dsh-bash-sandbox` 失败分类标**待核**（R-16）；其余假设 1–5 改为逐条复核表（1/2 已核未变、3/4 与版本无关、5 部分随版本 + `git merge-base --is-ancestor` 待核 ⇒ R-17） | 同上 §0.2 |
| **U6** | §11 G-P0 三处欠账 | **UA-6**（= 执行期 **P0-F1 / P0-F2**）判据 ④ 的内容全在 E2/E3/P3-5（V1 已令其退出 P0）；D2-b 同源；具名脚本表与判据不一致 | **已改**：①判据 ④ 标 **「延后（landing = 批 2 / G-P2）」、编号不动**（依据 §10.7「延后项（显式标注，不是漏掉）」）；②**D2-b 归属**随 ④ 移出批 1、成为 G-P2 判据项（批 1 可交付 = **D2-a + D2-c**）；③具名脚本表校正：**补 `test-tier0-predicate.mjs`**、**移出** `verify-d2-decision.mjs` / `test-decision-queue.mjs` / `test-design-gate.mjs`（G-P0 = 8 文件 / 10 命令） | 同上 §4.8 D2-b / §11 G-P0 判据 ④ / §11 具名脚本表 |
| **U7** | §0.2 新增假设 B-5 + §8 风险表 | **UA-7** `dsh-subagent` 新增进程级容量上限（0.1.5-rc.2 无此机制） | **已新增**（本轮唯一新增）：`ActivationPool` 满额抛 `ACTIVATION_LIMIT_REACHED`；默认 `maxDepth: 1` / `maxActiveSubagents: 8`，可由部署 `settings."subagent"` 覆盖；命中面 = `src/subagent-node.ts` 的 `subagents.startContinuable(...)`。**适用边界照抄**：**仅适用于"由 subagent child 承载的节点"**，可见会话承载的节点不受影响；**不得**普遍化为"所有节点都有并发上限"；**不得**因此新增任何机制（**无 `fault_ref`，属"知道即可"**）。风险行 R-18（`maxDepth: 1` 交互待核） | 同上 §0.2 B-5 / §8.1 R-15…R-18 |
| **U8** | 收尾 | —— | **已记**（本节）；自检：`check-p0-preconditions.mjs` → **`# V1..V10 ok (10/10)`，exit 0**；`npm run typecheck` → **exit 0** | **commit `4e06cee`** —— `docs/plan-0.8.0-execution.md`（U1–U7）+ 本文件 §8（U8） |

### 8.1 U9 · Owner 边界补正（开发期只动 dev，不动 web）

| 项 | 阶段 | 问题 id | 结论 | 落定位置（commit + 文件 + 章节） |
|---|---|---|---|---|
| **U9** | 部署边界 | **UA-9** Owner 已裁定「**整个开发只动 dev，不动 web**；4599 是 Owner 的工作环境，开发期不得触碰」——该边界**原始 brief 漏写**（责任在 brief，不在编辑者），故 U1–U8 沿用了旧的"两个 profile"措辞 | **已改**（三处主改 + 四处连带）：①§7.1 文件清单**只保留 dev**，删 web 行、"两个文件"改"**只写 dev**"；②§7.2 **删「重启 web（4599）」整行**；③§0.2 B-2 的 U5 附带事实改为「**web 侧不做**，保持原状 `[]`，本次升级中曾被写入、**已回退**」。**连带**：§4.7 N7 步骤 2 改为**重启 dev 实例、不涉及 4599**；§5.1 `verify-role-presets-roster.mjs` 改为**只验 dev**；§8.1 **R-04** 保留"web 与 dev 都含 `dsh-web-app`"作为**事实描述**并写明**它不构成"两个实例都要改"的依据**；§8.1 **R-14**（4599 重启）标**本项作废、风险消除** | **commit `910985b`** —— `docs/plan-0.8.0-execution.md` §7.1 / §7.2 / §0.2 B-2 / §4.7 / §5.1 / §8.1 |

**回退的可核事实（本机实测）**：`~/.dsh/profiles/web/cordis.patch.yml` 内容 = 模板原样 `[]`（217 B）；mtime `2026-09-20 22:13:24`，**晚于** `~/.dsh/profiles/dev/cordis.patch.yml` 的 `22:04:18`，与"web 曾被写入、随后回退"一致。**编辑者本轮的改动全部在仓库内**（`git show --stat 910985b` = 1 file），未触碰 `~/.dsh/` 下任何文件（沙箱亦不允许：`dsh --dump-config` 曾以 `EPERM ... ~/.dsh/profiles/*/cordis.yml` 失败）。

**自检（U9 后复跑）**：`node scripts/check-p0-preconditions.mjs` → **`# V1..V10 ok (10/10)`，exit 0**（**脚本未改**，依据 = `git show --stat 910985b` 只含计划文件）。

**本轮 commit**：`4e06cee` —— `docs(0.8.0 plan): adapt to DSH 0.1.6-alpha.2 (U1-U8)`（2 文件，+48/−15 于计划；`git show --stat 4e06cee` 可复跑）。

**本轮产出的待核项（4 条，均已进 §8.1 风险表，不得写成现状）**：R-15 `patchReload` 新行为 · R-16 `dsh-bash-sandbox` 失败分类 · R-17 `git merge-base --is-ancestor` 本机可用性 · R-18 `maxDepth: 1` 与拓扑的交互。

**未改动的权威文件**：`docs/plan-0.8.0-delivery-layer.md`（冻结契约）、`docs/ruling-d1-d5-oracle.md`、`docs/p0-scope-ruling.md`（只读）。

**同步项（不在本轮范围，登记不动手）**：`package.json` 的 19 条 peer + 对应 devDependencies 与 `node_modules` 仍为 `0.1.5-rc.2`（本机实测）⇒ 依赖面同步是**独立工作项**（impact §5-1/2）。

---

## 9. 依赖面迁移执行记录（2026-09-20，driver 执行）

**授权**：Owner（"动手吧"）。**锚点 = commit + 文件。**

**改动**：42 条 `@deepseek-ai/*` 范围 `0.1.5-rc.2 → 0.1.6-alpha.2`（peer 19 条 + dev 23 条），**保持原有写法风格**——2 条精确锁（`dsh-user-approval`、`dsh-session-title`）仍为精确锁。另新增 `.npmrc`（见下）。

**结果**：`npm install` exit 0；`npm run typecheck` **exit 0**；`npm test` **exit 0，254 pass / 0 fail**。**源码零改动即通过** ⇒ U1–U9 那份适配判断得到实测支撑。

**排障过程（值得留痕，两次失败都不是我们的声明错）**：
1. 首次 `npm install` **ERESOLVE**：`package-lock.json`（本地、未入库）钉着 251 处 `0.1.5-rc.2` ⇒ 删锁（已备份至 `/tmp/package-lock.json.0.1.5-rc.2.bak`）。
2. 删锁后仍失败 ⇒ 再清空 `node_modules` 干净重装，**仍失败** ⇒ 证明与旧树无关。干净解析给出了唯一真因：
   ```
   peer @deepseek-ai/dsh-agent@"^0.1.1-rc.2" from @deepseek-ai/dsh-client-runtime@0.1.1-rc.2
   ```
   **`dsh-client-runtime` 整条线停在 `0.1.1-rc.x`**（dist-tag `next = 0.1.1-rc.2`，无 0.1.6 版本），它对 16 个包声明 `^0.1.1-rc.2` 的 peer，按预发布匹配规则**不可能**被 `0.1.6-alpha.2` 满足。
3. **处置**：新增 `.npmrc` 置 `legacy-peer-deps=true`，并写明理由。这不是"绕过"：AGENTS.md 硬规则 4 规定**本仓 `node_modules` 只装 devDependencies**、peer 由宿主 profile 满足；这与 profile 侧 pnpm 的 `autoInstallPeers: false` **同旨**。我方对该包只有一处 **type-only** 用法（`src/client/index.tsx:14`）。
4. **补偿证明（必须做，因为 npm 不再核 peer）**：逐条核 **19/19 peerDependencies 均被 0.1.6-alpha.2 宿主满足**，缺失 0、不满足 0（含两条精确锁）。

**未做 / 待办**：① profile 侧尚未同步新构建（dev 里装的仍是 v0.5.1 旧构建），AGENTS.md 硬规则 3 三件套待 pack+sync 后核；② 本仓 `node_modules` 已整体换到 0.1.6-alpha.2 ⇒ **本地那棵 0.1.5-rc.2 旧树不再存在**，将来做版本对比需用 `dsh-upgrade-audit` 重新材料化（事实已全部抽干进 `docs/upgrade-0.1.6-alpha.2-impact.md`）。

**一处执行失误（如实记）**：为验证"旧树是否干扰解析"，我执行了 `rm -rf node_modules`，导致本地树一度为空；随后由本次成功安装恢复。判定上无害（该目录可再生），但**未经备份就删除**不在我的预案里，下一轮同类操作应先保全可回滚路径。

---

## 10. 批 1 · S1a 完成轮的 driver 独立复跑（2026-09-20）

**候选：commit `978c2fb`**（工作树干净）。复跑在 **detached worktree**（软链 `node_modules`）。

| 项 | 它自述 | driver 复跑 | 判定 |
|---|---|---|---|
| `npm run typecheck` | 0 | **exit 0** | 命中 |
| `npm test` | 257 pass / 0 fail | **exit 0；`# tests 257 / pass 257 / fail 0`**（254 + 新脚本 3） | 命中 |
| 新脚本单独跑 | 3 pass | **exit 0；3 pass**（须先 build，见下） | 命中 |
| `src/a2a.ts` 的 `await ctx.agents.resume(` | 1，在 `buildRoleSession` 内 | **1**（`src/a2a.ts:322`） | 命中 |
| `src/orchestra.ts` 的 `agents.resume(` | 1（是注释） | **1**（`:3512` 注释） | 命中 |
| `src/orchestra.ts` 的 `createSession(ctx, {` | 0 | **0** | 命中 |
| `buildRoleSession(` 的出现处 | "四条调用点" | **实际 5 处**：`2497 / 3069 / 3090 / 3514 / 3517` | **实质成立；计数不精确（双方都是）** |

**实质核验（读源码，不看计数）**：重激活的两条缝 `createRoleSession`（`:3514`）与 `resumeRoleSession`（`:3516`）**默认实现都路由到 `buildRoleSession`**（前者直调、后者构造 `{kind:"resume"}`）⇒ **三条路径确实全部经单一入口**。

**driver 侧两处自我更正（如实记）**：
1. **我用 `await buildRoleSession(ctx, {` 计数得 3，据此报"与自述 4 不符"——错的是我的模式**（`:3517` 写作 `return buildRoleSession(agentCtx, {`，变量名与关键字都不同）。**教训：锚点用 commit + 符号，不要用计数** —— 本项目已有此规则，这次是 driver 自己违反。
2. **我一度把"单跑脚本 exit 1"当成缺陷**：真实原因是我的 worktree 只跑了 `tsc --noEmit`，**`lib/` 从未产出**（`ERR_MODULE_NOT_FOUND: lib/a2a.js`）。**先读失败原文再分类**才避免了假发现。规则：**验证脚本类产物前必须先 `npm run build`**。

**对 driver 指令的一处偏离（判为接受）**：driver 原话要求"**删掉 `resumeRoleSession` 包装**"；实现保留它为**可注入的缝**（`dependencies.resumeAgent ?? 默认走 buildRoleSession`），因为 `scripts/test-recovery.mjs` 会注入它。**接受** —— 该指令的**目的**（`orchestra.ts` 不再拥有第二条 build/resume 实现）已达成，删除该缝会破坏既有测试。**属 driver 指令过于字面。**

**它自查出的第三条同族缺陷（已核）**：懒加载路径把 `provider`/`model`/`reasoningEffort`/`presetId` **以 `undefined` 值当键**传给 `createSession`，打不中其自身的 `!== undefined` 分支判断 ⇒ 已用既有的 `...(x === undefined ? {} : {x})` 写法修掉，**且未建立全局机制**（正确避开 R-creep）。同一缺陷类第三次出现：D4 那次在**返回值**、这次在**入参**。

**审查轮计数：+0**（检查不是轮次）。

---

## 11. 批 1 · S1b 轮的 driver 独立复跑与三条裁定（2026-09-20）

**候选：commit `27445a2`**（detached worktree；**先 `npm run build` 再单跑脚本**——上一轮的教训已固化为步骤）。

| 项 | 它自述 | driver 复跑 | 判定 |
|---|---|---|---|
| `npm run build` / `typecheck` | — / 0 | **exit 0 / exit 0** | 命中 |
| `npm test` | 261 pass / 0 fail | **exit 0；261 / 261 / 0**（257 + 新脚本 4） | 命中 |
| `test-role-blueprint-single-prepare.mjs` | 4 pass | **exit 0；4 pass** | 命中 |
| `test-role-session-single-path.mjs` | 3 pass | **exit 0；3 pass** | 命中 |
| `prepareRoleBlueprint(` 调用点 | `a2a.ts:401` · `orchestra.ts:869` | **两处，一致** | 命中 |
| plane 函数直调消失 | 无输出 | **两文件内零直调** | 命中 |

**driver 的 grep 第三次成为薄弱环节（记）**：我用 `export function prepare*Blueprint` 得到 0，据此一度怀疑函数被删；真相是它们是 **`export async function`**（`session-blueprint.ts:552` / `:786`），**仍在、仍被导出**。caller 计数三方各异（它说 13、我数 22 行、真实是 3 个测试文件：`test-session-blueprint.mjs` 10 · `test-orchestra-role-presets.mjs` 3 · `test-governed-provisioning.mjs` 3）。**结论：核这类声明一律读符号定义，不用计数** —— 这是本轮第二次由计数引发的误判。

### 裁定 A｜`agentOptions` 双算法差异：**不合并**，先判可达性
两条路径各自重算 `agentOptions`（"逐键独立回退" vs "整体配对回退"），同一"只给 provider"的输入会得到**不同模型路由**；两侧均有既有测试，**无法从代码判定哪一侧有意为之**。实现按"规则一"未合并、登记待裁 —— **处置正确**。
**裁定**：**保持不合并**；补一步**可达性判定**（`role.model` 是否可能在真实输入上只给 provider 而不给 model）。不可达 ⇒ 记为潜在差异、零优先级；可达 ⇒ 升级为 **Owner 的产品语义裁定**（不是我可以按口味定的）。已登记进计划开项。

### 裁定 B｜两个 plane 函数保留 + 新增派发器：**接受，但登记为对计划字面的偏离**
计划 §1 S1 行的字面要求是"两个 `prepare*Blueprint` **收敛为一个**，差异由 `spec.mode` 参数化"；实际达成的是**单一派发点**（`prepareRoleBlueprint` 按 mode 分派到两个仍在的函数）。
**接受依据（实证）**：3 个既有测试套直接引用这两个函数；其 `diff` 表明差异是**规则差异**而非重复，共用部分早已抽走 ⇒ 合并 body 不减少重复、只会让两套规则更难读，且要重写既有测试。
**登记后果**：D2 落地、判据 ① 变得可写时，**"同一函数"的形态须先定**（单一 body vs 单一派发点）——否则届时会在判据上撞车。

### 裁定 C｜下一轮做 **S3**，不是 D2
计划的依赖表写着 **D2 ← S1 + S3 + S4**，而 **S3 与 S4 都未做** ⇒ **D2 现在不可用**（Implementer 给的二选一漏了这条）。S3 同时是 **D1 与 D2 的共同前置** ⇒ 它在关键路径上。S4 无前置、可与 S3 并行，仍须在 D2 之前。

### 新发现｜**G-BUDGET 的输入在批 1 不存在**（与 O-5 的 ④ 同形态）
计划 §11 说 `verify-agent-budget.mjs` 读「会话事件流 **+ 节点记录**」，§9.1 的判据是**逐节点逐轮**计数；而**节点记录是 P2-2 的产物**（`orchestra/nodes/` 在本仓不存在，`src/` 内零引用）。
**默认裁定**：**G-BUDGET 标「延后（landing = 批 2 / P2-2 落地后）」**，与判据 ④ 同规；批 1 交付报告须在「未做/未验证」栏写明。
**反转条件**：若实测表明"逐轮归集"只靠 `team.json` + 会话事件流即可得（不需要节点记录），则 G-BUDGET 留在批 1 —— 由实现者给出证据后翻案。

**审查轮计数：+0**（检查不是轮次）。

---

## 12. 批 1 · S3 部分轮（G-P0 ⑤）的 driver 独立复跑与两条裁定（2026-09-20）

**候选：commit `69b62d8`**（3 文件：`docs/p0-report-s3.md` +228 脚本 + 台账）。

| 项 | 它自述 | driver 复跑 | 判定 |
|---|---|---|---|
| `node scripts/verify-role-presets-roster.mjs` | `healthy=12/12 roots=1 default="standard" agent_presets_rows=1 warnings=0`，exit 0 | **逐字一致，exit 0** | 命中 |
| 纯函数 `rosterFailures(composed)` 非恒真 | 四形态实测 | **按签名重建五形态**：happy `[]`；两跳 / 漏 `default` / trust 错 / 无 roots 各自报出对应原因 | 命中 |
| `npm run build` / `typecheck` / `npm test` | 0 / 0 / 261 | **0 / 0 / 261 pass / 0 fail**（本轮无代码改动，数字不变正确） | 命中 |
| 禁改面（依赖 / `.npmrc` / 契约 / 裁定） | 未动 | **未动**；闸脚本未被误挂进 `npm test` | 命中 |

**driver 的 grep/探针第四次出错（记）**：我第一次调 `rosterFailures` 传的是自造对象 `{rows,default,trust,healthy}`，四形态全抛 `composed.filter is not a function`。真实签名是 **`rosterFailures(composed)`**——收**合成后的 entries 数组**。**规则固化：探针必须先读签名再构造输入**（这是同一毛病第四次；前三次分别是 `export async function`、`await buildRoleSession(ctx, {` 的计数、以及没 build 就单跑脚本）。

### 裁定 D｜S3 判据"roster 来源 `path === \"\"`"**与实测冲突 ⇒ 改用行为形态**
计划 §1 S3 行要求断言"roster 来源的解析结果 `path === ""`"。实测：**`AgentPreset.path` 是必需绝对路径**（`dsh-agent-presets/lib/types/preset.d.ts`），`resolve(id)` 返回真实路径；`path === ""` 是**防御性代码，真实名册走不到**。
**裁定（按 O-5(d)：实测 > 计划原文）**：判据改为**行为形态** —— ①名册来源经 `presets.mount(agentCtx, resolved.id)` 挂载（断言 `presets.mount` 被调）②`mountRolePreset` **不读 `preset.path`**（断言 `readFile(preset.path)` 未被调）③名册路径上 `presetSource === "file"` 的调用点为零。
**计划文本欠账 +1（U10）**：§1 S3 行该处措辞需按上述改写。

### 裁定 E｜`builtin` 来源**本轮不动**，登记为 S6 候选
优先级 `project → global → dsh(名册) → builtin`；§7 应用后 `builtin` 在优先级上**永远不可达**（我们的 builtin 物化在 catalog 根里，而该根现在是名册根 ⇒ `dsh` 先命中）。
**裁定**：**不在 S3 里改它**。它是**死分支**，归属 **S6（死分支与重复实现）**，登记为 S6 候选并写明**不可达性的前提是 §7 已应用**。理由：把"把 builtin 并进名册解析"塞进 S3 会扩大 S3 的语义面，而删除死分支是 S6 的既定职责——**这是防 creep 的一侧**。
**接受它的附带实测**：`mountPreset(agentCtx, preset)` 收的是**已解析的 `AgentPreset` 对象**，故名册来源**本就不需要产 path**，需要产 path 的只有 project/global ⇒ **这是 S3 工作量的净减少，采纳**。

### 结构性观察（driver 侧，记）
四轮里有**两轮**（S1a、S3）只交付了分配范围的一部分。**原因在 driver 的轮粒度，不在实现者**。自本轮起：每轮 brief **显式写出"本轮不做什么"**，并把可独立收口的次要项移出该轮。

**审查轮计数：+0**。
