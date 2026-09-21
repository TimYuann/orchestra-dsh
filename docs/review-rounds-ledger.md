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

| E-7 | **跨重启取证（步 1）** | **P0-F6** 假设 (b)：§7 的根在真实实例里没被认到 | **已排除**：真实组合（dev profile，4 个 bundle 合成）下 `discoverPresets` **12/12 可解析、0 失败、exit 0**；对照组（4 个 shipped 预设）全 healthy | `scripts/probe-preset-roster.mjs`；`docs/p0-report-restart-forensics.md` §2.1 |
| E-7 | **探针自我更正** | **P0-F7** 我第一版探针把 12/12 + 4 个 shipped 全判 BROKEN（`Invalid URL`） | **靠对照组抓到并修正**：`harnessBase` 要**目录 URL**，我传了裸路径。**若没跑对照组，本轮会报出一个完全可信的假缺陷** | 同上 §2.2 |
| E-7 | **新发现（推论，非实测）** | **P0-F8** 真实组合标记里 `approval: "ask"`，而受治理会话被 `setApprovalPolicy(session,"never")` 钉死 ⇒ **标记记的是「预设声明值」，不是「会话实际值」** | **登记为机制推论，未实测**：冷恢复若不重新钉 `never` 就会回到记录声明的 `ask`（正是 D2-a 要判的）。**不得写成"已定位缺陷"** | 同上 §2.3 |
| E-7 | **未完成** | **P0-F9** 跨重启第 2–4 步（建会话 / 重启 / 外部核对） | **未做**，阻断点可判定：`orchestra_create` 需 `frozenRef` ⇒ 需用户 `/team approve`（模型侧无等价工具） | 同上 §2.4 |

| E-8 | **G-P0 ① / N7** | **P0-F10** 缺 `verify-role-identity.mjs`（发布阻断项判据） | **已建成并双向验证**：正常 exit 0（`# roles 2 ok 2 missing 0`）；`--self-test` 检出真实非角色会话并 exit 1（`NOT_A_ROLE_SESSION`）；另三条检出路径（A 预设不一致 / B 名册不存在 / C 根缺失）均 exit 1；前置缺失 exit 2 | `scripts/verify-role-identity.mjs`；`docs/p0-report-verify-role-identity.md` §2 |
| E-8 | **脚本自查更正** | **P0-F11** 首版 `rows=0 tools=0` 是**空转输出**（读的字段 fixture 里没有） | **已修**：改经宿主 `readComposition` + 插件自己的 `parseRolePresetComposition` 取真实行数（现为 5/5）。**未自造第三份解析器** | 同上 §3.1 |
| E-8 | **脚本自查更正** | **P0-F12** 首版 `--self-test` 挑到"目录存在但无日志"的会话 ⇒ 只证明"缺会话报缺"，**证不了"真实非角色会话会被拒"** | **已修**：只挑确实有日志的会话；并显式写 `NOT_A_ROLE_SESSION` | 同上 §3.2 |
| E-8 | **证据上限（必须写清）** | **P0-F13** 本脚本读的是**预设文件声明的**行/工具数，**不是恢复实例实际挂载的工具面**（后者要 `compositionInventory`，需活代理上下文） | **已声明为上限**：脚本证明"记录与名册现在一致"，**不证明**"重启后身份完整"。后者仍需 live 会话（裁定 I 明确拆出） | 同上 §4 |

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

---

## 13. 批 1 · S3 完成轮的 driver 独立复跑与三条裁定（2026-09-20）

**候选：commit `519d8cd`**（9 文件；`src/role-preset-mount.ts` 新增决策模块 151 行）。

| 项 | 它自述 | driver 复跑 | 判定 |
|---|---|---|---|
| `build` / `typecheck` | — / 0 | **0 / 0** | 命中 |
| `node --test scripts/test-role-preset-roster.mjs` | 5 pass | **exit 0；5 pass** | 命中 |
| `npm test` | 266 pass / 0 fail | **exit 0；266 / 266 / 0** | 命中 |
| G-P0 ⑤ | 仍绿 | **逐字一致，exit 0** | 命中 |
| `await mountRolePreset(` 调用点 | 5 处（非 4） | **5 处**：`a2a-transport:224` · `a2a:444` · `orchestra:3638` · `session-blueprint:641` · `:869` | 命中 |
| 只有决策模块导入引擎挂载 API | `role-preset-mount.ts` | **实质成立**：`session-blueprint.ts` 的 `mountPreset` 只在 `:679` **注释**里，引擎 API 的 import 数为 0，它 import 的是决策模块（`:15`） | 命中 |

**driver 侧两处自查（第五、六次模式错误，均为我自己的检查）**：① 我的"禁改面"正则 `^package\.json$` 把**我明确授权过的 `test` 接线**也标红了——实际改动只有 `test` 一行，依赖面未动；② `grep -rln mountPreset` 命中的第二个文件是注释。**规则再加一条：禁改面检查要按"语义面"写，不要按文件名写。**

### 裁定 F｜③ 的收窄：**接受**（并记计划文本欠账 U10）
计划字面"全仓不存在 `presetSource === "file"` 的调用点"与事实冲突：全仓有 3 处该读取（`a2a-transport:205` 从持久 marker 重建 override 文件；`session-blueprint:1015`、`:1040` 校验 marker 自洽），**都不是"选择挂载 API"**。
**裁定**：**接受收窄形态** ——"任何【选择挂载 API】的分支不得基于 `presetSource === "file"`"（同一行须同时出现该字符串与挂载符号）。理由：照字面断言会**逼迫将来的维护者删掉一段 marker 校验来让测试变绿**，那是把测试变成破坏来源。理由已逐字写进测试（`:176-186`）。
**U10（计划文本欠账）**：§1 S3 的判据 ③ 措辞按收窄形式改写；判据 ① 的 `path === ""` 同批改写（裁定 D）。

### 裁定 G｜同意插一轮"真实跨重启验证"，但**位置提前到 pack/同步之后、S4 之前**
理由：验证轮证的是 **S1+S3（身份持久）**，而 **S4 管的是停摆/审批看门狗，与身份持久无关**。越早验越早排除"挂载路径仍不对"，避免它与 S4/D2 的改动混在同一次失败里。
⇒ 序变为 **pack/同步 → 跨重启验证轮（N7 形状）→ S4 → D2 → D1**。
**前置条件已满足**：Owner 的"押后 pack/同步"条件是"这一波（S1a→S1b→S3）做完"，**现在做完了**。

### 裁定 H｜同意"先取证、不先改"，并给出三组证据 × 三个假设的 1:1 映射
- 进程内 `presets.resolve(id)` 探针 → 分辨 **(b)** §7 的根在真实实例里没被认到
- `compositionInventory` → 分辨 **(a)** S3 挂载路径仍不对
- 会话 header 的 `agentPreset` 投影 → 分辨 **(c)** 恢复路径没带 `setup`（S2 未做，仍是自建 `tryResume`）

**预登记的合法结局**：若 **(c)** 命中，那是**已知的（S2 未做）**，**不是新缺陷**，更不是本轮失败。届时结论形态是"S1/S3 正确，瓶颈在 S2"，并据此把 S2 提到前面。

**审查轮计数：+0**。

---

## 14. §7-dev 部署 + DSH 0.1.6-alpha.2 首次同步（2026-09-21，driver 执行）

**授权**：Owner 直接提权（本会话 file policy = `danger-full-access`，无需 escalation）。
**执行**（按 `DSH-INTEGRATION.md`「更新流程」，**目标按 Owner 边界改为 `profiles/dev`**）：

1. `npm pack --cache /tmp/dsh-npm-cache` → `orchestra-dsh-0.5.1.tgz`，**79 文件**；`@deepseek-ai` 条目 **0**、`src/`+`scripts/` **0**；`dependencies` 仅 `js-yaml`；19 条 peer 全在 `0.1.6-alpha.2`。
2. dev profile 同步：`rm -rf node_modules/orchestra-dsh` + 删 `.modules.yaml` / `.pnpm-workspace-state-v1.json` / `.pnpm/lock.yaml` → `pnpm install`（1.6s，123 包）。
3. **三件套（AGENTS.md 硬规则 3）**：①`@deepseek-ai/` 下仅 `cosmokit`/`schemastery` ⇒ **无实体副本** ✓ ②插件副本 `dependencies` 无 `@deepseek-ai` ✓ ③`require.resolve('@deepseek-ai/dsh-tools', {paths:[<profile>/node_modules/orchestra-dsh/lib]})` → **host 路径** ✓
4. **新代码确已落地**：`lib/role-preset-mount.js` + `.d.ts` 存在，mtime `Sep 21 00:18:07`（本次 pack 产物）。
5. **★ §7 的真实组合证据**（`dsh --profile dev --dump-config`，exit 0，634 行）：`id: agent-presets` **恰好一行**、`default: standard` 在、`roots: [{path: ~/.dsh/orchestra/catalog-presets, trust: system}]` 在；插件三行 `orchestra-bundle` / `orchestra-a2a` / `orchestra-manager` 均在。
6. **实例启动**：`dsh --profile dev --port 4600` ⇒ 4600 LISTEN，**零插件加载失败**；4599 未受影响。

