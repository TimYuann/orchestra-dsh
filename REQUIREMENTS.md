# orchestra-dsh v0.4.0 · 目标规格

> 本文件是 orchestra-dsh v0.4.0 的唯一目标规格面。它记录已经拍板的产品与架构合同，供后续 Executor 实现、Reviewer 验收；不把尚未实现的能力描述成现状。当前公开 checkout 是 v0.3.0，内部状态、评审报告和 DSH 集成手册不属于本仓库依赖。
>
> 文档中的 **已实现事实** 表示当前 v0.3.0 源码已经提供的行为；**v0.4 目标** 表示本版本必须保真的产品语义；**候选** 和 **开放问题** 不得被当作已冻结实现。API、JSON 字段和物理文件布局只在不违背本文件语义的前提下，于对应实现 Checkpoint 冻结。

## 0. 规格使用方式

### 0.1 术语和强度

- **Session**：一个完整、可观察、可恢复的 DSH agent 会话。Orchestra 创建的角色不是一次性 subagent。
- **Driver**：启动 Governed Orchestra、拥有协调决策权并负责闭环的会话。Driver 拥有决策，不拥有伪造质量 verdict 的权力。
- **Role**：Topology 中声明的职责实例，必须绑定完整的 Session Blueprint。
- **Topology**：描述图、角色、Preset、Loop、Gate、ownership、routes 和 Closure 的可复用协作设计。
- **Orchestration Document**：某个 Governed Orchestra 实例的逻辑 Living Document；包含批准后的合同、运行投影和 Driver 决策日志。
- **Attempt**：一次 Loop 执行。每次重试都是运行历史中的新有向节点。
- **Gate**：必须满足或由指定 owner 决策才能继续的边界。

除非后续 Checkpoint 明确细化，`MUST`/“必须”表示验收不变量，`SHOULD`/“应”表示默认策略，`MAY`/“可以”表示实现选择。

### 0.2 规范边界

本文件约束两条产品路径、图与文档语义、Session provisioning、运行时一致性、兼容方向和实施顺序。它不要求所有功能在本 Checkpoint 已完成，也不预先规定完整 JSON schema；过早冻结字段会把实现细节误当成产品合同。

## 1. 版本与产品定位

### 1.1 v0.4.0 的定位

Orchestra 是 DSH 的 **full-session Graph Engineering plugin**，不是 subagent team 的包装。它把完整 Session、可审查的有向协作图、受治理的 Loop/Gate/Closure 和可追踪 evidence 组合起来，使计划、执行、评审、重试、人工参与和结案都能被观察、恢复和验收。

产品保留两种一等用法：

| 用法 | 合同 | 适用场景 |
|---|---|---|
| **Lightweight A2A** | 不需要 Team、Orchestration Document 或 Graph；直接 `list/create/send/reply/read`，创建一个完整 Session 与其他完整 Session 协作。 | 临时咨询、一次性协作、无需治理闭环的消息传递。 |
| **Governed Orchestra** | 通过 `/team` 进行对话式设计，明确 Human Participation，用户批准后冻结文档化 Topology，实例化完整 Session，执行有界 Graph/Loop/Gate，并按 Closure 结束或显式失败。 | 严肃开发、长任务、需要责任归属、评审、重试和证据的协作。 |

两条路径共享 A2A transport，但治理边界不同：普通 A2A 不能因为某个 Orchestra 实例的 cwd/team ACL 而永久受限。

### 1.2 A2A 与 Orchestra 的边界

- A2A 是通用 transport，负责 Session 之间的消息投递、读取、回复和可观察的 delivery 语义。
- Governed Orchestra 的团队寻址优先使用稳定的 `teamId + roleId`，由运行时解析到当前 `sessionId`。display name、title 和路径不是身份。
- A2A 可以在没有 Team/Graph 的情况下工作；Orchestra 的团队寻址、Loop 路由和权限检查不能反向改变底层 A2A 的通用能力。
- 角色之间的消息可以直连；Driver 只接收需要其决策的节点，不应成为所有普通消息的中继站。

### 1.3 用户入口

`/team`、自然语言表达“开一个团队/协作”、以及直接调用 Orchestra 工具是等价入口，最终都必须遵守同一套 Governed 流程：理解目标 → 确认约束与 Human Participation → 读取上下文 → 提案 → 用户批准 → Freeze/实例化 → 运行 → Closure。

