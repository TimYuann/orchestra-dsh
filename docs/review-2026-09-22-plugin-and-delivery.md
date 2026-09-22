# Orchestra 全量审阅：当前底座与后续交付层

> 日期：2026-09-22。审阅基线：`1ddf52e80ba1bb29d8e73e2dbd9555fa73ed16aa`；最后源码提交：`d58c817`；package 版本：0.5.1。
> 范围：当前插件的主要生产调用链、测试与对外承诺，以及批 2（P1/P2）和批 3（P3/P4）的设计。不是仅审最近 diff，也不是全分支动态验收。
> 本轮只改文档，不修产品代码、不安装、不改 profile、不启停 DSH、不发布。冻结契约的变更建议不等于 Owner 已批准。

## 1. 总判断

**方向值得保留，底座需要定向收口，后续两批不宜照当前执行计划逐字实现。**

插件有清楚的产品价值：角色身份与独立上下文、按任务组队、一次批准、按需物化、直接协作、可恢复的编排事实。它不需要再变成一套通用 workflow engine。把可验证的交付事实交给 host、把任务路径留给角色判断，也符合既定的“0.5 强度”。

当前主要风险是三种错位：

1. **声明与执行错位**：reserved 记录里有完整设计，真正派活时却只消费了一部分。
2. **测试与生产入口错位**：领域函数与拒绝路径全绿，不代表成功工具结果、事件监听器或冷恢复链正确。
3. **设计保证与观测能力错位**：冻结清单、复制输入、记录 hash，不等于知道程序实际读了什么、访问了哪里。

不建议推倒重写，也不建议为了修复图读数而恢复已删除的 16 个微状态机工具。先收口已有生产链，再以最小交付闭环验证 host 层。

### 已有设计中值得保留的部分

- Session 与原生 continuable subagent 分工明确；独立 preset / cwd / 权限诉求不被偷偷降为 subagent。
- 自定义事实移出 DSH Session 事件日志，避免破坏原生回放契约。
- 建队 reserve-only、首派才物化；角色预设进入 DSH 名册。
- 使用宿主 fs 与版本 CAS；归档保留独立 Session 资产。
- 审批 `never`、accepted 不等于 processed、无法观测记 unknown，这些边界是正确的。
- 后续方案的候选绑定、Git CAS、不可改写历史、未知证据不放行，方向正确。

## 2. 验证与证据边界

### 本轮独立执行

- `npm run typecheck`：exit 0。
- `npm test`（包含 host/client build）：**284 tests / 284 pass / 0 fail / 0 cancelled**。
- 离线生产导出探针：`dispatchRoleTask` 的 subagent 首派请求未携带 persona/toolFilter；磁盘冲突后的 resume setup 只包含审批 pin。
- 提取实际 `turn-stopping` 注册回调，接上真实 `createRoleTurnGuard` 和延迟 readTeam：宿主 await 回调返回时 steer=0，放开读取后才 steer=1。
- 临时 Git 仓库探针：tree OID 不能作为 `worktree add --detach` 的 commit-ish；更新已 checkout 分支的 ref 不同步工作目录/index；candidate 是 ref 祖先不代表某个 expectedNew 合并提交已进入历史。

探针只使用进程内 fake ports 或临时 Git 仓库，不是 DSH live E2E。构建/测试日志在 `/tmp/orchestra-review-{typecheck,tests}.log`；临时文件不是长期证据依赖，下文保留关键读数与复现条件。

### 既有现场证据

`docs/p0-report-six-mechanisms.md`（`1ddf52e`）提供等待、加车道、混编、feature-development、替换和设置面板实测。本轮读报告并对照源码，**没有重跑这些 live 场景**。报告里的“角色按约定交接成功”不证明违规交接会被 host 拒绝。

### 独立复核

- Sol：生命周期与 DSH 原生契约。
- Terra：批 2/3 设计；首次 WebSocket 中断，保留原会话续跑后完成。
- Luna：测试覆盖、文档与展示面。
- 主审：逐条核对证据，补离线/Git 反例并合并重复发现。不是以三个 reviewer 的票数裁定正确性。