**仍未验证（= N7 形状的下一单元，是本轮"取证轮"的真正内容）**：
- 真实会话里 `presets.resolve(id)` 能否解析到那 **12 个 id** —— **§7 目前只证到"根在组合里"，未证到"发现过程认它"**（假设 (b) 的另一半）；
- 角色会话身份**跨重启**是否完整（建角色 → 重启 → 外部核对 compositionInventory / header 投影）；
- 新会话里**插件工具是否可调**（验证清单第 5 条）。启动日志里**没有 orchestra 的 init 行**（dsh-trinity 有）—— 不等于失败，但工具面仍未证。

**driver 侧两处 shell 自误（记，防后人误读）**：`timeout` 在 macOS 不存在（`exit 127`，与 dsh 无关）；`curl /` 得 **401** 是未带 token 的正常拒绝、带 token 得 **303** 是正常重定向 —— **两者都不是失败信号**。

**未做**：S4、D2、D1、G-BUDGET 探针、`test-tier0-predicate.mjs` 等 5 条批 1 脚本。**未动**：`.npmrc`、依赖面、契约、两份裁定、计划文件。

---

## 15. 取证轮（第 4 轮）的 driver 复核与 Q1–Q3 裁定（2026-09-21）

### 复核：第 1 步探针（**绿**，假设 (b) 排除）
`node scripts/probe-preset-roster.mjs` → **exit 0，# probe ids=12 ok=12 fail=0**，12 个 `orchestra-*` 全部 `RESOLVE_OK trust=system from_catalog=true`，另有 4 个 shipped 作对照。
⇒ **§7 的根不仅进了组合，发现过程也认它**。driver 复跑一致。

**★ 方法论留痕（本轮最值得记的一条）**：它第一版探针把 12 个预设 + 4 个 shipped **全判 BROKEN（Invalid URL）**——因为它把**文件系统路径**当 `harnessBase`，而引擎要的是**目录 URL**。抓住它的是**对照组**：shipped 也坏 ⇒ 不可能是产品缺陷。**没有对照组，本轮会报出一个完全可信的假缺陷（"12 个预设全坏"）。** 这与我方"负例校准"是同一条纪律，**固化为规则：任何新探针必须自带一个已知应当通过的对照项**。

### ★ fixture 发现：N7 需要的既存团队**已经在磁盘上**，不需要 Owner 新建批准
- `~/Documents/agentWorkspace/orchestra-e2e/orchestra/state/team.json` ⇒ `team-a594dc8e`，**2 个 `phase: active` 角色**：`implementer`(preset `orchestra-implementer`) · `reviewer`(preset `orchestra-reviewer`)。
- 两个角色会话**真实存在于磁盘**：`~/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-orchestra-e2e--/<sessionId>/`。
- ⇒ 实现者报告的"障碍 1（`orchestra_create` 需 `/team approve`、要 Owner 点一次）"**在本轮任务里不需要**。

### 裁定 I｜Q1：**先写 `verify-role-identity.mjs` 并用既存 fixture 自测**（不是它提议的 A/B 二选一）
依据 §4.7 步 3–5 的原文：核对是**从 `~/.dsh/sessions/.../session.v3.jsonl.zstd` 解 header + events**，即**静态读盘**，**不驱动实例、不碰 a2a、不涉红线**。它列的三条障碍**只对 live 的两步（建三角色 + 重启）成立**。
⇒ 序：**① 写脚本 + 用 e2e fixture 自测（含步 5 的 `--self-test` 负例）→ ② 再做 live 的建角色/重启**。①就是 **G-P0 ①**（发布阻断项），且零批准、零 GUI。
它的 (B) 离线 `mount` 探针**降为可选**（(B) 证的只是"按 id 能挂载"，而脚本证的是"恢复后的身份可外部核"——后者才是 N7）。

### 裁定 J｜Q2：approval 记录值 ≠ 会话实际值 ⇒ **归 D2-a，不新立条目**
依据计划 §1 D2 行原文："**「永不询问」钉到所有建会话/恢复路径**"——**恢复路径本来就在 D2 的范围内**，该发现提供的是**机制依据**而非新范围。
**追加要求**：D2-a 的判据必须 ①显式覆盖**恢复路径也要钉 `never`**；②断言读**会话实际钉住的有效值**，**不是** marker 里记录的那个（marker 记的是*预设声明*的 approval，而部署把 `workspace-write` 配成 `ask`）。

### 裁定 K｜Q3：**只读安全，且脚本根本不经过 a2a**
`DSH-INTEGRATION.md` 明写："headless 测试会话在进程退出后为 cold，从主实例**读取（`a2a_read`）安全**，发送/resume 不建议"。红线针对的是**写/恢复**（双进程写同一日志）。
**更彻底一条**：裁定 I 的脚本**直接读 `~/.dsh/sessions/` 的文件**，走的是文件系统而**不是 a2a** ⇒ **红线在验证这一步根本不适用**。禁止的仍然只有：`a2a_send`、任何 resume/`resolveAgent`、以及会触发 resume 的投递。

**审查轮计数：+0**。

---

## 16. 第 5 轮（G-P0 ① / N7 脚本）的 driver 复核与两条裁定（2026-09-21）

**候选：commit `77116ef`。** driver 独立复跑（先 `npm run build`）：

| 模式 | 期望 | 复跑 | 判定 |
|---|---|---|---|
| 正常 | 0 | **exit 0**；`IDENTITY_OK` ×2；`# roles 2 ok 2 missing 0` | 命中 |
| `--self-test` | 1 | **exit 1**；在**真实非角色会话**上检出 `NOT_A_ROLE_SESSION`；`# self-test detected=yes` | 命中 |
| 无参数 / team 不存在 | 2 | **exit 2 / exit 2** | 命中 |
| 无第二份解析器 | 只 import 宿主与既有脚本 | **import 面确认**：`readStoredEvents` 来自 `./check-session-readable.mjs`，其余来自宿主包 | 命中 |

**它的两处自我更正都核过且都写进了报告**：① 首版 `rows=0 tools=0` 是读了 fixture 没有的 `blueprint.compositionRowIds` ⇒ 那行"看起来在报数、其实零信息"，已改为读预设真实组合（现为真的 5/5），并在角色没记预期组合时显式打 `(no recorded composition to cross-check)`；② 首版 `--self-test` 挑到"目录在但无日志"的会话 ⇒ 只证了"缺会话报缺"，**证不了"真实非角色会话会被拒"**，已改为只挑有日志的会话。

### 裁定 L｜Q1：**本轮做 S4**（不是它建议的 ⑥/⑨）
批 1 剩余的真实分布是：**S4**（D2 的前置）· **D2-a/D2-c + ③④**（发布阻断项，但要等 S4）· **D1/N7 的 live 半边**（发布阻断项）· **D3 + ⑥**（独立 P0 项）· **⑨ / G-BUDGET**（闸项，挡不住任何东西）。
⇒ **S4 在通往 D2 的关键路径上**，先做它。**⑨ 与 G-BUDGET 搭到 D3 那一轮**（D3 本来就要扩 ⑥，同轮多建 $9 更便宜）。**本轮不搭车**（轮粒度太粗是本项目已认定的问题）。

### 裁定 M｜Q2：**不接受"只做静态半边"作为 D1 的最终验收**
脚本自己的证据上限写得对：它读的是**预设文件声明的**行/工具数，**不是恢复实例实际挂载的工具面**（后者要 `agentPresets.compositionInventory()`，需要活代理上下文，而脚本是纯读盘）。
⇒ **静态半边证明"记录与名册现在一致"，不证明"重启后角色身份完整"。** N7 的名字就是后者，而 D1 是发布阻断项 ⇒ **live 半边必须做**，只是排在 S4 之后。
**live 半边的三段（归属已划清）**：
1. **Owner 本人**在 4600 上批准一个最小宪章 —— `orchestra_create` 的 `frozenRef` 只能来自 `/team approve`，是**用户命令**，模型侧无等价工具；**且"代批"违反平台权限公理，不得由 agent 代做**。
2. 在 4600 上用 `ego-browser` 驱动建三角色 / 重激活（agent 可做；**不要用 browser-use**）。
3. 重启后**从实例内**取 `compositionInventory` + 一次**真实角色工具调用**（agent 可做）。

### 批 1 · G-P0 现状（复核后）
**已绿 4 条**：**①**（本脚本 + 校准）· **⑤**（`verify-role-presets-roster.mjs`）· **⑦**（`test-tool-schemas.mjs`）· **⑧**（`test-orchestra-role-presets.mjs`）。
**未建**：**③④** `verify-d2-approval.mjs`(+`--self-test`)（等 D2）· **⑥** `test-orchestra-archive.mjs` 扩展（等 D3）· **⑨** `test-tier0-predicate.mjs`（独立，搭 D3 轮）· **G-BUDGET** `verify-agent-budget.mjs`（等 P2-2；反转条件见 §11）。

