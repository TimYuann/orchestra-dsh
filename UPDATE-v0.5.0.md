# UPDATE-v0.5.0 · orchestra-dsh v0.5.0 发布说明与外部验收入口

> 发布日：2026-09-16 · 版本 `0.5.0` · 依赖基线 DSH `0.1.5-rc.2`
> **npm 上的上一版本是 `0.3.0`**：`0.4.0` / `0.4.1` 从未发布到 npm（只有 GitHub tag）。因此 `0.5.0` 是 npm 用户从 `0.3.0` 直接跨到的版本，本文 §1 的累计变化对他们是全部变化。
> 本文档面向**外部验收者**：只写本仓库能证明的事，跑不动的一律进 §4 诚实清单。

---

## 1. 版本与能力变化

### 1.1 相对 npm 用户（0.3.0 → 0.5.0）能看到的能力

| 能力 | 状态 |
|---|---|
| A2A 跨会话传输（`a2a_send` / `a2a_reply` / `a2a_read` / `a2a_create`） | 0.3.0 已有，0.5.0 大幅增强 |
| `a2a_stop`（真实 `agent.cancel(cause, { keepInbox: false })`，等价 Composer 的 Stop） | **新增** |
| `a2a_list` 按当前 CWD / 最近活跃降序、`query` 关键词筛选、`role` + 相对活跃时间 | **新增** |
| `a2a_read` 倒序渐进披露（默认最近 1~2 轮，按需扩大窗口） | **新增** |
| `orchestra_dispatch`（按需派发；角色 Session 不存在则顺手创建并登记） | **新增** |
| `orchestra_wait`（静默等待团队落盘变更；默认 20 分钟心跳超时） | **新增** |
| `orchestra_draft` + 用户批准（白话回复即可）+ `orchestra_create`（必须 `frozenRef`） | 0.4.0 引入，0.5.0 简化批准 |
| 五个 v0.4 任务拓扑 + 七个 v0.4 角色预设 | 0.4.0 引入，0.5.0 保留 |
| 设置面板 "orchestra" 页（拓扑目录 + 团队实例） | 已有 |

### 1.2 破坏性变更（本版核心）

**16 个微观状态机工具被彻底拔除**（规格书的 17 项清单还含一条 `orchestra_create` 里"一次性锁死全部 Roster"的臃肿校验，那不是工具）：

```
orchestra_loop_start   orchestra_attempt_start  orchestra_verdict
orchestra_handoff      orchestra_gate_open      orchestra_gate_fallback
orchestra_graph        orchestra_graph_reconcile orchestra_reconcile
orchestra_decision     orchestra_document       orchestra_charters
orchestra_close        orchestra_apply_amendment orchestra_freeze
orchestra_spawn        （以及 draft_revise / draft_retract 两个未发布的草稿命令）
```

- **driver 不再当底层状态机的"打卡员"**：节点之间直接用 `a2a_send` 交接硬事实，前线形成一个上限 2 轮的自洽小闭环，driver 由报告唤醒（`orchestra_wait`）而不是轮询。
- **拓扑里的 `protocol`（`loops` / `gates` / `handoffs` / `closure`）降级为声明式资产**：校验器仍然检查它们（引用真实角色、完成权归属），角色 welcome 仍然携带它们，但 v0.5 运行时**不再**用状态机工具去驱动——这是能力收缩，不是能力隐藏。
- **兼容处理（刻意不 fail loud）**：`REMOVED_ORCHESTRA_TOOLS` 在 provisioning 时会过滤掉用户旧拓扑/预设 `orchestraTools` 里残留的已删工具名，而不是让整个建队失败。用户侧旧拓扑因此**仍可用**，只是这些名字不再有对应工具。
- **控制点没有放松**：`orchestra_create` 依旧要求 `frozenRef`，而只有"用户批准某个 draft revision"才会产出它；`goal` + `topology` 单独调用仍然返回 `approval_required`。

### 1.3 非破坏性变更

- **记录载体迁出会话日志**（ADR-0002）：charter/receipt/blueprint/state/archive 全部落盘到 `<cwd>/orchestra/` 与 `~/.dsh/orchestra/`。原因：自定义 Session 事件类型会让**整个会话日志**在重启后无法加载（DSH 拒绝未知事件类型，而仓库外插件无法把自己的事件标成可忽略）。这条修复让插件碰过的每个会话重新变成原生可回放。
- **批准极简化**（ADR-0006）：用户在对话里回"启动 / 可以 / ok"即被记为该 draft revision 的批准（只有真实用户回合算数）；`/team approve <draftId>@<revision>` 仍可用但不再是必需。
- **新增常驻系统提示段 + `orchestration-principles` skill**：把"怎么拆任务"的原则常驻化，完整文本按需加载。