用户批准前不得冻结或实例化任何 Governed role Session。提案不是批准；工具返回成功也不能替代用户批准。

## 2. 图模型与有界执行

### 2.1 外层 DAG

Governed Orchestra 的外层是 **Directed Acyclic Graph (DAG)**。节点表示可观察的执行、判断、交接或人工边界；边表示允许的控制流和 evidence handoff。图的历史不能通过回边重新进入旧执行节点来形成隐式循环。

需要迭代的部分建模为 **composite bounded-loop node**。Loop 在逻辑上是一个复合节点，但每次 `attempt` 都在运行历史中展开为新的有向执行节点，因此重试历史保持无环、可审计、可恢复。

普通 A2A 讨论不必建图，也不需要通过 Graph Engineering validation。

### 2.2 Loop 的必备语义

每个 bounded Loop 必须声明以下语义；实现可以用事件、对象或其他存储表达，但不得丢失这些事实：

1. `entry`：进入本 Loop 的条件和上游节点；
2. `participants`：参与执行、评估或接收 handoff 的 role；
3. `input/handoff`：输入、上下文和上游 evidence 如何进入，以及结果如何交接；
4. `evaluator`：拥有质量判断权的 evaluator/reviewer；
5. `pass exit`：通过后唯一或明确的继续路径；
6. `retry path`：失败后如何产生下一次 attempt；
7. `hard cap`：最大 attempt/round 数和计数语义；
8. `cap-exhausted escalation`：达到上限后的强制上报和可选 remediation branch；
9. `evidence`：支持评估和交接的 report、commit、diff、test、screenshot、message id 或等价证据。

Loop 不能用“直到通过”“继续下一轮”或未声明的模型判断代替 hard cap 与出口。

### 2.3 Verdict 与 cap exhaustion

- evaluator/reviewer 拥有质量 verdict；Driver 可以接受、升级或结束，但不能自行伪造 `PASS`。
- 每个 attempt 结束时必须记录结果和 evidence。通过只能沿 `pass exit` 继续；失败只能沿声明的 `retry path` 或错误路径继续。
- cap 耗尽时，旧 Loop 终止。Reviewer/evaluator 必须向 Driver 提交 `cap_exhausted` packet，至少包含 Loop、最后 attempt、已核对 findings、已有 evidence、未解决风险和可行的下一步。
- Driver 只能通过一个**新的 remediation branch** 作决定：
  - `replan`，修改后续计划但不偷偷重开旧 Loop；
  - 按需创建 specialist 或替换 role；
  - 增加仲裁 reviewer；
  - 请求用户作出决定；
  - 以 `blocked` 或 `failed` 结束。
- 禁止隐藏的“无限下一轮”、自动越过 cap、覆盖旧 attempt 或把新问题伪装成旧 Loop 的修复。

### 2.4 Dynamic Task Board（非核心）

Dynamic Task Board/Blackboard 是另一种 pull/claim 协作范式，可以作为未来或混合节点。v0.4.0 不把完整 mission board、市场式 task claiming 或通用 workflow engine 设为核心必做；若某个实现 Checkpoint 引入局部 board，仍必须遵守本文件的身份、evidence、状态和 Closure 语义。

## 3. Living Orchestration Document

### 3.1 一个逻辑文档，三个层次

每个 Governed Orchestra 实例必须有一个逻辑上的 **Living Orchestration Document**。产品上可以展示成一份文档，但物理存储是否单文件留给实现设计。逻辑内容至少包括：

#### A. Frozen Charter

这是用户批准的 canonical 合同，包含：

- Mission、范围和约束；
- 角色及其 Agent Preset；
- 每类决定的 ownership；
- routes、handoff 和允许的协作边界；
- 每个 bounded Loop 及其 evaluator、cap、出口和 escalation；
- Gates 与 Closure；
- Human Participation Policy。

Frozen Charter 必须能回答：谁做什么、谁拥有每个决定、结果交给谁、何时通过、何时重试、重试何时停止、何时需要人、谁宣布结束。

#### B. Runtime Projection

这是由 plugin 的 machine state/event 推导出的当前视图，而不是角色自由编辑的文本。至少能够投影：当前 Loop/attempt、owner、pending gate、blocker、next step、状态（如 active、needs_retry、replan、degraded、blocked、failed）。