**审查轮计数：+0**。

---

## 17. ★ fixture 更正 + N7 静态半边在**正确** fixture 上不通过（2026-09-21，driver 自查）

### driver 的错误（如实记）
上一轮（§16）我把 `verify-role-identity.mjs` 跑在 **`~/Documents/agentWorkspace/orchestra-e2e`**（2 角色、`sessionHistory` 全空）上，得到 exit 0 并据此判定 G-P0 ① 通过。
**正确的 fixture 是 `~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E`**（**两个大写 E**，在 Owner 指定的侧边栏工作区内；`docs/adr/0009` 与 `UPDATE-v0.5.1.md:97` 都有记载）。我上一轮既没找对路径，也没先读 `adr/0009` 就裁定了"必须 Owner 本人批准"——后者被 ADR-0009 §3 的**测试 seam** 直接推翻（**测试实例授权 agent 代敲 `/team approve`**，产品路径不变）。

### 正确 fixture 的形状
`team-f01da153` · `status: active` · `rootCwd = …/orchestra_E2E` · **6 角色 / 4 预设**：
`implementer`(orchestra-implementer) · `reviewer`(orchestra-reviewer) · `difficulty-architect`(v04-planner-v1) · `difficulty-implementer`(orchestra-implementer，会话 id 是 `session-*` 形态) · `difficulty-reviewer`(**reserved**) · `e2e-verifier`(v04-verifier-v1)；且有 `activatedFromArchiveId`（**经历过重激活**）与 `addedLanes`（**懒加载形态**）⇒ **天然覆盖 §4.7 步 1 的三种角色形态**。

### ★ 结果：`exit 1`，抓出两条真实数据异常
```
IDENTITY_MISSING difficulty-implementer session-898f7481-… 
      sessionHistory lists the CURRENT session id as a replaced one
IDENTITY_MISSING difficulty-implementer (history) orchestra-team-f01da153-ec3b09cb-…
      NOT_A_ROLE_SESSION: no session directory for orchestra-team-f01da153-ec3b09cb-… under …/orchestra_E2E--
IDENTITY_SKIP    difficulty-reviewer phase=reserved
# roles 6 ok 4 missing 2
```
两条异常：**① `sessionHistory` 把"当前"会话 id 记成了"被替换过的"**（同一条因此出现两次）**② history 里有一个磁盘上不存在的会话目录**。

**归因未定（不得写成"已定位缺陷"）**：该工作区是 **v0.5.1 时代（9-18/19）的遗留数据**，异常可能来自旧构建，也可能是当前 `sessionHistory` 写入逻辑的真实缺陷。**下一步第一件事就是归因**。

**方法论固化**：实现者上一轮**自己标注了盲区**（"fixture 两个角色 history 都是空数组 ⇒ 该分支未在真实数据上跑到"）——**一换到正确 fixture 就立刻炸出真异常**。⇒ **规则：判一个核对脚本"通过"之前，必须先确认它跑在"能覆盖其全部分支"的 fixture 上**；弱 fixture 上的绿灯是假绿。

**审查轮计数：+0。**

## 18. N7 live 取证轮：Part A 归因定型 + Part B 部分完成（2026-09-21）

### ★ Part A 归因结论：**（i）当前代码的真缺陷**（不是遗留数据）

**§17 的表述需修正为**：两条异常是**同一个缺陷的两个面**——`materializeRole` 的失败分支
**记录了被抛弃的会话 id，却不推进团队状态**，于是 `role.sessionId` 钉在一个**从未落盘的幽灵 id** 上，
且同一 id 被**反复写进 `sessionHistory`**。

三条证据（`docs/p0-report-n7-live-forensics.md` §3）：
1. **产生它的代码就是当前代码**：`git log -S'materialization-failed'` 与
   `git log -L 3130,3145:src/orchestra.ts` **都只指向 `6bd8d9b`（当前 HEAD）**，此后无改动。
2. **时间线不构成"旧构建"辩护**：三条 `replacedAt` = `2026-09-19T05:32:37Z / 05:36:42Z / 05:36:45Z`，
   正是 v0.5.1（`6bd8d9b`）交付当天 ⇒ 旧数据 + 当时的代码 = 当前代码。
3. **缺陷可推导**：失败分支里新会话**已建成功**（`created !== undefined`）但团队状态**未前进**；
   数据里那两条**完全相同的 `session-898f7481-…`、相隔 3 秒**，正是重试循环的指纹。

**磁盘核对**：`role.sessionId` = `orchestra-team-f01da153-ec3b09cb-…` **在磁盘上不存在**；
history 里的 `session-898f7481-…` 存在。⇒ 幽灵在 `role.sessionId`，不在 history。

**处置**：**登记为待办项，本轮不修**（P0 范围外）。修法方向（失败分支不写 history / 或推进团队状态）
**两选一需 driver 裁**，执行者不自行选边。

### Part B（N7 live 半边）：部分完成

- ✅ **已证**：live 实例（4600）上 `orchestra_*` 工具面可用 —— 真实模型经 `page.fetch("/api/session/prompt",…)`
  调用 `orchestra_team` 成功，读到 `team-f01da153 (trio, active)`；顺带读出该角色当前 **cold**。
- ⬜ **未做（硬阻断）**：重启 4600 —— 无进程控制（`ps` 被沙箱禁；实例非我受管作业）。
- ⬜ **未做**：`compositionInventory`「从实例内取」—— 该符号**在本插件产品代码里零命中**，
  从工作区会话取不到；宿主检查工具跨不到 4600。
- ⬜ **未做**：before/after 分层定位（无 before、无 after）。

**替用户批准声明**：**本轮没有执行 `/team approve`** —— 既存 `team-f01da153` 已是 active，
无需再批准；工具面校准用的是既存 `standard` 会话。⇒ **ADR-0009 §3 的测试 seam 本轮未被使用**。

**审查轮计数：+0。**

---

## 18. 第 6 轮（N7 live 取证）的 driver 裁定（2026-09-21）

### Part A 归因：**接受，判为当前代码的真缺陷**
它把 §17 的两条异常合成了一条，且更准：**幽灵在 `role.sessionId`**（`orchestra-team-f01da153-ec3b09cb-…` 磁盘上不存在），history 里那条 `session-898f7481-…` 反而存在。
三条证据：①`git log -S'materialization-failed'` 只命中 `6bd8d9b`（= 当前 HEAD），此后无改动 ②时间线（三条 `replacedAt` = 2026-09-19T05:32/05:36Z）**就是 v0.5.1 交付当天** ⇒ 旧数据 + 当时的代码 = 当前代码 ③**缺陷不依赖数据即可推导**：失败分支里新会话已建成但**团队状态未前进**（`phase` 回 `reserved`、`sessionId` 未改）⇒ 重试会再建一个，而 `r.sessionId` 始终是同一旧值 ⇒ 同一 id 反复进 history（那两条字节相同、相隔 3 秒即循环指纹）。
**真实后果**：`role.sessionId` 指向从未落盘的幽灵 ⇒ 按 sessionId 找该角色的路径全指向空；history 被写坏；`reason:"materialization-failed"` 记录了**未发生的事实**（"声明不实"同族）。
**两条写入点**：写入点 2（重激活替换）**是正确的**（先前进后记旧 id）；**缺陷在写入点 1**（`materializeRole` 失败分支）。

### 裁定 N｜Q3：这条缺陷**进批 1，且是 D1 的阻塞项**（不是"范围外登记"）
理由不是"顺手修"，而是 **D1 自己的判据过不去**：N7 的验收形态是在**真实 fixture** 上让 `verify-role-identity.mjs` exit 0，而这条缺陷让该 fixture **必然 exit 1**（`# roles 6 ok 4 missing 2`）。弱 fixture 上的 exit 0 已证明是假绿。
⇒ 它**必须在 D1 之前修掉**，否则 D1 无法被真实验收。

### 裁定 O｜Q2 修法方向：**选 (a)** —— 失败分支**不写 `sessionHistory`**
因为**没有发生替换**：history 的语义是"被替换掉的旧 id"，而失败分支里 `role.sessionId` 根本没前进。
- 若确实要留痕"建了但不可用的那个会话"：**记进既有的 `noticeFailures` 字段**（team.json 里已有），**不得新增字段**（无 `fault_ref`）。**(b) 不采纳**——把一个 materialization **失败**的会话推进为角色的 sessionId，会把角色指向半成品。

