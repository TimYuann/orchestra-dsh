# P0 闸口径问题登记：G-P0 的「具名脚本表」与「退出判据」自相矛盾

> **登记人**：0.8.0 交付层 Implementer（Session 3）。**登记 ≠ 裁定**：本文件只给**可核证据 + 按哪一边执行的说明**，改计划文件属**开发平面编辑任务**，不在执行者权限内（`docs/ruling-d1-d5-oracle.md` §4.5 分工表）。
> **锚点**：`docs/plan-0.8.0-execution.md`（commit `66cfc20` 版本）。行号仅辅助定位。

---

## 1. 问题（P0-F1）

`docs/plan-0.8.0-execution.md` §11 对同一个闸 G-P0 给了**两处**彼此矛盾的表述：

| 位置 | 内容 | 是否与 V1 一致 |
|---|---|---|
| **§11 具名脚本表**（`sed -n '1123p'`） | G-P0 列出 **9 个脚本文件**，其中含 **`test-decision-queue.mjs`** 与 **`test-design-gate.mjs`** | ❌ **不一致** |
| **§11 退出判据**（`sed -n '1139p'`） | 逐项 ①–⑨，其中 ⑧ 已按 **V1** 写明"本条**只留 `E4`**；`E2`/`E3`/`F1′` 已退出 P0，**判据里不得再出现它们**" | ✅ **一致** |

`test-decision-queue.mjs` 覆盖 **E2/E3**，`test-design-gate.mjs` 覆盖 **F1′**（`sed -n '749p;750p'`）——**正是 V1 明令退出 P0 的三项**。§5.1 自己也已经标注过（`sed -n '749p'`：**"注意：E2/E3 已退出 P0（V1）**，本脚本随之为**后续项**"），但 §11 的具名表没有做同步修订。

**这属于 `docs/p0-scope-ruling.md` §0 命名的 fix-scope creep 的镜像形态**：修订只改了**一处**（判据），没改**同源的另一处**（具名表）。

---

## 2. 证据（原始输出）

```
$ sed -n '1123p' docs/plan-0.8.0-execution.md
| **G-P0** | `verify-role-identity.mjs`（+ `--self-test`）· `verify-d2-approval.mjs`（+ `--self-test`）· `verify-d2-decision.mjs` · `verify-role-presets-roster.mjs` · `test-orchestra-archive.mjs` · `test-tool-schemas.mjs` · `test-decision-queue.mjs` · `test-design-gate.mjs` · `test-orchestra-role-presets.mjs` | 11（9 个文件 + 2 个校准模式） |

$ sed -n '749p' docs/plan-0.8.0-execution.md
| `test-decision-queue.mjs` | 同上 | 仓库根 | 0 | **注意：E2/E3 已退出 P0（V1）**，本脚本随之为**后续项**；… |

$ ls scripts/test-decision-queue.mjs scripts/test-design-gate.mjs scripts/test-tier0-predicate.mjs scripts/verify-role-identity.mjs
ls: scripts/test-decision-queue.mjs: No such file or directory
ls: scripts/test-design-gate.mjs: No such file or directory
ls: scripts/test-tier0-predicate.mjs: No such file or directory
ls: scripts/verify-role-identity.mjs: No such file or directory
```

**同时核实的第二件事**：E2/E3 的**承载工具当前也不存在**——

```
$ grep -rn "orchestra_decision_open\|orchestra_defect_disposition\|orchestra_node_freeze\|orchestra_capsule_submit" src/
（零命中）
```

即：**P0 执行期无法"让这两个脚本通过"，因为它们的被测能力一件都还没实现**（且按 V1 也不应实现）。

第三处不一致：**`test-tier0-predicate.mjs` 被两个不同的闸同时点名，而文件不存在。**

- **G-PRE 的 S-PRE 清单**（`sed -n '1115p'`）："①`test-tier0-predicate.mjs`（**V3：档 0 的三组边界**——两个纯聊天会话 / 一支要合并 / driver 标签两向——**进本批回归**）"
- **G-P0 的退出判据 ⑨**（`sed -n '1139p'`，逐字）："⑨`test-tier0-predicate.mjs` 退出 0（**V3**：档 0 三组边界进本批回归）"
- **而 `scripts/check-p0-preconditions.mjs` 的 V3 断言只检查"计划文本里提到了它"**（实测输出 `listed_in_gpre=true`），**不检查文件存在**；该文件当前**不存在**（§2 的 `ls` 输出）。

这不只是缺文件：**"进本批回归"的落点与档 0 谓词的实现阶段不一致**。`docs/p0-scope-ruling.md` §1-1 把"**后续 schema 与用例生成体系**"移出 P0 前置依赖，而**档 0 谓词本身就是 P2 的工作项**（`docs/ruling-d1-d5-oracle.md` §3.3 第 1 条：节点记录是 P2 的工作项）。也就是说：**G-PRE 声称已把档 0 边界"进本批回归"，但那一批（P0）里没有档 0 谓词可回归。**