---

## 2. 安装 / 更新方式

在 DSH profile 目录下（先 `cd ~/.dsh/profiles/<your-profile>`）：

```bash
npm install orchestra-dsh          # 或 pnpm add / yarn add / bun add
```

**安全自检（所有包管理器）**——本插件的 `@deepseek-ai/*` 全部是 `peerDependencies`，由 DSH 宿主提供。若包管理器自己装了一份实体副本，插件会双实例加载并且**所有工具调用崩溃**：

```bash
ls node_modules | grep '^@deepseek-ai'   # 期望无输出（*.dup-bak 遗留文件可以接受）
```

出现实体副本时：删除 `node_modules/@deepseek-ai`，用"禁用 peer 自动安装"的方式重跑安装命令。

随后**重启 DSH**（bundle 行只在 boot 时读取；只有 `cordis.patch.yml` 与 home patch 是热监听的）。

### 从 0.4.x / 0.3.0 升级需要知道的三件事

1. 若你的自定义拓扑把已删的 16 个工具名写进了 `orchestraTools`，它们会被**静默过滤**（不报错）——角色 welcome 里如果还写着这些名字，请自行改成 `a2a_send` / `orchestra_report`。
2. 项目根会多出 `orchestra/`（运行时账本）与可能的 `.orchestra/`（项目级配置）。按需加入 `.gitignore`；本插件不替你决定。
3. 白话回复即可批准计划。若你的使用方式依赖"必须敲 slash 命令才算批准"的仪式感，请显式使用 `/team approve`。

---

## 3. 已运行的本地验证（发布复核本轮真实执行）

| 项 | 命令 / 方式 | 结果 |
|---|---|---|
| 类型检查 + 构建 | `npm run typecheck && npm run build`（host tsc + client tsc + tsdown） | 通过 |
| 单元 / 契约测试 | `npm test`（27 个测试文件） | **222/222 通过，exit 0** |
| 打包产物 | `npm pack --cache /tmp/dsh-npm-cache` | 73 文件 / 289.4 kB；`dependencies` 仅 `js-yaml`；17 个 peer；无 `src/`、无 `scripts/`、无 `@deepseek-ai` 副本；`README.md` / `LICENSE` / `cordis.yml` / `cordis.patch.yml` 均在包内 |
| 工具面实测 | 用假 ctx 加载 `lib/orchestra.js` 收集 `tools.register` 的 name | 实际注册 10 个：`orchestra_activate / create / dismiss / dispatch / draft / report / send / team / topologies / wait`；16 个已删工具**一个都没有**（与 `scripts/test-v05-slimming.mjs` 断言一致） |
| 打包产物二次消费验证 | 解包 tgz 到干净目录（只 symlink 宿主 `@deepseek-ai/*` 与 `js-yaml`）后 `import()` | 从**产物**（不是源码树）加载后注册 17 个工具（7 个 A2A + 10 个 orchestra）；34 个相对 import 全部可解析；无 `.ts` 残留；`lib/client.js` 存在且用 `__ModuleLoader__.load` 协议 |
| 隔离 profile 冷启动（真实 mount） | `~/.dsh/profiles/compat`（bundles 含 `orchestra-dsh`，依赖指向本 tgz）→ `pnpm install` → `dsh --profile compat --dump-config` → 起实例 :4602 | 组合树里三行 `orchestra-bundle` / `orchestra-a2a` / `orchestra-manager` 全部在；boot 页把 `orchestra-dsh/client.js` 列进插件 bundle 清单；该 bundle `HTTP 200`（11 MB 合并产物）且含 `settings.section` 注册；健康检查 401（无 token，符合预期）——验证后已停止该实例 |
| 已删工具零残留 | 全仓库 grep + `test-cp8-notices.mjs` 新增守卫 | 内置拓扑 welcome、角色预设指令、模型可见工具描述中都不再出现已删工具名 |

### 3.1 本轮发布复核修掉的问题（v0.5.0 开发会话遗漏）