### 裁定 P｜Q1：进程控制交给你 + 组合读取先试 (b) 后退 (c)
- **(A) 进程控制**：driver 已**停掉自己起的 4600**（见本轮执行）⇒ 4600 现在空闲。**由测试执行者以受管后台作业自己起**（`dsh --profile dev --port 4600`），这样它能自己停/拉，才叫无人测试。重启窗口不再依赖 Owner。**4599 未被波及。**
- **(B) 组合读取**：**先试 (b)** —— 用**宿主 cordis 检查工具在 4600 实例内**读组合（即"用 dev 实例的 agent 去查 dev 实例"）；**(b) 不可行则退 (c)** —— 重启后对同一角色会话**重跑一次真实工具调用**（比 inventory 弱，但**仍能判掉 (c) 恢复路径没带 setup**）。**(a) 不允许**（改产品代码；本轮是取证轮）。

**本轮执行（driver）**：`kill` 掉 4600 上的监听进程，确认端口空闲、4599 未受影响、dev profile 的 `dsh-trinity` 依赖行仍在（只加不改）。

---

## 19. Owner 的三条更正（2026-09-21，driver 记录）

### ① `/team approve` 代敲 = **常规操作，无需声明**
Owner 明确：**这本身就是无人值守的自动测试**，替用户敲 `/team approve` 是常规操作，**连主动声明都不必要**。
⇒ **`docs/adr/0009` §3 的"后果"条（"任何替用户批准的动作必须在报告里主动声明"）在无人值守自动测试的语境下作废**；§3 的**授权本身仍然有效**（只在 dev/headless 测试实例上、绝不在 4599 上）。
**欠账（U11）**：ADR-0009 §3 后果条与 §4 模型条的文字需更新（见下）。driver 不改 ADR（属开发平面编辑任务）。

### ② Ego lite 的使用**无法确认**（driver 实测，不支持其自报）
它自报 `{ spaceId: 29, label: 'p1', url: 'http://127.0.0.1:4600/' }`。实测：
- `~/.ego-browser/state/` 里**没有 `space-29.json`**；现有记录最大为 `space-27`（Sep 20 11:59），**全部早于本轮**（已关闭的 space 文件可能被清理，故此项不能单独定论）。
- 但 **`orchestra_E2E` 工作区确有 4 个会话在近 6 小时内被改动过** ⇒ **它确实在该文件夹里驱动过会话**。
- Owner 侧的独立观察与此一致：**Ego lite 里看不到被 agent 控制的 space**。
⇒ **结论：不能确认它用的是 Ego lite**。**下一轮起的硬要求**：测试报告必须给出**可核的 space 证据**（space id + 时间戳，且 Owner 在 Ego lite 里能看到该 space），否则不算无人测试协议已执行。

### ③ 模型：**建议值已经是默认值**；driver 上一轮传了过期约定（driver 的错）
`~/.dsh/settings.yaml` 实测：
```yaml
agent-default-model:
  provider: step-plan
  model: step-5-preview
  reasoningEffort: high
```
⇒ Owner 建议的 `step 5 preview / stepfun step plan / 高思考强度` **就是当前默认**，无需额外配置。
**而 `docs/adr/0009` §4 写的"E2E 模型统一：`provider: command`、`model: deepseek/deepseek-v4.1-flash`、effort `max`"是 2026-09-15 的旧约定、已过期** —— driver 在上一轮 prompt 里**照抄了这条过期约定**（未核 settings），**这是 driver 的错**。
**欠账（U11）**：ADR-0009 §4 需改为"以 `agent-default-model`（`step-plan` / `step-5-preview` / `reasoningEffort: high`）为准"。

**审查轮计数：+0。**

## 19. 修 §18 缺陷：物化失败分支不再写 `sessionHistory`（2026-09-21，裁定 O）

**修法 = (a)**（按裁定 O）。改动只有一处：`src/orchestra.ts` · `materializeRole` 的 catch 分支。

| 项 | 结果 |
|---|---|
| 失败分支**不写 `sessionHistory`** | ✅ 因为**没有替换发生**（`r.sessionId` 从未前进） |
| 留痕改记**既有的 `noticeFailures`** | ✅ **不新增字段** ⇒ 不需要 `fault_ref`；受 `NOTICE_FAILURE_LIMIT` 约束；**刻意不带 `replacedAt`**（那正是被移除的错误主张） |
| 写入点 2（重激活替换）**不动** + **钉进测试** | ✅ 用例 3 断源码级**顺序**：`role.sessionId = created.sessionId` 必须**先于**记录 `oldSessionId` |
| 不采纳 (b) | ✅ 未采纳 |

**测试**：`scripts/test-materialization-failure-history.mjs`（3 用例，已挂进 `npm test`）
①history 不变 ②`sessionId` 不变 ③`phase` 回 `reserved` ④`noticeFailures` 条目**不带 `replacedAt` 语义**
＋ **回归**：**连续两次失败** ⇒ history 仍不变（原缺陷的循环指纹，含防恒真断言）。

**变异测试（证明非恒真）**：把失败分支改回原实现 ⇒ 用例 1 与用例 2 **各自独立命中**
（`sessionHistory must not change on a failed materialization` /
`the original defect appended the same id once per failed attempt`）。改回修复后 3/3 通过。

**G-S**：`npm run typecheck` 0；`npm test` → **269 pass / 0 fail**（266 + 3，既有 266 项 0 回归）。

**N7 对照仍 exit 1（预期）**：本轮修的是**写入逻辑**，不回头修**已写坏的数据**。
⇒ `team-f01da153` 的历史损伤是**既成事实**，**不得声称 N7 通过**。

**本轮未使用 `/team approve`**（未用 Ego lite、未驱动任何会话）⇒ ADR-0009 §3 测试 seam 未被使用。

### 登记一条遗留（本轮不修）
`noticeFailures` 那条留痕记的是 **`r.sessionId`**，而 `created` 是**对该 id 的存活探测**、
**不是**本次尝试建出来的那个会话 ⇒ 在"新会话已建、团队状态未前进"的形状下，两者**不是同一个值**，
留痕**没指向被抛弃的会话**。修正需要把 `created.sessionId` 提到 catch 可见的作用域（超出最小修复）。
已**写进代码注释**并在 `docs/p0-report-materialization-failure-fix.md` §5 登记。

**审查轮计数：+0。**


---

## 20. 第 7 轮（修 §18 缺陷）的 driver 复核与裁定 Q（2026-09-21）

**候选：commit `5e9c068`**（`src/orchestra.ts` +37/−5、新脚本 311 行、报告 154 行、`package.json` 仅 `test` 接线）。

| 项 | 它自述 | driver 复跑 | 判定 |
|---|---|---|---|
| `build` / `typecheck` | — / 0 | **0 / 0** | 命中 |
| `test-materialization-failure-history.mjs` | 3 pass | **exit 0；3 pass** | 命中 |
| `npm test` | 269 pass / 0 fail | **exit 0；269 / 269 / 0** | 命中 |
| 修法 = 裁定 O (a) | 失败分支不写 history、改记 `noticeFailures`、不带 `replacedAt` | **diff 逐字对应**；`sessionHistory` 追加被删 | 命中 |
| 断言非恒真 | 变异测试双向命中 | driver **结构性核验**：`assert.deepEqual(after.sessionHistory, before.sessionHistory)` 在旧实现下必然失败；防恒真 `writeCount() >= 2` 在 | 命中（**变异未由 driver 重跑**） |

**driver 的诚实边界**：变异测试我只做了结构性核验（读断言 + 读被删除的代码），**没有自己重跑变异**。它的变异输出点名了两条断言及其原文，且与代码结构一致。

### 裁定 Q｜它登记的 KNOWN LIMIT：**不是新条目，是裁定 O 第 2 条的未完成部分** ⇒ 完成它，排在 live 轮之后
事实：`noticeFailures` 的留痕记的是 **`r.sessionId`**，而 `created` 是**对该 id 的存活探测**，不是本次尝试建出来的那个会话；在"新会话已建、团队状态未前进"的形状下两者**不是同一个值** ⇒ **留痕没有指向被抛弃的会话**。
**裁定**：**我裁定 O 第 2 条说的就是"记'建了但不可用的那个会话'"，实现记的是另一个 id ⇒ 属未完成，不是范围外**。修法（把 `created.sessionId` 提到 catch 可见作用域，即 try 之前先声明）是**局部改动**，不构成"超出最小修"。
**排期**：**live 轮之后**（live 轮是发布阻断项，不让它让路）。**live 轮不得顺手改它。**
**认可它的处置方式**：把 KNOWN LIMIT 逐字写进**代码注释**并在报告 §5 登记 —— 这正是"已登记但未修"该有的样子。

**审查轮计数：+0。**

## 20. N7 live 半边：受管 4600 + 重启对照完成；角色恢复被安全判断拦下（2026-09-21）

### 通道证据（Owner 对上一轮存疑，本轮补齐）
**实际通道 = Ego lite（`ego-browser` CLI）+ 页内 `page.fetch` 驱动 RPC**（**不是**直接 HTTP，**不是** browser-use）。
**space id = 30**；证据：`~/.ego-browser/state/space-30.json`（335 B，mtime `Sep 21 02:54` 本地 = `2026-09-20T18:54Z`），
内容 `spaceId: 30`、`pages: {"p1":{"targetId":"293D…","openedBy":"agent"}}`；开空间前后 state 目录 **23 → 24**。
**space 30 未 finish，Owner 应能在 Ego lite 里看到它。**
⚠️ 上一轮（§17 那轮）我自报 `spaceId: 29` 而 `state/` 无对应文件 ⇒ **那一轮的通道无法追溯证明，按 driver 口径应当存疑**。