运行索引：workflow `1bac37e4-de1c-4f82-9623-f527929f398f`；Sol `062aa263-3256-4136-9666-11a4b5c1c0be`；Luna `8b4315b9-7e82-44eb-9ee5-9749f10290be`；Terra 成功续跑 `853e2ad9-1485-4522-ac72-54141f5210af`。原 workflow 的 Terra failed 记录是第一次尝试，不能据此否认续跑报告。

## 3. 当前实现：应修的真实问题

以下行号对应上述固定基线。P1 为影响核心行为/保证；P2 为范围较小的正确性或可见性问题。

### C1 · P1：统一了函数入口，却没有统一完整出生契约

**锚点**：`src/orchestra.ts:2941–2975,3348–3374`；`src/a2a.ts:320–339,440–459`；`scripts/test-role-blueprint-single-prepare.mjs:151–170`。

`createGovernedTeam` 准备完整 Blueprint 后只保留事实；真正可达的 lazy materialization 没传 `mode:"governed"`、`governedBlueprint` 或 permissionPreset，走普通 preset 创建，而非已预检的 governed setup。read-only 只是之后再追加 sandbox 事件；完整工具/权限核对与 marker 写入不因此成立。

更直接的反例：角色 Session 已创建、席位尚未 active 时进程退出。重试 create 得到 already exists，随后的 `buildRoleSession(kind:"resume")` 没有提供组合 setup，实际只有 `pinApprovalNever`。恢复了 id，不代表恢复了 persona/tools。

现有测试甚至明确断言“只有一处传 governedBlueprint，其余路径仍 BLOCKED”；这条绿测试是在守住已知缺口，不是证明缺口消失。

**建议**：从已批准事实重新准备同一份角色契约，让初建/首派/恢复都消费它；恢复组合后核实际工具与权限。无需再加一层 wrapper。首个回归应是“创建后、记 active 前崩溃 → 再派活”。

### C2 · P1：subagent 的 persona/toolFilter 在预留到物化间丢失（F-6-5 已定位）

**锚点**：`src/orchestra.ts:1007–1034,3267–3278`；`src/orchestra-state.ts:117–142`；对照 `src/subagent-node.ts:142–163`。

`GovernedRolePlan` 有 persona/toolFilter；`reservedRole` 未保存，TeamRole 也无这两个字段。lazy 创建原生 child 时只传 label、prompt、childId、model，因此 DSH 根本没收到限制与人设。非生产主路径的 `provisionGovernedPlans` 反而正确传了它们。

本轮离线探针捕获 `startContinuable.request`：只有 prompt 和 parent（本探针未指定 model），没有 persona/toolFilter。这解释了上一轮 deny bash 仍出现在工具表里，不必先归咎于 DSH 的 restrict 实现。

**建议**：让冻结的 per-child 配置在首派时可恢复，并原样送入原生服务；测试从建队/持久化读回走到真实 dispatch seam，而非仅测试 createSubagentNode helper。工具过滤是可用性收窄，不替代文件沙箱。

### C3 · P1：回合停止钩子丢弃 Promise，补交保证失效

**锚点**：`src/orchestra.ts:447–501,5693–5702`；宿主 `dsh-agent-loop/lib/index.js:965–971`。

DSH await serial dispatch 后立即检查 next-step inbox。插件却以 `void Promise.resolve(...)` 启动含异步 readTeam 的 guard，监听器同步返回 undefined。

离线读数：`returns Promise=false; steer at await boundary=0; steer after delayed read=1`。迟到 steer 不再受“关闭前补一步”的保证保护。`scripts/test-node-stall.mjs` 的 guard 单测正确，但没验证注册回调的 await 链。

**建议**：返回/await guard 的 Promise，在链内 catch；注册级回归控制 readTeam 的完成时点，并断言宿主停止边界仍未结束。

### C4 · P1：subagent 后续派活与接管绕开了原生生命周期

**锚点**：`src/orchestra.ts:3563–3573,3918–3921,3973–3975`；`src/orchestra-state.ts:937–945`；`src/a2a-transport.ts:308–352`。

- active 角色的第二次 dispatch 统一走通用 `deliverMessage`，没有按 backend 使用 `subagents.sendMessage`。它在只有 Session、没有 Agent 的分支只追加 inbox 就返回 accepted，不负责原生 continuation 的恢复/唤醒。`orchestra_send` 已有正确分流，可复用。
- 新 driver takeover 把已物化 subagent 改为 reserved/new parent，却保留旧 childId。归档 drain 不删除 durable Session；DSH `startContinuable` 对已存在的显式 childId 抛 `DUPLICATE_CHILD`。重复派活不能消除这个冲突。