Projection 可以滞后于一条普通消息；不要求 Driver 实时监听每条角色消息，但在 coordination checkpoint 必须 reconcile，发现 stale state 时显式标记而不是静默覆盖。

#### C. Driver Decision Journal

这是摘要式 decision/change log，由 Driver 记录批准、路由选择、replan、人工决定、cap exhaustion 处置和 Closure 决策。每条重要决定应引用可复核 evidence，例如 report、commit、diff、test、screenshot 或 message id。

### 3.2 写权限和修订

- Driver 是 Frozen Charter 和 Decision Journal 的唯一语义写者。implementer、reviewer、oracle 等角色不得直接修改 canonical charter/journal；它们通过 handoff、report 和消息提交事实与建议。
- 原始批准合同与 Runtime Projection、派生报告和运行结果分离。角色不得为了掩盖失败重写原合同。
- Topology amendment 必须创建新的 revision，并记录变更原因、批准来源和影响的运行节点；不得原地改写已经批准的 revision。
- 文档 reconcile 只发生在明确的 coordination checkpoint，例如 Freeze、attempt 结束、Gate 决定、cap exhaustion、replan 和 Closure。
- Git 可以作为 evidence，不能承担 runtime 并发一致性。revision、CAS、append-only journal 或等价 stale-write 防护由 runtime 负责。
- 禁止要求所有 agent 共同编辑同一份原始 Markdown；文档是逻辑合同，角色通过受控写入面提交结构化事实或 report。

## 4. Human Participation Policy

### 4.1 开局确认

`/team` 初期必须确认运行时是否有人类参与，并将选择冻结进 Governed Topology。至少区分：

- **interactive**：关键决策点即时要求用户确认；
- **checkpointed**：按声明的 checkpoint 暂停，用户确认后才继续；
- **autonomous**：运行期间不要求用户作必需决定，只有明确可用的 fallback 或安全停止。

如果用户未明确选择，Driver 必须在冻结前询问或采用产品定义的安全默认，并把假设写入 Charter；不得在运行中临时改变 participation mode。

### 4.2 Human Gate 合同

每个 Human Gate 必须明确：

- `decision scope`：用户究竟决定什么，哪些选择不在范围内；
- `blocking scope`：Gate 阻塞哪个节点、Loop 或 branch，而不是无界阻塞整个运行；
- `on_unavailable`：用户不可用、超时、拒绝或输入无效时的行为，例如安全停止、进入 `blocked`、采用已批准 fallback 或结束为 `failed`。

autonomous Topology 不得包含没有 fallback 的 required human gate。Driver 不得在运行中制造一个没有可行 `on_unavailable` 行为的用户等待。

### 4.3 与 DSH Permission/Approval 的区分

Orchestra Human Gate 是产品协作决策层；DSH Permission/Approval 是工具、文件、网络等运行权限层，两者不是同一件事。`autonomous` 不自动等于 `danger-full-access`：Permission Preset 必须在开局明确选择，或在权限不足时安全停止并报告原因。

## 5. 完整 Session Blueprint 与 provisioning

### 5.1 硬不变量

0.4.0 的硬不变量是：任何由 `a2a_create`、`orchestra_create` 或 `orchestra_spawn` 派生的 Session，都必须有与其运行模式相匹配的完整 Session Blueprint，不得是无 Agent Preset/完整 composition、无工具或只有半成品元数据的 Session。

- Governed Orchestra 的每个 Role 必须绑定 `teamId + roleId` 并进入受治理 roster；不得留下 rosterless 的 Governed role。
- Lightweight A2A 有意不属于 Governed roster，也不要求伪造 team/role/topology metadata；它必须携带明确的 lightweight identity marker，并满足本节定义的完整 Lightweight Blueprint。

创建前必须完整解析 **Session Blueprint**，至少包括：

- Agent Preset 或可恢复的实际 composition generation；
- Permission Preset（sandbox + approval）；
- provider、model、reasoningEffort；
- cwd、title；
- mode-specific identity metadata：Governed 使用 team/role/topology metadata，Lightweight 使用 lightweight identity marker 并明确不属于 Governed roster；
- required tool capabilities；
- welcome/initial task 的 durable admission 计划。

这些内容是可验证的 provisioning 输入，不要求在一个具体 JSON 对象中表达。

### 5.2 三类选择必须分离