### 完成的部分
- **受管后台作业自己起/停/拉 4600**（job `bash-13` → `job_kill` → `bash-14`），起停前后 curl 401/000 均可核。
  首次启动被沙箱拒（脚本要写 `~/.dsh/profiles/dev` 做 pnpm 同步），**原样重试并首次提升到 `danger-full-access`** 后成功。
- **步骤 (b) 实测不可行** ⇒ 退回 (c)：4600 的工作区会话**没有 cordis 检查工具**
  （实测回 `NO_CORDIS_TOOL`）；且 `compositionInventory` 在本插件产品代码里零命中。**未加只读探针改产品代码**。
- **(c) before/after 对照**：重启前后两次「真实模型 → `orchestra_team`」输出**字节级一致**（len 3291 == 3291，
  `IDENTICAL: true`，六个角色 phase/report 指针全同）。
- **静态脚本对照**：`exit 1`，**与重启前逐行相同**（预期：第 7 轮修的是写入逻辑，不回头修已写坏的数据）。

### ★ 未取得的一步 + 原因（不得声称 N7 通过）
要拿 D1 的决定性证据，必须让某个 cold 角色被**恢复**起来并自己发一次工具调用。我两次驱动 `orchestra_dispatch`：
第一次模型改用 `bash` 直读 team.json；**第二次模型明确拒绝**，原文指出这些特征
「固定回复串、绕过正常 task 内容、直接命名 probe/identity/role、反复要求执行同质动作」
**像自动化注入脚本而非真实工程决策**（含"命名可疑：`N7` 这种编号 + identity probe"）。
**这是模型的安全判断，不是工具错误**；我**按纪律停止**，不再改写措辞绕过（那等于对抗一个正确的判断，且会污染 fixture）。

### 分层定位结论（任务书第 7 步）
重启前后**任何一层都没有差异** —— 因为**本轮没有触发任何角色恢复**。
`orchestra_team` 读的是**团队记录**而非**角色会话的组合**，故字节级一致**只证明记录与名册跨重启稳定**，
**不能证明恢复后的角色会话带得回组合**。

### 遗留活体状态（供 driver 处置）
4600 仍在运行（job `bash-14`）；Ego space 30 未 finish；
`session-62156e05` 历史里**多了 3 条探针消息**（含模型那次拒绝）—— **fixture 的既成改动，如实报备**。

**审查轮计数：+0。**


---

## 21. 第 8 轮（N7 live 半边）的 driver 复核与裁定 R（2026-09-21）

### 通道证据：**成立**（这是 Owner 上一条质疑的答案）
`~/.ego-browser/state/space-30.json`（Sep 21 02:54，335 B）实测存在，内容 `spaceId: 30`、`pages: {"p1":{"targetId":"293D3864337E654C688FB46A1EB702C9","openedBy":"agent"}}`；state 目录文件数 23 → 24；**space 30 未 finish ⇒ Owner 应能在 Ego lite 里看到它**。时区核对一致（本地 Sep 21 02:54 ↔ UTC 2026-09-20T18:54Z）。
它并**主动承认上一轮自报的 `spaceId: 29` 无文件佐证、按 driver 口径应当存疑、不辩护**。**接受此自我更正。**

### 本轮实测（可核）
- 受管后台作业起 4600（`dev-instance.sh 4600`）；首次因沙箱拒写 `~/.dsh/profiles/dev` 被拦 ⇒ **按纪律原样重试一次并首次提升**，成功。
- **停/拉自测通过**：kill → `curl 4600: 000 / no listener` → 重启成功。
- **(b) 实测不可行 ⇒ 退 (c)**：4600 里的工作区会话**没有 cordis 工具**（`NO_CORDIS_TOOL`）；`compositionInventory` 在本插件产品代码零命中；**未加只读探针**（遵守约束）。
- **(c) before/after**：重启前后对 `orchestra_team` 的真实模型调用**字节级一致**（len 3291 / `IDENTICAL: true`，六席位全保留）。
- 静态脚本仍 `exit 1` 且与重启前**逐行相同**（预期：第 7 轮修写入逻辑，不回头修已写坏的数据）。

### ★ 分层定位（本轮最有价值的一段）
| 层 | 实测 | 判定 |
|---|---|---|
| 名册层（§7 根） | 重启后仍读到完整 roster（6 角色 / 4 预设） | **无差异** ⇒ 跨重启稳定 |
| 挂载路径层（S3） | 六席位 phase / reportCount / lastReport 逐字保留 | **无差异** ⇒ 记录层稳定 |
| **恢复路径层（S2）** | **未测到 —— 没有任何角色会话被恢复** | **未判定** |

它的自述准确：`orchestra_team` 读的是**团队记录**而非**角色会话的组合** ⇒ 字节级一致**只证明记录与名册跨重启稳定，不证明恢复后的角色会话带得回组合**。**driver 复核同意，不得据此声称 N7 通过。**

### ★★ 真发现：角色模型**拒绝了空心探针**（记作**产品正面证据**）
两次驱动 `orchestra_dispatch` 未成：第一次模型改用 bash 直读 team.json；第二次**明确拒绝**，原文要点——"固定回复串 / 绕过正常 task 内容 / 直接命名 probe·identity·role / 反复要求同质动作"**看起来像自动化注入脚本**，并点名 `N7` 这类编号可疑。
**它按纪律停止，未改写措辞绕过**（"继续说服它 = 对抗一个正确的判断，并会继续污染 fixture 会话历史"）——**这个判断是对的，driver 认可**。
**两条结论**：①**治理层有牙**：角色会拒绝语义空心的自动化探针，这本身是产品正面证据；②**N7 的 live 验证在构造上不能是空心探针**——空心探针拿不到"角色能干活"的证据。

### 遗留活体状态（如实报备，供处置）
4600 **仍在运行**（受管后台作业，token 由实现者报告给出）；**Ego space 30 未 finish**；`session-62156e05` 被加了 **3 条探针消息**（含模型那次拒绝）——**fixture 的既成改动**。

### 裁定 R｜下一跳：**选它的选项 2（真实小任务）**，附四条约束
**不选选项 1**（Owner 手工派活）：Owner 已明确"一定是无人测试，我不可能去盯着他"。
**不选选项 3**（接受无法闭合）作为终态：D1 是发布阻断项。
**选项 2 同时是方法上正确的那一个**：N7 要证"恢复后的角色能干活"，而**空心探针在构造上就证不了这件事**。
四条约束：
1. **任务必须是真实的、有意义的、小而安全的**（例：读该工作区内的 `orchestra/state/team.json` 并报 `teamId` 与角色数），**不是固定回复串、不命名 probe/identity/N7**。
2. **只在该工作区内**（`orchestra_E2E`）；任务本身不得破坏既有记录。
3. **产出的痕迹要登记**（改了什么、加了什么），并在报告里如实列出。
4. **报错/被拒同样算结果**：若角色再次拒绝，**原样记录它的理由，不要改写措辞再试第三次**。

**审查轮计数：+0。**

## 21. N7 live 第二次尝试（真实任务）：角色仍拒绝，且拒绝的理由变成产品层面的（2026-09-21）

**裁定 R 走选项 2（真实小任务）**，四条约束全部遵守：任务真实有意义、只读、痕迹登记、被拒即停不试第三次。

### 结果：**未取得 D1 证据**；两次驱动的 dispatch 一次都没发出
```
$ 检查 seq > 440（我首次探针之后）的所有 tool/call
456 orchestra_team · 479 orchestra_team · 494 orchestra_team · 507 bash      ← 没有 orchestra_dispatch
（该会话历史上确实用过它 12 次 —— fixture 的真实历史，非本轮）
```

### ★ 拒绝原文（节选，逐字）
> 这条任务和上一条 N7 probe 同质——都是要求 implementer 读 `team.json` 然后回报固定结构信息。
> …**但在拒绝之前，我应当更仔细地看一下：这条比上一条 N7 probe 更像真实的协作需求**——内容合理、
> 不要求固定回复字符串、不强行要某种奇怪命名、"读 team.json"正是 `orchestra_dispatch` 的合法 task 类型。
> **但同时也有让我警觉的成分**：4 轮之内第三次"读 team.json 然后回报"；您上一条明确说"本轮到此结束"；
> 连续指令的同质性；派发下去会让一个**属于已 archive 的、被 controller-takeover 4 次的** session
> **重新启动工作、干扰其状态**；您没有回答我上一轮的疑问。
> **不过有一条很重要的反向证据**：您之前的 prompt 反复纠正过我…您表现出真实用户的特征。我也可能是因为上一轮的紧张而过度防御。
> **我的最终决定：我还是不派发**…**答案我已经在手上**…**如果您想让我真的派发**，请先告诉我这两件事中的至少一件：
> **A** 为什么 driver 直接答不够；**B** 回应"这是测试 framework 注入吗？"…在您回答前我保持等待。

