# 执行计划 0.8.0：交付层与强制力收口

> **本文是什么**：**计划**，不是契约。契约是 `docs/plan-0.8.0-delivery-layer.md`；需求是 `docs/2026-09-20-repo-delivery-requirements.md`；边界是 `docs/capability-boundaries.md`；原生能力对照是 `docs/dsh-native-capabilities.md`。
> **本文不重述它们的内容**，只写"谁在哪个文件做什么、怎么验、失败怎么退"。任何口径冲突以契约 v1.2 为准。
> **作者**：Session 2（计划作者）。**执行者**：Session 3。**审核**：Session 1（计划门，十二条）→ ChatGPT Pro 二审。
> **状态**：草案，未过门。本文中所有"将/计划"均为**尚未实现**；仓库现状仍以 `6bd8d9b` 为准。

---

## 目录

- [0. 依赖版本、假设清单与退回条目](#0-依赖版本假设清单与退回条目)
  - [0.1 依赖的契约版本](#01-依赖的契约版本)
  - [0.2 开工前必须落定的四件事（假设清单，含两条硬依赖）](#02-开工前必须落定的四件事假设清单含两条硬依赖)
  - [0.3 退回条目（无法机械判定或与契约冲突）](#03-退回条目无法机械判定或与契约冲突)
- [1. 任务分解（P0–P4 与 S1–S6 的工作项）](#1-任务分解p0p4-与-s1s6-的工作项)
- [2. 文件级改动清单](#2-文件级改动清单)
- [3. 实现顺序与前置依赖](#3-实现顺序与前置依赖)
- [4. 每条验收的可执行验证方式（N1–N7 + D2-a/b/c）](#4-每条验收的可执行验证方式n1n7--d2-abc)
- [5. 验收脚本](#5-验收脚本)
- [6. 记录与字段（schema 版本表）](#6-记录与字段schema-版本表)
- [7. 部署步骤](#7-部署步骤)
- [8. 风险与回退（含不可回退清单）](#8-风险与回退含不可回退清单)
- [9. agent 侧预算](#9-agent-侧预算)
- [10. 需求可追溯（A–F + 元规则 + 不做清单）](#10-需求可追溯af--元规则--不做清单)
- [11. 阶段退出闸汇总](#11-阶段退出闸汇总)

---

## 0. 依赖版本、假设清单与退回条目

### 0.1 依赖的契约版本

| 项 | 值 |
|---|---|
| 契约 | `docs/plan-0.8.0-delivery-layer.md` **v1.2 冻结（2026-09-20）** |
| 四处补丁 | ①§1.1 分级规则 ②§1.2 体检指标断言（实为 §1.9：五节 + 立即阻断清单）③边界清单第 2 条（三种例外）④E2 |
| 需求 | `docs/2026-09-20-repo-delivery-requirements.md`（A–F 六组 / N1–N7 / §4 十一条约束） |
| 基线代码 | `6bd8d9b`（v0.5.1，已提交、未发布） |
| 基线测试 | `npm test` → **248 pass / 0 fail**（2026-09-20 本机复跑实测，非转述） |
| 宿主 | DSH `0.1.5-rc.2`；两个 profile 都已装 `orchestra-dsh` 0.5.1 |

### 0.2 开工前必须落定的四件事（假设清单，含两条硬依赖）

这四件事**没有一条是设计问题**，全部是实现期一小时量级的机械核对；但**第三条和第四条不做，计划的部分任务就没有合法落点**。因此它们是本计划的**前置依赖**，写在最前面。

| # | 事项 | 我在本文中的假设 | 如果核对结果不同 |
|---|---|---|---|
| **B-1** | **槽位已占用** | `~/.dsh/orchestra/catalog-presets/` **已存在**为插件私有预设根，现有 **12 个**预设目录（**F8 实测更正**：原文写 13，`find . -maxdepth 1 -mindepth 1 -type d | wc -l` → 12）＝ **9 个 v0.4 规格目录**（`orchestra-v04-{implementer,reviewer,investigator,verifier,architect,planner,researcher,hardening-auditor,oracle}-v1`，逐一对应 `rolePresetSpec` 的 9 个 role）+ **3 个 legacy 目录**（`orchestra-implementer` / `orchestra-reviewer` / `orchestra-oracle`，是 v0.4 前身的 `legacyIds` 落点），每个目录含 `agent.cordis.yml` + `preset.yml`（v0.4 目录）——即 **S3 需要的物化已经发生**，S3 只改"按名册 id 解析"的代码，不搬迁文件 | 若目录内容缺失：§7 部署步骤加一步"先跑一次 `ensureBuiltinRolePresetArtifacts` 生成物化"，S3 前置依赖改为该步 |
| **B-2** | **契约 §1.1 的"直接改已有行"在本部署不成立** | 部署里 **没有** `id: agent-presets` 这一行可改：它由 `@deepseek-ai/dsh-web-app` 的 bundle 层 `cordis.patch.yml`（第 481 行）`insert` 而来，两个 profile 自己的 `cordis.patch.yml` 都是空数组 `[]`。因此"直接改该行"等于改 **bundle 内部文件**，会被升级覆盖 | **改为在 profile patch 层做「单跳 override」**（`- id: agent-presets` + `config` 自带 `default`；§7.1 给正文、§7.4 给内存实测、§8.1-R-02 给回退写法）。这是**实现落点**的偏离，不是口径偏离；契约 §1.1 的**四个实质要求**（私有根 / `trust: system` / `~` 写法 / 三条激活路径都能解析）**全部保留** |
| **B-3** | **`trust: system` 的根不被名册视为可写根 ⇒ 插件不能通过名册写它** | 契约 §1.1 已声明这个前提（"不被视为可写根 ⇒ 插件是唯一所有者"）。因此：**建会话时绝不要求名册写入**；预设的物化仍走插件自己的 `ensureBuiltinRolePresetArtifacts`（`flag: "wx"`，不覆盖用户文件） | 若插件确实需要名册写入（例如将来的"用户自建角色"）：**不在本计划范围**，登记为延后项（§10 尾部） |
| **B-4** | **`ctx.shell` 可用，且以宿主身份运行** | **要声明的包是 `@deepseek-ai/dsh-shell`**（`lib/types/index.d.ts:24-25` 在那里 `declare module '@deepseek-ai/cordis'` 并加 `Context.shell`）——**"服务定义在 `dsh-shell`、提供者是 `dsh-bash-sandbox`"**，两者不是一回事，见 §2.2 的说明。契约类型：`resolve()` → `ShellExecSpec`，`run()` → `ShellRunResult{exitCode, signal, timedOut, aborted, stdout, stderr, sandbox}`；`bash-sandbox` 行的默认 `timeoutMs: 60000`。P1/P2 的 git 与验收执行**全部走它** | ①若 `shell` 服务在部署里缺席：`inject` 会让本插件进入 waiting（**不静默降级**）。②**若它不以宿主身份运行（例如继承了某个会话的沙箱策略）⇒ P1 的全部证据不合法**——"宿主采集"的前提就没了，此时**必须停下**，不得产出证据（`capability-boundaries.md` #4）。③若插件需要 `dsh-bash-sandbox` 的**具体配置面**（本计划不需要，只用 `resolve/run`）：把它也加进 dev/peer |

**其余假设（不阻塞开工，但实现时若证伪要报告）**：

1. 会话日志落点 `~/.dsh/sessions/<slug>/<sessionId>/session.v3.jsonl.zstd`，`slug` 由 cwd 推导（实测目录名形如 `--Users-yuantian-Developer-orchestra-dsh--`）；`scripts/check-session-readable.mjs` 已证明"用宿主自己的 `validateStoredEvents` 判其可读性"这条路可行，N7 的外部核对**复用这个形状**。
2. `agentPresets.compositionInventory(presetId)` 可在**无 agent** 的宿主侧上下文中读取一个预设实际挂载的行与工具（`docs/dsh-native-capabilities.md` 第 1 节表格第 3 行）。N7 的"实际挂载的组合"由此获得。
3. 集成分支的 deliverable 形态为**节点分支 + worktree**（`.worktrees/<node-id>`），合并动作 = `git update-ref refs/heads/<integration> <new> <expected-old>`；契约 §1.7③ 与需求 §7.2-3 共同指向这个形态。
4. `orchestra/` 状态区与 `.worktrees/` 通过 `.git/info/exclude` 排除（需求 §2.1-3 已定）；因此收工对账读的是 **git 自己的 `status --porcelain`**，不是插件遍历文件。
5. N1–N7 的注入与判定全部可在**真实 git 仓库**上以脚本完成，不需要 fixture（需求 §3.1 明令"必须真实，不许 fixture"）。

### 0.3 退回条目（收窄 / 语义澄清）

按 brief 的"规则一"，**无法机械判定的要求不许保留做不到的承诺**。以下四条**退回**，并在落点处写成可判定的形态。它们不是"不做"，是"按可判定的形状做"。

> **F4 更正（计划门第 1 轮）**：**R-4 原来的退回理由（"不可机械判定"）不成立**——`dispositions.length === 0 ⇒ 拒` 本身完全可机械判定。它真正的问题是**字面执行会退化成填表 / 活锁**（一个确实没有相关缺陷的节点被迫造一条处置）。所以 R-4 是**语义澄清**，不是"不可判定"。下表已按此重述。

| # | 退回的原文要求 | 为什么不可机械判定 | 改成什么（本计划采用的形态） | 记录为 |
|---|---|---|---|---|
| **R-1** | 契约 §1.3 的"**无法证明不受影响**"判据 | 判据是"可核验的输入绑定 + **路径交集**"。而验收清单声明的"输入"是**角色写的自然语言**——插件手上只有路径字符串，没有"这条验收读了哪些文件"这一事实。**要算出来就必须自建依赖分析器**，而契约 §1.4 与 §3-P1"不做"清单**两次明令不做** | **默认整树失效**（§1.4 的第一顺位，本来就是默认）。只有验收声明了**机械可比对的形式**（`inputs[]`：路径 + `sha256` + `source`）才开放细粒度复用；**`inputs: []`（空数组）一律视为"未声明"**（F1），**没有 `inputs[]` 的验收一律判"受影响"**，逐条重跑。**变更路径由插件用 `git diff` 自算**（F1），**不取自角色**。**四条限定（F20）**：①属冻结验收协议，改它 = `generation + 1`；②审查者审的是"**这个声明是否正确**"，**不是**"这次复用是否安全"；③复用时**必须标注"基于声明输入集、完备性未证"**并**计入体检报告 §1.9⑤**；④**必须覆盖非 git 跟踪的输入**（夹具 / env 文件按 sha256 绑定，`source: "non-git"`） | `degraded`（诚实边界 `capability-boundaries.md` **#6**）；**不阻塞** |
| **R-2** | 需求 §2.A6"同一候选树 + 同命令 + 等价条件即可**引用**既有读数" | "等价条件"里包含**环境**；环境是一个开放集合（PATH、locale、env 变量数以百计），插件只采集**声明过的**那几个。声明外的差异**不可判** | 复用判据取**闭集**，**逐项相等 ⇒ 可复用**：`(candidateTree, inputsDigest, checkId, commandDigest, cwd, envDigest, mode, externalDeclaration)` **八项**（**F2**：原来只有五项，漏了**模式**与**外呼宣言**——那正是 P2-4 用例③"历史外呼读数不得证明本次真链"要拦的东西；**F21**：加 `inputsDigest` 以绑定 `inputs[]` 声明）。`envDigest` 只覆盖**声明过的** `env[]`。全部落进 `evidence.reuseScope` 随证据一起落盘。**F22：这八项是"必须比对的下界"，不是"只看这些"的上界**——插件已采集的**其它**身份字段（解释器版本、工具链版本、依赖目录摘要）若不同 ⇒ **至少 `warning` + 计入体检报告 §1.9⑤**，**不得静默放行** | `degraded`（`capability-boundaries.md` **#6**"只保证判定所依赖的条件逐项可比"） |
| **R-3** | 需求 §2.A7"失败的**位置/类型**"作为硬判据 | "位置"只对**能给出结构化输出的运行器**存在。通用仓库可能是任意语言、任意框架，插件不做运行器适配层（需求 §4.4 保持通用 + §4.8 机制准入） | **两档**：能解析则必须给出 `{name, location, type, reason}`；**解析不出** ⇒ 该验收判 `unqualified`（契约 §1.4 与 `alignment-0.5-position.md` A7 已写"给不出可解析输出 → `unqualified`"）。**"名字相同即无新增"在任何一档都不被接受**。**F3：`unqualified` 不是终点 ⇒ 必须给出收束出口**，见 §4.3.1（活锁是这条原来最大的缺陷） | 硬判据保留（`unqualified` 是可判定的），只是**不是"位置一定要有"** |
| **R-4** | 需求 §2.B2"强制摄入……**不允许空列表直接通过**" | **不是"不可判定"**（F4 更正）：`dispositions.length === 0 ⇒ 拒` 完全可机械判定。真正的问题是**字面执行会退化成填表 / 活锁**——一个确实没有相关缺陷的节点被迫造一条处置；而"有相关缺陷却空列表"是一种**语义**上的漏表态 | 拒绝条件写成**机械谓词**：`relevantDefects.length > 0 ∧ dispositions.length < relevantDefects.length` ⇒ 拒绝，原因码 `defect_disposition_incomplete`。**候选集为空 ⇒ 过**（这不是"漏表态"，是"确实不相关"）。**时机回到「准备阶段（prepared）」**（F5 + F19，见 §9.1） | 硬判据（**语义澄清**，非收窄判定能力） |

> **F5 的状态（时机移位）**：本计划**原来**把强制摄入的时机从需求的「准备阶段」移到了 freeze，并**未标注**该移位（计划门 F5 指出）。**该移位已取消**：按 round-8 裁定改回 **prepared**（F19）。所以现在**没有**"不申报候选的节点永不摄入"这个缺口，**也没有未标注的移位**。§9.1 的预算随之重算（F23）。

**另有一条不退回但必须写明的边界**：契约 §1.2 档 0 的机械谓词里"**依赖边 = 0**"与"**合并/发布/可复用 PASS 动作全部禁用**"——本计划把它实现为**准入时的声明 + 插件重算**（§2 节点记录字段 `tier` / `deliverable`），**不承诺插件能发现"角色偷偷依赖了别人"**。这落在 `capability-boundaries.md` #7（不能拦任意文件写入）之内。

---

## 1. 任务分解（P0–P4 与 S1–S6 的工作项）

命名：`S*` = 减法，`D*` = 缺陷收口，`E*` = 权限与请示，`P0..P4` = 契约 §3 的阶段。每项按 **负责面 / 输入 / 产出 / 退出判据** 四栏写。

### S 组 · 先减法（**必须整体先做完再开始 P0**）

| 项 | 负责面 | 输入 | 产出 | 退出判据（机器可判） |
|---|---|---|---|---|
| **S1** 统一建会话路径 | `src/session-blueprint.ts`、`src/a2a.ts`、`src/orchestra.ts` | 现有三条路径：①P0 首波 `orchestra.ts:2498 createRoleSession({mode:"governed"})` ②懒加载 `orchestra.ts:3069 createSession(...)` + 兜底 `:3084 agents.resume`（**无 setup**）③重激活 `orchestra.ts:3562 createRoleSession` + `:3644 resumeRoleSession`（setup 仅当 presetFile 存在才有） | **单一入口** `buildRoleSession(ctx, spec)`（`spec: {cwd, sessionId, rolePresetId, permissionPreset, model, title, caller}`）。三条路径都调它；`session-blueprint.ts` 的两个 `prepare*Blueprint` 收敛为一个 `prepareRoleBlueprint`，差异由 `spec.mode` 参数化 | `scripts/test-role-session-single-path.mjs`：三路径各建一次，断言 ①三者的 setup 执行的是同一函数（导出符号比对）②`agents.resume` 在全仓只剩 S2 那一处调用 ③三条路径产出的 blueprint 记录字段集完全相同 |
| **S2** 投递 / 冷恢复换原生 | `src/a2a.ts`、`src/a2a-transport.ts` | `tryResume`（`a2a-transport.ts:177-235`，自建 resume + 自建 preset 解析）、`deliverMessage`（自建投递） | **冷恢复**改调 `ctx.sessionController.resume(sessionId)`（DSH 原生：`composeAgent` + `presetForObservation` + `agents.resume({setup})`，见假设 B-4 与 `dsh-api-session-controller/lib/index.js:391-407`）；**唤醒**改调 `ctx.sessionController.prompt({sessionId, content})` 或 `ctx.agents.get(id)?.send/steer`。**保留**：`deliverMessage` 的"消息生命周期"（`accepted/claimed/answered`，`src/receipt-store.ts`）与 `agent/inbox/*` 折叠 | `scripts/test-v05-slimming.mjs` 扩展 + 新增 `test-native-delivery.mjs`：`sessionController` 缺席时**类型化失败**（不静默回退到自建）；`deliverMessage` 仍写 receipt；`receipt-store` 的 4 个用例不回归 |
| **S3** 预设进名册 | `src/orchestra-role-presets.ts`、`src/orchestra.ts`、`src/session-blueprint.ts`、`src/a2a-transport.ts` | 现有的**按文件路径挂载**：`mountPreset(agentCtx, {id, trust, path})`（`session-blueprint.ts:574` / `:801` / `orchestra.ts:3619` / `a2a-transport.ts:221`）；`resolvePresetFile`（`orchestra.ts:433`）把预设解析成"文件路径 + trust" | 新增 **单一挂载函数** `mountRolePreset(agentCtx, presetId)`：内部只调 `presets.resolve(id)` → `presets.mount(agentCtx, resolved.id)`。`resolvePresetFile` **降级**为"仅用于 `project`/`global` 覆盖来源的读取器"（保留 `project > global` 优先级），名册来源（`dsh`/roster）**不再生成 path** | `scripts/test-role-preset-roster.mjs`：①project / global / roster 三种来源各解析一次，断言 `source` 正确且 **roster 来源的解析结果 `path === ""`**（因为 `session-blueprint.ts:1014` 已有这个分支）②`readySnapshotAfterWrite` 后 `compositionInventory` 有该 preset 的行 ③**全仓不存在 `presetSource === "file"` 的调用点**（grep 断言写进测试） |
| **S4** 停摆兜底换第一手信号 | `src/orchestra.ts`（`ctx.on("agent/status")` 段，`src/orchestra.ts:5180-5226`） | 现状：`agent/status` 的 `running → idle` 推断（`dsh-native-capabilities.md` 禁忌 5） | ①订阅 `agent/turn-stopping`（`Promise|void` 形态、`@mode serial`、回合关闭前被 await 派发，`dsh-agent/lib/types/runtime-types.d.ts:396-400`）：目标角色的回合即将关闭且未交报告、未回 driver ⇒ 用 `agent.steer()` **续一步**要求补交；②订阅 `approval/asked`，维护 `{id, sessionId, askedAt}` 悬空表，收 `approval/decided` 时销账；③**`agent/status` 的推断路径删除**，只在 `turn-stopping` 与 `approval` 两条第一手信号上工作 | `scripts/test-node-stall.mjs` 重写：①构造"回合关闭前无报告"⇒ 断言 `steer` 被调用一次且**只一次**（同回合去重）②构造 `asked` 无 `decided` ⇒ 断言看门狗记账并通知 driver ③断言 `agent/status` 上**不再有本插件的监听器** |
| **S5** 删悬空能力 | `src/orchestra.ts`（`OrchestraDispatchArgs`，2735-2741）、`src/orchestra-preferences.ts`、`src/orchestra.ts:2047-2050` | 实测：`orchestra_dispatch` 的 `preset` / `timeoutMs` **两个字段零消费点**（`grep 'args.preset\|args.timeoutMs'` 无命中；`timeoutMs` 的 4384 行属 `orchestra_wait`）；三档偏好阶梯 `writePreferences` **无任何调用点**（仅导出与测试引用），且 `orchestra.ts:2049` 还在向模型描述"ask them ONCE then persist it" | ①从 `OrchestraDispatchArgs` 与工具 schema 删除 `preset` / `timeoutMs`，调用方传了即**类型化拒绝** `unknown_argument`（不静默忽略）②**删除 `tiers` 三档阶梯**：`orchestra-preferences.ts` 只保留 `roleMapping`（角色 → 模型）读取；`orchestra.ts:2049` 的措辞改为"未声明即继承 driver"③`readPreferences` 仍读旧文件，读到 `tiers` 即**告警并忽略**（不静默，也不崩） | `scripts/test-orchestra-preferences.mjs` 改写：断言 `tiers` 字段在类型层与校验层都不存在；旧文件（含 `tiers`）读取 ⇒ 返回 `roleMapping` + `diagnostic.code === "legacy_tiers_ignored"`；`orchestra_dispatch` 传 `preset` ⇒ 抛 `unknown_argument` |
| **S6** 死分支与重复实现 | `src/orchestra.ts`（`updateTeamRole` 的 4 处 inline `roles.map(...)`）、四处 `agents.resume` | 现状：`updateTeamRole` 已存在（`orchestra-state.ts`）但 2499/2520/3045/3099/3116 等处仍在手写 `roles.map`；`agents.resume` 出现在 `a2a-transport.ts:213`、`orchestra.ts:3084`、`:3505`（包装）、`:3644`（调用） | ①所有 team-role 变更走 `updateTeamRole`②`agents.resume` 收敛到 S1 的 `buildRoleSession` 与 S2 的 `resumeViaNative` **两处**，其余为调用 | `scripts/test-v05-slimming.mjs` 扩展为**源码级断言**：`grep -c 'roles.map(' src/orchestra.ts` ≤ 1；`grep -c 'agents.resume(' src/**` == 2 |

**S 组整体退出判据（契约 §2 原文）**：`npm test` + `npm run typecheck` 全绿；**248 项测试不回归**（新增项另计）；跨重启 E2E 通过（= N7，见 §4）。

### P0 · 事实层与三处收口

| 项 | 负责面 | 输入 | 产出 | 退出判据（机器可判） |
|---|---|---|---|---|
| **D1** 角色身份持久 | 部署侧（§7）+ `src/session-blueprint.ts` + `src/orchestra.ts` | S1/S3 之后的单一建会话路径 | ①profile patch 补 `roots`（§7）②三条路径（首波 / 懒加载 / 重激活）**都**经 `buildRoleSession`，`agent-presets` 名册自动 `resolve + mount`③blueprint 记录写"预期组合"（行 id 集 + 工具名集）④`scripts/verify-role-identity.mjs` 从外部核 | **N7**（§4.7）+ 断言"三条路径产出的 blueprint 记录字段集相同"+ 断言"任一角色的 blueprint 的 `presetId` 都能被名册 `resolve`" |
| **D2** 回合不悬挂 | `src/session-blueprint.ts`、`src/orchestra.ts`、`src/a2a.ts` | 现状：`setApprovalPolicy(session, "never")` **只在 governed blueprint 里**（`session-blueprint.ts:826`）；懒加载兜底 `agents.resume`（`:3084`）与重激活 resume（`:3644`）**都没钉**；lightweight 路径也没钉。而部署的 `permission` 行把 `workspace-write` 的 approval 配成 **`ask`**（`dsh-base/cordis.patch.yml:236-239`）⇒ 没有 blueprint 的路径**就是 ask** | ①**"永不询问"钉到所有建会话/恢复路径**（收口到 `buildRoleSession` 一处，因为 S1 已统一）②`turn-stopping` 钩子（S4）保证回合收束③三类去向按 E2 记录 | **D2-a / D2-b / D2-c**（§4.8 给出三条断言的可执行形态）+ 需求 §3.3-2 |
| **D3** 归档先停后记 | `src/orchestra-archive.ts`、`src/orchestra.ts`（`orchestra_dismiss` 4780 段） | 现状两处漏：重入归档不发退休通知；旧队已是完成/失败/放弃态时直接清活跃状态 | ①归档事务重排为 **cancel → notify → 落快照 → 写 archived marker**，每步幂等②重入归档（已是 archived marker）⇒ 仍发一次退休通知，返回 `already_archived`③旧队终态清活跃前必须通知 | `scripts/test-orchestra-archive.mjs` 扩展：①连调两次 `orchestra_dismiss` ⇒ 两次都产生通知记录，第二次返回 `already_archived`②构造 `completed` 旧队 ⇒ 断言清活跃前有通知事件③断言 archived marker 写入后 `orchestra_team` 返回 `team: null` + archive 列表含该 id |
| **D4** 工具闭包守卫 | `scripts/test-tool-schemas.mjs` | 现状已覆盖 `orchestra_topologies` 的 role summary schema。需求 §6 自述缺口：**8 个工具的 sweep 接线与 `orchestra_wait` 的工具闭包**没有自动化覆盖 | 把守卫从"role summary 一个形状"扩成**全工具闭包扫描**：对每个注册工具，读其 `inputSchema`/`outputSchema`，用一个"形状生成器"造出最少一个满足 `required` 的样本值，喂给 `JSON Schema` 校验；**再**断言每个工具的 handler 闭包引用的符号存在（`sweep` 接线） | `scripts/test-tool-schemas.mjs`：工具数从"若干"变为**全量枚举**（断言数 ≥ 现有注册工具数）；新增一个工具而忘改 schema ⇒ 该用例失败 |
| **E1** 权限预分配、提权不挂起 | `src/session-blueprint.ts`（`permissionService.set` + `setApprovalPolicy`） | 需求 §2.E1；`docs/dsh-native-capabilities.md` 禁忌 4 | 派发期钉死 `permissionPreset`（已实现）+ 运行期 `approval: never`（D2 收口）+ 被拒后**类型化事实**：`approval/asked` + `approval/decided` 是 DSH 写的**事实**，插件**不重写**，只在 blueprint 记录里留 `approval: "never"` | 需求 §3.3-2（§4.8）+ 断言 blueprint 记录 `approval === "never"`
| **E2** 三类请示各有去向 | `src/orchestra.ts`（新记录层）、`src/orchestra-records.ts` | 契约 §1.5/§1.9③；需求 §2.1-2 | ①`decision` 记录（字段见 §6）②**唯一的机械强制**：`blocks[]` 里的 nodeId **不得冻结或合并**，其余继续跑③写入 `orchestra/decisions/<decision-id>.json` | `scripts/test-decision-queue.mjs`：①`blocks=[node-A]` ⇒ node-A 的 `freezeCandidate` 与 `mergeCandidate` 都抛 `blocked_by_decision` 并带 decisionId②node-B 的同样动作成功③`blocks=[]` ⇒ 不阻塞 |
| **E3** 带默认值的请示 | 同 E2 | 契约 §1.5 五条收紧 | ①`default` 只能落在既有授权内（校验：`default` 引用的动作必须已在该节点的 `permissionPreset` 与 `writeSurface` 内，否则 `default_outside_authority`）②`deadline` **由宿主持久化**：记录文件带 `deadlineAt`，宿主在 `timer` 上注册到期扫描（`ctx.inject = [... "timer"]` 已具备）③到点：可默认类 ⇒ 应用 `default` 并写 `default_applied_then_overridden` 语义的字段；不可默认类 ⇒ `state = "blocked"`④迟到答案形**新决策**记录，不覆写旧记录 | `scripts/test-decision-queue.mjs`：①`default` 越权 ⇒ `default_outside_authority`②伪造时钟推进过 `deadlineAt` 触发宿主扫描 ⇒ 可默认类记录 `state` 推进且 `blocks` 解除、不可默认类记录 `state="blocked"`③重启后（重建 store）未到期的记录仍带原 `deadlineAt`，到期扫描仍会触发 |
| **E4** 默认档 = 工作区修改 | `src/orchestra-role-presets.ts:757-758` | **实现已是现状**（`danger-full-access` 从不合法）；**但测试没有覆盖它**（F9 实测：`grep -n "danger-full-access" scripts/test-orchestra-role-presets.mjs` **无命中**；唯一命中的是 `scripts/test-add-lanes.mjs:343`，那测的是 `orchestra_add_lanes` 的工具面，**不是**角色预设校验器） | 不动实现。**将新增**两条断言到 `scripts/test-orchestra-role-presets.mjs`：①`spec.sandbox === "danger-full-access"` ⇒ `validateRolePreset` 抛 `invalid_spec`②`spec.permissionPreset !== "workspace-write"` ⇒ 抛 `invalid_spec`。**措辞纪律：改前不得写成"已有该断言"** | `scripts/test-orchestra-role-presets.mjs`（新增两条用例，F9 / F12） |
| **F1′** 设计门独立会话 | `src/orchestra.ts`（gate 记录）、`src/orchestra-records.ts` | 契约 §1 表格"设计门 F1′"行；`docs/capability-boundaries.md` #3 | `gate` 记录字段见 §6；三条硬规则：①`gate_not_run` **≠** `satisfied`②未物化角色（`phase === "reserved"`）**不得**写进 `participants[]`③有第二个可用模型时 `satisfied`，否则 `degraded` 且进体检报告 ① 节 | `scripts/test-design-gate.mjs`：①未跑门 ⇒ 记录 `state="gate_not_run"`，且**工具返回里 `satisfied` 字符串不出现**②`reserved` 角色 ⇒ 写 `participants` 抛 `participant_not_materialized`③只有 1 个模型时 ⇒ `state="degraded"` 且体检报告①节计数 +1 |

### P1 · 证据层

| 项 | 负责面 | 输入 | 产出 | 退出判据 |
|---|---|---|---|---|
| **P1-1** 极薄执行层 | 新 `src/evidence-runner.ts`、`src/evidence-store.ts` | 假设 B-4（`ctx.shell`）；契约 §3-P1；需求 §2.A2；**F6 + F7** | 入口**只吃** `(nodeId, checkId)`；**命令从冻结清单查**（命令由节点在 prepared 提议、由门冻结，见 §4.1 的表）；从**冻结快照**执行（`git worktree add --detach <tree>`，§1.7①）；固定 `workdir` = 节点 worktree、`env` = 冻结清单里的 `env[]`；`ctx.shell.resolve({command, workdir, env, timeoutMs, sandboxPolicy})` → `run()`；**执行前逐项重算 `inputs[]` 的 sha256**（F18，§4.3.2）；结构化落盘证据文件（§6） | `scripts/test-evidence-runner.mjs`：①传 `(nodeId, checkId)` 正常跑通，证据文件字段齐全②**调用方无法传命令字符串**（类型层 + 运行时双重断言）③`checkId` 不在冻结清单 ⇒ `check_not_frozen` 类型化拒绝④清单里的 `inputs[]` 在运行前被改 ⇒ `input_digest_mismatch`（F18） |
| **P1-2** 运行前提一致 | 同 P1-1 | 契约 §1 表格"运行前提一致"行 + §1.7①；需求 §2.A 口径注 | 四行不对称判定 + `unknown` 规则；树身份/环境/模式/外呼四项**采集值**与**声明值**逐项比对；判定函数返回 `qualified / unqualified / warning` | `scripts/test-runtime-preconditions.mjs`：**四个象限各一个用例**（声明需要·已发生 / 声明需要·未发生 / 声明不需要·未发生 / 声明不需要·已发生）+ `unknown` 用例 + 三种例外各一个用例 |
| **P1-3** 冻结快照与输入绑定 | 同 P1-1 | 契约 §1.7①；**F18 + F20④ + F21** | `snapshotTree`（`git rev-parse <candidate>^{tree}` 的**输出**，不自己算）+ `worktree add --detach <tree>`；输入只有**一个**声明字段 **`inputs[]`**（**F21：`extraInputs[]` 已全局删除**，不存在第二个字段），每项 `{path, sha256, source: "git"｜"non-git", reason?}`，**`source: "non-git"` 的必须带 `reason`**（F20④：夹具 / env 文件属于这一类）。**未在 `inputs[]` 里声明、却参与验收的输入 ⇒ 该次证据 `unqualified`**（`unbound_input`） | `scripts/test-frozen-snapshot.mjs`：①塞一个未跟踪夹具并让它影响结果 ⇒ `unqualified` / `unbound_input`②把它写进 `inputs[]`（`source:"non-git"`）后重跑 ⇒ `qualified`③**声明了但内容已改**（夹具被改、sha256 不符）⇒ `unqualified` / `input_digest_mismatch`（F18，见 §4.3g） |
| **P1-4** 基线采集与差集 | 同 P1-1 | 需求 §7.2-9 | 插件采一次基线存**插件状态区**（`orchestra/baselines/<node-id>.json`，不进 git）；对比必须给出**名字 + 位置/类型**的差集（R-3 两档）；`stale_baseline` 判据：基线 SHA 偏离 或 基线外文件被改 | `scripts/test-baseline-diff.mjs`：①人工对账样例与脚本输出一致（把样例作为测试数据）②只改名字相同但位置不同的失败 ⇒ **不得**判"无新增"③基线 SHA 偏离 ⇒ `stale_baseline` 且**拒绝**用它判"无新增红" |

### P2 · 交付层

| 项 | 负责面 | 输入 | 产出 | 退出判据 |
|---|---|---|---|---|
| **P2-1** worktree 与租约 | 新 `src/delivery-worktree.ts`、`src/write-lease.ts` | 需求 §7.2-3/-4；契约 §1.6 | ①`git worktree add` 创建/回收，路径确定性（`nodeId → .worktrees/<node-id>`），可重入，dirty 不自动删②租约锚 = **可枚举写面（路径前缀集）**；不可枚举 ⇒ 退化为仓库级独占；**绝不用 `index.lock`**③准入硬拦：写面重叠的节点不得同时开工/冻结 | `scripts/test-write-lease.mjs`：①重叠 ⇒ `lease_conflict` 类型化拒绝②不可枚举 ⇒ 仓库级独占③**全仓不存在 `index.lock` 字样**（grep 断言） |
| **P2-2** 节点记录 | 新 `src/node-record.ts` | 契约 §3-P2；需求 §7.2-11 | 插件写、不进 git、非插件可读；`<主 worktree>/orchestra/nodes/<node-id>.json` + `schemaVersion` + 纯 JSON（§6） | `scripts/test-node-record.mjs`：①写→读往返②`schemaVersion` 错 ⇒ `unsupported_schema`③**用 `JSON.parse` 裸读**（同 `tests` 里一个"外部读者"函数，不用插件代码）能读懂全部事实字段 |
| **P2-3** 候选身份与复审 | 新 `src/candidate.ts` | 契约 §1.3；需求 §2.1-1 | 候选 = `{commit, tree, acceptanceManifest, decisionSnapshotHash, generation}`；冻结点 = **门运行之前**；失效的是"新候选的放行资格"：不交新改动 ⇒ 仍交旧候选；必须交 ⇒ 补审差异 + 重新确认证据适用性 + **只重跑无法证明不受影响的验收**（R-1 形态） | **N1**（§4.1） |
| **P2-4** 证据复用 | 同 P1-1 + `src/candidate.ts` | 契约 §1.4；**R-2 + F2 + F21 + F22** | **八项闭集是"必须比对的下界"**（F22）：`(candidateTree, inputsDigest, checkId, commandDigest, cwd, envDigest, mode, externalDeclaration)` 逐项相等 ⇒ 可复用；未知依赖一律不复用；**不自建依赖分析器**。**复用时的标注义务（F20③）**：证据带 `reuseBasis: "declared-inputs-only"` + `completeness: "unproven"`，并计入体检报告 §1.9⑤ | `scripts/test-evidence-reuse.mjs`：①八项全等 ⇒ `reused` 且带 `reuseBasis`②任一不等 ⇒ `fresh`③历史外呼读数**不得**证明本次真链（构造"上一次观测到真链、本次声明需要真链但未观测" ⇒ `unqualified`）④**`externalDeclaration` 不同（上次 required / 本次 forbidden）⇒ `fresh`**（F2 的直接用例）⑤**`mode` 不同（read-only / workspace-write）⇒ `fresh`**（F2）⑥**八项全等但已采集的其它身份字段不同（工具链版本）⇒ `reused` + `warning: other_identity_mismatch` 且计入⑤节，不得静默**（F22） |
| **P2-5** 合并门 + CAS | 新 `src/merge-gate.ts` | 契约 §1.7③；需求 §7.2-2；**F17** | `git merge-tree --write-tree` 预演 → **先落 `mergeIntent{expectedOld, expectedNew, previewedTree}`** → **`git update-ref <ref> <expectedNew> <expectedOld>` 原子更新** → 合并后 `git rev-parse HEAD^{tree}` 比对 `previewedTree` → 写 `mergeAttempts[]` → "ref 已推进、记账前崩溃"的**四段幂等恢复**（§4.2 步 6） | **N2**（§4.2）+ `scripts/test-merge-cas.mjs` 的崩溃注入用例（§4.2） |
| **P2-6** 豁免集 | 新 `src/exemptions.ts` | 契约 §1.6；需求 §2.1-3 | 显式声明在配置里；每条带**理由 + 加入人 + 加入时间**（缺理由即校验失败）；**每次对账报告必须打印当次全量豁免集**；写入 `.git/info/exclude` | `scripts/test-exemptions.mjs`：①缺理由 ⇒ 校验失败②对账报告输出里**含全部**豁免条目（逐条比对）③`.git/info/exclude` 含三者 |
| **P2-7** 收工对账 | 新 `src/reconciliation.ts` | 契约 §1.6；需求 §7.2-2 | 读 **git 自己的** `status --porcelain`（不遍历文件）→ 与节点声明写入面比对 → 范围外**点名**（不阻塞）→ **唯一例外**：越界触及他人**活跃租约** ⇒ **阻断冻结/合并**，且**豁免不能取消这个冲突** | `scripts/test-reconciliation.mjs`：①范围外改动 ⇒ `named[]` 且 `blocked=false`②越界命中他人活跃租约 ⇒ `blocked=true` + `lease_intrusion`③**把该路径加进豁免集后仍 `blocked=true`**（豁免不取消冲突） |
| **P2-8** 决策队列 | 同 E2/E3 | 契约 §1.5、§1.9③ | 见 E2/E3 | 同 E2/E3 |

### P3 · 治理层

| 项 | 负责面 | 输入 | 产出 | 退出判据 |
|---|---|---|---|---|
| **P3-1** 缺陷登记 | 新 `src/defect-registry.ts` | 需求 §2.B1 | 机器可读；只存活跃项；总量上限，超限要求先清理（超限 ⇒ 类型化拒绝 `registry_over_cap`） | `scripts/test-defect-registry.mjs`：①上限触发拒绝②已解决项移出后可再加 |
| **P3-2** 强制摄入 | 同 P3-1 + 节点记录 + 候选身份 | 需求 §2.B2；**R-4**；**F19** | 时机 = **准备阶段（prepared）**，**不是 freeze**——它的作用是在**动手前**影响动手的方式；放到 freeze 会退化成"事后签字"，而且**不申报候选的节点永远不会被摄入**（那类节点恰恰也可能碰已知缺陷）。<br>①按**写面重叠 / 事实重叠 / 权威引用重叠**算候选（判定必须可复核：算出的 `matchedBy[]` 落盘）②逐条处置 ③R-4 的机械谓词。<br>**F19 的"非新增机制"补法**：把「**相关缺陷集 + 每条处置**」纳入**候选身份的决策快照**（与 `decisionSnapshotHash` 同源）⇒ freeze / merge 侧若相关缺陷集变了，**由 A1 自动失效**（`generation + 1`、旧审查旧证据作废）。**两侧都覆盖，不加第二个检查点** | `scripts/test-defect-intake.mjs`：①候选非空 + 未表态 ⇒ `defect_disposition_incomplete`，且**发生在 prepared**（工具返回值里带 `phase: "prepared"`）②候选为空 ⇒ **允许通过**③`matchedBy[]` 落盘且可复核④**摄入之后、冻结之前**新增一条与写面重叠的缺陷 ⇒ `decisionSnapshotHash` 变化 ⇒ freeze 时 `generation + 1` 且旧审查被标 stale（F19 的核心断言） |
| **P3-3** 所有权与事务声明 | 同 P3-1 + `src/write-lease.ts` | 需求 §2.B3；**收窄出处**（F13）：`alignment-0.5-position.md` §4 的 **B3 行**把这一条**拆成两件事**（①硬拒 ②只登记），**契约 §3-P3 行**已照此写入"**写者冲突硬拒；声明完备性只登记**"。所以②"只登记、不阻断"**不是我方的静默收窄，是契约 §3-P3 与 `alignment-0.5-position.md` B3 行已经写定的口径** | ①同写面第二个活跃写者且无裁定 ⇒ **硬拒**（= N5，复用 P2-1）②`canonical owner` 未定这类**声明完备性** ⇒ **只登记不阻断**，close 时作为 residual 出现 | **N5**（§4.5）+ `scripts/test-ownership-declaration.mjs`：断言②**不阻断开工**（同场景下开工成功、close 时 residual 列表含该条） |
| **P3-4** 胶囊 | 新 `src/capsule.ts` | 需求 §2.C1/C2；契约 §3-P3 | 骨架机械生成；`required` **只留机器推不出来的三项**：下一步 / 已知失败 / 不可重复的外部动作；缺失标 `incomplete` **不阻塞** | **N6**（§4.6） |
| **P3-5** `do_not_repeat` | 同 P3-4 | 契约 §1.5-4；需求 §2.1-3 | 未知必须**停**（`unknown` / `attempted` ⇒ **阻断**，不是告警）；解除**只能由人节点作出并留痕** | `scripts/test-do-not-repeat.mjs`：①`unknown` ⇒ 阻断②解除记录缺 `resolvedBy`（人节点）⇒ 拒绝③解除后阻断解除 |
| **P3-6** 消息只带指针 | `src/a2a.ts`、`src/orchestra.ts` 的角色话术 | 需求 §2.C4 | 协作消息只承载指针与唤醒（node/decision id + 原因码）；**任何正确性条件不得依赖消息成功送达** | `scripts/test-pointer-messages.mjs`：①构造消息投递失败 ⇒ 判定路径仍能跑（读记录即可）②消息文本里出现"验收通过/失败判定"类字样 ⇒ 断言失败（防止把判据塞进消息） |

### P4 · 收尾

| 项 | 负责面 | 产出 | 退出判据 |
|---|---|---|---|
| **P4-1** C3 上下文可观察 | `src/orchestra.ts` | **先查 DSH 有无现成**（`docs/dsh-native-capabilities.md` 第 3 节判据）；有 ⇒ 复用，无 ⇒ 记录"DSH 不具备，故自建"并写明代价。只有观测，**不设配额、不强制轮换** | 观测读数出现在体检报告③节 |
| **P4-2** 每周机制复查上线 | 新 `src/weekly-review.ts` + 体检报告 ④ 节 | §1.8 三条判据 + **留痕（含"本周无候选"）** + **"比率已连续两窗报警 + 复查连续 N 周无候选"本身成为告警** | `scripts/test-weekly-review.mjs`：①无候选 ⇒ 仍写一条 review 记录②"两窗报警 + 两窗无候选" ⇒ 产出独立告警条目③删除动作必须绑定 `executor` 字段 |
| **P4-3** 体检报告 | 新 `src/health-report.ts` | **五节 + 立即阻断清单**；缺任一节即报告无效；④节含复查结论；⑤节**必须与①分开** | `scripts/test-health-report.mjs`：①删任一节 ⇒ `report_invalid`②①⑤合并 ⇒ `report_invalid`③立即阻断清单两项非零 ⇒ 报告带 `blocking` 标记 |
| **P4-4** 文档面同步 | `STATE.md`、`UPDATE-v0.8.0.md`、`AGENTS.md`、`docs/plan-0.8.0-delivery-layer.md` 的状态行 | 只写已实现项（需求 §4 约束 7「未验证的不要写成现状」） | `scripts/check-docs-status.mjs`：文档里出现"已实现/已完成"字样的行，其指向的符号必须在 `lib/` 里存在 |

---

## 2. 文件级改动清单

列"改什么 / 为什么 / 属于哪条需求"。**不写行号级 diff**（计划不是补丁）。

### 2.1 新增文件

| 文件 | 改什么 | 为什么 | 需求 |
|---|---|---|---|
| `src/evidence-runner.ts` | 极薄执行层：`(nodeId, checkId)` → 冻结清单 → 冻结快照 → `ctx.shell` → 结构化证据 | A2 的"系统自己跑验收"落点；契约 §3-P1 明确"只吃 `(node_id, check_id)`" | A2 / N3 |
| `src/evidence-store.ts` | 证据落盘（不可变、带 `schemaVersion`、纯 JSON） | "不可变落盘"是 A2 的判定字段载体 | A2 / A6 |
| `src/frozen-manifest.ts` | 冻结清单（命令 + cwd + env + 外呼声明 + **`inputs[]`（唯一声明字段）**） | §1.7① "命令从冻结清单查"的唯一来源；**F21 的单字段口径** | A1 / A2 |
| `src/runtime-preconditions.ts` | 四行不对称判定 + `unknown` 规则 + 三种例外 | A2 运行前提口径（一般化到树/环境/模式/外呼） | A2 / N3 |
| `src/baseline.ts` | 基线采集、`orchestra/baselines/`、差集、`stale_baseline` | A7 与需求 §7.2-9 | A7 |
| `src/delivery-worktree.ts` | `git worktree` 创建/回收，路径确定性，可重入 | A5 / §7.2-3 | A5 |
| `src/write-lease.ts` | 可枚举写面、租约、准入硬拦 | A5 / B3① / N5 | A5 / B3 |
| `src/node-record.ts` | 节点记录读写 + schema 校验 | §7.2-11；C2 的"只读记录"前提 | C1 / C2 |
| `src/candidate.ts` | 候选身份、generation、复审、证据复用判据 | A1 / A6 / §1.3 / §1.4 | A1 / A6 |
| `src/merge-gate.ts` | 预演 → 树比对 → `update-ref` CAS → 崩溃幂等恢复 | A3 / §1.7③ | A3 / N2 |
| `src/exemptions.ts` | 豁免集 + `.git/info/exclude` 写入 + 打印 | §1.6 / §2.1-3 | A5 |
| `src/reconciliation.ts` | `status --porcelain` 对账 + 越界例外 | A5 / §1.6 | A5 |
| `src/decision-queue.ts` | 决策记录 + 宿主持久化到期扫描 + `blocks[]` 强制 | E2 / E3 / §1.5 | E2 / E3 |
| `src/gate-record.ts` | F1′ 设计门记录 | 契约"设计门 F1′"行 | F1′ |
| `src/defect-registry.ts` | 缺陷登记 + 上限 + 剪枝 | B1 | B1 |
| `src/defect-intake.ts` | 重叠计算 + 逐条处置 + R-4 谓词 | B2 | B2 |
| `src/capsule.ts` | 胶囊骨架 + `required` 三项 + `incomplete` | C1 / C2 / N6 | C1 / C2 |
| `src/health-report.ts` | 五节 + 立即阻断清单 | §1.9 独立验收断言 | §1.9 |
| `src/weekly-review.ts` | 每周复查 + 留痕 + "报警无动作"告警 | §1.8 | 元规则二 |
| `scripts/verify-role-identity.mjs` | **外部**核对角色身份（N7） | D1 唯一验收 | D1 / N7 |
| `scripts/verify-delivery-e2e.mjs` | 端到端无人介入（§3.1） | 总判据 | §3.1 |
| `scripts/test-*.mjs`（§1 各表末列点名的） | 每项工作项的退出判据 | 每阶段闸要机器可判 | 全部 |

### 2.2 修改文件

| 文件 | 改什么 | 为什么 | 需求 |
|---|---|---|---|
| `src/session-blueprint.ts` | ①两个 `prepare*Blueprint` 收敛为 `prepareRoleBlueprint(spec)`，`buildRoleSession` 成为唯一入口（S1）②`mountPreset(agentCtx, {path})` 全部换成 `mountRolePreset(agentCtx, presetId)`（S3）③`setApprovalPolicy(session,"never")` 从 governed 分支**上提到公共段**，并补 lightweight 分支（D2）④blueprint 记录补"预期组合"字段 | S1/S3/D2/D1 | D1 / D2 |
| `src/orchestra.ts` | ①三条建会话路径改调 `buildRoleSession`；`:3084` 的**无 setup `agents.resume` 兜底删除**（改走 `resumeViaNative`）②`resolvePresetFile` 降级为 project/global 读取器③`ctx.on("agent/status")` 停摆段删除，改 `turn-stopping` + `approval/*`（S4）④删除 `OrchestraDispatchArgs.preset/timeoutMs`（S5）⑤`updateTeamRole` 收敛（S6）⑥接入 P1–P4 的工具/命令面 | S1–S6 + P0–P4 | D1–D4 / A1–A7 |
| `src/a2a.ts` | ①`createSession` 的 `presetFile` 参数删除，改 `presetId`（S3）②`createSession` 内部改调 `buildRoleSession`③`OrchestraDispatch` 侧沿用 | S1 / S3 | D1 |
| `src/a2a-transport.ts` | `tryResume` 改调 `sessionController.resume`；删除自建 preset 解析（`presets.resolve` 那段） | S2 / S3 | D1 |
| `src/orchestra-role-presets.ts` | ①`resolveRolePresetFile` 的返回值不再携带 `path`（roster 来源）②`mountRolePreset` 的 id 校验与错误码③`danger-full-access` 回归断言（E4） | S3 / E4 | D1 / E4 |
| `src/orchestra-archive.ts` | 归档事务重排 + 幂等重入 | D3 | D3 |
| `src/orchestra-state.ts` | `updateTeamRole` 复用点；team 记录补 `tier` 字段（§1.2 分级必须显式声明在节点记录里，team 侧只留投影） | S6 / §1.2 | §1.2 |
| `src/orchestra-preferences.ts` | 删除 `tiers` 三档；保留 `roleMapping`；旧文件读到 `tiers` ⇒ 告警忽略 | S5 | Owner 决定 3（`alignment-2026-09-20-next-round.md` §1-3） |
| `src/orchestra-records.ts` | 补 `decisions/`、`nodes/`、`health/` 三个目录的写入助手与 `safeSegment` 覆盖 | P2/P3/P4 的记录层 | C1 / §1.9 |
| `cordis.yml` | 若走"spawned 子会话"需要补行 | 见 §8 风险 R-02 | — |
| `package.json` | ①新增 **`@deepseek-ai/dsh-shell`**（**服务/类型定义的 owner**）到 `devDependencies` + `peerDependencies`（**严禁进 `dependencies`**，见 `AGENTS.md` 硬规则 1；F15 已把包名钉死为实测的那个：类型面在 `dsh-shell`，运行期提供者是 `dsh-bash-sandbox`，二者只需声明前者）②`scripts.test` 追加 §2.1 点名的全部 `scripts/test-*.mjs`；③`files` 白名单不动（新文件全在 `lib/`） | 假设 B-4 + 测试注册 | 防崩硬规则 |
| `scripts/test-tool-schemas.mjs` | D4 的全工具闭包扫描 | D4 | D4 |
| `docs/plan-0.8.0-delivery-layer.md` | **只改状态行**（"冻结 v1.2" → "执行中，见 plan-0.8.0-execution.md"） | 避免两处表述漂移 | §4.7 |
| `STATE.md` / `AGENTS.md` / `UPDATE-v0.8.0.md`（新） | 收尾同步 | §4.7 | §4.7 |

### 2.3 删除文件 / 删除代码块

| 目标 | 为什么 | 需求 |
|---|---|---|
| `src/orchestra-preferences.ts` 的 `IntelligenceTier` / `ModelPreferenceConfig.tiers` / `resolveModelForRole` 的档位分支 | S5：三档阶梯被 Owner 取消，且**没有写入口**（悬空能力） | Owner 决定 3 / 需求 §6 建议 6 |
| `src/orchestra.ts` 的 `agent/status` 停摆监听段（5180-5226） | S4：`running→idle` 是事后推断，被 `turn-stopping`（回合关闭前被 await）取代 | 需求 §2.D2 / `dsh-native-capabilities.md` 禁忌 5 |
| `src/a2a-transport.ts` 的 `tryResume` 全程 | S2：DSH 原生 `sessionController.resume` 已覆盖 | 需求 §4.1（优先减法） |
| `src/orchestra.ts:3084` 的裸 `agents.resume`（无 setup） | D1 的直接成因之一；`dsh-native-capabilities.md` 禁忌 1 | D1 / N7 |
| `OrchestraDispatchArgs.preset` / `.timeoutMs` 及其工具 schema 行 | S5：零消费点 | 需求 §6 建议 6 |
| `src/orchestra-role-presets.ts` 的 `LEGACY_*_CORDIS_YML`（若 S3 全绿后仍无引用） | S6：死分支。**删除前必须确认 roster 已能解析这些 legacy id** | S6 |

---

## 3. 实现顺序与前置依赖

```
[B-1..B-4 四项核对]  ← 前置，半小时量级
        │
        ▼
[S1]──►[S2]──►[S3]──►[S4]──►[S5]──►[S6]      ← 减法，必须整体先做完
        │        │
        │        └──► §7 部署（roots 一行 + 重启）
        │
        ▼
[P0: D1 (N7) · D2 · D3 · D4 · E1 E2 E3 E4 · F1′]
        │
        ▼
[P1: 执行层 · 运行前提 · 冻结快照 · 基线]   ──► N3
        │
        ▼
[P2: 租约 · 节点记录 · 候选身份 · 复用 · 合并门 · 豁免集 · 对账 · 决策队列]
        │                                    ──► N1 N2 N4 N5 + §3.1 E2E
        ▼
[P3: 缺陷登记 · 强制摄入 · 所有权 · 胶囊 · do_not_repeat · 消息指针]  ──► N6
        │
        ▼
[P4: C3 · 每周复查 · 体检报告 · 文档同步]  ──► 五节 + 立即阻断清单
```

**逐步前置依赖（明确写出"谁挡谁"）**：

| 步骤 | 前置依赖 | 为什么挡 |
|---|---|---|
| S1 | B-1..B-4 | 统一入口要知道最终有没有 `sessionController`（S2 的替身）与名册可用性 |
| S2 | S1 | 统一入口之后才有"一处 resume"可换 |
| S3 | **§7 部署步骤（roots 一行 + 重启）** | **"预设进名册"依赖 B 决策的部署步骤**：名册不认这个根，`presets.resolve(id)` 就找不到预设，S3 的代码改了也没用 |
| S3 | B-1（物化已存在） | 名册只认目录；目录不在，解析必失败 |
| S4 | 无（可与 S3 并行） | 但**必须在 D2 之前**：D2 的"回合不悬挂"要靠 `turn-stopping` 收束 |
| D2 | S1 + S3 + S4 | "永不询问钉到所有路径"要求路径已统一；`turn-stopping` 是收束的兜底 |
| D1 / N7 | S1 + S3 + §7 | 三条路径都要经名册 |
| P1-1..P1-4 | P0 全段 | 证据要绑到"冻结快照"，而冻结快照由候选身份产出；候选身份在 P2 —— **注意**：P1 只做**执行与采集**，`candidateId` 字段此时由 P1 自己签发一个占位并标 `provisional: true`，P2 接上后改为真候选。**这个临时状态必须落盘标记，不许假装已绑定** |
| P2-3（候选身份） | P1-3（冻结快照） | 候选身份的核心是"快照 + 清单 + 决策集" |
| P2-5（合并门） | P2-3 + P2-1 | 合并的对象是候选；租约决定谁能冻结 |
| P2-7（对账） | P2-1 + P2-6 | 越界例外要拿活跃租约与豁免集比对 |
| P3-2（强制摄入） | P3-1 + P2-3（候选身份） | 摄入结果要进**候选身份的决策快照**（F19），所以候选身份得先有；载体是节点记录，候选缺陷来自登记 |
| P3-4（胶囊） | P2-2 | 胶囊骨架从节点记录机械生成 |
| **D2-a/b/c 的编排** | **S4 先落地** | D2 的"回合不悬挂"要靠 `turn-stopping` 收束（§0.1 的实现顺序已把 S4 排在 D2 之前） |
| P4-3（体检报告） | P1…P3 全部（要读它们的计数） | 五节的数字来自前四个阶段 |
| P4-2（每周复查） | P4-3 的 ④ 节 | 复查结论是 ④ 节的内容 |

**并行度**：`P3-1/P3-3/P3-4` 可与 `P2` 后半段并行；`P4-1` 独立。其余严格串行。

**分批**：Owner 已允许分批（`alignment-2026-09-20-next-round.md` §1-9）。建议**两次交付**：`S+P0`（含 N7、D2-a/b/c、D3、D4，这是发布阻断项）→ `P1+P2`（含 N1–N5、§3.1 E2E）→ `P3+P4`（含 N6、体检报告）。每次交付的闸见 §11。

---

## 4. 每条验收的可执行验证方式（N1–N7 + D2-a/b/c）

**本节的写法约定**：每条给 **① 注入方式（可执行的命令/操作）② 期望的拒绝点与类型化原因码 ③ 拒绝时留下的记录（文件路径 + 字段）**。全节禁止"应当/理论上"。所有注入都在**真实 git 仓库**（`/tmp/orchestra-e2e-<ts>/repo`，`git init` + 至少一次 commit）上做。

**共同的观测入口**（所有 N 都用这三个，不用"看日志"）：

- `orchestra/nodes/<node-id>.json` —— 插件写的事实
- `orchestra/decisions/<decision-id>.json`、`orchestra/health/<window>.json`
- `git -C <repo> status --porcelain` / `git -C <repo> rev-parse <ref>` —— git 自己的输出

### 4.1 N1 · 审查通过后改候选 ⇒ 合并被拒

**验收目标**：审查结论绑在 commit 上；审查后改动候选 ⇒ 合并被拒，原因明确指向"审查结论属于旧候选"。

| 步 | 注入（可执行） | 期望 |
|---|---|---|
| 1 | `orchestra_draft` → 用户 `yes` → `orchestra_create`；`orchestra_dispatch` 派一个 implementer lane | 团队建立，lane 物化 |

**先写清命令的作者（F6 + F7，替换原 §1 P1-1 里"模型永不提供命令字符串"的措辞）**：

| 时点 | 谁 | 做什么 |
|---|---|---|
| **prepared** | 节点（会话）**提议** | 提出验收清单提案：每项 `{checkId, command, args[], cwd, env[], inputs[], externalMode}` |
| **freeze** | **门（插件）冻结，并成为记录作者** | 校验提案（`args[]` 形状、`command` 非空、`inputs[]` 的 `source/reason` 完整）⇒ 写入 `orchestra/nodes/<node>.frozen.json`，带 `frozenAt` + `generation`。**从这一刻起 `command` / `args` / `env` / `inputs[]` 都不可改**——改任一项 = 协议变更 = `generation + 1`（F20①） |
| **运行期** | **runner 只从 `frozen.json` 查** | `runCheck(nodeId, checkId)` 的入参**只有这两个 id**；`command` 从清单里读。**模型不得在运行期提供或改写命令字符串** |

精确措辞是："**命令由节点在 prepared 阶段提议、由插件在 freeze 时冻结并成为记录作者；运行期 runner 只从冻结记录里查**"——而不是"模型永不提供命令字符串"（后者与"节点提议清单"自相矛盾，这正是 F6 指出的冲突；F7 则钉死**记录作者是插件**，符合 §0 约束二）。
| 2 | 实现者产出候选 commit `C1`；`orchestra report` 交报告 | `orchestra/nodes/<node>.json` 出现 `candidate{commit: C1, tree: T1, generation: 1}` |
| 3 | 独立审查会话对 `C1` 出 PASS，写审查记录 | `gate`/`review` 记录带 `candidateGeneration: 1` |
| 4 | **注入**：`git -C .worktrees/<node> commit --allow-empty -m x` 造出 `C2`（tree 可能与 `T1` 相同——这正是要测的点：**身份是 commit，不是 tree**） | — |
| 5 | 让 driver 走合并门 | **拒绝点**：合并门的候选身份核对。**类型化原因码** `stale_candidate_review`，载荷 `{reviewedGeneration: 1, currentGeneration: 2, reviewedCommit: C1, currentCommit: C2}` |
| 6 | 检查留下的记录 | `orchestra/nodes/<node>.json` 的 `mergeAttempts[]` 追加一条 `{at, result: "rejected", code: "stale_candidate_review", ...}`；**不产生** `update-ref`，`git rev-parse refs/heads/<integration>` **不变** |

**§1.3 的补审路径也要跑**（同一脚本的第二段）：

| 步 | 注入 | 期望 |
|---|---|---|
| 4′ | `C2` 带着**真实改动**（改一个文件再 commit） | — |
| 5′ | 独立审查者补审差异 + 重新确认证据适用性 | `candidate.generation` 变 2；`review` 记录新签发，`reviewedCommit: C2` |
| 6′ | **只重跑"无法证明不受影响"的验收**。R-1 的精确形态（**F1**）：<br>· 清单里**没有** `inputs[]`、或 `inputs` 是**空数组** ⇒ 视为**未声明** ⇒ **一律判"受影响"、逐条重跑**（空数组不得被读成"声明了零个输入"）<br>· 有非空 `inputs[]` 的 ⇒ 变更路径**由插件用 `git diff <C1> <C2> --name-only` 自算**（**不取自角色**），与该 `inputs[].path` 求交集：**交集为空** ⇒ 标记 `reused`；**非空** ⇒ 重跑 | 证据里 `reused` 的**必须**带 `reuseScope`（R-2 的**八项**闭集）+ `reuseBasis: "declared-inputs-only"` + `completeness: "unproven"`（F20③）；**空 `inputs[]` 不得出现在任何 `reused` 证据里**（F1 的核心断言） |
| 7′ | 再走合并门 | 通过；`git rev-parse` 前进；`update-ref` 的 `expected-old` 与预演时的旧值一致 |

**硬线断言（契约 §1.3）**：把 `C1` 的验收清单改一个字（改断言文本）而不改 commit ⇒ 脚本必须拒绝把旧 PASS 复用，原因码 `acceptance_manifest_changed`。**"改断言或改决策语义不得换版本号继续用"** 由这条覆盖。

### 4.2 N2 · 预检后集成分支前进 ⇒ 重新预演或拒

**验收目标**：`merge-tree` 预演不是 CAS；目标 ref 的推进必须被 `update-ref <ref> <new> <expected-old>` 挡住。

| 步 | 注入（可执行） | 期望 |
|---|---|---|
| 1 | 节点 A 候选 `C_A` 就绪；合并门预演：`git merge-tree --write-tree refs/heads/<integration> C_A` ⇒ 组合树 `T_merged` | `orchestra/nodes/A.json` 记 `{previewedAgainst: <old-sha>, previewedTree: T_merged}` |
| 2 | **注入**：另一个节点 B 合法合并，`refs/heads/<integration>` 从 `<old-sha>` 推进到 `<new-sha>` | — |
| 3 | A 继续合并 | **两条合法路径之一，且必须是确定的一条**：`git update-ref` 用 `expected-old = <old-sha>` ⇒ **原子失败**；插件捕获后 `git rev-parse` 发现 ref 已推进 ⇒ **重新预演**（`merge-tree` 对 `<new-sha>` 重算）⇒ 若仍可合并则合、否则拒。**不允许**沿用旧预演直接合 |
| 4 | 记录 | `mergeAttempts[]` 追加 `{code: "base_advanced_retried"}` 或 `{code: "base_advanced_conflict"}`；两种情况下 **`git rev-parse` 的最终值必须是"重演后成立"或"未推进"**，脚本对此做断言 |

#### 4.2.1 F17 恢复判定表（**有序、穷尽**）

**两处 F17 的缺口已补**：(a) `ref == expectedOld` **且** `mergeAttempts[]` 已有同 `attemptId` 时，原四段表里的 ② 与 ④ **冲突且无优先级**；(b) `intent` **落盘中途崩溃 / 截断**全文没有规则。下面把这两件事一次收口。

**判定顺序就是下表的行序**——先判 ①，命中即返回；不命中再往下。**表是穷尽的**：最后一行是"其它一切"，所以不存在落到表外的输入。

| 序 | 先决条件（按序判，命中即停） | 判定 | 动作 |
|---|---|---|---|
| **①** | `mergeAttempts[]` 里**已有**同 `attemptId` 的条目 | **已完成**（无论 ref 现在是什么值） | 删 `intent`；**不做任何 ref 动作**；若 `ref` 与 `attempt.expectedNew` 不符 ⇒ 记 `ledger_ref_mismatch` 进**立即阻断清单**（§1.9）。**这一行优先于 ②④，是冲突的裁决者** |
| **②** | `ref == intent.expectedNew` | **ref 已推进、记账未完成** | 补写 `mergeAttempts[]` + `state = "merged"`；**不再 `update-ref`**（这是"重复合并导致 ref 二次前进"的唯一防线） |
| **③** | `ref == intent.expectedOld` | **`update-ref` 没发生** | 按 `intent` **重做一次**（CAS 仍带 `expectedOld`） |
| **④** | `ref` 是**第三个值**（既非 expectedOld 也非 expectedNew） | **他人已推进 ref** | 判 `base_advanced` ⇒ **回到预演**（§4.2 步 3），**不得**按 intent 重做 |
| **⑤** | `intent` **不可解析**（读到临时文件 / 截断 / JSON 坏 / 缺字段） | **视为无 intent** | 回落到"无 intent"的既定分支：**只读 `ref` 与会话记录**，按 ②③④ 的语义重新判定一次但不复用 intent 里的值；判不了 ⇒ `recovery_indeterminate`（类型化）+ 进**立即阻断清单**，**不猜** |
| **⑥** | `intent` **不存在**（从未写过，或已被 ① 删除） | **无在途合并** | 什么都不做（正常路径） |

**写入原子性（H-2）**：`intent` 用 **临时文件 + 原子 `rename` 写入 `orchestra/nodes/<node-id>.intent.json`**（写 `<name>.intent.json.tmp.<pid>` → `fsync` → `rename`）。这样 ⑤ 里那几种"半份文件"只可能出现在 `rename` 之前，而 `rename` 之前的文件**不叫** `intent.json`，所以 §6 的落点只会看到完整内容。**解析失败一律按"无 intent"处理（⑤），绝不按"半份内容"继续**——猜测崩溃点的语义正是 0.3 要禁的东西。

**判定脚本**：`scripts/test-merge-cas.mjs` 必须覆盖**六行各一个用例**，其中三行是 F17 的缺口：①与③同时满足（`ref == expectedOld` **且**已有同 attemptId）⇒ **必须走 ①**（记 `ledger_ref_mismatch`、不动 ref），**不得**走 ③ 重做；⑤ 截断的 `intent.json` ⇒ 走 ⑤ 而不是崩；⑥ 正常路径 ⇒ 无动作。另断言源码里存在 `rename` 调用（`grep` 断言，防止有人改成直接 `writeFile`）。

**同时必须跑的崩溃幂等用例（契约 §1.7③）**：

| 步 | 注入 | 期望 |
|---|---|---|
| 5 | 在 `update-ref` **成功之后、写 `mergeAttempts[]` 之前**注入进程终止（测试形态：把两者之间的写入点换成一个测试钩子，钩子抛错） | ref 已前进；节点记录里**没有**合并记录 |
| 6 | 重启/重跑恢复 | **幂等恢复：有序判定表，见下方 §4.2.1**（落点是 §6 的 `mergeIntent` 文件，**F17**）。**判定必须按表里的序号顺序**，第 ① 行先于其余各行 |
| 7 | 断言 | 整个用例后 `git rev-parse <ref>` **只前进过一次**（`git reflog <ref>` 的条目数 = 1，这是"ref 已推进、记账前崩溃"的**可机器判定**形态） |

### 4.3 N3 · 错误 worktree / 错误 PYTHONPATH ⇒ 证据不合格

**验收目标**：树的身份与环境都是**声明 + 采集 + 一致**；不一致即 `unqualified`，且该项验收**没有**有效证据。

| 变体 | 注入（可执行） | 期望 |
|---|---|---|
| **a. 错误 worktree** | 冻结清单里某条验收声明 `workdir: .worktrees/node-X`；在 host 侧把该次执行的实际 `workdir` 改成主 worktree（测试钩子） | **拒绝点**：树身份核对。原因码 `workdir_mismatch`，证据 `verdict: "unqualified"`，`treeIdentity.expected/actual` 都落盘 |
| **b. 错误 PYTHONPATH** | 冻结清单 `env: {PYTHONPATH: "<repo>/src"}`；让实际执行时 `PYTHONPATH` 指向别处（或缺失） | 原因码 `env_mismatch`，`envDiff[]` 列出键与两侧值；`verdict: "unqualified"` |
| **c. 假绿方向（致命方向）** | 清单声明 `external.mode: "required"`；本次运行**未观测到**任何外呼 | 原因码 `external_declared_required_not_observed`，`verdict: "unqualified"`。**这条是"关键前提未知不得判合格"的具体形态** |
| **d. 观测不全** | 清单声明 `external.mode: "required"`；观测器**未能采集**（无观测能力/被截断） | `external.observation: "unknown"` ⇒ **不得**判 `qualified`；原因码 `precondition_unknown`。**不许**把 `unknown` 当"未发生"来判不合格，也不许当"已发生"来判合格 |
| **e. 反向（默认只告警）** | 清单声明 `external.mode: "forbidden"`；本次**观测到**外呼 | `verdict: "qualified"` + `warning: external_unexpected`（**默认不阻塞**） |
| **f. 三种例外之一** | 同上但该验收声明 `testsNoExternalCall: true` | `verdict: "unqualified"`，原因码 `external_forbidden_observed_under_test_of_forbidden` |
| **g. 声明了但内容已变（F18）** | `inputs[]` 里声明了 `<repo>/fixtures/api.json` + sha256；验收跑之前**把该文件改一个字节** | 原因码 `input_digest_mismatch`，`verdict: "unqualified"`，载荷 `{path, declaredSha256, recomputedSha256}`。**重算规则见 §4.3.2** |

**记录**：每条证据落 `orchestra/nodes/<node>.evidence/<check-id>.json`（§6），含 `preconditions{tree, inputs, env, mode, external}` 五块与 `verdict`。

#### 4.3.1 F3：`unqualified` 的收束出口（取消活锁）

`unqualified` **不是终点**。否则一个"输出永远解析不出"的仓库会让节点永远拿不到有效证据且**没有任何出口**——那是 §0 约束三明令要避免的悬挂。出口按原因分成两类，**两类都是既有机制，不新增检查点**：

| 类 | 原因码 | 出口 | 谁关 |
|---|---|---|---|
| **Ⅰ · 可修**（声明与实际不一致，是**声明或运行器**的问题） | `workdir_mismatch` / `env_mismatch` / `input_digest_mismatch` / `unbound_input` / `external_declared_required_not_observed` / `external_forbidden_observed_under_test_of_forbidden` | 回**作者**：改冻结清单（改 `command` / `env` / `inputs[]` 之一）⇒ **协议变更 ⇒ `generation + 1`**、旧证据与旧审查按 A1 **自动失效** ⇒ 重跑。**受既有 Loop 的 `attempt` 上限约束**（拓扑里已声明，`orchestra-graph.ts` 的 attempt/expiry） | 作者 + 既有 cap |
| **Ⅱ · 不可修 / 未知**（插件缺这项能力，不是这次写错了） | `precondition_unknown`（外呼观测不全）· 运行器**持续**给不出可解析输出（R-3 的"解析不出"档） | **开一条决策队列记录**（`safetyClass: "non_defaultable"`，因为它决定"这次交付算不算数"）⇒ `blocks[]` 含该 nodeId ⇒ **该节点不得冻结/合并**；**节点回合正常结束**（E3：不可默认类到点**停在原地 = 记入 blocked 并结束回合**，不是等待）。**解除只能由人节点作出并留痕**（§1.5-4 的解除路径） | **人节点** |

**"整仓都测不了"的终态**（避免无限循环）：若某节点的**每一条** check 都落在 Ⅱ 类且人节点裁定"本仓无法产出合格证据"，该节点进 **`blocked` 终态**（不是 `merged_but_failed`，因为从未合并），`residuals[]` 记一条 `evidence_unavailable`，**它不阻塞其他节点**。这是"如实标明降级"（契约 §7 最后一段）的落点，**不是**把 `unqualified` 当成通过。

**判定脚本**：`scripts/test-unqualified-exit.mjs`。用例：①Ⅰ 类 ⇒ `generation` 自增且旧 `verdict` 被标 stale；②Ⅱ 类 ⇒ decision 记录生成、`blocks` 生效、**节点回合有 `turn/end`**；③人节点解除 ⇒ 阻断消失；④全部 check 落 Ⅱ 类且人裁定 ⇒ `blocked` 终态，且**其他节点仍能完成**。

#### 4.3.2 F18：已声明哈希的重算规则（与 F20④ 是同一件事的两面）

**这两条要一起读**：**F20④** 管"**声明面要盖住非 git 跟踪的输入**"（否则声明在构造上就不完整）；**F18** 管"**声明之后内容变了怎么办**"。两者合起来才是"按哈希显式绑定"的完整语义。

| 问题 | 规则 |
|---|---|
| 谁重算 | **宿主**（`src/evidence-runner.ts`）。**永远不采信角色给的哈希**，也不采信清单里写着的那个值当作"当前的" |
| 何时重算 | **每一次验收执行之前**，逐项重算 `inputs[]` 里每一项的 sha256 |
| 不一致怎么办 | `verdict: "unqualified"` + `reasonCode: "input_digest_mismatch"`；**不得沿用上次读数**，**不得**先跑再看结果 |
| git 跟踪的输入（`source: "git"`） | 同样重算。它们通常已被 `snapshotTree` 覆盖，但**清单可以声明主 worktree 里的路径**（这正是"测错树"P7 的入口），所以**不能省这一步** |
| 非 git 跟踪的输入（`source: "non-git"`） | **必须**在 `inputs[]` 里声明且带 `reason`（F20④）。夹具 / env 文件 / 生成物都属于这一类 |
| 未声明的参与输入 | `unbound_input` ⇒ `unqualified`（P1-3 用例①）。**"未声明"与"声明了但变了"是两个不同的原因码**，不可合并 |
| 哈希算法 | `sha256`，十六进制小写，**对文件内容**（不对路径、不对 mtime） |

### 4.4 N4 · 合并后检查失败 ⇒ 终态，不许改回进行中

| 步 | 注入 | 期望 |
|---|---|---|
| 1 | 正常合并节点 A（ref 前进） | `nodes/A.json` 的 `state = "merged"` |
| 2 | **注入**：合并后的检查失败（清单里放一条必然失败的检查，且该检查**只在合并后**跑） | `nodes/A.json` 的 `state = "merged_but_failed"`（**终态**） |
| 3 | 尝试把 A 改回 `in_progress`（调 `orchestra_dispatch` 到同一 node） | **拒绝点**：节点状态迁移。原因码 `terminal_state_immutable`，载荷 `{state: "merged_but_failed", attempted: "in_progress"}` |
| 4 | 尝试手工编辑 `nodes/A.json` 把 `state` 改回去，再读 | **不做进程取证**（`capability-boundaries.md` #7 / `alignment-2026-09-20` §7.1-2）：插件**不阻止**，但下一次判定重新读 git 与记录比对 ⇒ `ref` 前进过而状态是 `in_progress` = **账实不符** ⇒ 写入**立即阻断清单**（§1.9）并类型化报告 `ledger_ref_mismatch` |
| 5 | 合法出路 | 精确 revert（新 commit 反向撤销）或新建修复节点；两种都通过，且**原记录不改写** |

### 4.5 N5 · 第二个活跃写者无裁定 ⇒ 准备阶段拒绝

| 步 | 注入 | 期望 |
|---|---|---|
| 1 | 节点 A 声明写入面 `["src/a/**"]`，租约 active | `orchestra/leases/<lease-id>.json` 存在 |
| 2 | **注入**：节点 B 在准备阶段声明写入面 `["src/a/b.ts"]`（前缀重叠），无架构裁定 | **拒绝点**：准入。原因码 `lease_conflict`，载荷 `{conflictingLease: <lease-id>, overlappingPrefix: "src/a/", declaredPrefix: "src/a/b.ts"}`；B **不得**进入可开工状态 |
| 3 | 写面**不可枚举**（声明 `["**"]` 或没声明） | 退化为**仓库级独占**；此时任何其他活跃租约都冲突 |
| 4 | 有裁定（`decision` 记录 `state="resolved"` 且 `blocks` 不含 B） | 允许开工；裁定 id 写进 B 的节点记录 `archDecisionRef` |

### 4.6 N6 · 会话被杀 ⇒ 只读胶囊 + 记录 + git 续做

| 步 | 注入 | 期望 |
|---|---|---|
| 0 | **显式先生成一次胶囊**：`orchestra_capsule_submit`（正例必须自带这一步，**F14**） | `orchestra/capsules/<node>.json` 存在，`state` 至少 `incomplete` |
| 1 | 实现者会话继续干到一半（有 commit、有未提交改动、有报告） | 胶囊被 `turn-stopping` 钩子在每次回合关闭前**机械刷新**；被杀时取**最后一次成功生成**的那份 |
| 2 | **注入**：`a2a_stop(<implementer-session-id>, "kill for N6")` | 会话终止 |
| 3 | 新会话（fresh context）只读三样：`orchestra/capsules/<node>.json` + `orchestra/nodes/<node>.json` + `git -C .worktrees/<node> status/log` | 能回答：当前阶段、最后确认效果（commit/tree）、工作区状态、已知失败、下一步、不可重复动作 |
| 4 | **判定**：`scripts/verify-capsule-resume.mjs` 用一个**不读旧对话**的只读读者（脚本，不是会话）检查三项 `required` 字段齐全度 | `nextStep` / `knownFailures` / `doNotRepeat` 三项：齐全 ⇒ `complete`；缺 ⇒ `incomplete` 且**允许续做**（不阻塞） |
| 5 | 续做 | 新会话在同一 worktree 上继续，产出 `C2`；`generation` 递增 |

**F14 的措辞纪律**：上面第 0 步是**正例的一部分**，不是可有可无的铺垫。原因是胶囊的生成时机（`turn-stopping` 钩子）**本身就是 R-11 的兜底项**——若该钩子在某个路径上不触发，"被杀时已有胶囊"就**不成立**。所以正例**显式先生成一次**，把这条从"产品保证"降回"可复现的用例"；R-11 记的是"钩子不触发的退路"，不是"胶囊一定有"。

**N6 的"不读对话"是可判定的**：脚本进程的输入**只有**那三类路径（命令行参数就是它们），它没有会话日志的读权限路径 —— 这一点写进脚本的 `--help` 与用例断言（脚本内断言"未打开任何 `session.v3.jsonl.zstd`"）。

### 4.7 N7 · 重启 ⇒ 三种角色身份完整且可核

**口径**：从**外部**核实际挂载的组合，**不问会话自己**（`kickoff-0.8.0.md` §3 第 1 行）。

| 步 | 注入（可执行） | 期望 |
|---|---|---|
| 1 | 三种角色各建一个：①首波（`orchestra_create` 时物化）②懒加载（`orchestra_dispatch` 首次触达才物化）③重激活（`orchestra_dismiss` 后 `orchestra_activate`） | 三个角色 `phase === "active"`，各有 blueprint 记录 |
| 2 | **注入**：重启 dev 实例（`scripts/dev-instance.sh` 前台 Ctrl-C 后重跑；或 4599 重启） | 进程换掉 |
| 3 | **外部核对**：`node scripts/verify-role-identity.mjs --repo . --team .orchestra/team.json` | 退出码 0 |
| 4 | 脚本内部的三步（每步都断言） | ① 从 `~/.dsh/sessions/<slug>/<sessionId>/session.v3.jsonl.zstd` 解出 header + events（复用 `scripts/check-session-readable.mjs` 的 zstd 解码形状，**含"解不出即报错、不返回空"**的既有纪律）② 用**宿主自己的** `validateStoredEvents` 判其可读（不读即身份无意义）③ 算 `agentPreset` 投影（header.agentPreset 起、`agent-preset/selected` 事件推进）④ 对 `~/.dsh/orchestra/catalog-presets/<id>` **以名册同款方式**解析该 id，产出"**预期组合**：行 id 集 + 工具名集"⑤ 与节点记录里插件写的"预期组合"逐项比对 |
| 5 | **负例（必须有）** | 脚本带 `--self-test`：把 team.json 里某角色的 `sessionId` 换成一个**真实的、但不是角色**的会话 id ⇒ 脚本必须报 `NOT_A_ROLE_SESSION` 且退出码非 0。**没有负例的核对脚本等于一个永远说 OK 的脚本**（`check-session-readable.mjs` 已经立了这个先例） |
| 6 | **重激活的额外断言** | 重激活后该角色 sessionId 若变过，`sessionHistory[]` 必须有对应条目；`verify-role-identity.mjs` 对每个 `sessionHistory` 里的旧 id 也跑一遍第 3-5 步 |

**N7 不降级**（`alignment-2026-09-20-next-round.md` §7.2-12）。

### 4.8 D2-a / D2-b / D2-c · 回合不悬挂（需求 §2.D 的三条断言 + §3.3-2）

**先写清 DSH 的机制事实**（本节所有断言都建立在它之上，实测于 `@deepseek-ai/dsh-user-approval`）：

- 审批请求的处理顺序是：先无条件 append `approval/asked`，**再**判策略；策略为 `never` 时 `decide()` 直接返回 `"rejected"`，**根本不派发 `approval/request` 瀑布**（`lib/index.js:131-146`、`decide()` 的 `effectivePolicy(session) === "never"` 分支）。
- 因此 `approval/asked` 与 `approval/decided` 是**成对**的、由宿主写的事实，且**被回合包住**（`hasOpenTurn` 前置条件，`lib/index.js:49-53`）。
- 部署现状里 `workspace-write` 的 approval 是 **`ask`**（`dsh-base/cordis.patch.yml:236-239`）；`danger-full-access` 才是 `never`。所以**没有 blueprint 的建会话路径就是 `ask`** —— 这正是 D2（只覆盖首波）的机制级成因。

**D2-a · 钉死的路径不得挂起回合**

| 步 | 注入 | 期望 |
|---|---|---|
| 1 | 建一个 `read-only` 的角色会话（**三种路径各一次**：首波 / 懒加载 / 重激活） | blueprint 记录的 `approval === "never"` |
| 2 | **注入**：给该角色派一个必然触发沙箱写入的动作（例如让它 `write` 一个仓库外文件，或带 `sandbox_permissions` 调 `bash`） | 工具调用返回**确定性拒绝**（不是"等待中"） |
| 3 | 观测会话日志 | `approval/asked` 与 `approval/decided(outcome="rejected")` **成对出现**；对每一条 `asked`，同一个 `turn/start`…`turn/end` 区间内必有同 `id` 的 `decided` |
| 4 | 观测回合收束 | 该回合**正常 `turn/end`**（存在 `turn/end` 事件），且 `turn/end` 在 `decided` 之后 |
| 5 | **反例校准（必须有）** | 把某一条路径的 `approval` 改回 `ask` 并重跑：`turn/end` **不出现**（回合悬挂）⇒ 校准通过。这一步证明第 4 步不是恒真 |

**判定脚本**：`scripts/verify-d2-approval.mjs`，输入 = 会话日志目录 + 期望的 `approval` 值。退出码 0 = 全部路径通过；1 = 有路径悬挂或 `asked/decided` 不成对。

**D2-b · 走路由必须带截止时间、到点按申报默认值收束（不可默认类 ⇒ 停在原地）**

**注意口径**：这里的"路由"是**本插件的决策队列**（E2/E3），**不是** DSH 的审批受理者链——因为 E1 已把提权改成"派发期钉死 + 运行期确定性拒绝"，**没有任何东西走审批路由**（`alignment-2026-09-20-next-round.md` §2.1："受理者三选一已由 E 组取代，不再是待决项"）。

| 步 | 注入 | 期望 |
|---|---|---|
| 1 | 开一条 `safetyClass: "defaultable"` 的决策（`default` 在某节点的既有授权内，`deadlineAt = now + T`） | `orchestra/decisions/<id>.json` 带 `deadlineAt` 与 `default.authorityRef` |
| 2 | **注入**：不回答，把时钟推进过 `T`（测试用可注入的 `now`），触发宿主的到期扫描 | `state` 从 `open` 变 `default_applied`；`blocks[]` 解除；写入 `history[]` 一条 `{at, by: "host", why: "deadline"}` |
| 3 | **注入**：答案在到期**之后**才到 | **迟到答案形成新决策记录**（新 `<decision-id>`），旧记录**不被改写**；若该动作已按默认执行过，旧记录与节点记录带上 `default_applied_then_overridden` 语义字段 |
| 4 | 开一条 `safetyClass: "non_defaultable"` 的决策（权限变更 / 数据处置 / 不可逆外部动作 / 发布资格之一） | 到点后 `state = "blocked"`，**不代为实现默认**；节点进入 blocked，**但回合已结束** |
| 5 | `default` 越出该节点既有授权 | **拒绝**在写入时发生：原因码 `default_outside_authority`（契约 §1.5-1：不得临时自授决定权） |
| 6 | `do_not_repeat` 的某动作结果为 `unknown`/`attempted` | **阻断**（不是告警）；解除只能由**人节点**作出并留痕（缺 `resolvedBy` ⇒ 拒绝解除） |

**判定脚本**：`scripts/verify-d2-decision.mjs`。退出码 0 = 六个用例全部按期望。

**D2-c · 回合结束必须留下可判定事实**

| 步 | 注入 | 期望 |
|---|---|---|
| 1 | 上两个用例跑完后，读会话日志 | 每条 `approval/asked` 都能找到 `{id, outcome}` 配对的 `approval/decided`；`outcome ∈ {allowed-once, rejected, cancelled, unavailable}` |
| 2 | 读节点记录 | 每个被拒绝的提权尝试所对应的节点，至少留下 `approvalFacts[]` 一条：`{requestId, outcome, reasonCode, at}` |
| 3 | **反例校准** | 手工删掉一条 `decided` 后重跑判定 ⇒ 必须报 `dangling_approval` 且退出码 1 |

**判定脚本**：`scripts/verify-d2-approval.mjs --facts`（与 D2-a 同一脚本的第二遍）。

**需求 §3.3-2 的原始措辞是"断言它不发起审批，且回合能正常结束"。** 按 `capability-boundaries.md` **#1**，我们能保证的是"**请求不挂起 + 确定性拒绝 + 留痕**"，**不保证模型不会尝试**（DSH 仍会在工具结果里提示可申请提权）。所以 §3.3-2 在本计划中的**可判定形态**就是上面的 D2-a 步骤 2-5：**拒绝是即时的、`asked/decided` 成对、回合有 `turn/end`**。**不写"不发起审批"这种做不到的断言。**

### 4.9 §3.1 端到端无人介入（总判据之一）

`scripts/verify-delivery-e2e.mjs` 的唯一输入是一个已批准宪章的 team 目录。它按顺序驱动：冻结节点（含验收清单）→ 实现者产候选 → 独立审查 PASS → 合并门 + CAS → 合并后检查 → 收口。**除最初一次宪章批准外全程无人介入**。

可机器判定的形态：脚本自己在最后断言三件事 ①`git -C repo log --oneline <integration>` 上有且仅有该节点的合并 ②`nodes/<node>.json` 的 `state === "closed"` ③`mergeAttempts[]` 里**没有**任何人类介入记录（记录里有 `actor: "human"` 的条目数 = 0，宪章批准那条除外——它在 `orchestra/charter/records.json` 而不是节点记录里，所以这条断言是干净的）。

### 4.10 §1.9 五节 + 立即阻断清单（独立验收断言）

`scripts/test-health-report.mjs` 与 `scripts/verify-health-report.mjs`：生成一份报告后 ①逐节断言存在（五节缺一 ⇒ `report_invalid`）②断言 ①⑤ **不是同一节**（同一节 ⇒ `report_invalid`）③立即阻断清单两项（`ledger_ref_mismatches`、`remerged_nodes`）非零时报告带 `blocking: true`④**④节必须含每周复查结论**，且**"本周无候选"也算一条结论**（空节 ⇒ `report_invalid`）。

---

## 5. 验收脚本

**共同约定**（每个脚本的 `--help` 必须自述这些）：

| 约定 | 值 |
|---|---|
| 语言/运行时 | Node ≥ 22；`node scripts/<name>.mjs [flags]` |
| 导入面 | **只从 `../lib/*.js` 导入**（跟 `scripts/test-tool-schemas.mjs` 一致），不导入 `src/`；外部核对脚本（`verify-*.mjs`）**不导入本插件 lib**，只读文件与宿主包 |
| cwd | **仓库根**（`/Users/yuantian/Developer/orchestra-dsh`）。脚本内部对目标仓库一律用 `--repo` 绝对路径，不靠 cwd 推导 |
| 环境 | 需 `zstd` 二进制（`check-session-readable.mjs` 已依赖）；`DSH_SESSION_MODULE` / `DSH_PERSISTENCE_MODULE` 可覆盖宿主包路径（沿用既有约定） |
| 外呼 | **一律不外呼**。每个脚本在报告头打印 `external: none`。若将来某脚本必须外呼，它必须打印 `external: required` 并在退出摘要里带观测结果 |
| 退出码 | `0` = 全部断言通过；`1` = 有断言失败（`fail` 计数打印在末行）；`2` = 用法/前置不满足（缺 `zstd`、缺 `--repo`、目标不是 git 仓库） |
| 摘要格式 | 末三行固定：`ok N - <title>` 逐条 / `# fail F` / `# external <none|required:observed|required:not-observed|unknown>` |

**"运行前提声明"的记录方式**（brief §2 第 5 项要求）：每个脚本**在报告头打印一行**机器可解析的运行前提块：

```
run-preconditions: tree=<git rev-parse HEAD> env=<sha256 of sorted declared env> mode=<offline|online|n/a> external=<none|required:observed|...> node=<version> zstd=<version>
```

这一行**同时**写进目标仓库的 `orchestra/health/<window>.json` 的 `preconditions` 字段，因此"声明的运行前提"与"报告的运行前提"是**同一份数据**，可由 `scripts/test-runtime-preconditions.mjs` 直接比对。

### 5.1 脚本清单

| 脚本 | 命令 | cwd | 期望退出码 | 期望摘要（可判定） | 输出如何判定 |
|---|---|---|---|---|---|
| `test-tool-schemas.mjs`（扩展） | `node --test scripts/test-tool-schemas.mjs` | 仓库根 | 0 | 用例数 ≥ 注册工具数 + 既有用例 | `node --test` 自己的 TAP 输出；末行 `# fail 0` |
| `test-role-session-single-path.mjs` | 同上 | 仓库根 | 0 | S1 三条断言 | TAP `# fail 0` |
| `test-native-delivery.mjs` | 同上 | 仓库根 | 0 | S2 三条断言 | TAP |
| `test-role-preset-roster.mjs` | 同上 | 仓库根 | 0 | S3 三条断言（含 grep 断言） | TAP |
| `test-node-stall.mjs`（重写） | 同上 | 仓库根 | 0 | S4 三条断言 | TAP |
| `test-orchestra-preferences.mjs`（改写） | 同上 | 仓库根 | 0 | S5 `legacy_tiers_ignored` + `unknown_argument` | TAP |
| `test-v05-slimming.mjs`（扩展） | 同上 | 仓库根 | 0 | S6 两条 grep 断言 | TAP |
| `test-decision-queue.mjs` | 同上 | 仓库根 | 0 | E2/E3 六个用例 | TAP |
| `test-design-gate.mjs` | 同上 | 仓库根 | 0 | F1′ 三个用例 | TAP |
| `test-runtime-preconditions.mjs` | 同上 | 仓库根 | 0 | 四象限 + `unknown` + 三例外 = 8 用例 | TAP |
| `test-evidence-runner.mjs` / `test-frozen-snapshot.mjs` / `test-baseline-diff.mjs` / `test-evidence-reuse.mjs` | 同上 | 仓库根 | 0 | P1 各表末列 | TAP |
| `test-write-lease.mjs` / `test-node-record.mjs` / `test-merge-cas.mjs` / `test-exemptions.mjs` / `test-reconciliation.mjs` | 同上 | 仓库根 | 0 | P2 各表末列（含崩溃幂等用例） | TAP |
| `test-defect-registry.mjs` / `test-defect-intake.mjs` / `test-ownership-declaration.mjs` / `test-do-not-repeat.mjs` / `test-pointer-messages.mjs` | 同上 | 仓库根 | 0 | P3 各表末列 | TAP |
| `test-orchestra-archive.mjs`（扩展） | 同上 | 仓库根 | 0 | D3 的三条新用例（重入归档两次都通知 / 终态旧队清活跃前通知 / archived marker 后 `orchestra_team` 返回空队 + archive 列表） | TAP `# fail 0`（**G-P0 第 ⑥ 项点名它**，F12） |
| `test-unqualified-exit.mjs` | 同上 | 仓库根 | 0 | §4.3.1 的四个用例（F3 的收束出口） | TAP |
| `test-weekly-review.mjs` / `test-health-report.mjs` / `check-docs-status.mjs` | 同上 | 仓库根 | 0 | P4 各表末列 | TAP |
| **`verify-role-identity.mjs`** | `node scripts/verify-role-identity.mjs --repo <abs> --team <abs>` | 任意（路径全显式） | **0**（身份完整）/ **1**（有角色不合）/ **2**（用法或前置缺失） | 每个角色一行 `IDENTITY_OK|IDENTITY_MISSING <roleId> <sessionId> preset=<id> rows=<n> tools=<n>`；末行 `# roles 3 ok 3 missing 0` | 逐行解析：`preset=` 必须是名册可解析 id；`rows/tools` 与节点记录比对 |
| `verify-role-identity.mjs --self-test` | 同上 | 任意 | **1**（必须检出被换的 id） | 末行 `# self-test detected=yes` | `detected=yes` 且退出码 1 ⇒ 校准通过 |
| **`verify-capsule-resume.mjs`** | `node scripts/verify-capsule-resume.mjs --repo <abs> --node <id>` | 任意 | 0（可续做）/ 1（不可续做）/ 2（用法） | 末行 `# required present=2/3 state=incomplete resumable=yes` | `resumable=yes` 即通过（**`incomplete` 不阻塞**） |
| **`verify-delivery-e2e.mjs`** | `node scripts/verify-delivery-e2e.mjs --repo <abs> --team <abs>` | 任意 | 0（端到端成立）/ 1 / 2 | 末行 `# e2e merged=yes postcheck=closed human_interventions=0` | `human_interventions=0` 是硬判据 |
| **`verify-negative-N1.mjs` / `verify-negative-N2.mjs` / `verify-negative-N3.mjs` / `verify-negative-N4.mjs` / `verify-negative-N5.mjs` / `verify-negative-N6.mjs`**（**6 个独立脚本**：N1 旧候选审查 / N2 集成分支前进 / N3 运行前提不一致 / N4 合并后终态 / N5 第二个活跃写者 / N6 杀会话续做；**不写成 `N1..N5` 缩写**——缩写会让"到底点名了几个"各算各的，见 §11 的枚举表） | `node scripts/verify-negative-N<k>.mjs --repo <abs> --team <abs>` | 任意 | **0 = 注入被按期望拒绝**（即负例成立）/ **1 = 没被拒绝（回归！）** / 2 | 每个脚本末行 `# injected <reasonCode> rejected=yes attempts=<n>`（如 N1 的 `stale_candidate_review`） | **退出码 1 就是告警信号**：这条负例的拒绝点丢了 |
| **`test-orchestra-role-presets.mjs`**（扩展） | `node --test scripts/test-orchestra-role-presets.mjs` | 仓库根 | 0 | E4 的两条新用例（F9/F12） | TAP `# fail 0` |
| **`verify-d2-approval.mjs`** | `node scripts/verify-d2-approval.mjs --sessions <dir> --expect approval=never [--facts]` | 任意 | 0（三条路径全部即时拒绝、`asked/decided` 成对、回合有 `turn/end`）/ **1（有路径悬挂或 `asked` 无 `decided`）** / 2 | 每角色一行 `D2A_OK\|D2A_HANG <roleId> path=<first-wave\|lazy\|reactivate> asked=<n> decided=<n> turnEnd=yes\|no`；末行 `# paths 3 ok 3 hanging 0 dangling 0` | `hanging 0` 与 `dangling 0` 是硬判据；`--facts` 再核节点记录的 `approvalFacts[]` |
| `verify-d2-approval.mjs --self-test` | 同上 + 把一条路径的 approval 改回 `ask` | 任意 | **1**（必须检不出 `turn/end`） | 末行 `# self-test detected=yes` | `detected=yes` 且退出码 1 ⇒ 校准通过（证明第 4 步不是恒真） |
| **`verify-d2-decision.mjs`** | `node scripts/verify-d2-decision.mjs --repo <abs>` | 任意 | 0（§4.8 D2-b 六用例全部按期望）/ 1 / 2 | 末行 `# cases 6 ok 6 default_applied=<n> blocked=<n> late_answers=<n>` | 逐用例断言；`default_outside_authority` 与 `do_not_repeat` 阻断两例必须有 |
| **`verify-role-presets-roster.mjs`** | `node scripts/verify-role-presets-roster.mjs --profile web [--profile dev]` | 任意 | 0 / 1 / 2 | 末行 `# presets healthy=12/12 roots=1 default=standard` | §7.3-a：按 `applyEntryPatches` 的**浅替换**语义离线合成 patch 后断言 |
| **`verify-agent-budget.mjs`**（F23 / H-5） | `node scripts/verify-agent-budget.mjs --repo <abs> --team <abs>` | 任意 | 0（逐项断言全过）/ 1（任一项不过）/ 2 | 每节点一行 `BUDGET node=<id> role=<roleId> new=<n> total=<n>`；末行 `# nodes N delivery_new_max <n> delivery_over 0 review_new 0 review_total_ok yes` | **逐项分开断言**（H-5）：`delivery.new ≤ 3`（有真实请示时 ≤ 4）且 `delivery.new == delivery.total`；**`review.new == 0`**；`review.total == 1`；`driver.new == 0`；`tier0.total == 0`。**逐项断言是本脚本的全部判据**（单一上界判据对"审查型合计 1"恒真通过，判不出 `review.new == 0`）。计数来源 = 会话事件流按 `sessionId → nodeId` 归集（**不采信角色自报**，§9.4） |
| **`verify-health-report.mjs`** | `node scripts/verify-health-report.mjs --window <id> --team <abs>` | 任意 | 0（五节齐全且①⑤分开）/ 1 / 2 | `# sections 5 present 5 separated=yes blocking=<bool>` | `present 5` 与 `separated=yes` 都是硬判据 |

**为什么负例脚本"通过时退出 0"而不是"退出 1"**：CI 语义是"期望的结果发生了 ⇒ 成功"。注入被拒 = 期望结果。所以 `verify-negative-*.mjs` 的**期望退出码是 0**，而"没被拒"才返回 1。这一点写进脚本 `--help`，避免读者误判。

---

## 6. 记录与字段（schema 版本表）

**共同规则**（沿用仓库既有形状，见 `orchestra-state.ts:194` / `charter-store.ts:37` / `orchestra-graph.ts:25`）：纯 JSON、`schemaVersion` 必填、版本不符 ⇒ 类型化 `unsupported_schema`（**不静默迁移**）、时间戳一律 `now` 由调用方传入（便于测试伪造时钟）。**事实字段只由插件写**；角色只能写 `rationale` / `explanation` 一类解释性字段。

| 记录 | 路径（相对主 worktree） | 版本常量 | 关键字段 |
|---|---|---|---|
| 节点记录 | `orchestra/nodes/<node-id>.json` | `NODE_RECORD_SCHEMA_VERSION = 1` | `nodeId` `teamId` `charterRevision` `state` `tier`(`"standard"｜"lightweight"｜"off"`) `tierReason`(轻量档必填，缺即校验失败) `writeSurface[]` `leaseId` `worktree` `candidate{candidateId,commit,tree,generation,frozenAt}` `acceptanceManifestRef` `decisionSnapshotHash` `designerSessionId` `designerModel` `reviewerSessionId` `reviewerModel` `deliverable{merge,publish,reusablePass}` `faultRefs[]` `ratio{plan,implement,verify}` `residuals[]` `mergeAttempts[]` `updatedAt` |
| 胶囊 | `orchestra/capsules/<node-id>.json` | `CAPSULE_SCHEMA_VERSION = 1` | 机械字段：`lastConfirmedEffect{commit,tree,externalCallIds[]}` `workspace{worktree,dirty}` `resources{processes[],ports[],leases[]}` `evidencePointers[]`；`required` 三项（**只留机器推不出来的**）：`nextStep` `knownFailures[]` `doNotRepeat[]`；`state: "complete"｜"incomplete"`（缺 required ⇒ `incomplete`，**不阻塞**） |
| 证据 | `orchestra/nodes/<node-id>.evidence/<check-id>.json` | `EVIDENCE_SCHEMA_VERSION = 1` | `checkId` `candidateId` `commandDigest` `cwd` `treeIdentity{expected,actual}` `env{declared,observed,digest}` `mode` `external{mode,observed,observation:"observed"｜"unknown"}` `exitCode` `signal` `verdict:"pass"｜"fail"｜"unqualified"` `reasonCode` `summary` `failures[{name,location,type,reason}]` `baselineRef` `reuseScope{candidateTree, inputsDigest, checkId, commandDigest, cwd, envDigest, mode, externalDeclaration}` `otherIdentity{interpreter?, toolchain?, depsDigest?}` `otherIdentityMismatch?: true` `reuseBasis:"declared-inputs-only"` `completeness:"unproven"` `preconditionClass:"I"｜"II"`（§4.3.1 的收束出口分类）`reusedFrom` `collectedAt` |
| **合并意图（F17）** | `orchestra/nodes/<node-id>.intent.json`（**独立文件，不是节点记录的一部分**：它必须在 `update-ref` **之前**落盘，而节点记录是**原子替换**的——把意图塞进节点记录里，写它就会把"合并前"的整份记录一起改写，崩溃语义会变模糊） | `MERGE_INTENT_SCHEMA_VERSION = 1` | `attemptId` `expectedOld`（预演时读到的 ref 值）`expectedNew`（将要写入的新 commit）`previewedTree`（`merge-tree` 算出的组合树）`candidateId` `at`；**写入顺序 = 先落 intent → 再 `update-ref <ref> <expectedNew> <expectedOld>` → 再写节点记录的 `mergeAttempts[]`**。恢复只读它 |
| 冻结清单 | `orchestra/nodes/<node-id>.frozen.json` | `FROZEN_MANIFEST_SCHEMA_VERSION = 1` | `snapshotCommit` `snapshotTree` `checks[{checkId, command, args[], cwd, env[]:{key,value,source}, timeoutMs, externalMode, testsNoExternalCall?, inputs[]}]` `frozenAt`；**`inputs[]` 是唯一的输入声明字段**（F21）：每项 `{path, sha256, source: "git"｜"non-git", reason?}`，`source:"non-git"` 必带 `reason`。**没有 `extraInputs`**。**注意是 per-check 的 `inputs[]`**（每个验收各自声明它的输入）；清单根级没有"全清单输入"这种第二处口径。**改 `inputs[]` = 改验收协议 = `generation + 1`**（F20①，与 `command` 同级） |
| 候选 | 内嵌在节点记录 `candidate` | `CANDIDATE_SCHEMA_VERSION = 1` | `candidateId` `commit` `tree` `acceptanceManifestRef` `decisionSnapshotHash` `generation` `frozenAt` `frozenBy` |
| 决策队列 | `orchestra/decisions/<decision-id>.json` | `DECISION_SCHEMA_VERSION = 1` | `decisionId` `question` `default{action,authorityRef}` `deadlineAt` `blocks[]:nodeId` `state:"open"｜"default_applied"｜"resolved"｜"blocked"` `owner` `resolvedBy` `safetyClass:"defaultable"｜"non_defaultable"` `history[]` |
| 租约 | `orchestra/leases/<lease-id>.json` | `LEASE_SCHEMA_VERSION = 1` | `leaseId` `nodeId` `writeSurface[]`（路径前缀，可枚举；不可枚举 ⇒ `enumerable:false` 且按仓库级独占）`state:"active"｜"released"` `acquiredAt` `releasedAt` |
| 豁免集 | `orchestra/exemptions.json` | `EXEMPTION_SCHEMA_VERSION = 1` | `entries[{path,reason,addedBy,addedAt}]`（**缺任一项即校验失败**）；对账报告必须打印**当次全量** |
| 设计门 | `orchestra/gates/<node-id>.design.json` | `DESIGN_GATE_SCHEMA_VERSION = 1` | `state:"satisfied"｜"degraded"｜"gate_not_run"` `designer{sessionId,model}` `reviewer{sessionId,model}` `participants[]`（**只允许 `phase === "active"` 的角色进入**）`modelPoolSize` `reason` |
| 体检报告 | `orchestra/health/<window-id>.json` | `HEALTH_REPORT_SCHEMA_VERSION = 1` | `sections`：`degradations` / `exemptions` / `decisionQueue` / `ratio{plan,implement,verify}` + `weeklyReview` / `evidenceQuality`（**必须与 `degradations` 分列**）；`blocking{ledgerRefMismatches,remergedNodes}`；缺节 ⇒ `reportInvalid: true` |
| 基线 | `orchestra/baselines/<node-id>.json` | `BASELINE_SCHEMA_VERSION = 1` | `baselineSha` `collectedAt` `failures[{name,location,type}]` `stale:boolean` |
| 诊断（账实不符） | 追加进节点记录 `mergeAttempts[]` / 报告 `blocking` | —— | `code` `at` `expected` `actual` |

**字段表与契约的对应关系**（避免两处漂移）：节点分级字段对应 §1.2；候选五元组对应 §1.3；`reuseScope` **八项闭集（下界，F22）** + `reuseBasis`/`completeness`（F20③）对应 §1.4（R-2）；`preconditionClass` 对应 §4.3.1 的 `unqualified` 收束出口（F3）；`default/authorityRef/safetyClass` 对应 §1.5 五条收紧；`writeSurface/enumerable` 对应 §1.6；`mergeAttempts` 的 `expected-old` 记录对应 §1.7③；`ratio` + `weeklyReview` 对应 §1.8；`sections` 分列对应 §1.9⑤。

---

## 7. 部署步骤

**这一步是 S3 与 N7 的前置。** 与契约 §1.1 的唯一偏离已在 §0.2-B-2 说明：改的是 **profile patch 层**，不是 bundle 内部的行。

### 7.1 要写的内容（**单跳 override**；F16）

两个文件（`web` 与 `dev` 各一次）：

- `~/.dsh/profiles/web/cordis.patch.yml`
- `~/.dsh/profiles/dev/cordis.patch.yml`

把当前的 `[]` 替换为：

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer.
#
# orchestra 0.8.0 · 预设私有根（契约 §1.1 / docs/plan-0.8.0-execution.md §7）
#
# 单跳 override：`id: agent-presets` 这一行由 @deepseek-ai/dsh-web-app 的 bundle
# 层 insert 而来，而 **profile 层在本 profile 的 patch 栈里跟在 bundle 层之后**
# 应用（dsh-app-boot composeProfile: allPatches = bundlePatches → profile.patches
# → homePatches → overlays），所以这里直接按 id 覆盖它就够了。
#
# ⚠️ 不要写成 insert 一个 group 再往里插一行 —— 那会**插出第二条同名行**
# （内存实测：两条 id 都是 agent-presets），而不是覆盖原来那条。
#
# ⚠️ 配置是**按键浅替换**（applyEntryPatches 对每个 override key 直接赋值）：
# 写 `config` 就必须自带 `default`，否则 bundle 的 `{default: standard}` 被整个
# 顶掉，只剩 roots（内存实测：config = {"roots":[…]}）。
- id: agent-presets
  config:
    default: standard
    roots:
      - path: ~/.dsh/orchestra/catalog-presets
        trust: system
```

**三条写法纪律**（每条都有内存实测支撑，见 §7.4）：

1. **单跳，不两跳**。两跳（insert 一个 group，再往组里 insert 一行）会产出**两条** `id: agent-presets` 的行，两条的 `config` 还都是新的——既没覆盖也没去重。
2. `default: standard` **必须显式写出**，即使值与 bundle 的相同。
3. 路径写 `~`，**不展开**（发现过程 `expandHomePath` 会展开；`dsh-agent-presets/lib/index.js:393`）。

### 7.2 重启与验证时机

| 动作 | 时机 | 生效条件 |
|---|---|---|
| 改 `cordis.patch.yml` | S3 代码改完之后、跑 S3 测试之前 | **新增根需重启实例**（契约 §1.1 已写明） |
| 重启 dev（4600） | 立即 | `patchReload: "live"` 让 patch 文件本身热重载，但**新增根**要重启；`scripts/dev-instance.sh` 前台 Ctrl-C 后重跑即可 |
| 重启 web（4599） | **验收 N7 之前**，且要用户在场（这是用户自己的实例） | 同上 |
| 往已在扫描的根里放/改文件 | 随时 | **即时可见**（发现过程不做记忆化）——所以占位目录/文件改动不需要再重启 |

### 7.3 验证方式（从外部核实际挂载的组合，不问会话自己）

分三层，**每一层都是外部观测**：

| 层 | 怎么验 | 期望 | 失败意味着什么 |
|---|---|---|---|
| **a. 名册认不认根** | `node scripts/verify-role-presets-roster.mjs`（**直接 import 宿主的 `dsh-app-boot` `composeEntries`**，喂 `[bundlePatch, profilePatch, homePatches, overlays]` 四层，再对 `~/.dsh/orchestra/catalog-presets/` 逐个目录断言 `agent.cordis.yml` 存在） | **12/12** 目录健康；合成后 `id: agent-presets` **恰好一行**且 `rows[0].config.roots` 含该项、`trust: system`、`default === "standard"` | patch 语法/浅替换写错（最常见：漏 `default`），或写成了两跳（⇒ 两行） |
| **b. 三条激活路径都能解析到该根** | 走 S3 的 `test-role-preset-roster.mjs`（进程内 `presets.resolve(id)`） | 三种来源解析出的 `source` 正确，roster 来源 `path === ""` | 根没被扫到，或优先级被 project 覆盖（**预期行为**，不算失败，但要断言优先级） |
| **c. 重启后组合仍完整（N7）** | `node scripts/verify-role-identity.mjs --repo . --team .orchestra/team.json` | 三角色全 `IDENTITY_OK` | 恢复路径没走名册，或 blueprint 记录写错 |

**另加一条负例校准**：先故意把 `roots` 里那行注释掉、重启、跑 (c) ⇒ **必须**出现 `IDENTITY_MISSING`（证明 (c) 真的在校对，而不是恒真）。校准完成后恢复。

### 7.4 F16 的内存实测记录（写本章的依据）

**被测引擎是发货的那一份**，不是转述：`dsh-app-boot/lib/index.js` 的 `composeEntries`（已导出，`require` 直接用）与 `applyEntryPatches`（未导出，从模块正文提取后 `new Function` 执行）。探针脚本：`/tmp/f16-order.mjs`、`/tmp/f16-probe.mjs`。

| 探针 | 输入 | 实测输出 | 结论 |
|---|---|---|---|
| **A** | `composeEntries([bundlePatch, profilePatch, [], []])`，bundle = `insert` 一行 `agent-presets`（config `{default:"standard"}`），profile = **单跳** `- id: agent-presets` 带 `default` + `roots` | `[{id:"agent-presets", config:{default:"standard", roots:[{path:"~/.dsh/orchestra/catalog-presets", trust:"system"}]}}]` —— **恰好一行**，config 为覆盖后的值；**0 warning** | ✅ §7.1 的单跳写法**成立** |
| **B** | 同上但**层序对调** `composeEntries([profilePatch, bundlePatch, [], []])` | `[{id:"agent-presets", config:{default:"standard"}}]` —— 覆盖**丢失**，并 warn `patch: entry agent-presets not found` | 层序是承重的：profile 层**必须**在 bundle 层之后。`composeProfile` 的 `allPatches` 正是 `bundlePatches → profile.patches → homePatches → overlays`，所以 (A) 是本部署的真实路径 |
| **C** | 原计划的**两跳**（`insert` 一个 `orchestra-preset-root` group，再往组里 insert `agent-presets`） | `[{id:"agent-presets",…},{id:"orchestra-preset-root",…},{id:"agent-presets", config:{…roots…}}]` —— **两条 `agent-presets` 行** | ❌ 两跳**既无必要也未达目的**：它没有覆盖原行，而是插出第二条同名行。已从 §7.1 删除 |
| **D** | 单跳但**不带 `default`** | `config = {"roots":[…]}` —— `default` 被整个顶掉 | ✅ 浅替换陷阱**已复现**：`config` 是按键浅替换，写了就必须自带 `default` |

---

## 8. 风险与回退（含不可回退清单）

### 8.1 逐步风险与回退

| # | 步骤 | 失败会怎样 | 怎么退 | 可回退？ |
|---|---|---|---|---|
| R-01 | §7 patch 写法 | patch 未匹配 ⇒ **静默跳过**（`dsh-app-boot` 只 warn `patch: entry %C not found`）；名册少一个根 ⇒ S3 与 N7 全失败，但**没有明显报错** | 用 §7.3-a 的模拟脚本先离线验证；回退 = 把文件恢复成 `[]` 并重启 | ✅ 完全可回退 |
| R-02 | **单跳的层序风险**（取代原"找不到两跳写法"） | §7.4 探针 B 已证明：单跳覆盖成立的前提是 **profile 层在 bundle 层之后应用**。若 DSH 改了 `allPatches` 的层序，单跳退化为"warn `entry not found` + 静默不生效"——**N7 会失败，但 S3 的单元测试不会** | §7.3-a 的脚本**必须**直接调宿主 `composeEntries`（不是自己模拟一份顺序）⇒ 层序一变它立刻红。回退 = 改 `~/.dsh/profiles/*/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:481` 的 `config`（**会被下次升级覆盖**，故必须写进 `DSH-INTEGRATION.md`） | ⚠️ 可回退，但退法易被升级冲掉 |
| R-03 | S1 统一建会话路径 | 三条路径合并后某一类角色的行为变了（预设/权限/模型任一） | S1 单独一个 commit；出问题 `git revert` 该 commit。**注意**：S1 之后 `session-blueprint.ts` 的两个 `prepare*` 被删，revert 会把 D2 的"公共段上提"一起退掉 ⇒ 所以 **S1 的 commit 里不含 D2 的改动**（顺序纪律） | ✅ |
| R-04 | S2 换 `sessionController` | web 与 dev 都含 `dsh-web-app`，所以两个实例都有该服务；**但测试环境（`npm test`，无 profile）没有** ⇒ 测试会因为服务缺失而失败 | 在 `a2a.ts` 里把 `sessionController` 设为**可选依赖**：存在 ⇒ 走原生；不存在 ⇒ **类型化失败** `session_controller_unavailable`（**不回退到自建**，否则 S2 变成死代码）。测试用 fake ctx 提供该服务 | ✅ |
| R-05 | S2 的 `deliverMessage` 保留边界 | 若把"消息生命周期"也一起换成原生的，会丢掉 receipt（插件独有价值） | 明确边界写进代码注释与测试（`receipt-store` 用例不回归） | ✅ |
| R-06 | S3 名册解析 | 若名册解析出的 id 与 team.json 里记的 id 不一致 ⇒ 报错。实测 12 个目录的 id 与 `rolePresetSpec` 派生 id 一致（9 个 v0.4 id 一一对应 + 3 个 legacy id）（`orchestra-v04-*-v1` 目录名 == id），但**必须在 S3 测试里断言** | 断言失败 ⇒ 以名册 id 为准，同步 `rolePresetSpec` 与 `team.json`；**不做兼容映射**（Owner：不留兼容残留） | ✅ |
| R-07 | S4 `turn-stopping` 的 `steer` | 若 `steer` 在回合关闭边界不生效，停摆兜底退回"什么都不做"（比 `running→idle` 更差） | S4 测试里断言 `steer` 被调用**且回合确实多走了一步**（不是只断言调用）；不成立则保留 `turn-stopping` 的**事件记账**部分（至少比事后推断第一手），并把"续一步"标 `degraded` 进体检报告①节 | ✅（降级可回退） |
| R-08 | P1 用 `ctx.shell` | **`@deepseek-ai/dsh-shell`**（要声明的那个包）进了 `dependencies` ⇒ **DSH 双实例 → 所有工具调用崩溃**（`AGENTS.md` 硬规则 1） | **只进 `devDependencies` + `peerDependencies`**，`files` 白名单不动（`lib/` 本来就打包）。打包后核 profile `node_modules` **无 `@deepseek-ai` 实体副本**（只允许 `*.dup-bak`） | ✅（但踩了就是全崩，属高严重度） |
| R-09 | P2-5 `update-ref` 崩溃幂等 | 幂等恢复写错 ⇒ **重复合并**，ref 二次前进 ⇒ 账实不符 | 这一项的测试必须包含 §4.2 步骤 5-7 的崩溃注入，且断言 `reflog` 只前进一步 | ⚠️ **半可回退**：ref 已前进后只能精确 revert 或新建修复节点（契约 A4），**不得回改历史** |
| R-10 | P2-6 豁免集写入 `.git/info/exclude` | 改的是**用户的仓库**而不是插件状态区 | 写入前先读、只追加不覆盖；把"改过 `.git/info/exclude`"写进对账报告首行；回退 = 从记录里移除该插件追加的行 | ✅ |
| R-11 | P3-4 胶囊生成时机 | 若胶囊只在 `turn-stopping` 生成，那么"会话被杀"时可能没有胶囊 | N6 的用例 1 必须构造"被杀前已有一次成功生成"；被杀后只在已有胶囊上盖 `incomplete`；**若完全没有胶囊**，`verify-capsule-resume.mjs` 报 `resumable=no`（这是诚实结果，不是 bug） | ✅ |
| R-12 | P4-4 文档同步 | 把未实现的写成"已" | `scripts/check-docs-status.mjs` 做机械检查（§2.1） | ✅ |
| R-13 | 分批交付 | 两次交付之间 `lib/` 与 `docs/` 可能不一致 | 每次交付的最后一步固定跑 §11 的闸 + `check-docs-status.mjs` | ✅ |
| R-14 | 4599 重启 | 用户自己的实例要重启才生效 | **不主动重启**；在 §7.2 写明"验收 N7 之前要用户在场" | ✅ |

### 8.2 不可回退清单（写清楚，不许事后"再改改"）

| 动作 | 为什么不可回退 |
|---|---|
| **集成分支 ref 已前进后的合并** | 契约"合并后不可回卷"：`merged` / `merged_but_failed` 是**终态**。只能精确 revert 或新建修复节点。**不得回改历史、不得把原节点改回进行中** |
| **已冻结的候选记录** | 冻结是"候选身份"的事实；工作区改字改不掉它（§1.3）。记录不可改写（`alignment-2026-09-20-next-round.md` §7.1-2） |
| **已落盘的证据文件** | A2 要求"不可变落盘"。新证据写新文件，不改旧文件 |
| **已归档的 team 快照** | `orchestra-archive.ts` 的不可变语义；`orchestra_activate` 是**新建**活跃态，不修改档案 |
| **已发出的托管角色会话的 preset 选择** | `agent-presets` 的 `agent-preset/selected` 是**追加事件**；旧回合的记录不能被重写 |
| **`.git/info/exclude` 之外的仓库内容** | 插件不改用户的 git 配置以外的东西；任何对用户仓库的写入都必须能列出"我们写了哪几行" |

---

## 9. agent 侧预算

**目标**（brief §2 第 9 项 / `docs/alignment-0.5-position.md` §6）：**每节点新增 2–3 次工具调用**，超出部分必须说明"为什么不能由宿主承担"。

**总原则（决定预算能不能守住的那一条）**：**能由宿主机械推导的，不给 agent 加动作**。本计划的所有"判定"都落在宿主侧（`ctx.shell`、git、文件记录），agent 侧只增加**输入**。

### 9.1 逐节点预算表（**F23 重算**）

**重算的起因（F23）**：强制摄入的时机**从 freeze 移回「准备阶段 prepared」**（F19）⇒ 原来那句"处置搭在 freeze 上 ⇒ 0 次新增"**不成立**。下面是逐项重算的算式。

| 时点 | agent 动作 | 次数 | 宿主承担的部分（不给 agent） |
|---|---|---|---|
| **prepared（准备）** | `orchestra_defect_disposition`（每缺陷一行处置） | **1** | 相关缺陷候选的计算（写面 / 事实 / 权威引用重叠）、`matchedBy[]` 落盘、R-4 谓词、**"相关缺陷集 + 每条处置"写进候选身份的决策快照** |
| **freeze（冻结候选）** | `orchestra_node_freeze`（参数：nodeId + **验收清单提案**（含 `command`/`env`/`inputs[]`）+ 声明写入面） | **1** | 树身份（`rev-parse`）、快照 worktree（`worktree add --detach`）、**`inputs[]` 的 sha256 计算**（宿主算，不采信角色给的哈希；F18 还负责每次执行前重算）、租约准入检查、节点记录与 `frozen.json` 写入（**插件是记录作者**，F7） |
| **交付验收** | 无 | **0** | 命令查表、快照执行、cwd/env 采集、输入哈希重算、外呼观测、证据落盘、基线差集、`verdict` 判定 |
| **请 driver 裁定**（**仅当确有请示**） | `orchestra_decision_open`（question + default + deadline + blocks） | **0 或 1** | `deadlineAt` 持久化、到期扫描、`default` 越权校验、`blocks[]` 对冻结/合并的硬拦 |
| **收工 / 交接** | `orchestra_capsule_submit`（**只填 required 三项**：nextStep / knownFailures / doNotRepeat） | **1** | 机械字段（commit/tree/dirty/进程/端口/租约/证据指针）由胶囊生成器从节点记录与 git 推导 |
| **合计（交付型节点）** | —— | **3（无请示）/ 4（有请示）** | —— |

**最终数字（F23 的答案）**：**典型 3 次，上界 4 次**。

- **为什么是 3 而不是 2**：摄入回到 prepared 之后，`defect_disposition` 与 `node_freeze` 是**两个不同时点**的动作（前者影响"怎么动手"，后者在动手之后申报候选），无法再合并成一次调用。若强行合并到 freeze，就又违反 F19。
- **为什么典型是 3 而不是 4**：`decision_open` 只在**确有请示**的节点上出现。E2 的三类去向里"技术分叉 → oracle"走**既有** `a2a_send`（不新增动作），"范围/依赖/资源 → driver"走**既有** `orchestra_send`。所以多数节点的这一格是 **0**。
- **与 2–3 目标的差距**：**上界 4 超出 1 次**，已按 brief §2 第 9 项要求说明"为什么不能由宿主承担"（§9.3）。这不是新增机制，是 **F19 的直接后果**：把摄入放回它该在的时点，代价就是它必须有自己的承载动作。**若计划门认为 4 不可接受**，唯一不违反 F19 的替代是"让 driver 在写任务卡时一并携带摄入处置"——但任务卡是 **driver** 的动作，**被摄入的是执行节点**，两者不是同一个会话，所以这条替代**不成立**。
- **查询型节点（档 0）**：**0 次**——整个交付层关闭（§1.2 档 0 机械谓词），不产生节点记录、不产生候选、也不摄入。

### 9.2 为什么不能再压到 2 次（**F23 同步后**）

原来的论证（"`decision_open` 只在确有请示时出现 ⇒ 典型 2 次"）在 F19 之后**不再成立**：prepared 的摄入是**每个交付节点都要付**的固定成本，不能再靠"多数节点不请示"压回 2。

现在的论证变成两句：

1. **`decision_open` 仍然只在确有请示时出现**（三轮裁决未变），所以 3 与 4 之间的差别仍然真实存在；**把它机械推导掉等于替 agent 断言"你没有问题"**，那是 §0 约束三（严格压在宿主能重算的地方）之外的东西——**这一条保留**。
2. **prepared 的摄入不能被宿主推导掉**：R-4 的谓词（`relevantDefects.length > 0 ∧ dispositions.length < relevantDefects.length ⇒ 拒`）确实在宿主侧可判，但**逐条处置的内容**（认可 / 不适用并说明 / 本节点解决）是判断，且 `alignment-0.5-position.md` B2 明确"允许一句话理由，**不要求论证**"——它**不是**可推导的字段。所以这一格是 1 次，不是 0 次。

**合计**：典型 **3**（摄入 + 冻结 + 胶囊），上界 **4**（+ 请示）。

**F10：另有两处必须计入的动作（原来漏了）**

| 时点 | agent 动作 | 次数 | 为什么必须计入 / 为什么这已经是最低 |
|---|---|---|---|
| **独立审查（review 节点）** | `orchestra_report`（写审查记录：判定 + `reviewedCandidateId` + `inputs[]` 声明是否正确的意见） | **新增 0 / 合计 1** | **这个动作已经存在**（`orchestra.ts:4780` 注册的 `orchestra_report` 就是角色的交付通道）。本计划只是**给它加了必填字段**（`reviewedCandidateId` + 对 `inputs[]` 声明的意见，F20②），**不新增工具、不新增调用**。所以它对预算的边际贡献是 0，但**它确实是一次工具调用**——见下方「两个口径」 |
| **合并门触发** | **无 agent 动作** | **0** | 合并门由**插件**在"候选已冻结 + 审查 PASS 已记录 + 试证据齐备"时判定，**调用者是既有工具**（`orchestra_create/activate` 那条受治理路径上的门，或 driver 的既有提交动作）。**不新增工具**，因此不计入 agent 预算 |

**H-5：两个口径必须分开写，不得混用**

| 口径 | 定义 | 用途 |
|---|---|---|
| **新增（new）** | 相对**基线 `6bd8d9b` 的行为**，本计划**额外增加**的 agent 侧动作数 | 判据 9 的"不增厚"**按这个口径**衡量 |
| **合计（total）** | 该节点这次运行**一共发生**的 agent 侧动作数（含**基线就已有**的动作） | 用于核对"没有偷偷多打一次"，以及 `verify-agent-budget.mjs` 的逐节点统计 |

**按节点类型汇总（F23 的最终口径，两个数字都给）**：

| 节点类型 | 新增（new） | 合计（total） | 明细 |
|---|---|---|---|
| **交付型（实现者）** | **3**（无请示）/ **4**（有请示） | **3** / **4** | 摄入 1 + 冻结 1 + 胶囊 1 (+ 真实请示 1)；**这三/四次全部是新增** |
| **审查型（reviewer）** | **0** | **1** | 合计的那 1 次是**基线已有**的 `orchestra_report`（只加必填字段，不加调用） |
| **driver** | **0** | **0 新增动作** | 任务卡、派发、合并触发都走既有工具 |
| **档 0（查询型）** | **0** | **0** | 交付层整体关闭 |

**因此 §11 的 G-BUDGET 必须分开断言**（原写法只有 `expect<=4`，**判不出"审查型 0 新增"**——审查型合计 1 ≤ 4 会恒真通过）：
```
delivery.new   <= 3      # 典型；确有真实请示时允许 4
delivery.new   == delivery.total
review.new     == 0      # H-5 的硬断言：不受 delivery 的上界影响
review.total   == 1
driver.new     == 0
tier0.total    == 0
```

**为什么必须分开**：原来的单一判据 `expect<=4` 对"审查型合计 1"**恒真通过**——`1 <= 4`，所以它**永远判不出**"审查型 0 新增"这条真正要守的线。`review.new == 0` 是唯一能判它的断言。

### 9.3 为什么这些动作不能由宿主承担

| 动作 | 为什么必须在 agent 侧 |
|---|---|
| `freeze` | 验收清单是**意图**（"什么算做完"），契约 §0 约束二：会话写意图，插件写事实。宿主无法生成意图 |
| `decision_open` | `question` / `default` 是意图；宿主无法知道"这个分叉该不该问人" |
| `capsule_submit` | 三个 required 字段是契约明确列的"**机器推不出来**"的项（§3-P3 原文） |
| `defect_disposition` | 处置决定（认可 / 不适用并说明 / 本节点解决）是判断（`alignment-0.5-position.md` B2：允许一句话理由，不要求论证）。**它有自己的 1 次调用**（F19 把它放回 prepared；**不能再搭在 freeze 上**，见 §9.1 的算式） |

### 9.4 `ratio{plan, implement, verify}` 的记录方式

- **单位**：**轮次**（轮次为准，token 可选——契约 §3 记账要求原文）。一轮 = 一次 assistant 回合（不是一次工具调用）。
- **口径**：`plan` = 产生/修改验收清单与决策的回合；`implement` = 产生候选 commit 的回合；`verify` = 复核他人的候选的回合（含独立审查与合并后检查）。
- **谁来写**：**插件写**。数据来源是宿主持有的会话事件流（`turn/start` / `turn/end` + 工具调用序列），按 `sessionId → nodeId` 归集。**不让角色自报**（自我记账可被做漂亮——这正是 §1.8 要防的）。
- **每个节点**：`ratio` 落在节点记录里；**按根任务归集的实际成本**（含失败、取消、返工）落在体检报告④节。
- **默认职责**：`ratio` **只作报警**（§1.8）。删除机制走每周复查三条判据，**不由比率直接决定**。
- **报警线**（可判定，写进 `weekly-review`）：`plan + verify > implement` 连续两窗 ⇒ 报警；同时写入"本周机制复查结论"，**"本周无候选"也必须是一条结论**；"比率连续两窗报警 + 复查连续 N 周无候选" ⇒ **独立告警**。

---

## 10. 需求可追溯（A–F + 元规则 + 不做清单）

**规则**：指不到落地动作的，必须显式标注"延后/不做 + 理由"。

### 10.1 A 组（仓库交付门）

| # | 落地动作 | 阶段 |
|---|---|---|
| A1 候选身份绑定 | `src/candidate.ts` + 节点记录 `candidate` + 冻结清单 `src/frozen-manifest.ts`；N1（§4.1） | P2 |
| A2 由系统执行验收 | `src/evidence-runner.ts` + `src/evidence-store.ts` + `src/runtime-preconditions.ts`；从**冻结快照**执行（§4.3 的六个变体） | P1 |
| A3 合并门 + CAS | `src/merge-gate.ts`：`merge-tree` 预演 → `rev-parse HEAD^{tree}` 比对 → `update-ref <ref> <new> <expected-old>` → 崩溃幂等；N2（§4.2） | P2 |
| A4 合并后失败不可回卷 | 节点状态机 + `terminal_state_immutable`；账实不符进立即阻断清单；N4（§4.4） | P2 |
| A5 worktree 隔离与单一写者 | `src/delivery-worktree.ts` + `src/write-lease.ts` + `src/reconciliation.ts` + `src/exemptions.ts`；N5（§4.5） | P2 |
| A6 证据复用判据 | `src/candidate.ts` 的 `reuseScope` **八项闭集（下界）**；**R-2 已收窄 + F2 补齐模式/外呼 + F22 写明下界非上界**；复用须标 `reuseBasis`/`completeness` 并计入 §1.9⑤（F20③）；历史外呼读数不得证明本次真链 | P2 |
| A7 失败对比粒度 | `src/baseline.ts` 差集 + R-3 两档（解析不出 ⇒ `unqualified`） | P1 |

### 10.2 B 组（架构守卫）

| # | 落地动作 | 阶段 |
|---|---|---|
| B1 活跃缺陷登记 | `src/defect-registry.ts`（上限 + 剪枝 + `registry_over_cap`） | P3 |
| B2 强制摄入 | `src/defect-intake.ts` + R-4 的机械谓词（`relevantDefects>0 ∧ dispositions<relevant` ⇒ 拒绝；为空不拒） | P3 |
| B3 所有权与事务声明 | ①第二活跃写者 ⇒ **硬拒**（复用 P2-1 租约，N5）②`canonical owner` 未定 ⇒ **只登记**、close 时作 residual | P3 |

### 10.3 C 组（上下文卫生）

| # | 落地动作 | 阶段 |
|---|---|---|
| C1 交接胶囊 | `src/capsule.ts`（骨架机械生成；required 只留三项；缺 ⇒ `incomplete` 不阻塞） | P3 |
| C2 可独立续做 | `scripts/verify-capsule-resume.mjs`（只读胶囊 + 节点记录 + git；不读会话日志） | P3 |
| C3 上下文可观察 | P4-1：**先查 DSH 有无现成**；无 ⇒ 自建并写明代价。纯观测，**无配额、不强制轮换** | P4 |
| C4 消息不承载事实 | `src/a2a.ts` 消息构造只带指针 + 原因码；`test-pointer-messages.mjs` 断言判据不在消息里 | P3 |

### 10.4 D 组（强制力收口，**修复，不得回归**）

| # | 落地动作 | 阶段 |
|---|---|---|
| D1 重启后角色变空壳 | S1 + S3 + §7 + `scripts/verify-role-identity.mjs`；N7（§4.7） | P0 |
| D2 回合永不结束 | D2 收口（`approval: never` 钉到所有路径）+ S4（`turn-stopping` + `approval/asked` 看门狗）；§4.8 三条断言 + 需求 §3.3-2 | P0 |
| D3 归档停不干净 | 归档事务重排为 cancel → notify → 快照 → marker；重入幂等 | P0 |
| D4 工具闭包层测试 | `scripts/test-tool-schemas.mjs` 扩成全工具闭包扫描 | P0 |

### 10.5 E 组（权限与请示）

| # | 落地动作 | 阶段 |
|---|---|---|
| E1 权限预分配、提权不挂起 | 派发期钉 `permissionPreset`（现状）+ 运行期 `approval: never`（D2 收口）；确定性拒绝 + 留痕；**不保证模型不会尝试**（`capability-boundaries.md` #1） | P0 |
| E2 三类请示各有去向 | `src/decision-queue.ts`，**唯一机械强制** = `blocks[]` 里的节点不得冻结/合并，其余继续跑 | P0 |
| E3 带默认值的请示 | §1.5 五条：①`default` 落既有授权内（`default_outside_authority`）②可撤销 + 成本上限③`default_applied_then_overridden`④不可重复动作结果未知 ⇒ **停**（阻断）+ **人节点留痕解除**⑤`deadline` **宿主持久化 + 到期唤醒** | P0 |
| E4 默认档 = 工作区修改 | **已是现状**（`danger-full-access` 从不合法）；只加回归断言 | P0 |
| F1′ 设计门独立会话 | `src/gate-record.ts`：`gate_not_run ≠ satisfied`；未物化角色不得记为已参与；有第二模型 ⇒ `satisfied`，否则 `degraded` 且进报告①节；记录双方 session id + model id；**不得声称"换会话 = 换模型"** | P2 |

### 10.6 元规则、三条约束、不做清单

| 项 | 落地动作 |
|---|---|
| **元规则一**（一条机制一个已付过成本的故障） | 节点记录带 `faultRefs[]`；**每个新机制在 PR/工作项里指名故障**（P 编号见 `2026-09-20-repo-delivery-requirements.md` §8）：`src/evidence-*` → **P7**（测错树）/ **P16**（环境前提静默失效）/ **P9**（既有红无稳定基线）；`src/baseline.ts` → **P8**（只比失败名字，不比位置/类型）**+** 契约 A7 行（F11）；`src/candidate.ts` → **P15**（返修无上界、判据事后才出现）**+** 契约 A1 行（F11）；`src/merge-gate*` → **P5**（守卫在事务外）/ **P13**（每次合并要会签 + 全局冻结）；`src/write-lease*` → **P4**（规则只写在 prompt 里）/ **P12**（稀缺资源靠人仲裁排队）；`src/capsule*` → **P1**（状态只住在会话里）/ **P17**（交接漏列既有红）；`src/node-record*` → **P1** / **P3**（每个状态变更提交一次）；`src/decision-queue*` → **P6**（无人能答的审批 ⇒ 回合永不结束）；`src/defect-*` → **P20**（开工时带着未决问题）。**指不出的不做** |
| **元规则二**（成本比率只报警） | P4-2 `weekly-review` 三条判据 + 留痕 + "报警无动作"独立告警；§9.4 的口径 |
| **§0 约束一**（门只在插件拥有的动作上） | 每个门在代码里标注 `HARD`（准入/记账/验收执行/git/合并/归档）或 `NAMED`（事后点名）；**唯一例外**：越界触及他人活跃租约（§4.5） |
| **§0 约束二**（事实只由插件写） | §6 的字段表区分事实字段与解释字段；`test-*` 里断言"角色写的字段不参与 `verdict` 计算" |
| **§0 约束三**（严格压在宿主能重算处） | P1/P2 的全部判定都在宿主侧；需要再跑一轮会话的（"这次改动是否影响那个结论"）⇒ 宽和 + 留痕 + 交给人 |
| **不做：开工前完备度闸** | 验收清单冻结点是**申报候选之前**（§4.1 步骤 2），不是开工前。代码里**不存在**"开工前必须有验收清单"的校验 |
| **不做：词汇闸** | 无"新词许可"校验；新概念只登记不阻断 |
| **不做：整批拒的原子收工** | 门只判节点**声明过的**写入面；范围外降级为告警 + 点名（§4.4 步骤 4 的形态） |
| **不做：自己遍历文件算树** | 只用 git 自己的输出（`status --porcelain` / `rev-parse` / `merge-tree` / `update-ref`）；`test-reconciliation.mjs` 里加 grep 断言：`src/` 下不存在 `readdir` 遍历工作区的实现 |
| **不做：用 `index.lock` 判写者** | `test-write-lease.mjs` 的 grep 断言 |
| **不做：因未跟踪文件整批拒** | 未跟踪文件只在**参与验收**时才通过 `inputs[]`（`source:"non-git"`）绑定；不作为整批拒的理由 |
| **不做：普遍细化到子树** | 复用粒度默认整树（R-1）；只对声明了 `inputs[]` 的验收开放细粒度 |
| **不做：自建依赖分析器** | 代码里不存在；R-1 的收窄就是它的替代 |
| **不做：沙箱实现 / CI 集成 / 并发调度 / 环境 profile 完整建模 / token 配额 / UI** | 一律不做（契约 §3-P1 不做清单 + 需求 §4.2/§4.3） |
| **不做：进程取证式身份** | D1 的身份 = 会话 id + 组合标记 + 插件签发记录 |
| **不做：整批"同问题问五遍"** | 只在低频高影响的判断上可选，本计划不启用 |

### 10.7 延后项（显式标注，不是漏掉）

| 项 | 为什么延后 |
|---|---|
| 通过名册**写**预设（用户自建角色的写入路径） | `trust: system` 的根不被视为可写根（B-3）。Owner 已定 B 方案，写入路径不在本版范围 |
| `difficulty-reviewer` 那类"异质模型"审查 | `capability-boundaries.md` #3：本部署没有第二个可用模型时记 `degraded`。机制已就位（F1′），能力本身不在本版 |
| 环境 profile 完整建模 | 契约 §3-P1 明列"不做"。R-2 的收窄是它的替代 |
| 代理封堵外呼（best-effort） | 契约 §1 已允许"尽力而为"，但**不得当强制证明**。本计划不实现，只在证据里留 `external.observation` 字段供将来接入 |

---

## 11. 阶段退出闸汇总

**闸点名的脚本清单（显式枚举）**——H-6 的教训是"单一数字"本身不可靠：简写（`verify-negative-N1/N2/N4/N5.mjs` 这种斜杠组）与自校准模式（`--self-test`）会让"到底点名了几个"各算各的（门数到 17、我数到 16，**两个数都源自对同一批歧义 token 的不同数法**）。所以这里**逐列枚举，用文件数为准**：

| 闸 | 脚本文件（逐个列出） | `node` 命令数 |
|---|---|---|
| **G-P0** | `verify-role-identity.mjs`（+ `--self-test`）· `verify-d2-approval.mjs`（+ `--self-test`）· `verify-d2-decision.mjs` · `verify-role-presets-roster.mjs` · `test-orchestra-archive.mjs` · `test-tool-schemas.mjs` · `test-decision-queue.mjs` · `test-design-gate.mjs` · `test-orchestra-role-presets.mjs` | 11（9 个文件 + 2 个校准模式） |
| **G-P1** | `verify-negative-N3.mjs` · `test-baseline-diff.mjs` · `test-frozen-snapshot.mjs` | 3 |
| **G-P2** | `verify-delivery-e2e.mjs` · `verify-negative-N1.mjs` · `verify-negative-N2.mjs` · `verify-negative-N4.mjs` · `verify-negative-N5.mjs` · `test-merge-cas.mjs` | 6 |
| **G-P3** | `verify-negative-N6.mjs` · `verify-capsule-resume.mjs` · `test-defect-intake.mjs` · `test-ownership-declaration.mjs` | 4 |
| **G-P4** | `verify-health-report.mjs` · `test-weekly-review.mjs` · `check-docs-status.mjs` | 3 |
| **G-BUDGET** | `verify-agent-budget.mjs` | 1 |
| **合计** | **26 个脚本文件**（去重后：上表 20 个具名文件 + `verify-negative-N1/N2/N3/N4/N5/N6` 共 6 个） | **28** |

**说明**：上表是"闸**点名**的脚本"。§5.1 的交付清单更长（还包含 P1–P3 其余工作项的退出判据脚本，它们由各自工作项的退出判据约束，不由阶段闸点名）。**26 个点名脚本 100% 在 §5.1 清单里**（用跨全文收集 → 与 §5.1 求差集的方式机械核对，差集为空）。


**每个闸都必须机器可判**（brief §3 第 3 条）。括号里是判定命令。

| 闸 | 退出判据 | 判定命令 |
|---|---|---|
| **G-S（减法）** | `npm run typecheck` 0；`npm test` 全绿且**既有 248 项不回归**；S1–S6 的六个新/改测试全绿；（N7 在 G-P0 判） | `npm run typecheck && npm test` |
| **G-P0（事实层）** | ①`verify-role-identity.mjs` 退出 0（= N7）②`verify-role-identity.mjs --self-test` 退出 **1**（校准通过；**同一脚本的校准模式，不另计一个脚本**）③`verify-d2-approval.mjs` 退出 0 且 `hanging 0 dangling 0`（D2-a + D2-c），其 `--self-test` 退出 **1**（校准通过；**同一脚本的校准模式**）④`verify-d2-decision.mjs` 退出 0（D2-b 六用例）⑤`verify-role-presets-roster.mjs` 退出 0（§7.3-a，名册真认这个根）⑥`test-orchestra-archive.mjs` 扩展用例全绿（D3）⑦`test-tool-schemas.mjs` 全工具覆盖（D4）⑧E2/E3/E4/F1′ 的测试全绿 | 上述脚本逐个；**任一非 0 即不进 P1** |
| **G-P1（证据层）** | ①`verify-negative-N3.mjs` 退出 0（六个变体全被按期望判）②`test-baseline-diff.mjs` 的人工对账样例一致③`test-frozen-snapshot.mjs` 的"未跟踪夹具不会让证据冒充输入绑定"用例通过 | 三个脚本 |
| **G-P2（交付层）** | ①`verify-delivery-e2e.mjs` 退出 0 且 `human_interventions=0`（§3.1）②`verify-negative-N1.mjs` / `verify-negative-N2.mjs` / `verify-negative-N4.mjs` / `verify-negative-N5.mjs` **逐个**退出 0（不为缩写单列一行） ③`test-merge-cas.mjs` 的崩溃幂等用例通过（`reflog` 只前进一次）④§1.7 的两项早期信号可被观测（体检报告⑤节的 `unknownPreconditionPasses` 与 `crossBoundaryCount` 字段有值） | 六个脚本 |
| **G-P3（治理层）** | ①`verify-negative-N6.mjs` + `verify-capsule-resume.mjs` 退出 0 ②`test-defect-intake.mjs` 的 R-4 谓词两向用例通过（非空未表态 ⇒ 拒；为空 ⇒ 过）③`test-ownership-declaration.mjs` 断言②**不阻断开工** | 三个脚本 |
| **G-P4（收尾）** | ①`verify-health-report.mjs` 退出 0（五节 + ①⑤分列 + 立即阻断清单）②`test-weekly-review.mjs` 的"无候选也留痕"与"报警无动作告警"用例通过③`check-docs-status.mjs` 退出 0 | 三个脚本 |
| **G-BUDGET（随 G-P0 一起核，F23 / H-5）** | **两个口径分开判**（字段名与脚本输出一致，见 §9.1）：`delivery.new ≤ 3`（典型）/ `≤ 4`（**仅确有真实请示**，门第 2 轮裁定已接受）且 `delivery.new == delivery.total`；**`review.new == 0`**（硬断言）；`review.total == 1`；`driver.new == 0`；`tier0.total == 0`。计数来源是宿主持有的会话事件流（按 `sessionId → nodeId` 归集），**不采信角色自报**（§9.4） | `scripts/verify-agent-budget.mjs`（读会话事件流 + 节点记录；末行 `# nodes N delivery_new_max <n> delivery_over 0 review_new 0 review_total_ok yes`）。**只写 `expect<=4` 判不出"0 新增"**，所以逐项分开断言 |
| **G-RELEASE（bump 0.8.0）** | 契约 §7 三条同时成立：N1–N7 全部按期望被拒绝/被处理 **+** §3.1 端到端无人介入跑通 **+** §1.9 五节 + 立即阻断清单有效。外加 `AGENTS.md` 硬规则 2/3 的两步 | `npm pack --cache /tmp/dsh-npm-cache` → 按 `DSH-INTEGRATION.md`「更新流程」同步 profile → 核 profile 无 `@deepseek-ai` 实体副本 + `require.resolve` 从 lib 视角指向 host 路径 + health 200 → **新会话**实测 |
| **G-CLIENT（条件闸）** | 若本轮**确有** client 改动：必须真开浏览器验证（`ego-browser` 打开 `http://127.0.0.1:4600/?token=…`），`tsc` 全绿不算数 | `AGENTS.md` 硬规则 3。**本计划不含 client 改动**，若执行期新增了 client 改动则该闸启用 |

---

## 附：本文与契约的偏离一览（便于计划门逐条核）

| 偏离 | 类型 | 位置 | 是否改口径 |
|---|---|---|---|
| §7 部署改为 profile patch 层的**单跳 override**（`- id: agent-presets` + `config` 自带 `default`） | **实现落点** | §0.2-B-2 / §7.1 / §7.4 | 否。契约 §1.1 的四个实质要求全部保留。**内存实测**：单跳 ⇒ 恰好一行、0 warning；两跳 ⇒ 两条同名行（§7.4 探针 C），**已不采用** |
| R-1 证据复用的"无法证明不受影响"退化为默认整树 | **退回 + 降级** | §0.3 | 否。§1.4 本来就以整树为默认；这里只是**拒绝**在没有 `inputs[]` 时假装能算交集 |
| R-2 复用判据收窄为**八项**闭集（原写五项，F2 补 `mode` + `externalDeclaration`，F21 补 `inputsDigest`），并写明"下界非上界"（F22） | **退回 + 降级** | §0.3 | 否。`capability-boundaries.md` #6 已限定保证范围 |
| R-3 失败位置/类型改为"解析不出即 `unqualified`" | **退回（收窄）** | §0.3 | 否。契约 §1.4 与 A7 已写"给不出可解析输出 → `unqualified`" |
| R-4 "不允许空列表通过"改为机械谓词 | **退回（收窄）** | §0.3 | 否。空候选集不拒，是让判据可判定 |
| 体检报告落点定为 `orchestra/health/<window-id>.json` | **补落点**（契约只定"必须有五节"，未定载体） | §6 | 否。补的是载体，不是内容 |
| 新增**四个** agent 工具（`orchestra_defect_disposition` / `orchestra_node_freeze` / `orchestra_decision_open` / `orchestra_capsule_submit`） | **补工具面**（契约未定工具名） | §9.1 | 否。契约定能力，工具名是实现细节。**F10 更正**：原写"五个"但只点名三个，且把后来被并入 freeze 的 `orchestra_defect_disposition` 同时列成独立工具——**现在是四个**，与 §9.1 的表逐行对应（`defect_disposition` 因 F19 回到独立动作，**是**独立工具） |

**本文不新增任何契约之外的机制**。§9.1 的工具是 §1–§3 已有能力的入口；若计划门认为某个工具本身构成"新机制"，它对应的 `fault_ref` 已在 §10.6 的映射表里给出。