- **Agent Preset** 决定完整的 agent composition、persona、工具面和运行纪律。
- **Permission Preset** 决定 sandbox、approval 和安全边界。
- **Model Selection** 决定 provider、model、reasoningEffort。

三者可以互相引用，但不能用 Agent Preset 的默认值掩盖权限或模型事实，也不能把 permission/model 选择塞进只描述 persona 的文本中。

### 5.3 Lightweight 与 Governed 的解析规则

- Lightweight A2A 未显式指定 Agent Preset 时，必须继承调用 Session **实际运行的 composition generation**；不能只读取当前 deployment default。它必须记录 lightweight identity marker、实际 preset/composition、工具面、权限、模型、cwd/title 和 durable admission 事实，但不得凭空创建 team/role/topology metadata 或 Governed roster。
- Governed Orchestra 的每个 Role 必须有显式完整 Agent Preset，或由 Topology 明确指定并可解析的 base preset。preset 未定义、解析失败或只有 persona 文本时，不得继续创建。
- professional role preset 必须建立在一个已知完整 composition 上，例如 `standard`、`minimal`、`code` 或明确完整的自定义 composition；不能只有 `persona` 而没有工具面。
- resume 必须恢复该 Session 实际运行过的 preset/model/permission facts，不能套用新的默认配置覆盖历史事实。

### 5.4 Provisioning 状态

只有在以下通用条件，以及对应运行模式的身份条件都验证通过后，Session 才能标记为 `active`：

1. preset composition 已解析并可加载；
2. required tools 已满足；
3. Permission Preset 已解析；
4. Model Selection 已解析；
5. cwd、title 已写入；
6. Governed Session 已写入 team/role/topology metadata 并建立 roster 映射，或 Lightweight Session 已写入 lightweight identity marker 且明确不在 Governed roster；
7. welcome/initial task 已被 durable admission 接受并可追踪。

任一环节失败必须显式记录 `provisioning_failed` 或 `degraded`，并保留可恢复的失败原因；不得静默返回成功、留下无记录孤儿或把部分创建伪装成完整 active Session。Governed 多角色创建必须具备 transactional multi-role provisioning 语义：部分失败要么可回滚/补偿并有记录，要么整个实例显式进入失败状态。

### 5.5 v0.3 已知缺口（必须修复）

当前 v0.3.0 的 `src/a2a.ts` 中，`createSession` 在 `presetId` 与 `presetFile` 都缺失时可以不 mount composition；这与 `a2a_create` “默认继承 caller preset”的描述不一致，可能创建无工具 Agent。它是 v0.4.0 的必修复项，不得在兼容层继续静默保留。

## 6. Topology Template 与 Role Preset 体系

### 6.1 两类资产必须分开

- **Topology Template** 描述“怎样协作”：图、Loop、Gate、routes、ownership、Closure、Human Participation 和角色引用。
- **Role Preset** 描述“角色怎样工作”：完整 Agent composition、职责纪律、工具能力、交接方式以及与 Permission/Model 的边界。

修改一个 Role Preset 不应隐式重写已经 Freeze 的 Topology；修改 Topology 也不应把历史 role 的运行事实改成新默认。

### 6.2 当前 v0.3 基线事实

当前公开 v0.3.0 源码内置并暴露 4 个 Topology Template：`duo`、`trio`、`oracle`、`four-role-dev`；内置 3 个 Role Preset：`orchestra-implementer`、`orchestra-reviewer`、`orchestra-oracle`。这些是已实现基线，不等于 v0.4.0 已满足 Graph/Loop/Gate 合同。

### 6.3 v0.4 任务型 Topology 候选

以下是 v0.4.0 的候选内置 Topology，不是已实现清单：

- `feature-development`；
- `bug-diagnosis-and-fix`；
- `refactor-and-migration`；
- `architecture-decision`；
- `product-or-ui-design`；
- `release-readiness`；
- `audit-and-hardening`。

以下是候选 Role Pool，不代表每个角色都必须进入每个 Topology：

- `implementer`；
- `debugger/investigator`；
- `verifier`；
- `reviewer`；
- `architect`；
- `researcher`；
- `frontend-designer`；
- `release-auditor`；
- `documenter`。

每个实际纳入 v0.4 交付的内置 Topology 必须带有 graph/loop/gate/role-preset 定义、至少一个示例任务和真实 E2E 验收。候选名单要到对应实现 Checkpoint 冻结后才能转为已实现事实。

