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