| 编号 | 问题 | 影响 | 处置 |
|---|---|---|---|
| P1 | 五个内置任务拓扑的 `welcome` 正文仍要求角色调用已删的 `orchestra_handoff` / `orchestra_verdict`（同一提交只清理了 `orchestraTools` 允许列表，没清理散文） | 角色会去调不存在的工具，白烧一个回合 | 20 处改为 `a2a_send` 直接投递 / 把 PASS-FAIL 写进 `orchestra_report` |
| P2 | `rolePrompt()`（v0.4 角色预设指令）仍写 "use `orchestra_handoff` for typed milestones" | 同上，且这五个拓扑挂的就是这些预设 | 改为 `a2a_send` |
| P3 | 模型可见描述提到已删工具：`orchestra_dismiss` 提 `orchestra_spawn`、`orchestra_topologies` 提 `orchestra_spawn`/"fails closed in 4B"；`orchestra_draft` 声称草稿存在 "Driver Session 的 append-only events"（ADR-0002 已改为文件） | 直接误导 driver 的事实与工具选择 | 全部按实现改写 |
| P4 | `README.md`（随包发布 + GitHub 首页）仍在宣传 `orchestra_spawn` / `orchestra_freeze` / `orchestra_apply_amendment` 与整套 v0.4 graph 工具，路线图还标 0.4.1 未发布 | 用户按 README 调工具必失败 | 工具面按真实注册重写，路线图补 v0.5.0 |
| P1（测试侧） | 测试断言本身把 P1 的陈旧文案写死了（`test-cp8-notices.mjs:205` 要求 welcome 含 `orchestra_handoff`） | 缺陷被测试锁死，改文案会让测试变红 | 断言改为 v0.5 交接纪律（要求 `a2a_send`），并新增"任何内置拓扑 welcome 都不得出现已删工具名"的守卫 |
| P5 | 内部文档口径漂移：`STATE.md` 正文仍写 v0.4.x（而头部写 v0.5.0）；`DSH-INTEGRATION.md` 让 dev 实例跑 4601（ADR-0009 已改 4600）；v0.5 规格书说内部账本在 `.orchestra/`、外部资产进 `docs/receipts/`，实现是运行时状态在 `orchestra/`（只有配置在 `.orchestra/`）；缺 v0.5.0 发布说明 | 下一个接手的 agent 会照着错的口径干活 | 两文档按实况同步（本轮已含 v0.5.0 同步基线），并补本文件；规格书与实现的差异在此记录，不改实现 |

> P1–P3 的共同点：**工具被删了，但教模型使用工具的文本没删**。新增的守卫守卫的是这一整类问题，而不是某一条。

---

## 4. 未运行（诚实清单 —— 以下均未由本次发布复核运行）

1. **v0.5.0 自称的 full-lifecycle E2E（Pixel Craft / Trio 拓扑）没有在本仓库复现**。该演练由开发会话在自己的 workspace（`agentWorkspace`）完成，其产物（`artifacts/web/pixel-craft/`、`orchestra/reports/implementer-*`、`reviewer-*`、`orchestra/archive/*`）**不在本仓库**，本次复核也未找到它们。因此 §3 里没有把它算作可自证证据——它以开发会话的报告为准。
2. **浏览器验证 5 项清单**（`UPDATE-v0.4.0.md` §8：draft 表格卡片、driver 提醒、team graph 摘要行、welcome 纪律句、投递不可达不炸工具）本轮未重跑。
3. **受治理全流程的真实 multi-session E2E 仍需用户本人批准一次**（结构性约束，见 §5）：`/team approve` 与"白话批准"都只认真实用户回合，模型侧没有等价工具。**不要**用浏览器自动化替用户批准——那等于 agent 自我批准，绕开了产品唯一的硬控制点。
4. **headless profile** 未安装 v0.5.0。
5. **4599 的安装尚未生效**：`web` profile 已装好并通过三件套 + 整 profile 冷启动验证（把 web profile 起在 4603，`orchestra-dsh/client.js` 与 `dsh-trinity/client.js` 同时出现在插件清单），但**正在跑的 4599 进程仍是旧组合**——bundle 行只在 boot 时读取，必须重启 `dsh --profile web --port 4599` 才会加载 v0.5.0。重启后请在新会话里跑一次 `orchestra_topologies` / `a2a_list` 完成行为层验收。详见 `DSH-INTEGRATION.md` 的「2026-09-16 v0.5.0 同步基线」。

---

## 5. 外部验收入口（最小可复现）

### 场景 A：轻量 A2A（无需任何批准，可完全自主跑）