## 7. 自定义 Graph Engineering 规范

### 7.1 Hard errors

Draft→Freeze、Topology Amendment、Loop cap exhaustion 处置和 Closure 等关键边界必须执行 Graph Engineering validation。至少拒绝以下情况：

- role id 不唯一，或 preset/model/sandbox/permission 无法解析；
- edge、ownership、gate、closure 引用不存在的 role、node 或 branch；
- 同一类关键决定没有单一 final owner；
- 没有单一 closure owner；
- bounded Loop 缺少 hard cap、pass exit 或 cap-exhausted escalation；
- Human Gate 缺少 decision scope、blocking scope、on_unavailable，或与 Human Participation Policy 不相容；
- 未经用户批准就 Freeze 或实例化 Governed Topology；
- required tool capabilities、Session Blueprint 或 durable admission 不完整；
- 失败路径会静默产生 orphan Session、假 active 状态或不可恢复的半个实例。

### 7.2 Soft warnings

验证可以允许但必须可见地警告：

- unreachable role；
- orphan output；
- 过度 fan-in Driver；
- 并行写冲突；
- handoff evidence 不足；
- 角色过多；
- Gate 过多或 scope 过大；
- Loop/branch 的证据、出口或责任边界不清晰。

Soft warning 不得被工具 render 的一句摘要吞掉；应进入 Draft/Freeze 结果或 Runtime Projection，供 Driver 和用户作决定。

### 7.3 检查边界

普通 A2A 讨论、临时 `a2a_create` 和不声明 Governed Team 的消息流不经过上述 Graph 检查。检查只发生在关键边界：Draft→Freeze、Topology Amendment、Loop cap exhaustion 和 Closure；Provisioning 本身仍必须执行 Session Blueprint 与安全校验。

## 8. Runtime、消息与恢复的鲁棒性合同

### 8.1 状态和身份

- 多角色 provisioning 必须是 transactional，部分失败不得留下无记录孤儿或假 active。
- 对 Governed Orchestra，`teamId + roleId → sessionId` 是稳定映射；Session 被替换时保留 session history、replacement reason 和当前有效映射。Lightweight A2A 使用自身的 lightweight identity marker，不要求 team/role 映射。
- display name/title/cwd 只能用于展示或上下文，不能作为身份、权限或恢复键。
- `active`、`degraded`、`blocked`、`needs_retry`、`replan`、`failed`、`provisioning_failed` 等状态必须显式化；禁止 silent fallback/partial success。

### 8.2 消息与写入

- `accepted`、`claimed`、`answered` 是不同语义：accepted 只说明 transport 接受，claimed 说明目标已认领，answered 说明有对应回复。工具和 UI 不得把它们混为完成。
- message id 必须可去重；必要的写操作必须具备 idempotency key、revision 或等价保护。
- Runtime 写入使用 revision/CAS 或等价 stale-write 防护；并发更新冲突要显式返回并触发 reconciliation，而不是后写覆盖前写。
- report、handoff、decision journal 和状态投影应保留 evidence 引用；不能只保存一段不可定位的最终摘要。

### 8.3 分层与 DSH 依赖

- 核心 transport/runtime 与可选 discovery、GUI、workspace/query adapter 分层；观察面失败不能拖垮核心消息、状态和 Closure。
- 只依赖 DSH 稳定公开 seam。不要把 private experimental Agent Teams package 作为 runtime dependency；可以借鉴其 durable mailbox、task CAS/DAG、wait 和 provisioning 语义，但必须由本插件自己的公开 seam 实现。
- 保留 `@deepseek-ai/*` 只能作为 `peerDependencies` 的防双实例红线；发布和 profile 安装不得把宿主包复制进插件自己的运行时依赖。

## 9. v0.3.0 基线事实、兼容方向与已知缺口

### 9.1 基线事实（不是 v0.4 完成声明）

当前 checkout 的实现已提供：

- A2A 的 `list/create/send/reply/read` 工具、live/durable/resumed delivery receipt、冷 Session resume 和基础消息读取；
- Orchestra 的 topology 读取、`orchestra_create`、`orchestra_spawn`、`orchestra_team`、`orchestra_activate`、`orchestra_dismiss`、`orchestra_report`、`orchestra_topologies`；
- 4 个内置 Topology、3 个内置 Role Preset、`/team` onboarding prompt、团队 state/archive、报告记账和 display-only GUI projection；
- 当前实现仍以 `<cwd>/orchestra/state/team.json`、`orchestra/archive/` 和 `.orchestra/`/全局 topology/preset 目录为主要存储面，角色 Session 本身独立于 dismiss 保留。

