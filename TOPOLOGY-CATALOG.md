# orchestra-dsh v0.4.0 · Task Topology / Role Preset Catalog

> 状态：**6A freeze + 6B implemented（2026-08-25）**。本文冻结 v0.4.0 首发任务型
> Topology 与 Role Pool 的产品合同；D.1~D.5 五个 Topology 与 E 节七个 Role Preset
> 已由 6B 实现（BUILTIN_TOPOLOGIES / orchestra-role-presets，本地 contract/
> integration tests 18 文件 142 测试全绿）。**真实 full-session E2E 未运行**，
> 由用户另开的 DSH「创造模式」验收 Session 按 `UPDATE-v0.4.0.md` §4/§5 独立
> 执行；本文的合同值不受实现状态影响。
>
> 研究截止：2026-08-24。DSH 官方仓库事实使用
> dsh 0.1.1-rc.2 release commit
> b150a551b8d465e31e418e1b2eaf5e79bbb7d28e；本仓库 package manifest 仍以
> 0.1.0-rc.6 public seam 为实现兼容基线。两者之间的差异必须在 6B 本地
> contract tests 与最终外部 E2E 交接中显式列出，不能由本文假定兼容。

## 0. 冻结结论

### 0.1 v0.4.0 首发 Topology

首发限定为五个任务族。五个仍然是有限批次：它们覆盖 build、diagnose、
change-safety、decision 和 security-hardening 五种不同图形，同时共享
七个以内的 Role Pool，6B 可以为每项建立可重复 E2E：

1. feature-development：从已批准需求到可验证代码交付；
2. bug-diagnosis-and-fix：从可复现故障到根因、修复和回归证据；
3. refactor-and-migration：在行为基线、兼容窗口和回滚证据约束下演进代码；
4. architecture-decision：从约束与证据到可执行的架构决策；
5. audit-and-hardening：从安全/可靠性审计发现到可验证的最小加固。

五者分别代表 build/review、diagnose/repair、change/compatibility、
analysis/decision、audit/remediation 五种不可互换的主图形。它们共享
有限 Role Pool，但不是把同一套角色名单换个标题。每个模板都有自己的
route、Loop、Gate、Closure 和 E2E 合同。

### 0.2 明确延期

本轮不 ship：

- product-or-ui-design：需要浏览器、视觉/图像或设计文件能力，当前 DSH
  profile 的可选工具不能被默认假定；
- release-readiness：与 verifier/reviewer 的证据图高度重叠，且发布权限
  与外部系统集成不属于本轮核心；
- frontend-designer、release-auditor、documenter：分别依赖可选设计能力、
  发布系统或与已有 deterministic/document owner 重叠。

延期不是“已实现的兼容别名”。旧 Topology 继续可读；新模板必须由用户
明确选择，不能静默替换旧模板。

### 0.3 冻结与实现的边界

- 本文 D/E 节是 6B 的输入合同；**6B 已按本文实现**（2026-08-25，提交链 798b221→4403b0f），本地 contract/integration tests 全绿。
- 本文中的能力合同明确分为 compositionTools 与 orchestraTools；实现必须
  分别做 capability preflight，缺失就 fail loud，不能把 host tool 伪装成
  DSH composition row。
- deterministic test、lint、build、diff 和 hash 等可由代码执行、Gate 或
  evidence oracle 完成的工作，不单独虚构一个 Agent role。
- 所有 Governed role 都是完整 DSH Session；Role Preset 不是 subagent
  prompt 包装，也不能绕过 Session Blueprint、Permission/Model pin、CAS
  和 durable admission。
- 外部 Agency Agents 研究显示可用角色空间远大于首发批次，但它是一个
  可安装的 standalone Markdown persona roster，不是 Orchestra 的 durable
  graph/state 合同；我们吸收其 deliverable、scope 和 evidence 纪律，不
  复制其数百个专门 persona。

## A. Terminology

| 术语 | 本文含义 | 不应混淆 |
| --- | --- | --- |
| Topology Template | 可复用的协作设计：角色、图边、ownership、typed handoff、bounded Loop、Human Gate、Closure 及其默认参与策略。 | 不是一次运行状态，也不是某个 Agent 的 persona。 |
| Role Preset | Orchestra 对一个职责的可复用合同：职责、decision rights、禁止事项、report/handoff 约束，以及一份完整可挂载的 DSH Agent Preset composition 策略和独立的 Orchestra host capability 需求。 | 不是只有 system prompt 的角色名；也不是 DSH Permission Preset。 |
| DSH Agent Preset | DSH 的 composition 目录，决定 persona、model-facing tools、skills、compaction、workflow/delegation 和 tool presentation 等 agent-plane 能力。 | 不决定 provider/model 路由，也不等于 Permission Preset。 |
| Permission Preset | DSH 的 sandbox/approval bundle。它与 Agent Preset、Model Selection 分离；effective sandbox 可以在角色合同中有明确 override。 | 不等于 Orchestra Human Gate。 |
| Mission | 本次 Governed Orchestra 要完成的目标、范围、约束、验收和 non-goals 的冻结快照。 | 不是一个泛化 workflow 的输入字符串。 |
| Runtime | 某个冻结 Topology 的实际 Team/Role/Graph/Loop/Gate/Closure 事件与状态。 | 不反向修改 Frozen Charter 或 Role Preset。 |
| full-session role | 具有自己的 durable Session、Agent Preset、Permission/Model facts、cwd、history、inbox 和 sessionId 的 Governed role。 | 不是一次调用即结束的 subagent。 |
| subagent | DSH 可选的 delegation 机制；若使用，也必须服从当前 Session composition 和权限，不能取代 Orchestra roster 或 Graph node。 | 不是本目录中的默认角色实现。 |
| deterministic verifier | 由代码、测试命令、schema、diff 或 evidence reader 执行的确定性检查。 | 不是为了“跑测试”而新增的模型角色。 |

本文将 Role Preset id 写成 implementer、reviewer、investigator、verifier、
architect、researcher、hardening-auditor。它们是 Orchestra v0.4 角色
合同；其底层 DSH composition 见 E 节。现有 orchestra-implementer 等
v0.3 id 仍属于兼容输入，6B 不得无记录覆盖它们。

## B. Research findings

### B.1 来源与版本

以下 mutable repository source 使用 immutable commit URL；网页资料记录
访问日和公开页面版本。关键事实与本文推论分开写。

