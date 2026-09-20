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