这些事实可以作为兼容输入和回归基线，但它们没有自动满足 v0.4 的完整 Blueprint、Graph validation、Living Document、Human Participation 或 transactional provisioning 合同。

### 9.2 兼容与迁移要求

实现阶段必须为 v0.3 的 `team/archive/topology` 提供明确读取策略，至少覆盖：

- 旧 `team.json` 的 active/dismissed 标记、旧字段命名和角色 session 映射；
- archive snapshot 的恢复、替换和历史保留；
- v0.3 topology/preset 的来源优先级、schemaVersion 和未知字段处理；
- 旧团队地址与新的 `teamId + roleId` 寻址之间的映射；
- 读取旧状态失败时的显式 degraded/blocked 结果，而不是把旧数据当作空团队或静默重建。

兼容读取不得破坏原始 archive 或角色 Session。具体字段映射、迁移写入时机、旧 topology 缺失 graph/loop/gate 时的默认策略，必须在“核心类型/存储 seam 与兼容读取” Checkpoint 冻结并由 Reviewer 验收；本规范不提前虚构迁移 schema。

## 10. v0.4.0 非目标

以下内容不属于 v0.4.0 核心交付：

- BPMN/Airflow 式通用 workflow engine；
- 要求每条 A2A 消息都使用强制 typed envelope；
- 强制完整 Task Board；
- 把 Graph Edge 直接作为通信 ACL；
- 依赖 DSH private experimental package；
- `dismiss` 杀死 full Session 角色；dismiss 只结束实例并保留可观察的角色资产；
- 把候选 Topology/Role Pool 当作已经实现；
- 用 GUI、workspace adapter 或 discovery 层替代核心 runtime 的一致性和证据合同。

## 11. 后续实施 Checkpoint 建议

以下顺序用于拆分后续实现工作；每个 Checkpoint 主题单一、必须独立验证和提交，后项不得假定前项“差不多完成”。这是实施建议，不是已完成清单。

### Checkpoint 1 · 核心类型、存储 seam 与兼容读取

- **依赖**：本规范。
- **范围**：冻结最小 domain/event 类型、revision/CAS seam、`teamId + roleId` 映射，以及 v0.3 team/archive/topology 的只读兼容策略。
- **验收**：旧 active/archive/topology 可被显式分类、恢复和报告；未知/损坏数据进入 degraded/blocked；并发 stale write 不静默覆盖；不扩展 UI 或新 Topology。

### Checkpoint 2 · Session Blueprint 与 complete provisioning

- **依赖**：Checkpoint 1 的类型和状态 seam。
- **范围**：按运行模式完整解析 Agent Preset/实际 composition generation、Permission Preset、Model Selection、required tools、mode-specific identity metadata、welcome/initial task durable admission；为 Governed 多角色实例提供 transactional multi-role provisioning；修复无 preset 可生成无工具 Agent 的 v0.3 缺口。
- **验收**：所有 a2a/orchestra 派生 Session 都能证明与模式匹配的完整 Blueprint；Lightweight Session 有 lightweight identity marker 且不伪造 team/role/topology roster，Governed Role 有完整 roster 映射；失败显式为 provisioning_failed/degraded；resume 恢复历史运行事实；无未记录的 Governed role 或假 active。

### Checkpoint 3 · A2A transport/discovery 分层与 role addressing

- **依赖**：Checkpoint 1–2。
- **范围**：保持 A2A 的通用 lightweight 能力，分离可选 discovery/GUI/workspace adapter；加入 Governed 的 `teamId + roleId` 寻址和替换映射，不把 cwd/team ACL 下沉为永久 transport 限制。
- **验收**：无 Team 的 list/create/send/reply/read 仍可用；accepted/claimed/answered 可区分；消息 id 去重；跨实例/替换 Session 寻址稳定；观察面失败不影响核心投递。

### Checkpoint 4 · Topology Draft/Freeze/Document/Journal