**建议**：subagent 所有派活都走原生 continuation 服务；接管已物化 child 时签发新实例 id 并保留旧身份。仅从未物化的座位可复用预留 id。这不同于延期的 S2：是当前已支持 subagent 的行为正确性。

### C5 · P1：归档“请求停止”不等于“确认停止”

**锚点**：`src/orchestra.ts:2666–2673,3647–3688,3744–3750`。

Session cancel 抛错后继续循环；subagent drain 的 helper 内部吞错；上层仍写不可变 archive 和 archived marker。通知也是 detached。因而当前顺序虽是 retire → record，仍不能保证“归档后角色不再运行”。

**建议**：区分 rollback 的 best-effort 清理与正式 dismiss 的严格停止。正式归档先确认所需停止结果，失败返回具体角色、保留 active 状态；通知可以 best-effort，但不能冒充停止证明。还需按原生 cancel 契约核实终止完成时点，不能仅以调用过 cancel 作判据。

### C6 · P1：dismiss 副作用成功，返回 schema 却失败（F-6-2）

**锚点**：`src/orchestra.ts:3776–3785,5214–5228`。

成功返回总有默认 reason/summary，schema 未声明且禁止额外字段。因此带参和不带参的首次正常归档都会被 DSH 判 invalid output；这是“已做事却报失败”，重试会混淆结果。

**建议**：补齐 schema 或删去不需要的返回字段；用真实成功 handler 返回值校验。既有第六轮有两次 live 复现，本轮源码复核确认。

### C7 · P2：替换身份、报告指针和展示面不够可靠

- **替换同 id（F-6-4）**：`src/orchestra.ts:4014–4035`。new id 与 history old id 相同；应区分稳定角色 id 与会话实例 id，最小改法是 replacement 分配新 Session id。
- **报告路径可覆盖**：`:5247–5298` 无条件 writeText；reportId 含内容 hash，但记录只保存路径、不保留旧内容。两角色使用同名报告会让旧记录指向新内容。当前不是可信不可变证据库，批 2 不可直接把这些路径当冻结证据。
- **看板隐藏重要事实（F-6-3）**：`:5037–5067,5095–5101`。added_lanes、notice_failures 在结构化结果中，但 render 没输出。应给模型简短摘要与可追查路径。
- **无工作区时模板不恒显**：`:5454–5504,5590` 仅遍历 roots 填模板；roots 为空则空目录，与 `src/client/index.tsx:5–9` 的承诺冲突。应单独提供 bundled/global 基线。

这些不要求新治理框架；修身份、避免报告覆盖/明确可变语义、补渲染即可。

### C8 · P2：归档 CAS 失败后重试会留下重复快照

**锚点**：`src/orchestra.ts:3746–3772`；`src/orchestra-archive.ts:509–510`。

快照写入后 marker CAS 失败，提示重试；重试产生新随机 archive id。因此“再次 dismiss 已归档 marker”幂等，不代表“快照与 marker 之间失败”幂等。并发报告可触发该窗口。

**建议**：先明确残留快照的状态与唯一生效快照，再选择复用 dismissal attempt 的最小恢复方案；不要把所有历史快照自动当成功归档。正式修复须覆盖中间失败，而非只测连续两次正常调用。

## 4. 图协议：审阅分歧的处理

**事实**：第六轮 observed events=[]、rev=0；闭环写函数在生产入口不可达。**同样真实的事实**：v0.5 slimming 明确撤掉微状态机工具，README 已把它们写为声明式资产。

所以不把 F-6-1 简化为“漏实现，恢复所有工具”。需要修正的是：

- catalog/UI 仍用“Loop PASS 且 Gate approve 后才收束”等强措辞；`/team decide` 没有可打开的 gate；用户可能把宣言误认为强制机制。
- `docs/plan-0.8.0-execution.md:557` 用“既有 Loop attempt 上限”约束 unqualified 返修，但当前 live 没有 attempt，不能作为后续安全前提。
- lazy opening message 未沿用完整 welcomeProtocol，也不能仅凭旧 provisioning helper 宣称完整协议自动注入每个角色。

