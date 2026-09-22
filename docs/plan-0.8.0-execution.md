# 交付层 v2 执行入口（2026-09-22）

> **DRAFT，先修计划，不直接实现**：当前仍有9项独立搜证确认的设计阻断；先读 [交接文档§6](handoff-2026-09-22-upgrade.md#6-第二部分文档已重写但仍有9处待修)。第一部分源码当前也有3处TS错误。下方顺序是拟议地图，不是已获最终开工验收。

> **今晚执行者从这里开始。** 这是尚未实施的第二部分；不要把文档状态当产品能力。本轮只修第一部分和本计划，**不要立即实现本计划**。
> 规范唯一来源：[`plan-0.8.0-delivery-layer.md`](plan-0.8.0-delivery-layer.md)。本文件负责依赖顺序、接口落点和验收。取代旧 S/P/V 条目互相覆盖的执行顺序；旧裁定保留作历史证据，不再要求执行者叠加解释。
> 当前源码迁移到 DSH **0.1.7-alpha.1**；插件版本仍 **0.5.1**。开发仅 **dev-orchestra:4600**，兄弟项目 **dev-trinity:4601**；原 dev/web、4599 和历史会话不动，不推送、不发布。

## 0. 开工前确认，不重做整个审计

1. 读 `STATE.md` 当前段、`docs/upgrade-0.1.7-alpha.1-implementation.md` 的实际 commit/测试/运行期记录，以及契约 v2。交接时核对 HEAD 和 working tree，保留已有修改。
2. 第一部分必须先完成角色新建/首次派活/重启恢复、native child 后续投递/接管、strict dismiss、浏览器装载等验证。未通过的相关路径先修；不要用交付层绕过坏掉的底座。
3. Host train 以 package.json 和目标发布包为准。旧 `agent-presets` roots、`mountPreset`、SessionController 私有 resume helper（不是公开 AgentRegistry.resume）、旧 client runtime 和 `shell.run/start` 都不能抄用。
4. 安全前提：Git 可用；沙箱后端真正 enforcing；有获授权的**未被 checkout 的**集成 ref；有合法 Git commit identity；测试使用隔离仓库/新会话。缺项类型化退出，不去改全局配置、用户分支或安装同名 host 实体副本。

本计划不要求先写齐所有节点的验证清单、画完整图或配齐固定角色。开发可探索；**候选冻结前**必须补齐本候选所需检查与决策。

## 1. 实施顺序与交付切片

| 顺序 | 范围 / 文件 | 完成条件 |
|---|---|---|
| R0 根统一 | 新 `src/orchestra-repository.ts`；接入 `orchestra.ts`、`a2a.ts` 读取 team/report 的路径、state/records/blueprint/charter/archive/recovery 调用点 | 主 worktree 与 linked worktree 得到同一 teamRoot/repositoryId；执行 cwd 不变；冲突旧团队不覆盖 |
| R1 身份与冻结 | 新 `src/orchestra-delivery.ts`、`src/orchestra-delivery-store.ts`；复用 records 的文件写入/CAS | off 默认；授权准入；light 仓库级单交付写者；Node/Candidate/manifest/decisions 先于执行落盘；不可变记录冲突可判 |
| R2 Git intent | 新 `src/orchestra-git.ts` | 用真实 Git 构造 expectedNew commit；detached 验证现场属于该 commit；完整 intent 先落盘；checkout 目标/冲突/非法 ref 拒绝 |
| R3 host 执行 | 新 `src/orchestra-evidence.ts`，shell 接口适配 | 仅 nodeId/checkId → 冻结清单；有限执行与取消；实际 cwd/tree/前提/日志留痕；unknown 不冒充 pass |
| R4 审查与 CAS | 交付模块 + 小型工具注册 seam | 非作者 review 绑定当前 intent/证据；stale 拒绝；update-ref expectedOld CAS；postcheck 与不可逆终态 |
| R5 崩溃恢复 | store/Git/交付模块，不引入第二本账 | 每个断点的精确 expectedNew 对账、幂等 receipt、未知阻断；light 端到端无人介入测试成立 |
| R6 standard | 后续 `orchestra-leases.ts`、`orchestra-decisions.ts`；设计门/基线 | 范围租约、host deadline 恢复、迟到决策、F1′、基线差集实测通过 |
| R7 恢复与观测 | 后续 capsule/health seam、现有面板和报告渲染 | 不可重复动作、人节点解除、五节+阻断项、成本真实性和文档闭环 |

**R0–R5 是第一条可交付纵切。** R6/R7 不是其前置，但没有它们不能宣称 standard 或全部 0.8.0 验收完成。每个新机制必须关联本轮审阅/真实失败用例的 fault_ref；没有用途的字段和抽象不实现。

## 2. 接口责任（约定实现形状，不是现成 API）

下列是**待新增的插件内部接口**；不要声称 DSH 已提供它们。按项目现有 error class / Result 风格统一即可，字段语义以契约 §4 为准。

```ts
resolveRepositoryContext(executionCwd, signal)
  // -> { repositoryId, commonDir, teamRoot, executionCwd, isGit }
admitDelivery(team, laneId, authorRoleId, authorization, level)
  // -> NodeIndex; off 不产生节点，非 Git / 无授权拒绝
freezeCandidate(nodeId, candidateRef, checkManifest, decisions, expectedRevision)
  // -> Candidate; host 解析真实 OID，冻结 digest；模型提供的是待核材料
prepareMerge(nodeId, expectedRevision)
  // -> MergeIntent + validationWorktree；不推进 ref
runFrozenCheck(nodeId, checkId, signal)
  // -> Evidence；不能接收 command/cwd 覆盖
recordReview(callerIdentity, nodeId, attemptId, evidenceRefs, findingPayload)
  // -> Review；身份从当前 Session 得到，不从 payload 信任
commitDelivery(nodeId, expectedRevision, signal)
  // -> Receipt；校验 current generation/intent/evidence/review 后 CAS
reconcileDelivery(nodeId, signal)
  // -> Receipt 或 typed blocked；永不自动 reset 用户树
```

`expectedRevision` 防止旧并发请求覆盖新节点。Evidence/Review 都携带 attemptId；CAS 入口不接受 role 自报的 expectedNew/通过数/exitCode。新 generation 保留旧记录，不就地改 candidate。

公开模型工具保持**少量业务操作**，建议四个：prepare（准入/冻结/预演）、check、review、commit；查询并入现有看板/节点查询。每个操作内部处理完整状态转换，模型不逐个推进 bookkeeping 状态。工具仅在交付能力启用且调用角色有对应权限时暴露；普通 A2A 和 direct 路径不增加必调工具。准确工具名/注册风格沿用仓库规范，禁止恢复旧十六个微动作工具。

## 3. 目标版 shell 契约（已核发布包）

依据 `@deepseek-ai/dsh-shell@0.1.7-alpha.1/lib/types/index.d.ts` 和 `types.d.ts`：

```ts
const shell = ctx.get('shell');
if (!shell) /* capability_unavailable */;
const spec = shell.resolve({
  command: commandFromFrozenManifest, // host quoting，非模型直传字符串
  workdir: validationWorktree,
  timeoutMs: manifest.timeoutMs,
  onExpiry: 'kill',
  stdoutMaxBytes: manifest.stdoutMaxBytes,
  signal,
  env: declaredEnvironment,
  sandboxPolicy: resolvedHostPolicy,
});
const handle = await shell.execute(spec);
const result = await handle.result();
```

**没有公开 `run/start` 方法。** `handle.kill()` 幂等请求终止；`await handle.done` 等实际结束。`result()` 在基础设施错误时 reject；非零退出、超时、取消通常返回结构化结果。必须分别处理 exitCode/null、timedOut、aborted、sandbox.denied、runnerFailed/enforcement、stdout/stderr 截断与 spill。`done` 不 reject 不等于执行成功。

声明 `dsh-shell`（以及确有导入才需要的 dsh-subprocess 等）为与 host 对齐的 peer + dev，绝不 runtime dependency。复用 host 获取 sandbox policy 的公开接口。服务缺席/执行器不 enforcing 时，仅 delivery 入口失败，不能令整个 A2A 插件 waiting。

Shell command 的所有参数由校验后的冻结数据引用并安全 quote；路径含空格/引号有负例测试。Git OID 固定为解析后的合法 hash，ref 通过 `git check-ref-format`；不能拼接任意用户命令。不要从 shell 输出的自然语言中猜结构化结果。

## 4. Git 事务的具体时序

1. 准入及冻结节点，持久化 author 身份/检查与决策 digest。
2. 校验 integration ref 是授权直接 ref，所有 worktree 中均未 checkout；读取 M=expectedOld、C=candidateCommit。
3. `merge-tree --write-tree M C` 得 T；冲突终止。
4. `commit-tree T -p M -p C` 得 N=expectedNew；显式配置提交身份/时间，不改 git config。
5. write-once 保存 `{M,C,N,T,parents,manifestDigest,decisionsDigest,attemptId}`。
6. `git worktree add --detach <validationPath> N`；核 commit/tree/入口和额外输入；执行 pre_merge checks。
7. 独立会话审查 N、候选差异、报告和证据；host 绑定调用身份与 exact attempt。
8. 重核当前节点修订/授权/ref/checkout/判据；`update-ref --no-deref <ref> N M`。
9. write-once committed receipt；在 N 上执行 post checks，若失败追加 merged_validation_failed receipt 并固定终态。

每一步的业务错误都写明是否产生外部作用。ref 已推进后任何后续错误不能返回普通“未执行，请重试”而掩盖效果。进程死掉后的恢复按契约 §6.3，仅用精确 N，不用 C 是否可达。

首版不更新目标 branch 已检出工作区，因此不支持直接 CAS 当前主分支。需要用户工作区看到新结果时，由人/另一个明确授权动作检出或合并；它不隐含在本层“已交付到 ref”的含义中。

## 5. 可执行验收（实施时新增测试，现阶段不要伪造结果）

单元测试负责纯记录/判断；真实临时 Git 仓库负责 OID/ref/worktree；DSH enforcing dev 实例负责权限、host runner、Session 身份。Mock 不能替代最后一层。

| 用例 | 脚本落点（待新增/扩充） | 操作与决定性断言 |
|---|---|---|
| 根一致 | `scripts/test-orchestra-repository.mjs` | 主/linked 路径读取同队、报告归主根；executionCwd 不变；split_team_state 保留两份原文件 |
| 默认关闭 | `scripts/test-orchestra-delivery.mjs` | direct/A2A/普通 team 不创建 delivery 记录、不要求检查表；显式 standard 未实现时清晰拒绝 |
| N1 候选失效 | 同上 | 冻结后改 commit/checks/decision → generation 新值；旧 Evidence/Review 不能放行新候选；旧记录内容仍不变 |
| N2/B5 ref 与恢复 | `scripts/test-orchestra-git.mjs` | 预演后 ref 前进 → stale；C 在历史但 N 不在 → 对账阻断；N 可达但 tip 已前进 → 只补本次 N receipt |
| checked-out ref | 同上 | 主或 linked worktree checkout target 均拒绝；拒绝前后 index/worktree 字节不变 |
| commit/tree 区别 | 同上 | merge-tree 的 T 仅作为 commit-tree 输入，实际 detached HEAD 是 N；N 的父序列准确 |
| N3 前提 | `scripts/test-orchestra-evidence.mjs` | 错 cwd/PYTHONPATH、缺额外夹具、关键 observer 缺席、假 stdout 真链、manifest 变动 → unqualified，不能 pass |
| runner 失败 | 同上 | prepare/spawn 错误、signal、timeout、sandbox denial、截断和基础设施 reject 各有不同事实/原因码；没有悬挂 promise |
| 执行污染 | 同上 | 脚本修改跟踪入口/源码使证据无效；只写授权构建目录可记录；下一次干净现场不会带入上次产物 |
| N4 合并后失败 | `scripts/test-orchestra-delivery.mjs` | CAS 后 postcheck 失败 → 终态；禁止重派作者/改回 working；新修复节点保留原 receipt |
| N5 并发写者 | light 在 delivery，standard 在 leases 测试 | light 第二个准入拒绝；standard 路径前缀相交拒绝，豁免命中他人活跃租约仍阻断 |
| 任意断点恢复 | `scripts/test-orchestra-delivery-recovery.mjs` | intent 前/后、CAS 前/后、receipt 前/后注入进程终止；账实无歧义则补账一次，否则 blocked；不重写 intent |
| E3 截止/晚到 | `scripts/test-orchestra-decisions.mjs` | 重启补办到期，default 不越权，答案晚到产生新决策；unknown do_not_repeat 只接受受权人处理 |
| N6 胶囊 | `scripts/test-orchestra-capsule.mjs` | 原会话不可用，从记录/Git/胶囊恢复；缺下一步标 incomplete 可补齐；未知不可重复动作阻断 |
| N7 原生身份 | dev E2E，扩充既有角色恢复 harness | 新建/首次派活/重激活并重启后再次派活；实际 persona/tools/sandbox/approval 与记录一致；child continuation 单独验证 |
| F1′ 与判据身份 | delivery/设计门测试 | 作者自签拒绝；不同 Session 同模型记录 degraded；gate_not_run 不记参与或批准 |
| 体检真实性 | 后续 health 测试 | 五节+阻断项存在；unknown 指标不输出 0；失败/消息/取消进入 total，added 单列 |

**R0–R5 端到端**：隔离仓库 → 已授权未检出 ref → 新 node → 候选冻结 → intended merge commit → host checks → 独立审查 → CAS → receipt → 杀进程重启补账；第二次同请求无重复交付。成功和至少一个预期拒绝路径都要跑。

建议开发命令（脚本创建后才存在）：

```text
npm run typecheck
npm run build
node --test scripts/test-orchestra-repository.mjs scripts/test-orchestra-delivery.mjs scripts/test-orchestra-git.mjs scripts/test-orchestra-evidence.mjs scripts/test-orchestra-delivery-recovery.mjs
npm test
npm pack --cache /tmp/dsh-npm-cache
```

报告必须记录 commit/dirty diff 标识、host 精确版本、profile、命令/exit code、证据路径与未测项；不是只写 PASS。

## 6. 运行验证与责任

**当前 Owner 分工**：主 agent 负责实现、文档与集成；subagent 仅探查、搜证、调研、测试。新派发只允许 **Sol medium / Sol xhigh**。这不是插件内部模型默认策略，不能把 harness 选型硬编码进产品。

测试 agent 可以在明确授予的临时快照中生成 probe/执行验证，不改主仓源码。运行 dev 集成测试前，由主 agent 给出准确制品、profile、允许启动/停止的进程身份及测试工作区；只允许自己的 dev-orchestra / 4600，不影响 dev-trinity / 4601、原 dev/web 或历史会话。没有这些条件时报告阻断，不私自创建替代生产配置。

安装按 `DSH-INTEGRATION.md` 的防双实例原则，但**profile 名必须用本节新边界**。验证无 host 实体副本、lib 视角解析到宿主、health、浏览器实际注册、新会话工具调用和跨重启。新版本资料需同步到当前文档顶部，不让历史 dev/root 安装命令继续当当前指引。

## 7. 收尾条件与后续交接

- 每个切片先验证其失败/恢复路径，再扩大验证；不因为有新的规范便增加与故障无关的 gate。
- 第一部分源代码、light 纵切、standard 扩展分别报告完成度，不相互冒充。
- 交接只留：当前 commit/未提交差异、已证实结果、失败事实、下一处操作、不可触碰的边界。先完成 R0 根一致，再 R1 身份；不得从“跑验收脚本”跳过候选冻结和 intent。
- 发布另行批准，既有正式实例不自动更新；不 bump 0.8.0、push/tag/publish 来制造完成感。
