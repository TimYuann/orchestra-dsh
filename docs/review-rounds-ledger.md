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