| 来源 | 版本/访问 | 用途 |
| --- | --- | --- |
| [DSH release commit](https://github.com/deepseek-ai/deepseek-harness/commit/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e) | dsh 0.1.1-rc.2，commit b150a551，2026-08-21 | 当前官方公开实现锚点。 |
| [DSH Agent Presets README](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/preset/agent-presets/README.md) | 同上 | preset discovery、mount、composeFrom、standing mount、失败回滚和文件信任边界。 |
| [DSH standard composition](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/apps/cli/config/agent-presets/standard/agent.cordis.yml) | 同上 | standard 的完整工具、skills、compaction、delegation 和 workflow composition。 |
| [DSH minimal composition](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/apps/cli/config/agent-presets/minimal/agent.cordis.yml) | 同上 | minimal 的有限 shell/editor composition。 |
| [DSH code composition](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/apps/cli/config/agent-presets/code/agent.cordis.yml) | 同上 | code 在 standard 能力上加入 Code Mode presentation，且依赖 codeRuntime。 |
| [DSH permission preset docs](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/subsystems/permission-presets.md) | 同上 | workspace-write/danger-full-access、approval/sandbox 分离、custom 派生状态。 |
| [SSSF](https://github.com/disler/super-simple-software-factory/tree/de31374882e7a4e3e5b7bb9bd09e69dc2f779356) | commit de313748，2026-08-02 | deterministic control plane、bounded phase、typed envelope、post-condition gates。 |
| [LoopX](https://github.com/huangruiteng/loopx/tree/e059b1757c2a5ab8eb909f55d068c70b05a7f6b9) | commit e059b175，2026-08-24 | durable control-plane、scope、evidence、handoff、gate、projection 与 stop/recovery 原则。 |
| [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | 2024-12-19，访问 2026-08-24 | 简单可组合的 prompt chaining、routing、parallelization、orchestrator-workers、evaluator-optimizer、human checkpoint 和 bounded stopping。 |
| [LangGraph workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) | 官方文档，访问 2026-08-24 | predetermined workflow、conditional routing、parallel fan-out/aggregation、orchestrator-worker、evaluator loop。 |
| [OpenAI Agents orchestration](https://openai.github.io/openai-agents-python/multi_agent/) | 官方 SDK 文档，访问 2026-08-24 | code-vs-LLM orchestration、agents-as-tools、handoff、specialized agents、structured output 和 evals。 |
| [OpenAI handoffs](https://openai.github.io/openai-agents-python/handoffs/) | 官方 SDK 文档，访问 2026-08-24 | destination-specific handoff、typed input、input filtering 和 handoff ownership。 |
| [Agency Agents](https://github.com/msitarzewski/agency-agents/tree/ebe9c99acb5c96f9468de368d8bead775387d1a7) | commit ebe9c99，2026-08-06 | 大规模 standalone specialist roster；用于评估角色粒度、deliverable、scope 与 evidence 纪律，不作为 Orchestra runtime/API 事实。 |

### B.2 DSH Preset 能力：source-backed facts

1. DSH Agent Preset 是包含 agent.cordis.yml 的目录。官方 README 把
   discovery、health、trust、path 和 broken reason 作为 roster facts；可
   解析的 preset 才能进入 composition。
2. mount 的支持位置是 Agent factory 的 setup 阶段：Session/Agent 尚未
   publish 时 mount 失败会使创建回滚。broken YAML、缺少 composition、未
   成为可用 service 或把 service 错误发布到 root realm 都应失败。
3. 当前官方实现使用 standing mount：一个 preset composition 在进程中
   建立可复用的 scope，加入该 preset 的 Session 通过 scope parent chain
   得到 tools/prompt/skills。composeFrom 是从父 Agent 的实际 composition
   加入同一 generation 的绑定；它不是按同 id 重新 mount 新 generation。
4. standard 是完整 coding composition，官方文件列出 shell、filesystem、
   fs-search、skills、plan/compaction、goals、delegation/workflow、todo
   和 web 等模型面能力。minimal 是刻意缩小的 persistent shell +
   str-replace-editor composition，并且不带 standard 的 compaction。code
   在 standard 能力上增加 Code Mode 的 tool presentation。
5. DSH 把 model routing 留在 host/per-agent 的 model selection seam，而
   不是 preset YAML 的隐式事实。Permission Preset 也独立于 Agent Preset：
   官方默认表至少区分 workspace-write + ask 与 danger-full-access + never；
   与表项都不匹配时，current 是派生的 custom，而不是可写入的 preset 名。
6. 当前 standard/code 文件中的 Codex/Claude Code provider rows 是 disabled
   optional rows。由此可见“宿主安装了 provider”不等于“该 preset 已向
   Agent 暴露工具”；6B 必须把 optional capability preflight 与 composition
   mount 分开，缺失 required capability 时 fail loud。
7. preset file 是 composition input，不是运行时 persistence target；切换
   已产生历史的 Agent 会破坏历史与工具一致性。运行中的 Session 应保留
   已加入的 generation，后续新 Session 才读取新 stamp。

本文后续角色表使用两个明确字段：

- compositionTools：必须出现在 DSH Agent Preset 的 agent-plane composition
  中，例如 tool-bash、tool-fs、tool-fs-search、tool-web；通过 preset
  discovery、mount/setup 和实际 scope-visible tool schema 验证；
- orchestraTools：由 Orchestra plugin/host tool catalog 提供，例如
  orchestra_report、orchestra_handoff、orchestra_verdict；它们不进入
  agent.cordis.yml，不由 DSH preset mount 验证，而是在 host plugin 注册、
  caller scope 和 tool schema seam 上单独验证。

两类能力都可以是 Role 的硬 required capability，但不能合并成一个会让
实现者误加 DSH row 的无类型 capability 数组。

### B.2.1 本仓库当前 preset scope：已实现事实

当前 checkout 的实际 built-in Role Preset 仍只有
orchestra-implementer、orchestra-reviewer、orchestra-oracle 三个。它们
不是只写 persona 的空壳，而是可 mount 的完整 minimal-based composition：

- implementer：persona + agent-instructions + tool-fs + tool-fs-search +
  tool-bash；由 topology 选择 workspace-write；
- reviewer：同一类读工具面，由 topology 选择 read-only，并把唯一写入口
  限定为 orchestra_report；
- oracle：读工具面 + orchestra_report，只给建议，不拥有 verdict/closure；
- 三者显式不含 plan mode、goal、subagent、workflow、web、compaction 和
  PTY；a2a_* / orchestra_* 等插件/宿主工具不应被误报成角色 composition
  rows；
- 来源优先级是 project .orchestra/presets > user/global orchestra preset
  root > DSH-native preset > catalog builtin fallback。catalog builtin 物理
  位于独立的 catalog-presets root，不伪装成 user/global source，因此安装
  fallback 不会 shadow DSH-native preset；自定义文件需要按现有 Topology
  Catalog 与 Session Blueprint 规则解析。

因此“当前 scope”准确说是：每个角色拥有自己的 full Session 和最小角色
工具/纪律 composition，权限由 topology/Blueprint 独立 pin；它不是 DSH
standard 的全量 coding toolset，也不是 agency-agents 的 standalone
Markdown persona。6A 冻结的七个 Role Preset 是下一实现目标，不能回写成
当前已实现。

### B.3 DSH 事实到 Orchestra 约束：推论

| DSH 事实 | Orchestra 的推论 |
| --- | --- |
| setup 前 mount 失败可回滚 | Governed role 的 Session Blueprint 必须在 Agent publish 前验证 preset、权限、model、required tools；不能先创建再补 persona。 |
| composeFrom 继承父代实际 generation | Lightweight 与 delegated child 不能只读当前 default；Governed role 的 preset 事实必须记录并可恢复。 |
| optional row 可以 disabled，且 host/runtime 可能缺失 | topology 的 compositionTools/orchestraTools 必须分别 preflight；可选 row 没有证明就不能被写进成功 receipt。 |
| model 与 permission 在 preset 外独立解析 | Role Preset 只能声明默认/策略，runtime 必须固定真实 provider/model/reasoning 与 base/effective permission。 |
| standing mount 的 scope parent chain 提供工具面 | Role Preset 的“完整 composition”必须是可实际 mount 的 Agent Preset 文件，而不是 persona-only 文本。 |

这些是对本仓库 v0.4 合同的设计推论，不声称 DSH 提供 Orchestra 的
team/role/graph API。Orchestra 只依赖仓库已声明的 public DSH seam；不依赖
private experimental Agent Teams。

### B.4 Graph Engineering findings：吸收什么

#### SSSF

SSSF 的主要机制是“deterministic Python owns the graph; coding agents are
bounded nodes”：代码负责 sequencing、retries、acceptance 和 event trace，
Agent 只负责一个有边界的 phase。它用 typed JSON envelope 传递上下文，
用 gates 在 envelope 之后验证 artifacts、diff 和 tests，并明确 code phase
不应被包装成一个 tester agent。

Orchestra 吸收：

- Graph/Loop/Closure 的控制转移由 runtime event 和 deterministic checks
  负责，角色不能靠自然语言声称完成；
- candidate、report、verdict、evidence 通过 typed handoff 传递；
- build/lint/test/diff 等稳定命令是 code/evidence gate，不新增泛化 tester；
- 失败修复优先在原 Session 的 bounded attempt 中进行，保留 history。

拒绝：

- SSSF 的 Python/SQLite/PI 具体实现不进入 DSH runtime；
- 不把它的 stamped workflow、provider roster 或 visualizer 当作 Orchestra
  API；
- 不把完整 factory 变成 v0.4 通用 workflow engine。

#### LoopX

LoopX 的官方仓库把 durable goal state、run history、gates、evidence、
handoff、scoped ownership、projection 和 recovery 分层；它强调 projection
不是第二个 truth source，用户 gate 只阻塞声明 scope，状态写回必须带
identity/scope/revision，blocked、repair、replan、user_action_required
不能被“继续运行”吞掉。

Orchestra 吸收：

- Role/edge/loop 以稳定 identity 和当前 mapping 寻址；
- 每次 handoff/decision 都携带 evidence 与可重放 receipt；
- gate 只阻塞声明的 branch/loop/node；
- Runtime projection 与 Markdown 是 derived view，不能反向改 Charter；
- 不可证明的接受、完成或发布状态保持 blocked/failed。

拒绝：

- 不引入 LoopX 的 scheduler、quota、heartbeat、todo market、lease daemon
  或 dashboard；
- 不把 agent-native Kanban/Task Board 设为 v0.4 核心；
- 不把外部 LoopX 状态文件当作 DSH runtime storage。

#### Anthropic、LangGraph、OpenAI：可组合图模式

三组官方材料有共同部分，但用途不同：

- Anthropic 把 prompt chaining、routing、parallelization、
  orchestrator-workers 和 evaluator-optimizer 作为可组合 patterns，并提醒
  只在复杂度带来可证明收益时增加 agent；coding 的质量同时依赖自动测试和
  人类 review。
- LangGraph 把 predetermined workflow 与 dynamic agent 分开，示范
  conditional edge、parallel fan-out/aggregation、orchestrator-worker 和
  evaluator loop；这些都能映射成可验证的 Topology graph，而不要求每条
  普通对话都结构化。
- OpenAI Agents SDK 区分 agents-as-tools（manager 保持最终对话控制）与
  handoff（specialist 接管后续 turn），并建议 code orchestration、typed
  structured output、specialized agents 和 evals；handoff input 是有 schema
  的小元数据，不是把 application state 藏进自然语言。

Orchestra 的合并推论：

- feature 使用 directed implementation → verification → review，并在
  evaluator-optimizer Loop 中保留 capped repair；
- bug 使用 diagnosis → fix → verification → review，把根因证据作为
  handoff 的必要输入；
- architecture decision 使用 research fan-in → architect synthesis →
  review → human decision，避免把“多 Agent 讨论”当成无界群聊；
- 并行只用于无重叠 write scope 的 research/inspection；共享代码写入保持
  单 owner 或显式 CAS；
- authority、verdict、Gate 和 Closure 留在 Orchestra runtime，不由模型
  动态重写。

### B.5 不采纳的机制

- 通用 BPMN/Airflow/workflow compiler；
- 每条 A2A 消息都必须 typed；
- 让 Graph Edge 变成 transport ACL；
- 为 lint/test/build 专门创建没有决策权的 Agent；
- 依赖 DSH private Agent Teams；
- 用一个万能 orchestrator role 替代清晰的 evaluator、owner 和 handoff；
- 把可选浏览器/图像/provider 能力当成所有 profile 的硬前提。

### B.6 Agency Agents：角色目录的启发与边界

Agency Agents 的 README 把每个 agent 定义为可单独安装的 Markdown 文件，
并按 engineering、design、testing、security、product、project-management
等 division 分类。每个文件通常包含 identity/personality、core mission、
workflow、technical deliverables、success metrics 和 communication style；
Codex integration 只把 name、description、developer instructions 转成
standalone custom-agent 文件。仓库在 commit ebe9c99 的目录中包含
Minimal Change Engineer、Code Reviewer、Software Architect、Multi-Agent
Systems Architect、Evidence Collector、Reality Checker、Application
Security Engineer、Compliance Auditor 等不同专长。

这组事实说明两件事：

1. 角色的可复用价值不只来自 persona，而来自明确 mission、deliverable、
   success/evidence 和 prohibited scope；这支持把首发从三项扩到五项，并
   把 security hardening 作为有实质差异的图；
2. Agency Agents 的安装模型是“一个文件一个 standalone specialist”，
   没有本仓库要求的 team/role durable mapping、CAS、typed runtime event、
   bounded Loop、Human Gate 或 Closure。因此它不能直接作为 Topology 或
   DSH Agent Preset 实现。

Orchestra 的适配决策：

- 吸收 Minimal Change Engineer 的 scope discipline 到 implementer/
  refactor 的 write boundary；
- 吸收 Evidence Collector/Reality Checker 的 evidence-over-assertion 与
  final integration check 到 verifier/reviewer；
- 吸收 Multi-Agent Systems Architect 的 least privilege、explicit
  topology、fallback、context scope 和 failure-mode 设计到所有模板；
- 吸收 Application Security Engineer/Compliance Auditor 的 threat model、
  rescan、control reference、remediation evidence 到 hardening-auditor；
- 不把 frontend、marketing、support、游戏等 specialist 逐个变成
  Orchestra 首发 Role Preset；它们留作未来 domain pack，前提是先拥有
  独立 Graph/E2E/permission 合同。

## C. Selection rubric 与全候选矩阵

每项按 0–3 评分，分数越高越适合当前 v0.4 首发：

- 用户频率/价值：0 低频，3 高频且直接产生价值；
- 与现有模板差异：0 只是改名，3 图、责任或证据显著不同；
- Graph/Loop 可复用性：0 只能特化，3 能稳定复用已有 graph primitives；
- Role Preset 复用度：0 需要大量新角色，3 主要复用 frozen role pool；
- DSH 工具/可选依赖风险：0 高风险，3 只需当前 public composition；
- E2E 可重复性：0 依赖外部系统/主观结果，3 可在临时仓库以固定证据复现；
- 实现与维护成本：0 很高，3 小而可控；
- 过度编排风险：0 容易变成 workflow theater，3 边界清晰且 orchestration 有实益。

| 候选 Topology | 频率/价值 | 差异 | 图复用 | 角色复用 | DSH 风险 | E2E | 成本 | 低过编排风险 | 合计 | 决策 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| feature-development | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 2 | 22/24 | **ship** |
| bug-diagnosis-and-fix | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 3 | 23/24 | **ship** |
| refactor-and-migration | 3 | 3 | 3 | 3 | 3 | 2 | 2 | 2 | 21/24 | **ship**；与 feature 共享角色，但新增兼容/回滚图 |
| architecture-decision | 2 | 3 | 3 | 3 | 3 | 3 | 2 | 3 | 22/24 | **ship** |
| product-or-ui-design | 2 | 3 | 2 | 2 | 1 | 1 | 1 | 2 | 14/24 | defer；可选浏览器/视觉能力未形成稳定 E2E |
| release-readiness | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 3 | 17/24 | defer；与 verifier/reviewer 重叠且外部发布边界未冻结 |
| audit-and-hardening | 3 | 3 | 2 | 2 | 2 | 2 | 2 | 2 | 18/24 | **ship**；安全 findings、rescan、风险 Gate 构成独立图 |

### C.1 选择的边界

五项 ship 是本轮上限：feature、bug、refactor、architecture、hardening
各自有不同的 entry/evaluator/evidence 或 blocking decision；它们仍共用
七个以内的 Role Pool，6B foundation 和 deterministic checks 可以复用。
没有为了凑数量 ship release；没有把 UI 依赖伪装成当前 profile 的稳定能力。

## D. Frozen v0.4 delivery catalog

### D.0 共同运行合同

#### 角色、权限、模型和能力平面

- 每个角色都是 full Session，必须有 teamId + roleId → sessionId durable
  mapping，并先 reservation 后 publish。
- implementer 是唯一默认 code write owner；其他角色 read-only。Driver
  只写 orchestration state、reports/journal 和 runtime commands；它不以
  自己的身份伪造 reviewer/evaluator PASS。
- 所有角色的 base Permission Preset 默认是 workspace-write + ask；read-only
  角色再通过明确的 effective sandbox override 使用 read-only。任何模板都
  不默认 danger-full-access。
- Model Selection 默认采用 deployment default 并在 Blueprint 中 pin；
  topology 可提供 explicit provider/model/reasoningEffort override，但必须
  成对且在 create 前解析。没有隐藏的“architect 自动更强模型”规则。
- compositionTools 与 orchestraTools 都是硬 capability contract。前者在
  DSH composition mount/visible-scope seam 预检和 publish 前复验；后者在
  Orchestra host/plugin tool registration/schema seam 预检和 publish 前
  复验。任一缺失都必须 no state/no Session/no Agent 地 fail loud。Host
  tools 永远不能被写入 DSH Agent Preset 文件来“补齐”。
- default participation 见各模板。User approval for Draft/Freeze 是所有
  Governed 实例的前置条件，不被 topology 的 autonomous/interactive 选择
  取代。

#### 统一 handoff payload

每个 typed handoff 至少包含：

- summary：当前阶段的短结论；
- artifactRefs/evidence：report、commit、diff、test、screenshot、message、
  file 或 url 的非空引用；
- knownRisks 或 notes：可选但必须是字符串；
- source role、target role、mission/team/loop/attempt ref：由 runtime 注入
  或校验，不能由消息文本自称。

Handoff 的 requiredPayloadFields 与 requiredEvidenceKinds 由各模板声明。
普通 A2A 仍可传自然语言；只有下列 Governed milestone 使用 typed handoff。

#### 统一 closure 合同

每个模板只有一个 closure owner：Driver/controller。Closure 需要：

- 对应 Loop 已 PASS，或沿允许的 failed/abandoned outcome 给出 reason/evidence；
- required handoff/verdict/evidence 齐全；
- required Human Gate 已完成，且 openGatePolicy 不允许未解决的 completed；
- 无 pending delivery/CAS reconciliation；
- terminal event 后禁止再创建新 attempt/handoff/verdict。

#### 统一错误与停止条件

required capability、role mapping、typed payload、evidence、Gate option、
Loop cap、CAS 或 durable admission 失败都 fail loud。Loop 达 cap 时进入
cap_exhausted，不能隐藏开下一轮；Driver 只能提出新的 remediation branch，
本文首发模板不自动增删 role。

### D.1 feature-development

**id / 名称 / 描述**

- id：feature-development
- name：Feature Development
- description：把已批准 feature mission 变成有边界、可测试、经评审的代码交付。
- 适用：需求、范围和验收可以写成 code/evidence checks 的新功能。
- 不适用：主要是故障根因探索、跨版本大迁移、设计决策或发布动作。

**Mission contract**

Mission 必须提供 objective、scope、constraints、acceptanceCriteria、
nonGoals、target cwd 和至少一个可执行/可观察验收。implementer 只能改
scope 内文件；不允许把“顺手重构”“发布”“扩大权限”当作隐含任务。

**Initial roles 与权利**

| roleId | Role Preset | sandbox / permission | model strategy | compositionTools | orchestraTools | write boundary |
| --- | --- | --- | --- | --- | --- | --- |
| driver | controller session | caller-selected effective sandbox；不由模板偷偷升级 | deployment default pinned，显式 override 优先 | caller Agent Preset；不由 topology 追加 | orchestration tools、A2A/typed handoff、report read | team/document/graph/journal；不持有 reviewer verdict 权 |
| implementer | implementer | workspace-write / workspace-write + ask | deployment default pinned | tool-bash、tool-fs、tool-fs-search | orchestra_report、orchestra_handoff | mission scope 内源码/测试；不得写 canonical charter/graph |
| verifier | verifier | read-only / workspace-write + ask base | deployment default pinned | tool-bash、tool-fs-search | orchestra_report、orchestra_handoff | 只写 report/evidence channel；不改代码 |
| reviewer | reviewer | read-only / workspace-write + ask base | deployment default pinned | tool-fs、tool-fs-search、tool-bash | orchestra_report、orchestra_verdict、orchestra_handoff | 只写 review report；唯一 review Loop evaluator |

**Graph / routes / ownership**

控制流：

driver --mission--> implementer
implementer --candidate--> verifier
verifier --verification--> reviewer
reviewer --verdict--> driver
reviewer --findings--> implementer

ownership：

- implementation：implementer；
- deterministic verification：code/evidence gate，verifier 解释结果；
- review verdict：reviewer；
- user decision：direct Human Gate；
- closure：driver。

typed handoffs：

| kind | from → to | required payload | required evidence |
| --- | --- | --- | --- |
| candidate | implementer → verifier | summary、changedFiles、knownRisks | commit、diff、test |
| verification | verifier → reviewer | summary、checks、notes | test、diff、file |
| findings | reviewer → implementer | summary、findings、repairScope | report、diff、message |
| verdict | reviewer → driver | summary、verdict、unresolvedFindings | report、commit、diff、test |

**bounded Loop**

- loopId：implementation-review；
- entry：implementer / candidate_ready；
- participants：implementer、verifier、reviewer；
- evaluatorRole：reviewer；
- candidateKind：candidate；
- verdictKind：PASS、FAIL、BLOCKED；
- maxAttempts：2；
- passRoute：verification → human gate → closure；
- retryRoute：reviewer findings → implementer repair → verifier；
- capExhaustedRoute：cap_exhausted → driver remediation branch；
- requiredEvidence：commit、diff、test、report。

FAIL 且 attempt < 2 只能沿 retryRoute；attempt = 2 仍 FAIL 必须 cap
exhausted。BLOCKED 不得伪装 FAIL 或自动消耗新 attempt。

**Human Gate / Closure**

- default human mode：checkpointed；
- gateId：feature-closure-approval；
- decisionScope：是否接受本次 feature candidate 的已声明验收；
- blockingScope：closure；
- options：approve、request-changes、stop；
- required：true；
- onUnavailable：blocked；
- closure owner：driver；
- requiredLoopOutcomes：implementation-review:passed；
- requiredVerdicts：PASS；
- requiredEvidenceKinds：commit、diff、test；
- openGatePolicy：reject；
- allowed outcomes：completed、failed、abandoned；
- userOverride：false。

**按需升级角色**

发生 cap_exhausted 或 evidence 争议时，Driver 可在新的 remediation branch
明确请求 architect 或 investigator，但这不是旧 Loop 的隐式第三轮，也不在
首发自动创建。

**显式 non-goals**

不处理线上发布、跨仓库迁移、视觉设计、自动增删角色、完整 Task Board、
danger-full-access 或把 reviewer 变成代码修复者。

**E2E 场景与验收**

在临时 fixture repo 中创建一个小 feature mission，走 Draft → user approve
command → Freeze → Team provisioning。让 implementer 修改 scope 内文件，
verifier 运行固定 test/typecheck 命令并写 evidence，reviewer 先产生一次
FAIL/findings，再在第二次 attempt 产生 PASS。验收：

1. reserved mapping 先于任何 role Session publish；
2. 两个 attempt 是不同 DAG nodes，旧 finding 不被覆盖；
3. typed handoff 的 message receipt、report、commit/diff/test refs 可重读；
4. closure gate 未批准时 closure 被拒绝，批准后才 terminal completed；
5. implementer 越界写、reviewer 伪造 PASS、缺 test evidence、第三轮 attempt
   都 fail loud；
6. Team/Document/Graph/role phases 与最终 output 一致。

**与 v0.3 Topology 的关系**

它是 trio/four-role-dev 的 v0.4 graph-engineered successor 方向，但不做
无提示自动替换：duo、trio、oracle、four-role-dev 继续作为 legacy
compat input；只有用户选择 feature-development 才使用本合同。

### D.2 bug-diagnosis-and-fix

**id / 名称 / 描述**

- id：bug-diagnosis-and-fix
- name：Bug Diagnosis and Fix
- description：先建立可复现事实和根因，再实施最小修复、回归验证和评审。
- 适用：失败测试、回归、崩溃、数据/状态不一致或明确可观察的 defect。
- 不适用：没有症状/证据的开放式 feature 设计，或主要是跨版本 migration。

**Mission contract**

Mission 必须提供 symptom、reproduction/evidence source、scope、acceptance
和 non-goals。investigator 在没有根因证据前不得把修复建议当作事实；
implementer 只能改已批准 repair scope。

**Initial roles 与权利**

| roleId | Role Preset | sandbox / permission | model strategy | compositionTools | orchestraTools | write boundary |
| --- | --- | --- | --- | --- | --- | --- |
| driver | controller session | caller-selected；无隐式升级 | deployment default pinned | caller Agent Preset；不由 topology 追加 | orchestration、report、handoff | mission/graph/journal；不伪造 evaluator |
| investigator | investigator | read-only / workspace-write + ask base | deployment default pinned | tool-fs、tool-fs-search、tool-bash | orchestra_report、orchestra_handoff | 只读调查与 report/evidence |
| implementer | implementer | workspace-write / workspace-write + ask | deployment default pinned | tool-bash、tool-fs、tool-fs-search | orchestra_report、orchestra_handoff | repair scope 内源码/测试 |
| verifier | verifier | read-only / workspace-write + ask base | deployment default pinned | tool-bash、tool-fs-search | orchestra_report、orchestra_handoff | 只写验证 report |
| reviewer | reviewer | read-only / workspace-write + ask base | deployment default pinned | tool-fs、tool-fs-search、tool-bash | orchestra_report、orchestra_verdict、orchestra_handoff | 只写 review report；唯一 quality evaluator |

**Graph / routes / ownership**

控制流：

driver --symptom--> investigator
investigator --diagnosis--> implementer
implementer --candidate--> verifier
verifier --verification--> reviewer
reviewer --findings--> investigator/implementer
reviewer --verdict--> driver

ownership：

- reproduction and root-cause evidence：investigator；
- repair code：implementer；
- deterministic regression checks：code/evidence gate，verifier 解释；
- quality verdict：reviewer；
- closure：driver。

typed handoffs：

| kind | from → to | required payload | required evidence |
| --- | --- | --- | --- |
| diagnosis | investigator → implementer | symptom、reproduction、rootCause、repairScope | report、test、message、file |
| candidate | implementer → verifier | summary、changedFiles、knownRisks | commit、diff、test |
| verification | verifier → reviewer | regressionSummary、remainingRisks | test、diff、report |
| findings | reviewer → investigator/implementer | findings、nextEvidence、repairScope | report、message |
| verdict | reviewer → driver | verdict、unresolvedFindings | report、commit、diff、test |

**bounded Loop**

- loopId：diagnosis-fix-review；
- entry：investigator / diagnosis_ready；
- participants：investigator、implementer、verifier、reviewer；
- evaluatorRole：reviewer；
- candidateKind：candidate；
- verdictKind：PASS、FAIL、BLOCKED；
- maxAttempts：2；
- passRoute：verification → human gate → closure；
- retryRoute：findings → investigator/implementer → verifier；
- capExhaustedRoute：cap_exhausted → driver remediation branch；
- requiredEvidence：report、commit、diff、test、message。

第一 attempt 若 diagnosis 不足，reviewer 必须返回 findings；不能让
implementer 以猜测的 root cause 进入成功路径。达到 cap 后不得自动扩大
scope 或创建第三次普通 attempt。

**Human Gate / Closure**

- default human mode：checkpointed；
- gateId：bug-fix-acceptance；
- decisionScope：是否接受已证明的 root cause、最小修复和 regression evidence；
- blockingScope：closure；
- options：approve、request-changes、stop；
- required：true；
- onUnavailable：blocked；
- closure owner：driver；
- requiredLoopOutcomes：diagnosis-fix-review:passed；
- requiredVerdicts：PASS；
- requiredEvidenceKinds：report、commit、diff、test；
- openGatePolicy：reject；
- allowed outcomes：completed、failed、abandoned；
- userOverride：false。

**按需升级角色**

调查证据不足可在新的 remediation branch 请求 architect；外部依赖或
安全影响可请求 researcher。二者都不是自动第三轮修复。

**显式 non-goals**

不做线上 hotfix 发布、自动回滚生产、未批准的大重构、自动更换 model/
permission、Task Board claim 或把“测试通过”单独当作 root cause proof。

**E2E 场景与验收**

在临时 repo 预置一个稳定失败的 test 和最小日志。investigator 先写带
reproduction/rootCause 的 diagnosis，implementer 只改 repair scope，
verifier 运行原失败用例与回归用例，reviewer 首轮拒绝缺失 evidence，第二轮
在补齐后 PASS。验收：

1. 无 diagnosis handoff 或 rootCause evidence 时 implementer candidate 不能
   进入 evaluator；
2. original failure 与 regression test 都要有可重读 test refs；
3. 错误 diagnosis、越界文件、missing diff、reviewer 伪造 PASS 都拒绝；
4. cap_exhausted 后只生成 Driver packet，不生成隐藏下一轮；
5. closure 记录 completed/failed/abandoned 的语义，而不是把 blocked 当成功。

**与 v0.3 Topology 的关系**

没有等价的 v0.3 内置模板。oracle 可以作为旧的分析输入，但不会自动
转换成 investigator；旧模板继续按 legacy 兼容读取。

### D.3 architecture-decision

**id / 名称 / 描述**

- id：architecture-decision
- name：Architecture Decision
- description：在约束、证据和候选方案之间形成可审查、可执行的架构决策。
- 适用：需要权衡多个实现方向、边界/依赖/迁移影响的设计决策。
- 不适用：已有明确实现路径的普通 feature，或没有可验证 decision scope 的
  开放式 brainstorming。

**Mission contract**

Mission 必须提供 decision question、constraints、in-scope/out-of-scope、
候选方案或允许 researcher 生成候选的规则、acceptance criteria 和
required evidence kinds。architect 拥有推荐/决策稿，不拥有用户 approval
或 runtime PASS 的伪造权。

**Initial roles 与权利**

| roleId | Role Preset | sandbox / permission | model strategy | compositionTools | orchestraTools | write boundary |
| --- | --- | --- | --- | --- | --- | --- |
| driver | controller session | caller-selected；无隐式升级 | deployment default pinned | caller Agent Preset；不由 topology 追加 | orchestration、report、handoff、decision command | charter/graph/journal；不冒充用户 |
| researcher | researcher | read-only / workspace-write + ask base | deployment default pinned | tool-fs-search、tool-fs | orchestra_report、orchestra_handoff | 只写 source/evidence report |
| architect | architect | read-only / workspace-write + ask base | deployment default pinned；可显式 override | tool-fs-search、tool-fs | orchestra_report、orchestra_handoff | 只写 decision brief/report，不改代码 |
| reviewer | reviewer | read-only / workspace-write + ask base | deployment default pinned | tool-fs、tool-fs-search、tool-bash | orchestra_report、orchestra_verdict、orchestra_handoff | 只写 review report；评估 decision evidence |

Architecture research is local-only in the base composition. A topology that
declares web as required must select an explicit web variant and run capability
preflight before reservation; missing web remains blocked/deferred, never an
implicit pending mount.

**Graph / routes / ownership**

控制流：

driver --question--> researcher
researcher --research-brief--> architect
architect --decision-brief--> reviewer
reviewer --findings--> researcher/architect
reviewer --verdict--> driver
architect --recommendation--> driver

ownership：

- source gathering：researcher；
- option synthesis and recommendation：architect；
- decision brief quality verdict：reviewer；
- hard user choice：direct Human Gate；
- final closure：driver。

typed handoffs：

| kind | from → to | required payload | required evidence |
| --- | --- | --- | --- |
| research-brief | researcher → architect | question、options、facts、unknowns | url、file、report |
| decision-brief | architect → reviewer | decision、alternatives、tradeoffs、impact | report、file、url |
| findings | reviewer → researcher/architect | missingEvidence、risks、requiredRevision | report、message、url |
| recommendation | architect → driver | recommendedOption、reasons、migrationImpact | report、file、url |
| verdict | reviewer → driver | verdict、unresolvedFindings | report、message、url |

**bounded Loop**

- loopId：decision-validation；
- entry：researcher / research_ready；
- participants：researcher、architect、reviewer；
- evaluatorRole：reviewer；
- candidateKind：decision-brief；
- verdictKind：PASS、FAIL、BLOCKED；
- maxAttempts：2；
- passRoute：user decision gate → closure；
- retryRoute：findings → researcher/architect → reviewer；
- capExhaustedRoute：cap_exhausted → driver requests user/replan；
- requiredEvidence：report、file、url、message。

PASS 只表示 decision brief 满足 evidence/structure contract，不表示用户
已经选择方案。只有 direct Human Gate 通过，Driver 才能把结果标为
completed；未批准不能冻结为 Team topology amendment。

**Human Gate / Closure**

- default human mode：interactive；
- gateId：architecture-decision-approval；
- decisionScope：选择/接受哪一个已列出的 architecture option；
- blockingScope：closure；
- options：accept、revise、stop；
- required：true；
- onUnavailable：blocked；
- closure owner：driver；
- requiredLoopOutcomes：decision-validation:passed；
- requiredVerdicts：PASS；
- requiredEvidenceKinds：report、file、url；
- openGatePolicy：reject；
- allowed outcomes：completed、failed、abandoned；
- userOverride：false；需要改合同必须回到 Draft/Approval/Freeze。

**按需升级角色**

需要实现可行性 spike 时，Driver 必须开新的 remediation branch 请求
implementer；不把 architecture role 直接变成代码 owner。

**显式 non-goals**

不实施方案、不自动修改当前 code、不开发布流程、不执行 UI 设计、不把
自然语言“看起来可以”当成用户 approval，也不复制完整 research workflow
engine。

**E2E 场景与验收**

在临时 repo 中提供一个有两个候选方案的架构问题。researcher 写带稳定
URL/file refs 的 research brief，architect 写含 alternatives/tradeoffs/
impact 的 decision brief，reviewer 首轮指出缺失 evidence，第二轮 PASS。
用户通过 exact direct command 选择 option 后才允许 completed closure。验收：

1. source 文件在 Freeze 后改变不影响已保存的 snapshot/digest；
2. reviewer PASS 不等于 user approval；
3. missing URL/evidence、候选越界、普通 Agent 伪造用户决定都 fail loud；
4. decision brief 只能写 report/evidence，不改 runtime code；
5. amendment 必须产生新 charter revision，不能直接改 current roster。

**与 v0.3 Topology 的关系**

它复用 oracle 的“推演”场景，但将 advice、evaluator、Human Gate 和
Closure 显式化；oracle 保持兼容输入，不自动改写为 architecture-decision。

### D.4 refactor-and-migration

**id / 名称 / 描述**

- id：refactor-and-migration
- name：Refactor and Migration
- description：在行为基线、兼容窗口和可回滚证据下完成结构或版本迁移。
- 适用：目录/模块重组、API/schema 迁移、依赖替换和行为保持的架构演进。
- 不适用：没有稳定 baseline 的新 feature，或必须直接发布生产的 cutover。

**Mission contract**

Mission 必须提供 baseline commit/version、source/target contract、迁移
scope、兼容窗口、rollback/abort 条件、acceptance 和 non-goals。每个
migration slice 必须能回答旧行为如何验证、何时允许切换、失败如何回退；
不得用“全量重写后再看看”替代这些事实。

**Initial roles 与权利**

| roleId | Role Preset | sandbox / permission | model strategy | compositionTools | orchestraTools | write boundary |
| --- | --- | --- | --- | --- | --- | --- |
| driver | controller session | caller-selected；无隐式升级 | deployment default pinned | caller Agent Preset；不由 topology 追加 | orchestration、report、handoff | migration contract、graph/journal |
| architect | architect | read-only / workspace-write + ask base | deployment default pinned；可显式 override | tool-fs、tool-fs-search | orchestra_report、orchestra_handoff | 只写 migration plan/compat report |
| implementer | implementer | workspace-write / workspace-write + ask | deployment default pinned | tool-bash、tool-fs、tool-fs-search | orchestra_report、orchestra_handoff | 当前 slice 的源码/测试；不得改 baseline evidence |
| verifier | verifier | read-only / workspace-write + ask base | deployment default pinned | tool-bash、tool-fs-search | orchestra_report、orchestra_handoff | 只写 compatibility/rollback evidence |
| reviewer | reviewer | read-only / workspace-write + ask base | deployment default pinned | tool-fs、tool-fs-search、tool-bash | orchestra_report、orchestra_verdict、orchestra_handoff | 只写 review report；唯一 evaluator |

Migration planning is local-only by default. External web research is an
explicit variant and cannot be silently inferred from the architect role.

**Graph / routes / ownership**

控制流：

driver --migration-question--> architect
architect --migration-plan--> implementer
implementer --slice-candidate--> verifier
verifier --compatibility-evidence--> reviewer
reviewer --findings--> architect/implementer
reviewer --verdict--> driver

ownership：

- migration/rollback contract：architect；
- slice code：implementer；
- old/new behavior and rollback checks：code/evidence gate，verifier 解释；
- quality verdict：reviewer；
- cutover/closure decision：driver + required Human Gate。

typed handoffs：

| kind | from → to | required payload | required evidence |
| --- | --- | --- | --- |
| migration-plan | architect → implementer | baseline、target、slice、compatWindow、rollback | report、file、commit |
| slice-candidate | implementer → verifier | changedFiles、compatImpact、rollbackStep | commit、diff、test |
| compatibility-evidence | verifier → reviewer | oldPath、newPath、comparison、rollbackResult | test、diff、report |
| findings | reviewer → architect/implementer | findings、requiredCompatCheck、scope | report、message |
| verdict | reviewer → driver | verdict、remainingRisk、cutoverRecommendation | report、commit、diff、test |

**bounded Loop**

- loopId：migration-validation；
- entry：architect / migration_plan_ready；
- participants：architect、implementer、verifier、reviewer；
- evaluatorRole：reviewer；
- candidateKind：slice-candidate；
- verdictKind：PASS、FAIL、BLOCKED；
- maxAttempts：2；
- passRoute：compatibility Gate → closure；
- retryRoute：findings → implementer/architect → verifier；
- capExhaustedRoute：cap_exhausted → driver replan or abandon；
- requiredEvidence：commit、diff、test、report、file。

一个 attempt 可以包含一个声明过的 migration slice，但不得把多个未声明
slice 隐藏在一个 candidate 中。旧行为失败、rollback 未验证或兼容窗口
未覆盖时只能 FAIL/BLOCKED，不能沿 passRoute。

**Human Gate / Closure**

- default human mode：checkpointed；
- gateId：migration-compatibility-approval；
- decisionScope：是否接受 declared slice、兼容证据和 rollback plan；
- blockingScope：closure；
- options：approve、revise、stop；
- required：true；
- onUnavailable：blocked；
- closure owner：driver；
- requiredLoopOutcomes：migration-validation:passed；
- requiredVerdicts：PASS；
- requiredEvidenceKinds：commit、diff、test、report；
- openGatePolicy：reject；
- allowed outcomes：completed、failed、abandoned；
- userOverride：false。

**按需升级角色**

跨服务/跨仓库影响可在新的 remediation branch 请求 researcher 或额外
architect；不得在旧 Loop 中无限添加迁移专家。

**显式 non-goals**

不执行生产 cutover、自动删除旧 API、不凭模型判断兼容、不引入全局
migration scheduler，也不把 release-readiness 伪装成迁移成功。

**E2E 场景与验收**

在临时 repo 中提供 old API 与 new API 兼容 fixture。architect 先写
baseline/target/rollback plan，implementer 做一个最小 slice，verifier
运行 old/new contract tests 和 rollback smoke，reviewer 首轮拒绝缺少
旧路径证据，第二轮 PASS。验收：

1. baseline commit 和 target diff 可重读且不被新 attempt 覆盖；
2. rollback evidence 缺失时 closure 被阻塞；
3. 第二 slice 不能越过第一 slice 的 Gate 或改变其 scope；
4. cap 后没有隐藏第三次迁移；
5. source mutation 不改变已 Freeze 的 migration contract。

**与 v0.3 Topology 的关系**

没有等价的 v0.3 内置模板；它复用 trio/four-role-dev 的实现-评审骨架，
但新增加 compatibility/rollback owner，因此不做自动 alias。

### D.5 audit-and-hardening

**id / 名称 / 描述**

- id：audit-and-hardening
- name：Audit and Hardening
- description：对明确边界做安全/可靠性审计，形成可验证 finding，并在批准
  后完成最小加固与 rescan。
- 适用：AppSec、权限/身份、敏感数据、依赖、运行时 invariants、可靠性
  guard 和 prompt/tool boundary。
- 不适用：合规认证签字、生产安全响应、没有明确资产和 evidence oracle
  的泛化“看一遍”。

**Mission contract**

Mission 必须声明 audited assets、trust boundaries、风险标准、禁止触碰
的范围、required checks、rescan/closure evidence 和 residual-risk policy。
hardening-auditor 的 finding 必须能映射到位置/资产、影响、修复建议和
可重现检查；“看起来安全”不是 evidence。

**Initial roles 与权利**

| roleId | Role Preset | sandbox / permission | model strategy | compositionTools | orchestraTools | write boundary |
| --- | --- | --- | --- | --- | --- | --- |
| driver | controller session | caller-selected；无隐式升级 | deployment default pinned | caller Agent Preset；不由 topology 追加 | orchestration、report、handoff | audit charter、graph/journal |
| hardening-auditor | hardening-auditor | read-only / workspace-write + ask base | deployment default pinned | tool-fs、tool-fs-search、tool-bash | orchestra_report、orchestra_handoff | 只写 findings/threat model report |
| investigator | investigator | read-only / workspace-write + ask base | deployment default pinned | tool-fs、tool-fs-search、tool-bash | orchestra_report、orchestra_handoff | 只写 reproduction/impact evidence |
| implementer | implementer | workspace-write / workspace-write + ask | deployment default pinned | tool-bash、tool-fs、tool-fs-search | orchestra_report、orchestra_handoff | 只改批准的 hardening scope |
| verifier | verifier | read-only / workspace-write + ask base | deployment default pinned | tool-bash、tool-fs-search | orchestra_report、orchestra_handoff | 只写 rescan/regression evidence |
| reviewer | reviewer | read-only / workspace-write + ask base | deployment default pinned | tool-fs、tool-fs-search、tool-bash | orchestra_report、orchestra_verdict、orchestra_handoff | 只写 security review；唯一 evaluator |

**Graph / routes / ownership**

控制流：

driver --audit-scope--> hardening-auditor
hardening-auditor --finding--> investigator
investigator --remediation-brief--> implementer
implementer --hardening-candidate--> verifier
verifier --rescan-evidence--> reviewer
reviewer --findings--> investigator/implementer
reviewer --verdict--> driver

ownership：

- finding/threat model：hardening-auditor；
- impact/reproduction：investigator；
- remediation code：implementer；
- deterministic rescan/regression：code/evidence gate，verifier 解释；
- security quality verdict：reviewer；
- residual-risk Gate 与 closure：driver + direct Human Gate。

typed handoffs：

| kind | from → to | required payload | required evidence |
| --- | --- | --- | --- |
| finding | hardening-auditor → investigator | fingerprint、asset、location、impact、severity、fix、reproductionOrWhyNot | report、file、message |
| remediation-brief | investigator → implementer | reproduction、rootCause、repairScope、risk | report、test、file |
| hardening-candidate | implementer → verifier | changedFiles、controlAdded、knownRisks | commit、diff、test |
| rescan-evidence | verifier → reviewer | originalFinding、rescan、regression、residualRisk | test、diff、report |
| verdict | reviewer → driver | verdict、openFindings、residualRisk | report、commit、diff、test |

**bounded Loop**

- loopId：hardening-remediation；
- entry：investigator / remediation_ready；
- participants：investigator、implementer、verifier、reviewer；
- evaluatorRole：reviewer；
- candidateKind：hardening-candidate；
- verdictKind：PASS、FAIL、BLOCKED；
- maxAttempts：2；
- passRoute：security-risk Gate → closure；
- retryRoute：findings → investigator/implementer → verifier；
- capExhaustedRoute：cap_exhausted → driver requests user risk decision or abandon；
- requiredEvidence：report、commit、diff、test。

审计 finding 可以在 Loop 前记录为 immutable evidence；初始 finding 的
rescan 与 residualRisk 可以是未产生/unknown，绝不能由 auditor 预填未来
结果。只有 remediation candidate 的 rescan 和 regression evidence 才能
进入 PASS；缺少 rescan 只能 BLOCKED，不得被低严重度标签掩盖。

**Human Gate / Closure**

- default human mode：checkpointed；
- gateId：security-risk-acceptance；
- decisionScope：接受已修复 finding 或明确 residual risk 的处理；
- blockingScope：closure；
- options：approve、remediate、stop；
- required：true；
- onUnavailable：blocked；
- closure owner：driver；
- requiredLoopOutcomes：hardening-remediation:passed；
- requiredVerdicts：PASS；
- requiredEvidenceKinds：report、commit、diff、test；
- openGatePolicy：reject；
- allowed outcomes：completed、failed、abandoned；
- userOverride：false；risk acceptance 必须是 direct user decision，不是
  reviewer 或 auditor 自授。

**按需升级角色**

复杂 threat model 可在新的 remediation branch 请求 architect；专项 UI/
browser/security provider 不作为审计模板的默认隐式依赖。

**显式 non-goals**

不提供法律/合规认证、不自动批准风险、不做生产 incident command、不把
静态扫描分数当成安全证明、不默认写外部 ticket 或 deploy。

**E2E 场景与验收**

在 fixture repo 中种入一个可复现的 authorization/secret-handling/tool
boundary 缺陷。hardening-auditor 先只记录 fingerprint、位置、影响、修复
要求和 reproduction/why-not，不能填写未来 rescan；investigator 建立
reproduction，implementer 做最小 patch，verifier 运行 exploit/regression
rescan，reviewer 先拒绝缺少 rescan、再在证据齐全后 PASS。用户
通过 Gate 后才 completed。验收：

1. audit 只读角色不能直接改代码或风险状态；
2. finding fingerprint、rescan 和 residual-risk 可跨 attempt 重读；
3. 修复后仍可复现或 rescan 缺失时不得 PASS；
4. user risk decision 不能由模型字段伪造；
5. closure 后不能新增 hardening attempt，旧 finding/evidence 保留。

**与 v0.3 Topology 的关系**

没有等价的 v0.3 内置模板；它复用 bug 的 diagnosis/repair/review 骨架，
但增加 security asset、threat boundary、rescan 和 residual-risk Gate，
因此不是 bug 模板的改名。

## E. Frozen Role Pool

### E.0 共同 Role Preset 规则

每个 Role Preset 必须落成一份可 mount 的完整 composition。6B 可通过
copy official base preset 后删减 rows，但最后必须仍有有效 top-level plugin
list、persona/instructions、所需 tool rows、compaction/skills（如合同
要求）和 profile preflight；禁止只创建一段 persona 文本再声称“有 preset”。

共同默认：

- base DSH Agent Preset：默认从 standard copy；minimal 只给 verifier/
  constrained inspection 作为经 E2E 证明的替代，code 只在 codeRuntime
  capability 已 preflight 时使用；
- base Permission Preset：workspace-write + ask；
- effective sandbox：按角色表写死，不从 topology 的 title 推断；
- model：deployment default pinned，显式完整 selection 优先；
- 不启用 subagent provider、Codex/Claude Code optional provider 或
  danger-full-access 作为隐式依赖；
- mount 失败、compositionTools row 缺失或 visible-scope mismatch、以及
  orchestraTools 的 host service/schema 缺失，都要在 Session publish 前
  返回稳定 provisioning diagnostic；后者不能通过向 DSH composition 加 row
  来绕过。

### E.0.1 最终 ID 与 legacy mapping

v0.4 使用新的 versioned lower-kebab IDs，避免把 v0.3 的 minimal composition
误认成完整 Role Preset。旧 ID 继续可解析，但不自动迁移、不覆盖用户文件：

| 语义角色 | v0.4 stable ID | legacy ID | 处理 |
| --- | --- | --- | --- |
| implementer | orchestra-v04-implementer-v1 | orchestra-implementer | legacy 保留；新 Topology 只引用 v0.4 ID |
| reviewer | orchestra-v04-reviewer-v1 | orchestra-reviewer | legacy 保留；新 Topology 只引用 v0.4 ID |
| investigator | orchestra-v04-investigator-v1 | 无 | 新增 v0.4 ID |
| verifier | orchestra-v04-verifier-v1 | 无 | 新增 v0.4 ID |
| architect | orchestra-v04-architect-v1 | 无；oracle 不自动映射 | 新增 v0.4 ID；旧 oracle 继续 legacy |
| researcher | orchestra-v04-researcher-v1 | 无 | 新增 v0.4 ID |
| hardening-auditor | orchestra-v04-hardening-auditor-v1 | 无 | 新增 v0.4 ID |

项目级/全局级同名文件优先于 catalog builtin；已存在文件只读解析并由
Blueprint/Loader 验证，绝不因版本升级覆盖。legacy Topology 的 preset
引用保持 legacy，只有显式 Topology amendment 才能切换到 v0.4 ID。D.1–D.5
表中的 Role Preset 列是语义角色标签，解析时必须使用本表对应的 stable ID。

### E.1 implementer

- purpose：在已批准 mission/repair scope 内实现代码和测试。
- decision rights：选择实现细节、提交 candidate、解释已改文件。
- prohibitions：不能改 Charter/Document/Graph、不能发 review PASS、不能改
  scope 外文件、不能自行扩展 role 或权限。
- DSH base composition：standard copy；保留 persona、agent-instructions、
  tool-bash、tool-fs、tool-fs-search、skills、plan-mode、compaction、todo；
  默认移除 delegation、goal、tool-web 和 Code Mode presentation，除非
  topology 的 capability fields 与 profile preflight 明确需要。code 是可选
  explicit variant，不是默认。
- compositionTools：tool-bash、tool-fs、tool-fs-search。
- orchestraTools：orchestra_report、orchestra_handoff。
- sandbox/permission/model：workspace-write；workspace-write + ask；
  deployment default pinned。
- report/handoff：candidate 必须有 summary、changedFiles、commit/diff/
  test refs、knownRisks；findings 只由 reviewer route 回来。
- optional deps/mount failure：Code Mode、web、optional subagent provider
  缺失时不能静默降级；若不是 required 则不出现在该 composition。
- reused by（exhaustive）：initial use = feature-development、
  bug-diagnosis-and-fix、refactor-and-migration、audit-and-hardening；
  remediation-only = architecture-decision；deferred/future = release-readiness。

### E.2 reviewer

- purpose：按 frozen acceptance 和 review scope 评价 candidate，产出 findings
  或质量 verdict。
- decision rights：唯一能在上述实现/decision Loop 中记录 PASS/FAIL/BLOCKED
  的 evaluator。
- prohibitions：不能改源码、不能替 implementer 修复、不能伪造用户 Gate、
  不能改 Charter/Graph/Journal、不能把新问题偷偷扩进 repair scope。
- DSH base composition：standard copy；保留 tool-fs、tool-fs-search、只读
  tool-bash、必要 tool-web、skills/compaction，移除 editor、delegation、
  goal 和 Code Mode。
- compositionTools：tool-fs、tool-fs-search、tool-bash。
- orchestraTools：orchestra_report、orchestra_verdict、orchestra_handoff。
- sandbox/permission/model：read-only effective sandbox；workspace-write +
  ask base；deployment default pinned。
- report/handoff：R1/R2 或 topology 声明的 bounded review；verdict 必须
  引用 report、diff/test 或 decision evidence。
- optional deps/mount failure：tool-web 只有在 topology required 且 preflight
  成功时启用；其余缺失不能阻止纯本地 code review。
- reused by（exhaustive）：initial use = feature-development、
  bug-diagnosis-and-fix、refactor-and-migration、architecture-decision、
  audit-and-hardening；remediation-only = none；deferred/future =
  release-readiness。

### E.3 investigator

- purpose：建立 bug symptom、reproduction、root cause、repair scope 和
  未知项。
- decision rights：调查结论与 evidence sufficiency recommendation；不能
  自行批准修复或发 quality PASS。
- prohibitions：不能把猜测写成 root cause、不能改 repair scope 外文件、不能
  直接关闭 bug、不能改权限/Charter。
- DSH base composition：standard copy 的 read-only variant；保留
  tool-fs、tool-fs-search、tool-bash、skills、compaction；tool-web 只作为
  explicit optional row。
- compositionTools：tool-fs、tool-fs-search、tool-bash。
- orchestraTools：orchestra_report、orchestra_handoff。
- sandbox/permission/model：read-only；workspace-write + ask base；
  deployment default pinned。
- report/handoff：diagnosis 必须含 reproduction、rootCause 或明确
  unknown、candidate evidence、repairScope、knownRisks。
- optional deps/mount failure：web/provider 不存在时仍可做本地调查；若任务
  required web，则 preflight fail，而不是返回“已研究”。
- reused by（exhaustive）：initial use = bug-diagnosis-and-fix、
  audit-and-hardening；remediation-only = feature-development；
  architecture-decision、refactor-and-migration 由 researcher/architect
  路径负责，不默认加入 investigator；deferred/future = release-readiness。

### E.4 verifier

- purpose：解释 deterministic test/lint/typecheck/build/diff/schema 结果并整理
  evidence；命令本身由 code/Gate 执行。
- decision rights：报告检查是否可复现、哪些 acceptance evidence 缺失；
  不能发 reviewer quality verdict 或用户 approval。
- prohibitions：不能修改代码、不能把一次命令退出 0 解释成全局成功、不能
  跳过 declared required check。
- DSH base composition：优先使用精简 standard copy（bash、fs-search、
  report/handoff、最少 compaction）；6B 只有在目标 profile 的 public
  minimal persistent-shell seam 有真实 E2E 后，才可切 minimal。
- compositionTools：tool-bash、tool-fs-search。
- orchestraTools：orchestra_report、orchestra_handoff；deterministic checks 以 runtime command adapter
  注册，不把命令当作 Agent 自创工具。
- sandbox/permission/model：read-only；workspace-write + ask base；
  deployment default pinned。
- report/handoff：verification 必须列 command、exit/result、scope、evidence
  refs、未执行项目；不能只写“tests pass”。
- optional deps/mount failure：shell/tool surface 不可证明时在 reservation
  前 fail；不以模拟工具名补齐 receipt。
- reused by（exhaustive）：initial use = feature-development、
  bug-diagnosis-and-fix、refactor-and-migration、audit-and-hardening；
  remediation-only = none；architecture-decision uses deterministic
  code/evidence checks plus reviewer and does not provision verifier；
  deferred/future = release-readiness。

### E.5 architect

- purpose：把研究事实、候选方案、权衡、影响和推荐收敛为 decision brief。
- decision rights：拥有 architecture recommendation/decision brief 的
  语义写权；不拥有用户最终选项、review verdict 或 code mutation 权。
- prohibitions：不能把推荐写成已批准、不能直接修改源码/roster、不能省略
  alternatives/risks/evidence。
- DSH base composition：standard copy 的 analysis variant；保留 tool-fs、
  tool-fs-search、skills、compaction、report/handoff；移除 bash、editor、
  delegation、goal、web 和 Code Mode。web 是显式 variant。
- compositionTools：tool-fs、tool-fs-search。
- orchestraTools：orchestra_report、orchestra_handoff。
- sandbox/permission/model：read-only；workspace-write + ask base；
  deployment default pinned，强模型必须显式 override。
- report/handoff：decision brief 必须列 decision question、alternatives、
  recommendation、tradeoffs、constraints、migration impact、unknowns 和
  evidence refs。
- optional deps/mount failure：若 web 不可用但 mission 允许 local evidence，
  明确列 no-web limitation；若 required web，则 fail preflight。
- reused by（exhaustive）：initial use = architecture-decision、
  refactor-and-migration；remediation-only = feature-development、
  bug-diagnosis-and-fix、audit-and-hardening；deferred/future =
  release-readiness。

### E.6 researcher

- purpose：收集和整理 source-backed facts、local evidence、unknowns 和
  option inputs。
- decision rights：选择搜索/读取路径并提交 research brief；不能选择最终
  architecture option、发 PASS 或改变 mission。
- prohibitions：不能以二手资料支撑关键事实、不能写源码、不能把 source
  availability 当作 correctness、不能伪造用户批准。
- DSH base composition：standard copy 的 research variant；保留
  tool-fs-search、tool-fs、skills、compaction、report/handoff；移除 bash、
  editor、delegation、goal、web 和 Code Mode。web 是显式 variant。
- compositionTools：tool-fs-search、tool-fs。
- orchestraTools：orchestra_report、orchestra_handoff。
- sandbox/permission/model：read-only；workspace-write + ask base；
  deployment default pinned。
- report/handoff：research brief 必须保留 source URL、访问/commit 版本、
  fact/inference 标签、unknowns、evidence refs 和下一步问题。
- optional deps/mount failure：web provider 缺失时只能做 local-only research
  并将缺口标记为 blocked/deferred；不静默声明完成。
- reused by（exhaustive）：initial use = architecture-decision；
  remediation-only = bug-diagnosis-and-fix、refactor-and-migration；
  deferred/future = product-or-ui-design、release-readiness、
  audit-and-hardening。audit-and-hardening 本轮使用 hardening-auditor，
  不默认加入 researcher。

### E.7 hardening-auditor

- purpose：做有边界的安全/可靠性审计，产出可重现 finding、threat/
  control requirement 和 remediation acceptance。
- decision rights：定义 finding 的证据标准、严重度和 rescan 要求；不能
  直接改代码、批准 residual risk 或发最终 PASS。
- prohibitions：不能把扫描分数当证明、不能回显 secret、不能把客户/用户
  数据写入 report、不能以合规标签代替具体 control evidence。
- DSH base composition：standard copy 的 security-analysis variant；保留
  tool-fs、tool-fs-search、tool-bash、skills、compaction、report/handoff；
  tool-web 仅在 audit mission 显式需要且 preflight 成功时启用；移除
  editor、delegation、goal 和 Code Mode。
- compositionTools：tool-fs、tool-fs-search、tool-bash。
- orchestraTools：orchestra_report、orchestra_handoff。
- sandbox/permission/model：read-only；workspace-write + ask base；
  deployment default pinned。
- report/handoff：初始 finding 必须有稳定 fingerprint、asset/location、
  impact、severity、reproduction 或 why-not、fix；rescan、regression 和
  residual-risk 是 verifier → reviewer 的后置事实，初始 residual risk
  只能标 unknown。只把可重读 evidence 交给 investigator/reviewer。
- optional deps/mount failure：SAST/DAST、web、browser、外部 compliance
  provider 都是 optional；required capability 缺失时 blocked/deferred，不
  伪造 covered。
- reused by（exhaustive）：initial use = audit-and-hardening；
  remediation-only = none；deferred/future = release-readiness 的 security
  lane。

### E.8 评估但不冻结的 Role Pool

| 候选 | v0.4 处理 | 原因 |
| --- | --- | --- |
| debugger/investigator | canonical id 冻结为 investigator；保留 debugger 作为概念别名，不新增第二份 composition | 调查与根因是 bug 图的核心，名称统一避免 preset copy 爆炸。 |
| frontend-designer | defer | 需要 browser、image/vision、design-file 等 optional capability 和独立 write boundary。 |
| release-auditor | defer | release-readiness 还未 ship；先复用 verifier/reviewer 的 evidence contract。 |
| documenter | defer as role | Driver Journal、Document 和 deterministic Markdown 已有 owner；不能为写文档复制一个无 decision rights 的 Agent。 |

## F. Implementation batches

> 状态（2026-08-25）：6B-0~6B-5 **全部完成**并独立提交（
> `orchestra-role-presets.ts` / `BUILTIN_TOPOLOGIES` / 各 `test-*.mjs`），
> 本地 contract/integration tests 全绿；各批次的 E2E 场景与验收入口见
> `UPDATE-v0.4.0.md` §5，由外部 DSH 验收 Session 执行。下文保留为批次合同。

### 6B-0 · Role Preset foundation

- 建立七个 Role Preset 的 complete composition/copy 来源和 trust；
- 在当前 rc.6 public seam 做 mount、composeFrom、required tool surface、
  permission/sandbox/model pin 的 interface test；
- 以 profile capability preflight 覆盖 standard rows、minimal fallback、
  codeRuntime/web optional 缺失；
- 证明 setup/mount 失败不会 publish Session/Agent。

### 6B-1 · feature-development

- 集成 topology catalog、Frozen Charter、2B provisioning、5A/5B graph；
- 验证 implementation-review Loop、human gate、closure 和 cap packet；
- 用临时 fixture repo 做 candidate → verify → review → terminal 的
  contract/integration tests；真实 full-session E2E 由外部 DSH 验收 Session
  根据 v0.4.0 Update Note 执行。

### 6B-2 · bug-diagnosis-and-fix

- 复用 6B-0 与 verifier/reviewer；
- 增加 reproduction/rootCause/repairScope typed handoff；
- 以 contract/integration tests 验证错误诊断、缺证据、越界写和 cap
  exhaustion；真实 full-session 负面路径交由外部 DSH 验收 Session。

### 6B-3 · architecture-decision

- 集成 researcher/architect/reviewer 的 read-only graph；
- 验证 stable source refs、decision brief、review Loop 和 direct user choice；
- 以 deterministic/contract tests 验证 Frozen snapshot 与 source file 后续
  变化隔离；真实多 Session 执行由外部 DSH 验收 Session覆盖。

### 6B-4 · refactor-and-migration

- 复用 implementer/architect/verifier/reviewer；
- 增加 baseline、compatibility window、slice、rollback typed handoff；
- 以 fixture/integration tests 验证 old/new contract 与 rollback smoke；真实
  full-session 迁移路径交由外部 DSH 验收 Session。

### 6B-5 · audit-and-hardening

- 集成 hardening-auditor/investigator/implementer/verifier/reviewer；
- 增加 finding fingerprint、threat boundary、rescan 和 residual-risk Gate；
- 以 contract/integration tests 验证缺少 rescan、风险伪造、secret 泄漏和
  closure 后续写入；真实 full-session 路径交由外部 DSH 验收 Session。

完成 6B-0 至 6B-5 后，开发团队不执行真实 full-session E2E。最终必须交付
`UPDATE-v0.4.0.md`，说明代码状态、安装/更新方式、能力与兼容变化、已运行的
本地验证、未运行的真实 E2E、每个首发 Topology 的成功/失败场景与可复制验收
入口。用户将在 DSH 中另开“创造模式”Session，先阅读该 Update Note 和当前
代码，再独立设计并执行 E2E；该 Session 的结果不回写为本 Catalog 的既成事实。

### Deferred roadmap

- 0.4.x：release-readiness；根据 verifier/reviewer 与 hardening 的结果决定
  是否需要独立发布权限/外部系统边界。
- 0.5：product-or-ui-design、frontend-designer，以及需要 browser/image
  capability 的 human/design workflow。
- documenter 只有在未来出现独立 decision rights、write scope 和 E2E
  价值时才重新评估；普通 Journal/Markdown 不创建该角色。

## G. 兼容矩阵、开放风险与审查边界

### G.1 兼容矩阵

| 资产 | 当前事实 | 6A 冻结处理 | 6B 预期 |
| --- | --- | --- | --- |
| duo/trio/oracle/four-role-dev | v0.3 内置 Topology | 保留可读，不静默映射 | 通过 explicit alias/migration policy 验证；缺 Graph 字段时标 legacy |
| orchestra-implementer/reviewer/oracle | v0.3 Role Preset | 保留旧 id，不能当作新完整 role contract | 新 preset 可由 official base copy 建立，旧 Session 不改写 |
| hardening-auditor | v0.4 新增 Role Preset | 6A 冻结但尚未实现 | 由 standard security-analysis copy 与真实 finding/rescan E2E 证明 |
| standard/minimal/code | DSH official complete compositions | 作为 base composition 候选，不等于本仓库角色 preset 已实现 | 由 capability preflight 证明 mount 和实际 tool surface |
| DSH 0.1.0-rc.6 manifest | 本仓库当前实现 seam | 不在文档中升级依赖 | 6B 先以 rc.6 编译/E2E；另做 live rc.2 integration evidence |
| DSH 0.1.1-rc.2 | 官方当前 release commit | 只作为研究事实 | 不把 rc.2 新增 private/未声明 seam 带回 runtime |

### G.2 Open risks

1. 官方 rc.2 的 standing mount 细节与仓库 rc.6 类型之间可能存在兼容差异；
   6B 必须记录实际 public export 和 failure behavior。
2. standard 的 web、Code Mode 和 optional provider rows 依 profile 而异；
   角色 composition 不能在没有 capability preflight 时宣称完整。
3. role-specific copy 删除 rows 后仍需在目标 DSH profile 做真实 mount；
   “YAML 能解析”不等于“Agent scope 有工具”。
4. architecture 的 research evidence 质量不能由模型自评取代 source refs
   与 reviewer/用户 Gate。
5. 五个首发 topology 都可能被过度拆成许多微角色；6B 应优先减少角色和
  parallel fan-in，而不是追求图的视觉复杂度。

### G.3 固定审查范围

Reviewer 对 Checkpoint 6A 只审：

- 本文是否确实冻结有限首发批次，而非把候选伪装成 implemented；
- 来源是否一手、版本/commit/访问时间是否可追溯，事实与推论是否分开；
- 五个 ship topology 的 role/edge/owner/loop/gate/closure 引用是否一致；
- Role Preset 是否是 complete composition contract，是否诚实处理
  Permission/Model/optional capability；
- 每项是否有可执行 E2E、主要失败路径和旧模板兼容关系；
- REQUIREMENTS.md §6 是否只做同步引用，没有扩展实现范围。

本文件不冻结 6B 的 JSON 字段、源码路径、具体 DSH private API、GUI、
recovery、release 或下一 Checkpoint。