**建议**：当前明确区分“角色纪律”与“host 强制”。后续若需有限返修，用交付节点自身的明确状态/次数驱动；是否复用 graph 领域模块另作实现选择，不恢复模型逐步记账负担。

## 5. 后续两批设计：开工前需要修正的假设

这些是设计问题，不是把 P1–P4 尚未实现误报成当前 bug。

### D1 · P1：Git 合并缺少 commit 构造与工作目录归属

**锚点**：执行计划 `:223–226,236,443–449,817`；契约 §1.7。

`merge-tree --write-tree` 产出 tree，`update-ref refs/heads/...` 需要 commit；计划没有明确 expectedNew 的构造、父提交集合和身份。`git worktree add --detach <tree>` 若指实际 tree OID，实测 exit 128：`is a tree, not a commit`。

另一个独立反例：对当前 checkout 的 integration 分支 update-ref 后，HEAD 内容为 candidate，但磁盘仍为 base，status 出现 staged 修改。CAS 不同步 worktree/index；合并后直接在旧目录跑测试会验证错树。

**建议**：从 candidate commit 建冻结快照；先用 Git 构造唯一 merge commit（例如 commit-tree），持久化 intent 后 CAS；明确目标 ref 不由活跃写入工作区 checkout，验证在对应 commit 的独立快照进行。不要默默用 reset --hard 补救。

### D2 · P1：恢复 B5 的祖先判据太弱，还会改写历史身份

**锚点**：执行计划 `:473–487,525`。

B5 用 candidateCommit 是当前 ref 祖先判断 A 已完成，并把 expectedNew 记成当前 ref。两份不同的合并提交完全可以都包含同一 candidate，其中一份并不是 A 的 intent 产物。

临时 Git 反例：`is-ancestor candidate otherMerge` exit 0；`is-ancestor intendedExpectedNew otherMerge` exit 1。按 B5 会给未发生的 A 合并补成功账。

**建议**：以该 attempt 已持久化的 expectedNew 为身份，验证它是否进入当前 ref 历史及其 tree/parents；当前后继 ref 另记 observation，不能覆盖 expectedNew。candidate 可达本身不足以证明本次事务完成。祖先查询 error 不得当 false。

### D3 · P1：冻结输入与外呼观测，计划仍承诺超出采集能力

**锚点**：执行计划 `:122–146,223–226,427–428,543–590`；契约 §1.3/1.4/1.7；官方 ShellExecRequest / ShellRunResult。

- 复制已声明 inputs 能防“这份副本变了”，不能发现所有未声明的参与输入，也不能自动重写任意测试脚本的读取路径；P1-3 却承诺一律检测 `unbound_input`。
- 契约要求“已有工具核验完整输入范围”才细粒度复用；执行计划又允许 declared-inputs-only、completeness=unproven 的路径不相交证据复用。这不是同强度保证。
- DSH shell 的 env 是普通环境覆盖/合并，不是封闭环境；不能把传入 env[] 当作完整有效环境。
- ShellRunResult 有退出、超时、输出、文件沙箱事实，没有网络调用事实。未定义可信部署侧观测器，却要求 required/observed 正例，落点不完整。

**建议**：第一版采用整树与明确运行条件绑定，默认重跑；不引入通用依赖分析器。将“已声明输入已绑定”与“完整输入范围已证明”拆开；后者无法证明就不开放细粒度复用。外呼无可信采集器时 unknown → 不合格，不能采信程序 stdout 的自证。env 只声明已核字段和未封闭边界，不承诺完整可重放。

### D4 · P1：仓库级身份与节点生命周期应先于证据执行落地

**锚点**：Owner alignment §1 #4/§7.2 #7；执行计划 P1/P2；`src/orchestra-state.ts:374,683–685`；`src/orchestra.ts:2966,5247–5278`。

现有 state/report/charter/receipt 大量从调用 Session cwd 派生。节点进入 `.worktrees/<node>` 后，若只新增 delivery-worktree.ts 而不统一根解析，会看不到主团队或形成第二份状态。owner 已决“一个仓库一个团队”，但执行计划缺少完整接入位置与跨 worktree 回归。

同时 P1 要消费 frozen candidate，而 candidate 身份与节点记录在 P2 才接入。应明确跨批依赖，而不是先用临时真源再替换。