1. 新开一个会话，让它开一个协作者：`a2a_create(execution: "session", label: "probe")`；
2. `a2a_list` —— 期望：新会话按活跃度排在当前 CWD 组前面，带 `role` 与 `lastActivity`（如 `just now`）；
3. `a2a_send(sessionId, "回复一句话")` —— 期望：返回 `state=accepted` 的回执（`live_inbox` / `durable_inbox` / `resumed_inbox`），**accepted ≠ processed**；
4. `a2a_status(messageId)` —— 期望：只在有相关 Session 事件时单调推进，否则停在 `unknown`；
5. `a2a_stop(sessionId)` —— 期望：立刻掐断目标正在跑的推理并清空待办；
6. `a2a_read(sessionId)` —— 期望：默认只回最近 1~2 轮，传更大的 `turns` 才展开。

### 场景 B：受治理全流程（**需要用户本人批准一次**）

1. 对 driver 说清目标与约束；
2. driver 调 `orchestra_draft` —— 期望：产出提案表格卡片，每行一个角色（含 backend / preset / sandbox / model / effort / tools）；
3. **用户本人**回一句"启动"（或敲 `/team approve <draftId>@<revision>`）—— 期望：driver 被自动唤醒，得到 freeze target（`draftId@revision#digest`）；
4. driver 调 `orchestra_create(frozenRef)` —— 期望：事务性建队，无孤儿会话；
5. `orchestra_dispatch(roleId, task)` —— 期望：角色 Session 不存在时按需创建并登记，返回投递回执；
6. `orchestra_wait()` —— 期望：报告**布尔**变更（绝不回传变更内容），或 20 分钟后心跳超时唤醒；
7. 角色用 `orchestra_report` 落盘报告 —— 期望：返回绝对路径，且该角色报告计数 +1；
8. `orchestra_team` —— 期望：客观事实看板（会话存活态、报告数、最后报告路径、最后活跃）；
9. `orchestra_dismiss` → `orchestra_activate(archive_id)` —— 期望：归档不可变；live 复用 / persisted 恢复 / missing 替换三分支，部分失败落 `degraded` 而不是假装成功。

### 反例（必须 fail loud，不能静默）

- `orchestra_create(goal, topology)` 不带 `frozenRef` → `approval_required`；
- `orchestra_wait()` 在没有 team 时 → 明确报错（"空等只会白烧超时"）；
- `orchestra_dismiss` / `orchestra_activate` 对不存在/损坏的 archive → 拒绝发布 active。

---

## 6. 风险与边界

- **破坏性**：0.4.x 用户如果依赖那 16 个工具中的任何一个，升级即失效。这是 v0.5 的设计意图（driver 上下文被它们淹没），不是事故。
- **静默过滤有代价**：旧拓扑 `orchestraTools` 里的已删名字被静默剔除。好处是不炸建队，代价是"我声明了它却没人告诉我它没了"。本版选择前者，并把守卫放在了内置资产上。
- **批准语义变松**：一句"ok"就算批准。这是用户明确要求的简化（共识备忘录 §5.1），但它意味着**任何**真实用户回合里的肯定词都可能放行最后展示过的草案。
- **`orchestra/` 会出现在项目根**：这是运行时账本，不是业务文档。项目自身的治理规范（`PROGRESS.md`、`docs/receipts/` 之类）仍由 driver 按项目要求如实产出——插件不替你写业务文档。
- **bundle 改动需要重启进程**：装完不重启，4599 上不会有任何变化。

---

## 7. 变更清单（本轮发布复核的实际改动）

```
src/orchestra-topology.ts      20 处 welcome 散文：orchestra_handoff/orchestra_verdict → a2a_send / orchestra_report
src/orchestra-role-presets.ts  rolePrompt 的 typed-milestone 指令改为 a2a_send
src/orchestra.ts               orchestra_draft / orchestra_dismiss / orchestra_topologies 描述按实现改写；
                               两处引用已删工具的报错文案与注释清理
scripts/test-cp8-notices.mjs   交接纪律断言改为 a2a_send；新增"welcome 不得出现已删工具名"守卫
README.md                      Quick start / 内置拓扑 / 工具一览 / 路线图 按 v0.5.0 真实工具面重写
UPDATE-v0.5.0.md               本文件
STATE.md / DSH-INTEGRATION.md  状态与端口口径同步（4600 归 orchestra；v0.5.0 同步基线）
```