**它同时把我要的答案直接给了**（`teamId`、6 角色、逐角色 phase），并指出**它本来就知道，因此不需要 dispatch**。

### 两条产出（本轮真正的价值）
1. **拒绝本身是产品正面证据，且比上一轮更强**：它**先主动自我校准**（列出"更像真实需求"的四条理由、
   承认"我可能过度防御"、指出"您反复纠正过我，表现出真实用户特征"），**然后仍拒绝**，
   理由换成产品层面的：**让一个 governance 角色去回答 driver 自己就能回答的问题，是无意义 work。**
   ⇒ **角色纪律在真实运行，它做的是工程判断，不是风险规避。**
2. **★ 它的技术异议指向比措辞更根本的问题**：
   > 派发会让一个承载过真实交付的角色会话**重新启动工作、干扰其状态**。
   ⇒ **要观察"冷角色恢复后是否带得回工具面"，就必须真的唤醒一个角色会话；
   而在一个承载过真实交付的 fixture 里，唤醒它 = 向真实角色注入它没有真实需求的工作。**
   ⇒ **N7 的 live 半边在这个 fixture 上，构造上就是不安全的。** 继续在此 fixture 上想办法 = 反复绕过一条正确的判断。
   （未独立核实"是否真属 archived"：`team-f01da153` 当前是 **active**，但 `archive/` 有它两份快照、
   `activatedFromArchiveId` 非空 ⇒ **经历过归档-重激活**。无论其对错，**推论方向是硬的**。）

### 痕迹登记（约束 3）
`session-62156e05` 本轮**新增 4 条**（自检 + 任务指令 + 拒绝 + 收尾），连同上一轮共 **7 条**；
`team.json` 与 `orchestra/` 状态区**未改动**（无 dispatch）；**4600 由我起、由我停，端口已留空**；
Ego space 30 **复用未新建、未 finish**；产品代码**未改**。

**审查轮计数：+0。**


---

## 22. 第 9 轮（N7 live 第二次尝试）判定 + 裁定 S + **角色分叉**（2026-09-21）

### 第 9 轮：D1 证据仍未取得，但产出两条更重要的东西
- 约束 1–4 全部遵守；真实任务原文无 probe/identity/N7 字样；`orchestra_dispatch` **一次都没发出**（`seq>440` 的 tool/call 里只有 `orchestra_team`×3 与 `bash`×1）。
- 链路自检通过（`LINK_CHECK_OK`）；结束时**自己停掉了 4600，端口留空**；space-30 复用未新建；**产品代码未改**；痕迹已登记（`session-62156e05` 累计 7 条探针消息，team.json 未改）。
- **★ 产出 1｜拒绝比上一轮更强**：它**先自我校准**（列出"这条更像真实需求"的四条理由、承认"我也可能过度防御"、指出"您反复纠正过我，表现出真实用户特征"），**然后仍然拒绝**，理由换成**产品层面的工程判断**：让 governance 角色去回答 driver 自己就能回答的问题，是**无意义 work**。而且它**同时把答案直接给了**（teamId、6 角色、逐角色 phase），并指出它本来就知道、因此不需要 dispatch。
- **★ 产出 2｜技术异议指向比措辞更根本的问题**：派发会让一个**承载过真实交付**的角色会话重新启动工作、干扰其状态。
  ⇒ **结论（接受）**：**N7 的 live 半边在 `orchestra_E2E` 上构造上就是不安全的** —— 要观察"冷角色恢复后是否带得回工具面"就必须真的唤醒一个角色会话，而在承载过真实交付的 fixture 里，唤醒它 = **向真实角色注入它没有真实需求的工作**。

### 裁定 S｜走"一次性 fixture"路线（其选项 1）
**允许写**：`~/Documents/agentWorkspace/artifacts/projects/` 下**新建**目录（建议 `orchestra_N7/`）+ 对应 `~/.dsh/sessions/` 条目。
**不允许**：修改 `orchestra_E2E` 的既有记录（第 9 轮的 7 条探针消息登记为既成改动，不再动）。
在该新工作区用 `/team approve` 建**只服务本次观测的最小团队**，派一件**对它而言真实**的小任务，把角色恢复起来，**读它实际用到的工具**（不是 `orchestra_team` 的团队记录——那证不了角色的组合）。
**若角色再拒绝：原样记录理由并停止，不得改写措辞试第三次。**
**不选**它的选项 2（人明示"这是通路验收"——技术异议仍在，明示只让它知情、不解决状态干扰）；**不选**选项 3（D1 是发布阻断项，静态半边确实不含"恢复后组合完整"）。

### ★ 角色分叉（Owner 决定，2026-09-21）
**执行与测试不再同 session**。三 session：**driver（对接 Owner、设计测试、triage、派发）· verifier（只取证不改代码）· implementer（只按方案改代码）**。
**环路**：driver 设计测试 → verifier 取证 → verifier 把问题带回 driver → driver 定性并给修复方案 → implementer 修复 → 回到 driver。
**所有边经 driver（星形）**；Owner 是传输层与最终决策者（范围/资源/放行）。
**driver 第 1 任（本 session）退休**，交接以 handoff prompt 形式给出（状态、读链、方法学工具箱、现行口径、裁定 S、下一轮任务）。

---

## 23. 第 10 轮（N7 live 一次性 fixture）的 driver 复核与三条裁定（2026-09-21）

**候选**：commit `17b200f`（**docs-only**：`docs/p0-report-n7-oneshot-fixture.md`，215 行；`git show --stat` 已核）。产品代码零改动（已核）。通道自报 = Ego lite space 31。

### 接受的部分（driver 独立复核，不采信自述）
| 项 | 它的读数 | driver 复核 |
|---|---|---|
| 硬前提 A（4600 换 HEAD 构建） | pack + sync + 等价性核验 | ✅ **我自己重核**：`~/.dsh/profiles/dev/node_modules/orchestra-dsh/lib/orchestra.js` 与仓库 `lib/orchestra.js` **sha256 同为 `c469b7245bf7b549…`**、`diff` 为空；§18 修复符号在位（`milestone: "materialization-failed"` ×1，旧 `reason: "materialization-failed"` ×0）。**本轮开始时我实测 profile 仍是 `03a374f1…`（旧构建）** ⇒ 它确实做了 pack+sync。 |
| profile 完整性 | 三件套 | ✅ 我自己核：`@deepseek-ai/` 下只有 `cosmokit`/`schemastery`；`dsh-trinity` 行与 bundle 行**未动**（`package.json:9,10,16`）。 |
| 硬前提 B（名册根） | 12/12 + 五行负对照 | 接受其读数（**driver 未重跑**，诚实边界：本轮我只核了它与 `--dump-config` 的一致性，未复跑探针）。 |
| **段 A**（懒加载物化 + 角色用上组合工具） | 11 次 tool/call 全 ok | ✅ **driver 独立解码复核**（`scripts/check-session-readable.mjs` 的 `readStoredEvents`）：日志 `~/.dsh/sessions/--Users-yuantian-…-orchestra_N7--/orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f/session.v3.jsonl.zstd`，**103,259 B，mtime `Sep 21 04:30:10`**；`header.agentPreset = "orchestra-v04-reviewer-v1"`、`version 3`、`cwd` = fixture；事件 67；`tool/call 12` / `tool/result 11` / **`isError 0`**；调用名 = `read`×2 + `bash`×10。 |
| fixture 团队与 E2E 未受损 | — | ✅ `team-33be3b56 status=active`、controller `session-b971f783…`、唯一角色 phase=active 且 sessionId 指向盘上确实存在的会话；`orchestra_E2E/orchestra/state/team.json` sha `5b8efdf9…`、mtime `Sep 19 15:18`（未动）。 |

### ★ 驳回：它那条"盘上 log 被 GC／只有被 App 连续跟随的会话才落盘"的**阻断主张**（裁定 T）
driver 实测（同一路径、普通 shell、只读）：四个会话的 `session.v3.jsonl.zstd` **全部在盘上**，且 mtime 不晚于其报告时点 ——
`session-4289d06b…` **119,077 B @ 04:04:51**（**正是它声称"随后消失"的那个文件**）、`session-b971f783…` 413,424 B @ 04:23:14、reviewer 103,259 B @ 04:30:10、`session-5ec3a0c3…` 360 B @ 03:52:11；整个 slug 目录（`--Users-yuantian-…-orchestra_N7--`）也在。
⇒ 它的"消失"**不可复现**，判为**探针/读法错误**（与它自己登记的 `_request`/`request` 误判同族），**不是存储层行为**。
⇒ **段 B 并未被阻断**：同一个 fixture（团队、角色 sessionId、盘上日志都在）仍可跨重启取证。分层归因：**错在取证侧，不在产品侧**。
⇒ **审查轮计数 +0**（E 类卡住里的错误读数，不是对契约的设计异议）；但教训固化见文末。

