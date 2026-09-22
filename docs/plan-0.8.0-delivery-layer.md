# 交付层契约 v2 · 可选的 host 确定性交付（目标 0.8.0）

> **DRAFT / 未通过开工检查**：独立搜证发现9项可执行性阻断，完整清单与下一步在 [交接§8](handoff-2026-09-22-upgrade.md#8-第二部分交付层草案保持原状态)。下面的 v2 文字尚未吸收这些修正，不得直接按“冻结/最终版”开工。

> **2026-09-22：设计规格，不是已实现能力。** Owner 已授权修改旧冻结设计。本文件替代 v1.2.1 及零散追加条款；历史版本保留在 Git。唯一执行入口：[`plan-0.8.0-execution.md`](plan-0.8.0-execution.md)。
> 当前宿主目标 **DSH 0.1.7-alpha.1**，插件包仍为 **0.5.1**。第一部分的角色、A2A、动态 lane 和恢复升级单独验收；本轮**不实现**本文件的新交付层。
> 本次变更依据：[`review-2026-09-22-plugin-and-delivery.md`](review-2026-09-22-plugin-and-delivery.md) 的 D1–D6，以及 [`iteration-2026-09-22-role-and-scaling.md`](iteration-2026-09-22-role-and-scaling.md)。下述明确修正覆盖旧计划相反措辞，不以历史“冻结”阻止修正。

## 1. 产品边界与启用

Driver 选择组织方式，host 验证和执行机器可判定的动作。直接工作、原生 subagent、独立 Session/A2A、Orchestra team 均可不启用交付层；**有产物、跨角色交接或多人，并不自动开启治理**。没有启用时不强制节点记录、task-card 文件、设计门或交付工具调用，但原有权限和外部操作授权照常生效。

显式启用后才接管指定 Git ref 的交付动作。未经过本层的 Git 操作仍可能发生；插件只能对账和拒绝自己拥有的下一步，不能声称拦截所有文件写入或所有 Git 命令。

- `off`（默认）：不发行本层的合格证据/交付 PASS，不接管 ref。
- `light`：明确授权的候选身份、冻结快照执行、绑定审查、merge intent、CAS 和恢复均保留。第一版仅支持同一仓库一个活跃交付写者；第二个准入明确拒绝。可略过设计门、细粒度租约、胶囊。
- `standard`：在 light 基础上启用设计门、写面租约、决策队列、胶囊和体检。相应能力尚未实现时返回 `capability_unavailable`，不得把 light 冒充 standard。

等级、理由、授权来源和目标 ref 持久化。off → light/standard 是重新准入，不追认旧 PASS。对外发布、部署、凭据修改等**不在 Git 合并授权之内**，本层不自动执行。

## 2. 已有系统是前提，不另起一套团队

复用 `TeamState` 的 teamId、controller、原 mission、`AddedLane` 的增量目标/参与角色、`TeamRole` 的 execution/sessionId/blueprint，以及既有 reports。业务 lane 与交付 node 不等同：一个 lane 可产生多个串行候选；不要求无交付工作的 lane 有 node。

角色和运行原生边界：

- 预设由 bundle 中 `@deepseek-ai/dsh-agent-preset` 行声明；使用 `dsh-agent-preset-registry`。**不再配置 roots 或文件 mount API。**
- 泛用宿主/UI激活可走 `sessionController.resolveAgent`；Orchestra受治理冷恢复应走公开 `ctx.agents.resume({setup: preparedBlueprint.setup})`，保留两参数与同步commit并先核普通Session身份/并发恢复。私有的是SessionController内部helper。已live只核验，不假称重新执行setup。child使用原生continuation/sendMessage/drain。
- 审查者角色、verifier 与 host runner 分工不同：作者提供材料；独立角色做语义审查；host 采集执行事实。角色不能自报 exitCode/OID 获得放行。
- 成员 approval never；模型显式指定优先，否则继承 driver 当时的实际路由。角色更换产生新实例身份，历史报告不改名冒充新实例。
- 图协议目前不自动推进 attempt/cap；交付状态由本层自己的业务操作推进，**不恢复已经删除的微状态机工具**。

## 3. 先统一仓库根，后写任何新记录

新增一个共享 `resolveRepositoryContext(executionCwd)`：用外部 Git 获得 absolute common-dir、worktree 清单和当前顶层目录，realpath 后确定 repositoryId 和主 worktree `teamRoot`；执行目录保留为独立 `executionCwd`。不凭目录名去掉 `.git` 推断主根。首版不接收 bare repository；无 Git 的旧 A2A/Team 仍按原 cwd 工作，但 delivery 准入拒绝。

**所有** team/report/blueprint/charter/archive/lane/recovery/交付工具通过同一根解析，不只新工具上移。业务文件仍在各角色 executionCwd。权限 escrow 必须明确允许 teamRoot 的内部记录路径，不能默默扩大角色工作区权限。

遇到多个 worktree 既存的不同活跃 team：`split_team_state`，列出冲突路径并停止自动合并；不覆盖、不选择最新、不批量迁移。没有冲突的既有主根团队保持兼容。

记录布局（全为项目内部数据，不进交付快照）：

- `<teamRoot>/orchestra/state/team.json`：现有团队真源。
- `<teamRoot>/orchestra/nodes/<nodeId>.json`：带 schemaVersion/revision 的可恢复索引；版本化更新，只指向不可变记录。
- `<teamRoot>/orchestra/delivery/<nodeId>/g<generation>/candidate.json`、`checks.json`、`decisions.json`、`intents/<attemptId>.json`、`evidence/<runId>/…`、`reviews/<reviewId>.json`、`receipts/<receiptId>.json`：write-once；冲突内容返回 `immutable_conflict`。
- `<teamRoot>/.worktrees/orchestra/<nodeId>/<attemptId>`：host 创建的 detached 验证现场；已有目录先核身份，dirty 或身份不同不自动删除/重用。

路径由 host 校验的安全 id 推导；模型不传任意 statePath、cwd、输出路径或 git ref 命令片段。通用存储优先复用 `orchestra-records.ts` 与现有 CAS seam，不为此引入数据库/通用事件平台。

## 4. 最小记录契约

下列为必须字段；时间均为 host UTC ISO，OID 来自 Git，digest 为 canonical JSON/文件内容 SHA-256，不接受 agent 提供的“事实”。JSON 不写 undefined。每份持久化记录均有 `schemaVersion: 1`、`repositoryId`、`teamId`、`nodeId`；id 只作寻址，不作可信证明。

| 记录 | 必须内容 |
|---|---|
| NodeIndex | revision、laneId、authorRoleId、authorSessionId、execution、executionCwd、level、authorizedRef、status、generation、activeAttemptId?、candidateRef?、lastReceiptRef? |
| Candidate | generation、commit、tree、baseCommit、checksDigest、decisionsDigest、declaredScope、authorRoleId/sessionId、createdAt |
| CheckManifest | checkId、phase (`pre_merge`/`post_merge`)、仓库相对 entrypoint、argv、期望结果、timeoutMs、输出大小上限、声明环境键/模式、额外输入引用、关键前提及其可用 observer |
| MergeIntent | attemptId、generation、ref、expectedOld、candidateCommit、expectedNew、mergeTree、orderedParents、checksDigest、decisionsDigest、createdAt |
| Evidence | runId、attemptId、candidate/intent 引用、checkId、entrypointDigest、实际 commit/tree/cwd、开始/结束、exitCode 或未启动原因、取消/超时、声明和观察到的前提、输入摘要、日志引用/摘要、`pass/fail/unqualified`、reasonCodes |
| Review | reviewId、candidate+intent 引用、reviewerRoleId/sessionId/model、authorSessionId、freshContext 声明及来源、结论/问题、evidenceRefs、createdAt |
| Receipt | receiptId、attemptId、ref、expectedOld、expectedNew、observedRef、结果 (`committed`/`merged_validation_failed`/`reconciliation_required`)、postCheckRefs、recordedAt |

作者不能指定 generation、expectedNew、合格证据字段或审查者身份。冻结入口可指定一个已存在的候选 ref 作为材料；host 必须将其解析为 commit、校验祖先/范围/授权，并固定 OID 后才成为 Candidate。**冻结在检查前，不要求探索开工前写完全部验收。**

索引状态：`working → frozen → prepared → checking → review_required → ready → committing → committed`；检查失败到 `check_failed`，未知前提到 `unqualified`，前提变化到 `stale`，不可安全恢复到 `blocked`。这些是 host 操作的结果，不是让模型逐个调用“进入状态”。`committed` 和 `merged_validation_failed` 都不可退回 working。

候选/验收/决策语义变化创建 generation+1；历史只读。ref 前进只创建新 attempt/intent，不能改写旧 intent。所有证据与审查绑定**实际 attempt 的 expectedNew**；旧审查不会随 ref 漂移自动变成新放行资格。

## 5. Host runner：先有候选，后有证据

公开执行输入仅 `(nodeId, checkId)`。Host 从当前不可变 candidate/manifest/intent 查命令，**不接收任意 shell 字符串**。用目标版原生 `ctx.shell.resolve(request)` → `await ctx.shell.execute(spec)` → `await handle.result()` 和既有 sandbox policy；不另造沙箱、不实现 CI、不让 reviewer 的 read-only 会话替 host 执行写入型检查。

1. 冻结 Candidate 和检查/决策集；生成并持久化 MergeIntent；验证现场 detached 在 **expectedNew commit**，不是 tree OID，也不是可变作者工作区。
2. 确认现场 HEAD/tree、入口文件和 manifest digest、允许写入的构建/缓存目录、额外输入绑定。拒绝路径穿越/逃出现场的入口和符号链接；解释器/依赖/setup 命令也必须来自冻结的配置。
3. 安装依赖或准备现场若必须发生，由冻结 setup 检查显式描述，并记录其结果；不能把未经记录的共享 node_modules、未跟踪夹具或外部文件当成候选本身。缺少所需输入/观测器返回 unqualified，不猜测闭包。
4. 执行有限时长、有限输出的检查，保留 stdout/stderr 到受控文件，模型只收到有界摘要和指针。结果丢失、超时、取消、输出截断影响判定时不能记 pass。
5. 复核入口/树是否被检查修改；需要修改源码的检查不是对原冻结候选的成功验证。构建产物只能进入声明的输出区域，下一次从干净现场执行，不能因 HEAD 未变便假定工作树未变。

**环境是 overlay，不是封闭容器。** DSH shell 的 env 参数不能证明环境已清空。关键 env 键、工具链、依赖和模式必须有 host/受信部署 observer 的实际读数；未观测键不声称已封闭。秘密值只允许受控摘要/存在性记录，不保存明文、不向模型输出。仅凭 declaredInputs 的 hash 不证明输入集合完整。

**外部前提不是 stdout 自证。** 有受信部署 observer 才能判“本次发生真实外呼”；没有就 unknown。关键前提 unknown → unqualified。要求真链但未发生 → 不合格；不要求却发生 → 通常告警，若验收断言要求不外呼、可能有外部副作用、或场景依赖离线，则不合格。额外动作若越权，直接拒绝而不靠告警豁免。

首版**不复用跨 attempt/generation 的执行结果**，全部重跑。历史 PASS 只证明那次受限条件下的结果，不证明 hermetic、完整输入闭包或本次外呼。以后只有现成工具证明完整输入边界时才增加细粒度复用；不自建通用依赖分析器。

基线单独绑定 baseline commit/tree、相同 manifest/运行条件及实际 diagnostics。按名字+位置/类型比较新增问题；条件不同或基线失效 → `stale_baseline`。不让“原来就红”绕过不同故障。

## 6. Git 预演、合并与恢复（D1–D3/B5 的修正）

Host 只调用外部 Git plumbing。禁止自己遍历文件算树、用 index.lock 判作者、自动 reset/clean/stash 用户现场。

### 6.1 准备 intended commit

- target 必须是已授权的直接 branch ref，完整 `refs/heads/...`；拒绝 symbolic ref、HEAD、tag 及任何 worktree 正检出的目标 ref。验证前与 CAS 紧前均重新查询 `git worktree list --porcelain -z`。这不是对任意外部 Git 进程的全局锁；部署者不得同时外部检出该 ref，竞态被发现立即账实不符。
- `expectedOld = git rev-parse <ref>^{commit}`；固定 candidateCommit。
- `git merge-tree --write-tree <expectedOld> <candidateCommit>`，冲突返回 `merge_conflict`。
- 用 `git commit-tree <mergeTree> -p <expectedOld> -p <candidateCommit>` 构造 **expectedNew**，显式 author/committer/message/时间来自 host 配置与本次冻结数据。仓库未配置合法提交身份就类型化拒绝；不冒用用户身份、不修改 git config。
- 即使可 fast-forward，首版也使用明确的 intended merge commit，减少多套恢复规则。记录 orderedParents 和 OID，**持久化完整 intent 后**才允许 runner/review/CAS。对象写出后、intent 保存前崩溃只产生未引用对象；不能据此算合并。

### 6.2 放行与 CAS

全部 pre_merge 检查 pass、独立审查批准、无阻断决策/活跃写面冲突，且绑定的 candidate/manifest/decisions/intent 未变后，进入 ready。审查绑定的是合并后的 expectedNew，不能只审作者分支却忽略集成差异。

CAS 紧前重新检查 ref==expectedOld、目标未被 checkout、generation/attempt 仍当前、授权仍有效。执行：

```text
git update-ref --no-deref <ref> <expectedNew> <expectedOld>
```

ref 前进：返回 `stale_target`，不自动覆盖、不悄悄继续旧证据。新预演、新 attempt、重跑并重新审查。`update-ref` **不会更新任何已检出 worktree 的 index/工作文件**，因此本版明确拒绝 checked-out target，不实现事后“同步主工作区”。

ref 推进成功立即写不可变 receipt。post_merge 检查绑定 expectedNew detached 现场；它验证已交付 commit，不假称验证了使用者的可变工作区。失败写终态 `merged_validation_failed`，不能倒回进行中或自动回滚 ref；后续修复/revert 是新的获授权节点。

### 6.3 任意中断后的精确对账

重启先读持久化 intent，核对 expectedNew 的 tree 和 orderedParents；记录不全 → blocked，不能重新计算一个不同 new 代替历史。

| observedRef / 事实 | 恢复动作 |
|---|---|
| 等于 expectedNew | CAS 已发生，幂等补 receipt，再完成/恢复 post checks |
| expectedNew 是 observedRef 的祖先 | 本次已交付且 ref 后来前进；按原 expectedNew 补账，单独记录 later tip，不把 later tip 变成本次候选 |
| 等于 expectedOld | 在假设 ref 未被外部移动再退回时，本次未推进；重新核授权/检查/审查绑定后才可原 CAS 重试。发现 reflog/外部移动迹象不能证明未执行时 → reconciliation_required |
| 不包含 expectedNew | `reconciliation_required`；停止本节点后续交付，保留 observedRef，请受权操作者对账 |
| receipt 已有但对应 expectedNew 不再可达 | 已记账交付被外部改写，立即阻断；不抹除历史 receipt |

**candidateCommit 在分支历史里不是本次 CAS 成功的证明**。所有恢复以持久化的精确 expectedNew 为锚。对恶意改写 ref/reflog 的进程不承诺不可抵赖性或全局事务原子性。

## 7. 独立审查与设计门

light 的候选审查要求非作者的独立 Session、记录双方 session/model、所读 candidate/intent/evidence。Host 记录真实调用身份，拒绝作者自签；fresh context 的创建事实可记录，但不声称能证明模型训练独立或没有任何外部信息。

standard 的 F1′ 设计门在实现前增加独立设计审查。第二个可用模型优先；只有同模型可用可记 `degraded`，不能声称异质，`gate_not_run` 不能冒充已通过。独立会话本身仍必需。

补审聚焦差异及影响面；到约定轮次上限应升级真实阻断项，而不是隐藏新缺陷或无限加审。首版执行证据仍全量重跑，不能用审查者一句“无影响”放行复用。

## 8. standard 后续扩展（不挡住第一个 light 纵切）

### 写面租约

Host 签发 repoId/nodeId/ownerSessionId/epoch、规范化路径前缀、有效期及上次确认。无法枚举写面时仓库级独占。路径相交拒绝准入；实际改动超申报范围点名，但触及他人活跃租约必须拒绝冻结/合并，豁免不能绕过。超时不等于旧进程停止：先核 host 活动/终止并对账，确认后才能提高 epoch 交接；未知则 blocked。列明每条豁免的理由/加入人/时间，并在当次报告完整输出。

### 决策与不可重复动作

决策含 question、分类、owner、blocks、authorizedDefault、costBound、deadline、state、resolvedBy、supersedes。Host 持久化截止时间，原生 timer 负责唤醒，启动时扫描补办过期项；处理幂等。默认仅在既有授权内、可撤销、有成本上限；不能把默认记成用户批准。晚到答案创建新决策并评估受影响节点。

技术问题交 oracle，范围问题交 driver；新增权限/产品风险进决策队列；安全或不可逆不走默认继续。`do_not_repeat` 为 attempted/unknown 时阻断重试，只有受权人提交带证据的处理决定才能解除，不靠模型自授。

### 胶囊、摄入与体检

机器部分由节点/角色/Git 事实生成，角色只补下一步、已知失败、不可重复动作等不可机械推断信息。缺失标 incomplete，允许恢复后补齐；不可重复动作未知仍阻断该动作。消息带引用，不把整段状态复制成另一个真源。

架构/相关历史问题摄入只针对有实际 fault_ref 的检查，要求解释相关性；不纳入通用缺陷管理产品。机制成本按根任务统计，失败/取消/消息/返工也计入；`total = existing + added`，不能又把沟通算动作又宣称 total==added。没有可靠计量记 unknown，不编造效率比率。

体检保留五节：降级、全量豁免、决策年龄和等级分布、plan/implement/verify 成本与机制复查、证据质量；另列立即阻断的 ref/账本不符与已合并节点再派发。未实现指标标 unavailable，不能当零。成本只报警；停用机制要求连续窗口有成本、无独有拦截、原故障有等强覆盖，并记录责任人与执行结果。

## 9. 交付与验证边界

N1–N7 保留为验收标识，具体用例/文件/实施顺序见执行入口。先交付一个可选 light 纵切，再实现 standard 扩展；不把完整治理系统或 P4 报表设为纵切开工前置。第一部分真实 Session/child/浏览器/跨重启验证仍不可由本规格或单测替代。

达到已承诺范围的机器及真实运行验收后才能讨论 bump 0.8.0；本规格改完、工具存在、计划勾选或 reviewer 写 PASS 都不等于已经交付。