- **依赖**：Checkpoint 1–3。
- **范围**：建立 Living Orchestration Document 的 Frozen Charter、Runtime Projection、Driver Decision Journal；实现用户批准、revision/amendment、唯一语义写者和 checkpoint reconcile seam。
- **验收**：未批准不能 Freeze/实例化；角色只能提交 report/handoff；amendment 生成新 revision；projection 可从 machine state/event 重建；journal evidence 可定位。

### Checkpoint 5 · bounded Loop、handoff/event、cap-exhausted 与 Closure

- **依赖**：Checkpoint 1–4。
- **范围**：实现 DAG 节点/边、attempt 展开、有界 Loop 合同、evaluator verdict、handoff/evidence、cap-exhausted packet、remediation branch、Gates 和单一 Closure owner。
- **验收**：历史无环；每个 Loop 有 entry/participants/input/evaluator/pass/retry/cap/escalation/evidence；Driver 不能伪造 PASS；R2/cap 后不会隐藏生成无限下一轮；blocked/failed/replan 明确可见。

### Checkpoint 6 · 内置任务型 Topology 与 Role Preset

- **依赖**：Checkpoint 2、4、5。
- **范围**：从候选名单中冻结本次交付的任务型 Topology 和 Role Pool；补齐完整 Agent composition、Permission/Model 边界、graph/loop/gate/role-preset 定义、示例任务。
- **验收**：每个纳入的内置 Topology 都有真实 E2E；候选但未纳入的能力保持明确未实现；Preset 不再是 persona-only；模板修改不重写已 Freeze 实例。

### Checkpoint 7 · recovery / activate / dismiss

- **依赖**：Checkpoint 1–5。
- **范围**：按 team/role 稳定映射恢复、Session replacement/session history、archive 保留、controller takeover、degraded/blocked 恢复语义；维持 dismiss 不杀死 full Session 的合同。
- **验收**：live/persisted/missing Session 分支显式可见；恢复失败不会假装 active；旧 archive 不被破坏；替换后新寻址和 report/journal evidence 连续。

### Checkpoint 8 · GUI / observation projection

- **依赖**：Checkpoint 3–7 的稳定 projection seam。
- **范围**：将 Template、Frozen revision、Runtime Projection、pending Gate、Loop/attempt、角色状态和 archive 以只读观察面呈现；GUI 是可选 adapter，不拥有语义写权限。
- **验收**：观察层停用时核心 runtime 仍工作；界面显示 active/degraded/blocked/failed 和 evidence 引用，不把 accepted 渲染成 answered；不引入第二套状态源。

### Checkpoint 9 · E2E、pack/profile 防崩与发布收尾

- **依赖**：Checkpoint 1–8。
- **范围**：覆盖 Lightweight A2A、Draft→Freeze→provision→Loop→Gate→Closure、cap-exhausted remediation、resume/replacement、兼容读取、GUI projection；验证 pack/profile 安装和 peer dependency 红线。
- **验收**：真实 full-session E2E 可重复；失败路径有显式状态和 evidence；`@deepseek-ai/*` 不进入 dependencies 或重复实例；构建、打包、profile smoke 和发布材料与 v0.4 规格一致。

## 12. 开放问题（不改变已拍板合同）

下列问题留给对应实现 Checkpoint 冻结，不能被默认实现偷偷决定：

1. Living Document 的物理存储是单文件、事件集合还是混合投影，以及各层的落盘/重建策略；
2. 最小 Graph/Event 类型和 revision/CAS API 的具体字段与 DSH 公开 seam；
3. v0.3 旧字段到 v0.4 domain/event 的完整映射、迁移写入时机和旧 topology 缺少 Loop/Gate 时的兼容策略；
4. team/role addressing 的公开工具参数形状，以及与旧 session-id 参数的过渡期兼容方式；
5. Permission Preset 的内置目录、approval 适配方式和不同 DSH profile 的能力声明；
6. interactive/checkpointed/autonomous 的默认提示与超时 UX，只要最终满足 Human Gate scope/fallback 合同；
7. GUI 所需的 observation/query adapter 具体协议，只要观察面不成为核心 runtime 依赖；
8. 任务型 Topology 候选中哪些进入 v0.4.0 的实际交付批次，以及每个批次的真实 E2E 任务样例。

开放问题不允许削弱本文件已经冻结的硬不变量；如果答案改变产品语义，必须通过新的 Topology/document revision 和明确的 Driver/用户批准记录。