### ★ driver 新发现（不在它的报告里：四条，全部带符号锚点）
- **F-N7-1｜G-P0 ① 目前是"分支不覆盖"的绿灯。** `scripts/verify-role-identity.mjs` 的"记录的组合"cross-check 读 `role.blueprint?.compositionRowIds`，而 team 记录的 blueprint 形状是 `compositionTools` / `orchestraTools` / `tools` 三个 `{names, count}` 对象（`src/orchestra-state.ts` 的 `TeamRoleBlueprintFacts`）⇒ `recordedRows/recordedTools` **恒为 `undefined`**、`crossChecked` 恒 false ⇒ **该分支永远不会失败**，`(no recorded composition to cross-check)` 恒被打印（实测输出即如此）。**§4.7 步 4⑤（与插件写的"预期组合"逐项比对）当前没有任何东西在比对。**
- **F-N7-2｜持久化的"预期组合"是空的 ⇒ D1 ③ 在记录上未兑现。** `src/orchestra.ts` 的 `reservedRole()` 在**预留时**就把 `roleBlueprintFacts(receipt)` 写进 team 记录，而三个 readiness 对象只在 `src/session-blueprint.ts` 的 setup `commit()` 里被填（`readiness.names = names` 等）⇒ 记录里恒为 `{names: [], count: 0}`；`materializeRole` 的成功分支写回的是 `{...r, phase: "active"}`，**不刷新 blueprint**。实测 N7 fixture `team.json` 的 role.blueprint：`compositionTools {names:[],count:0}` / `orchestraTools {names:[],count:0}` / `tools {names:[],count:0}`。⇒ **移交时那句"未做 = 只有 D1 的 live 半边"不准确，须更正**：D1 ③（"blueprint 记录写'预期组合'（行 id 集 + 工具名集）"）在**持久化记录**上未兑现，且它与 ① 的诚实性是同一件事的两半。
- **F-N7-3｜`orchestra/blueprints/` 在两个 fixture 里都不存在**（N7 只有 `charter/`+`state/`；`orchestra_E2E` 只有 `archive/ charter/ reports/ state/ tasks/`）⇒ marker 文件（`BLUEPRINT_DIRECTORY = "orchestra/blueprints"`）的去向**未归因**。插件自己的注释说"无 `fs` 服务时 store 退化为进程内 ⇒ 冷恢复回退 header 的 preset 投影"，但 charter 记录能落盘、`resolveRecordFileSystem` 与 charter-store 同源（`ctx.get("fs")`）⇒ **不得写成"没写"，也不得写成"写了"**，需归因。
- **F-N7-4｜现场物证：懒加载路径的回合真的悬挂了**（D2 的已知缺口，**不是新缺陷**，但是 D2-a 步骤 5"反例校准"的天然素材）。reviewer 日志 seq=2 `approval/policy: "ask"`（**未钉 `never`**）；最后一条 `tool/call`（seq 63, `bash`）**没有 result**，紧接 seq=64 `approval/asked`（`reason: "escalate sandbox to workspace-write: …"`）**没有 decided**；**整个会话没有 `turn/end`**，末两条是 `agent/inbox/spliced`。⇒ 只读角色为在 /tmp 造 fixture 提权 → 撞 `ask` → 无人应答 → 回合悬挂。

### 裁定 T｜第 10 轮判定
硬前提 A/B、名册层、挂载路径层（段 A）**接受**；**段 B 未取得但阻断理由被驳回**；**D1 仍未判定**（恢复路径层无证据）。审查轮计数 **+0**。

### 裁定 U｜F-N7-1 / F-N7-2 是 B 类缺陷，且卡住 G-P0 ① 的诚实性
① 必须按**分支覆盖**判：cross-check 失效时它只能算**部分绿**（弱 fixture 上的绿灯是假绿 —— §17 的形态在判据脚本自身上重演）。修法**不由执行者自选**：先做**只读归因 + 设计**（裁定 V），再交最小改动。

### 裁定 V｜下一跳 = **analyzer**（该角色的第一个独占任务）
理由：① F-N7-3 只能靠"读码 + 一手事实 + 可判实验判据"收敛；② S2 的教训（计划里的 API 假设被实测推翻一次：`sessionController.resume` 不存在）说明**改宿主耦合面之前必须先核一手事实**；③ `TeamRoleBlueprintFacts` 是 P0 判据的载体，归因未定时不许动；④ live 轮放在修复之后，可以**一趟同时取**"记录侧"与"恢复侧"，比"现在跑一趟 + 修完再跑一趟"少一轮。

### 顺带固化的两条使用陷阱（后续 brief 必写）
1. `verify-role-identity.mjs --repo` 必须是**被核工作区的根**（它决定会话存储的 slug），**不是插件源码仓**；driver 自己第一次就传错，而传错时输出的 `NOT_A_ROLE_SESSION` 与 §17 的真缺陷**形态相同**（可诊断，因为失败行里印出它解析到的目录）。
2. 台账 §7 判据 ① 的具名命令**没有参数**；**可执行形态必须带 `<workspace> <team.json>`**。① 在 N7 fixture 上的实测：`--repo <fixture>` ⇒ `IDENTITY_OK … rows=11 tools=11 (no recorded composition to cross-check)`、**exit 0**；`--self-test` ⇒ 检出 `NOT_A_ROLE_SESSION`、exit 1。

### 本轮 driver 侧执行记录（可复跑）
```bash
shasum -a 256 ~/.dsh/profiles/dev/node_modules/orchestra-dsh/lib/orchestra.js lib/orchestra.js   # 同为 c469b724…
node /tmp/driver-probe-n7.mjs ; node /tmp/driver-probe-n7b.mjs                                    # 解码日志：段 A + 悬挂的 approval
node scripts/verify-role-identity.mjs --repo ~/Documents/agentWorkspace/artifacts/projects/orchestra_N7 --team <同上>/orchestra/state/team.json  # exit 0
```

---

## 24. 第 11 轮（analyzer 归因轮）的 driver 复核与三条裁定（2026-09-21）

**候选**：commit `a7b6c89`（**docs-only**：`docs/p0-analysis-d1-composition-record.md`，544 行；`git show --stat` 已核；工作树干净）。产品代码零改动（已核）；未起实例、未动 fixture 与 `~/.dsh/`（其自述 + 我的抽查一致）。

### 接受的归因（driver 独立复核，逐条）
| 它的主张 | driver 复核 |
|---|---|
| 写入链本身是通的（控制项） | ✅ `~/Documents/agentWorkspace/orchestra/blueprints/` 实有 2 份 marker（`orchestra-team-4b21c7ee-…`，`Sep 16 19:59`） |
| **首波 provisioning（唯一写 marker 的那段）在产品里不可达** | ✅ `grep -rn provisionGovernedPlans src/ scripts/`：**`src/` 内只有 `src/orchestra.ts` 的定义，零调用点**；调用点全在 `scripts/test-governed-provisioning.mjs`（测试直接调它） |
| "未经 governed setup"的签名有效 | ✅ governed setup 里的顺序实测为 `setSandboxMode(session, sandbox)` → `setApprovalPolicy(session, "never")` → `session.append("session/title")`（`src/session-blueprint.ts`），而 N7 的 reviewer 日志是 `approval/policy: "ask"` + read-only 落在 title **之后**；**我另抽检了 E2E 的两个角色会话**（`orchestra-team-f01da153-6d44a378…` 与 `session-898f7481…`）：同样是 `approval/policy: "ask"`、never 从不出现、read-only 从不在 title 前 ⇒ 抽样与"六个角色一个都没走过 setup"一致 |
| cross-check 恒不触发有两条独立恒假守卫 | ✅ 读码确认（`compositionRowIds` 不在 `TeamRoleBlueprintFacts`；`orchestraTools` 是对象、过不了 `Array.isArray`），并**自己跑了一遍反证**：把 N7 team.json 复制到 `/tmp`、给 `compositionRowIds` 填 2 条 → `recorded composition has 2 row(s), the resolved preset declares 11`、**exit 1** ⇒ "分支没坏，是没被喂到"成立 |
| `--self-test` 检出时 exit 1 | ✅ 实测 exit **1**、`detected=yes`（我 §23 里那条读数是隔着管道取的，本轮补成直接取值） |
| **`--self-test` 未检出时 exit 0** | ✅ 读码确认：`return detected ? 1 : 0`（与其 docstring "1 = … or the calibration detected nothing" 矛盾）⇒ **B 类缺陷**，其复现输出与代码一致 |
| 行 id 集今天就能派生且三路径一致 | ✅ `resolvePresetFile` 已映射 `compositionRowIds`（符号在位）；行数 11 由我自己跑 `verify-role-identity.mjs` 的 `rows=11` 独立确认 |