（这条与 §1 的 P0-F1 是**同一个形态**：修订改了文本的**一处**，没有同步**同源的另一处**，于是形成了"闸说自己会拦，实际拦不到"的状态。）

---

## 3. 本轮按哪一边执行（并说明理由）

**按 §11 的「退出判据」执行，不按「具名脚本表」执行。** 理由三条，全部可核：

1. **判据是承重的那一边**：具名表只是"闸点名了哪些脚本"的索引（其同节自述："上表是'闸**点名**的脚本'"，且 §5.1 才是交付清单），而**退出判据才是"通过 = 什么"的定义**。计划自己写明"**每个闸都必须机器可判**（brief §3 第 3 条）"，可判定的那一处只能是判据。
2. **V1 的效果文本明确写的是判据**：`docs/ruling-d1-d5-oracle.md` §4.4 V1 的期望原文是"`:1065`⑧ 的判据里**不再出现 E2/E3/E4/F1′**；`:271` 的 P0 方括号同步为 `D1 · D2 · D3 · D4 · E1 · E4`"——**它点名了 ⑧ 与本节的方括号，没点名具名表**。按"修订范围蔓延"纪律，**不得**由"判据清了 E2/E3/F1′"反推"具名表也必须改"是**执行者**的义务。
3. **反方向执行会直接违反 P0 范围**：若按具名表，则 G-P0 要求 `test-decision-queue.mjs`(E2/E3) 与 `test-design-gate.mjs`(F1′) 通过 ⇒ **等于在 P0 内实现 E2/E3/F1′**，与 V1、`p0-scope-ruling.md` §1-1、Owner 的冻结范围**三条全部冲突**。

**因此本轮 G-P0 的应跑项 = 判据 ①–⑨ 里**当前阶段**已存在、且属于 P0 收窄范围的那些脚本**，逐项按各自期望退出码判。本轮（E-1 阶段）只有两项具备：

| 判据项 | 脚本 | 现状 |
|---|---|---|
| ⑦ D4 | `scripts/test-tool-schemas.mjs` | ✅ 已跑，`# pass 8 # fail 0` |
| ⑧ E4 | `scripts/test-orchestra-role-presets.mjs` | ✅ 已跑，`# pass 10 # fail 0` |
| ① ② D1/N7 | `verify-role-identity.mjs` | ⬜ 未创建（依赖 S1/S3/§7） |
| ③ D2-a/c | `verify-d2-approval.mjs` | ⬜ 未创建 |
| ④ D2-b | `verify-d2-decision.mjs` | ⬜ 未创建（**且 D2-b 的被测对象是决策队列 E2/E3 ⇒ 需与 F1′ 一并复核**，见 §4） |
| ⑤ §7.3-a | `verify-role-presets-roster.mjs` | ⬜ 未创建（依赖 §7） |
| ⑥ D3 | `test-orchestra-archive.mjs`（扩展） | ⬜ 未扩展 |

---

## 4. 由此派生的一条**新**不一致（必须一并交给 Owner/修订者，不由执行者裁定）

**判据 ④ 与 V1 可能互相矛盾**：判据 ④ 要求 `verify-d2-decision.mjs` 退出 0，而该脚本的规格（`sed -n '771p'`）是"**§4.8 D2-b 六用例全部按期望**"，六用例里包含 `default_outside_authority`、`deadline` 到期扫描、`default_applied_then_overridden`——**这些全是 E3 的内容**，而 V1 明令 **E3 退出 P0**并"**明确标注未启用，不得假称 E3 已完成**"（`p0-scope-ruling.md` §1-1）。

同时 D2-b 的六个用例里有 **"`do_not_repeat` 的某动作结果为 `unknown`/`attempted` ⇒ 阻断"**，那属 **P3-1/P3-5**（缺陷登记与 do_not_repeat），也**不在 P0**。

⇒ **判据 ④ 在 P0 收窄版里没有合法落点**。三选一，需裁：

- (a) **D2-b 一并移出 P0**（与 E3 同步），G-P0 判据删除 ④ —— 与 V1 的口径最一致；
- (b) D2-b 保留，但**六用例缩到 P0 内可成立的部分**（例如只留"`blocks[]` 对冻结/合并的硬拦"这类不需要 E3 的项），并**改写脚本规格**；
- (c) 承认 E3 回到 P0 —— **与 V1 直接冲突，不建议**。

**本执行者不做这个裁定**（按"规则一"退回，带证据）。在裁定之前，**D2 的可交付部分 = D2-a + D2-c**（那两条不依赖 E3：D2-a 的"即时拒绝 + `asked/decided` 成对 + 回合有 `turn/end`"、D2-c 的"回合结束留下可判定事实"都在 P0 内可判）。

---

## 5. 未做（如实）

- **未修改** `docs/plan-0.8.0-execution.md`：改它属开发平面编辑任务（裁定 §4.5）。
- **未创建** §4 里列出的任何缺失脚本：它们的被测能力未实现（E2/E3/F1′ 明确未启用）。
- **未跑** G-P0 整闸：9 个具名脚本里当前**只有 2 个存在**。