**建议**：先定义仓库根/团队根解析与最小节点身份；prepared 是意图，候选 commit 存在后才 freeze candidate+manifest+decisions。所有旧工具、报告、通知、恢复都使用同一团队根，节点执行 cwd 单独保留。非 Git 工作目录的现有 A2A/编排仍可用，交付动作才拒绝。

### D5 · P2：预算方程与真实协作动作矛盾

**锚点**：执行计划 `:975–987`。

total 定义包含原有 report/通信，却要求 delivery.total == delivery.new == 3+decisions；现有收束又要求 report + reply。review.total==1 与同一纪律也冲突。

**建议**：新增治理动作与总动作分开计；总成本含报告、通信、失败和返修。预算应报警并帮助删冗余，不应用无法满足的等式逼角色隐瞒动作。

### D6 · 批 3 的范围建议：保留恢复与副作用安全，推迟泛化治理

胶囊“缺字段 incomplete 但可续做”、不可重复外部动作 unknown 必停、迟到决策产生新记录，这些设计值得保留。必须区分 agent 回合结束与业务节点 blocked，后者可以合法等待人，不要为追求 human_interventions=0 偷授权限。

风险在于把每周机制复查、强制摄入、统计体检、完整胶囊同时变成首个交付闭环前置，增加新的伪通过面。建议先交付“一个候选 → host 验证 → 独立审查绑定 → CAS → 崩溃恢复”的纵向闭环，再添加故障已有证据支撑的机制。此为范围建议，**不直接改写 Owner 的冻结范围**。

## 6. 为什么全绿仍漏这些问题

`test-tool-schemas.mjs:445–521` 多数工具 CASES 预期 error；dismiss 只测无团队，部分 pattern 为 `/./`。它证明 handler 被调用，不证明成功结果合法，更不是“全部错误都是类型化业务拒绝”。纯 helper 的正确性也掩盖了 lazy 路径漏字段、registered listener 丢 Promise，以及旧 provisioning 无调用点。

最有价值的测试补充不是再加大矩阵，而是覆盖几个组合边界：

1. create → 持久化读回 → dispatch → 捕获原生请求/实际组合；
2. 创建成功但席位尚未 active → 重启 → 再派活；
3. registered turn-stopping listener + 延迟 fs；
4. dismiss 正常成功、停止失败、snapshot 后 marker CAS 失败；
5. materialized subagent → dismiss → 新 controller activate → dispatch；
6. Git intent 的“candidate 已进入别的提交，但 expectedNew 没有”反例。

## 7. 建议顺序与未做事项

- **先修底座**：C1–C6，附带 replacement id 与必要渲染修正。保留当前成功场景，不恢复微状态机工具面。
- **再改设计文本**：D1–D4 的技术事实与可判定边界；先明确解决方案，再更新冻结版本与对应验收，不靠追加一轮审查代替改正。
- **再做交付层**：最小纵向闭环，随后批 3；每个 guarantee 都对应一个真的走生产 seam 的反例。
- **本轮未做**：任何产品修复、DSH live/浏览器/跨重启复跑、profile/依赖改动、打包安装、发布。历史报告中认证 URL 不应复制进新报告或发布材料；本报告只引用路径。

## 8. 官方依据（固定版本，而非 master 漂移）

DSH tag `dsh-v0.1.6-alpha.2` 对应 commit `ddefc45fbc7f8e46dd73185e68295696d1297887`。本轮通过 GitHub API 取以下官方文件，并结合该版安装体核对运行语义：

- [插件开发规范](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/preset/agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md)：bundle/patch、host/client 归属、slot inject、安装与实际生效分开验证。
- [Agent Presets](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/preset/agent-presets/README.zh.md)：名册、standing mount、每会话组合、代际与恢复限制。
- [Subagent 服务](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/subagent/subagent/src/index.ts)：startContinuable/sendMessage/drain 的生命周期与父子授权。
- [Subagent 子系统](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/docs/subsystems/subagent.zh.md)：持久 descriptor、persona/toolFilter、activation 与会话的区别。
- [Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/api/session-controller/src/agent.ts)：原生 Session 激活/恢复，不代替 subagent continuation。
- [Shell 类型](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/shell/shell/src/types.ts)：env 合并语义、执行与沙箱事实；没有通用网络/文件读取 provenance。

**总体结论：可以继续投资，但先让已有承诺在真实入口成立，再往上叠确定性交付。**