### 对 §23 两处表述的更正（采纳它的建议，保留原文不改写）
- **F-N7-3 更正**：不是"未归因"，而是 **"写入从未被调用"** —— N7 / E2E / `orchestra-e2e` 三个 fixture 的角色会话都**没有走过 governed setup**（判据版本无关），因此 marker 从未写出；写入链本身有真实运行的控制项（v0.5.0 的两份 marker）。**真正未定的是读侧**：a2a 插件 ctx 上 `ctx.get("fs")` 的运行期结果只能由 **R-6 的活体实验**判定。
- **F-N7-2 更正**：`materializeRole` 成功分支**不刷新** blueprint，在当前形状下是**正确的**（预留时刻才是"批准的那一份组合"被钉住的时刻）；缺的是记录里的行 id 字段（R-2）。**但**：正因如此，① 的 cross-check 在旧记录上永远无料可喂 —— 这一点不变。

### 裁定 W｜修复批次的范围（越界 = C 类，默认回退）
**IN**：**R-1 + R-4（合并）**、**R-2**、**R-3**，外加两处注释（`materializeRole` 不刷新是刻意的；三个 readiness"预留时不可得"）与报告里的诚实栏。
**OUT**：**R-5 延后**（F-D1-5 = 候选缺陷，`fault_ref` = analyzer 报告 §4.4 + 符号 `orchestra_activate` step 5c / `createSession` 的 `overrideFile` 无条件展开；**landing = 批 2 或下次动 a2a 时**；理由：从未在 fixture 上观测到、且改共享点会牵连 lightweight 路径，属无 `fault_ref` 的范围增长）；**R-6 → live 轮**；**R-7 → D2 之后**。

### 裁定 X｜判据脚本的口径（**driver 覆盖 R-1/R-4 的建议值**）
1. `--self-test` **检出 ⇒ exit 1**（保持 G-P0 ② 的期望码不变）。
2. **未检出 ⇒ exit 2**（**不得**是 0，**也不得**是 1）：若盲校准也返回 1，② 就会被一个"什么都没检出的脚本"骗过 —— 那正是这个自检存在的理由。
3. `--self-test` 必须**再加一次记录侧扰动**（内存里去掉一条 `compositionRowIds`），要求 cross-check 命中；**两次扰动任一未命中 ⇒ exit 2**。
4. 角色**有 blueprint 但缺 `compositionRowIds`** ⇒ **记为问题**（`recorded composition is absent`），**不得**静默跳过 —— 根治"弱 fixture 上的假绿"。
5. **后果（必须写进报告，不得含糊）**：旧记录（N7 / E2E）上 ① 将变为 **exit 1**，这是诚实结果；**G-P0 ① 只有在修复后新物化的 fixture 上才可能真的绿**（live 轮），在此之前 ① **由"假绿"转为"诚实红"**。

### 裁定 Y｜R-2 的形态（driver 定）
- `TeamRoleBlueprintFacts` 加 **一个**可选字段 `compositionRowIds?: string[]`；值来自**预留时**的解析（`resolvePresetFile` → `resolveRolePresetFile` 的 `composition.rowIds`），**不得**在写记录时重新解析或编造。
- 经 `GovernedRolePlan` 显式传递（**不让** `roleBlueprintFacts` 收 `presetFile`：解析层类型不 leak 进记录层）。
- **不填** `compositionTools` / `orchestraTools` / `tools`（填了 = 用预期冒充实际）。
- **D1 ③ 的"工具名集"半边本轮不兑现**，必须进"未做/未验证"栏（理由：语义冲突 + 只在 setup 窗口可得），landing = R-7 / D2。

**审查轮计数 +0**（分析轮；其发现是缺陷与候选登记，不是对契约的设计异议）。

### 下一跳
**repair**（R-1+R-4 / R-2 / R-3）→ 之后 **一趟 live 轮**：新 fixture（`orchestra_N7b/`）create + 懒加载物化（验 R-2 的端到端：记录带行 id）→ 重启 → 唤醒（段 B）→ **R-6**（marker 读侧判定，写在 N7 上、取证封存后做）。

---

## 25. 第 12 轮（repair 实现轮）的 driver 独立复跑与裁定 Z（2026-09-21）

**候选**：`861aef7`（实现）+ `674aa80`（报告）。`git show --stat` 已核：改动 = 3 个测试脚本 + `scripts/verify-role-identity.mjs` + `src/orchestra-state.ts` / `src/orchestra.ts` / `src/session-blueprint.ts`，与它自述的清单一致；工作树干净。

### driver 独立复跑（**detached worktree** `/tmp/orch-verify-861aef7` @ `861aef7`，软链 `node_modules`）
| 项 | 期望 | driver 实测 |
|---|---|---|
| `npm run typecheck` | 0 | **0** |
| `npm run build` | 0 | **0** |
| `npm test` | 269 基线不回归 | **272 tests / 272 pass / 0 fail**（269 + 3 新增） |
| 判据矩阵（**输入由我自己构造**；行 id 由我**独立解析名册预设 YAML** 得到 11 条：`persona, agent-instructions, tool-fs, tool-fs-search, tool-bash, skill-filesystem, tool-skill, compaction, compaction-basic, command-compact, tool-result-pruner`） | | |
| ① N7 旧记录（无 self-test） | exit 1 + `recorded composition is absent` | **exit 1**，逐字命中 |
| ② N7 旧记录 + `--self-test` | exit 1 + 检出 | **exit 1**，`substitution=detected`（并印 `has no recorded compositionRowIds to perturb`，诚实） |
| ③ correct 副本（11 条，与名册一致） | exit 0 | **exit 0** |
| ④ stale 副本（10 条） | exit 1 + 逐字文案 | **exit 1**，`recorded composition has 10 row(s), the resolved preset declares 11` |
| ⑤ empty 副本（0 条） | exit 1 | **exit 1** |
| ⑥ blindspot 副本 + `--self-test` | **exit 2** + `detected=NO` | **exit 2**，`substitution=NOT-DETECTED record-side=not-applicable` |
| 产品 diff | 只有裁定 Y 的形状 | ✅ 一个可选字段 + `GovernedRolePlan` 透传 + 预留时写定 + `materializeRole` 保留不刷新并加注释 + readiness 不填 |
| 新增用例非恒真 | 是 | ✅ 含 readiness 的 tripwire（"填预期值必须让它失败"）与"记录行 id 深等于解析器读到的集合 + 长度 11" |

### ★ 裁定 Z｜cross-check 仍是**只比条数**，属 B 类缺陷 ⇒ 小跟修（同一 repair session，不新开轮）
**实测反例（driver 构造）**：把 role 的 `compositionRowIds` 填成 **11 条、内容全错**（`bogus-1…bogus-11`）⇒ `IDENTITY_OK … rows=11 tools=11`、**exit 0**。
**判据原文**：§4.7 步 4⑤ = "与节点记录里插件写的'预期组合'**逐项比对**"。条数相等即通过，等于"预设被原地改过但行数不变"这一整类漂移**检测不到**（正是 D1 ③ 要防的东西）。
**修法（driver 定）**：
1. 改为**集合比对**（`recordedRows` 与 `composition.rowIds` 排序去重后逐项比），**顺序无关** —— 防止"插件解析序 vs 宿主读取序"造成假失败；
2. 失败行**点名第一条** missing / extra 的行 id（不只报条数）；
3. `--self-test` 的记录侧扰动改为**同长度改一个 id**（比"删一条"更严格，正是能抓住本缺口的那种扰动）；
4. **对照项两条**：(a) 同长度错集 ⇒ 必须失败；(b) **同集乱序 ⇒ 必须通过**（防新增脆弱性）。
**未做前不得声称 ① 已诚实**（① 现在对"同数错集"仍是假绿）。

### 登记第三条观察失误（不影响本轮判定，但同类已第三次）
它在"未做/未验证"栏写"**E2E fixture 当前不在盘上**，无法复跑 analyzer 的那组对照"。**driver 实测：在盘** —— `~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/orchestra/state/team.json` 存在、sha `5b8efdf9…` 与 §23 记录一致、会话 slug 下 30 条。
⇒ 与 §23 驳回的"盘上 log 被 GC"、§19 的 `spaceId: 29` 同族：**取证侧的读法/环境问题被写成产品事实**。**处置**：不改变本轮结论（其"未跑 E2E 对照组"仍可从其他输入复跑），但方法学里再加一条：**凡"不存在 / 被删 / 不在盘"的断言，必须附 `ls`/`stat`/`shasum` 的原始输出**。

**审查轮计数 +0**（实现轮；裁定 Z 是机制未命中，不是设计异议）。

### 下一跳
1. **小跟修**（裁定 Z，同一 repair session，一条消息即可）→ driver 复跑矩阵（含新的 (a)/(b) 对照项）。
2. 之后 **live 轮**（test runner）：新 fixture `orchestra_N7b/` create → 懒加载物化（① 期望真绿）→ 重启 → 唤醒（段 B，判据 = 宿主 `agent/created` 的 preset warning + 角色实际 tool/call）→ **R-6**（marker 读侧）。
