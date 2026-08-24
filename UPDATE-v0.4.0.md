# UPDATE-v0.4.0 · orchestra-dsh v0.4.0 发布说明与外部验收入口

> 本文件是给「在 DSH 中另开的创造模式验收 Session」独立执行 E2E 用的：自包含、可复制、诚实。
> 开发团队已运行的本地验证（单元/contract/integration）与**未运行的真实 full-session E2E** 都在这里如实列出；
> 未运行的真实 E2E **不写成 PASS**。执行 E2E 前请先读本文件与当前代码，再独立设计验证步骤。

## 1. 版本与能力变化（v0.3.0 → v0.4.0）

版本号：`0.3.0` → `0.4.0`（package.json / tgz `orchestra-dsh-0.4.0.tgz`）。

### 新增能力

| 能力 | 说明 | 主要入口 |
| --- | --- | --- |
| Living Orchestration Document | 一个逻辑文档三层（canonical / markdown projection / runtime projection），写权限 = controller + semantic writer，revision/CAS 防护 | `orchestra_document`、`orchestra_reconcile`、`orchestra_decision` |
| Charter Draft → Freeze → Approve | append-only draft 事件、`/team approve <draftId>@<revision>` 是唯一硬批准（自然语言不算）、freeze 产出不可变 frozenRef | `orchestra_draft`、`orchestra_freeze`、`orchestra_charters`、`/team approve` |
| Bounded Graph Runtime | 外层 DAG + loop/attempt/verdict/gate/closure 状态机；typed handoff（含 controller 目标）；cap_exhausted；terminal 后禁写 | `orchestra_loop_start`、`orchestra_attempt_start`、`orchestra_verdict`、`orchestra_handoff`、`orchestra_gate_open`、`orchestra_close`、`orchestra_graph` |
| Transactional provisioning | reserve-first、部分失败 no orphan/no fake active、welcome durable flush 后才 active | `orchestra_create` |
| 七个 v0.4 Role Preset | implementer/reviewer/investigator/verifier/architect/researcher/hardening-auditor，versioned ID（`orchestra-v04-*-v1`），compositionTools/orchestraTools 双平面 capability preflight | 内置 catalog |
| 五个任务型 Topology | feature-development / bug-diagnosis-and-fix / architecture-decision / refactor-and-migration / audit-and-hardening（schemaVersion 1，D.1~D.5 冻结合同） | `orchestra_topologies` / `orchestra_draft(topology=...)` |
| Session 命名三段式 | `<roleId> · <mission 缩写> · <cwd-slug>`，确定性纯函数，create/spawn/activate 同源 | `roleSessionTitle` |
| Driver 节点提醒 | handoff/verdict/report/gate/close 成功后 host 一行短提醒投递 driver（best-effort、自嗨跳过；触发器非状态源） | 内置于上述工具 |
| 提案表格卡片 | orchestra_draft 的 role_blueprint_preview 以 Markdown 表格渲染；orchestra_team 增加 graph 状态摘要行 | `orchestra_draft` / `orchestra_team` |
| 恢复/激活 | archive 不可变、activate 三分支（live/persisted/missing）、controller takeover、归档 graph 校验 fail-loud | `orchestra_dismiss` / `orchestra_activate` |

### 兼容变化（legacy 保留，不静默替换）

- `duo` / `trio` / `oracle` / `four-role-dev` 四个 v0.3 内置 Topology 继续可读（缺 graph/loop/gate 字段时标 legacy，不自动迁移）。
- `orchestra-implementer` / `orchestra-reviewer` / `orchestra-oracle` 三个 v0.3 Role Preset 继续可解析；**新 Topology 只引用 v0.4 versioned ID**。
- 项目级/全局级 topology/preset 文件优先于 catalog builtin；已存在文件只读解析，绝不覆盖。
- 旧 `team.json`/archive 的 v1.0 读取走兼容 normalize（不写回源文件）。

## 2. 安装 / 更新方式

在 DSH profile 目录（如 `cd ~/.dsh/profiles/<profile>`）安装：

| 管理器 | 命令 | 注意 |
| --- | --- | --- |
| **npm** (推荐) | `npm install orchestra-dsh@0.4.0` | npm ≥7 会自动装 peer 依赖——先在 profile 的 `.npmrc` 设 `auto-install-peers=false`，或加 `--legacy-peer-deps` |
| **pnpm** | `pnpm add orchestra-dsh@0.4.0` | 发布后 24h `minimumReleaseAge` 策略：在 `pnpm-workspace.yaml` → `minimumReleaseAgeExclude` 加 `orchestra-dsh@0.4.0` |
| **yarn** | `yarn add orchestra-dsh@0.4.0` | Yarn 自动装 peer 依赖——装完跑下面的 safety check |
| **bun** | `bun add orchestra-dsh@0.4.0` | 同上，装完跑 safety check |

**Safety check（所有管理器）**——本插件的 `@deepseek-ai/*` 都是 `peerDependencies`（由 DSH host 提供）。如果包管理器实体化了副本，插件双实例加载，所有工具调用崩溃（`reading 'prepare'` 事故模式）：

```bash
ls node_modules | grep '^@deepseek-ai'   # 期望无输出（*.dup-bak 残留允许）
```

有副本就 `rm -rf node_modules/@deepseek-ai` 后关闭 peer auto-install 重装。

**更新（本地 tgz 同步，开发循环）**：改代码 → `npm run typecheck` → `npm run build` → `npm pack --cache /tmp/dsh-npm-cache` → 在 profile 里把 `orchestra-dsh` 指向新 tgz（`file:<path>/orchestra-dsh-0.4.0.tgz`）→ `rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json && pnpm install`（**必须删状态文件**，否则 pnpm 乐观检查跳过）→ 验证三件套（见 §7）→ **新会话**实测（旧会话污染不可修复）。

## 3. 已运行的本地验证（开发团队已做）

`npm run typecheck` ✓；`npm run build` ✓（tsc host + tsc client + tsdown）；`npm test` ✓。

**全量 18 个测试文件 / 142 个测试，0 fail**：

| 测试文件 | 覆盖 |
| --- | --- |
| scripts/test-v0.3.0.mjs | v0.3 兼容基线回归 |
| scripts/test-orchestra-state.mjs | team.json v1.0/v1.1 normalize、CAS、状态迁移 |
| scripts/test-orchestra-archive.mjs | archive 不可变、legacy 读取、dismiss 集成 |
| scripts/test-orchestra-topology.mjs | 9 个内置模板解析、precedence、validator |
| scripts/test-session-blueprint.mjs | lightweight/governed blueprint、preflight |
| scripts/test-governed-provisioning.mjs | transactional provisioning、session 命名三段式 |
| scripts/test-orchestra-role-presets.mjs | 七个 v0.4 preset 合同 |
| scripts/test-a2a-transport.mjs | A2A transport 分层 |
| scripts/test-orchestration-document.mjs | living document 三层 |
| scripts/test-orchestration-charter.mjs | draft/approve/freeze、digest 稳定性、快照隔离 |
| scripts/test-orchestra-graph.mjs | graph runtime 核心（loop/handoff/gate/closure） |
| scripts/test-feature-development.mjs | D.1 合同 + happy path + cap + fail-loud |
| scripts/test-bug-diagnosis-and-fix.mjs | D.2 合同 + happy path + 负面 + findings 双目标 |
| scripts/test-architecture-decision.mjs | D.3 合同 + PASS≠批准 + 读图只读性 |
| scripts/test-refactor-and-migration.mjs | D.4 合同 + attempt 隔离 + pending 阻塞 closure |
| scripts/test-audit-and-hardening.mjs | D.5 合同 + 缺 rescan 不得 PASS + 只读 |
| scripts/test-recovery.mjs | CP7：graph 跨 archive/activate 续写、三分支、takeover |
| scripts/test-cp8-notices.mjs | CP8：milestoneNotice、表格 render、best-effort 提醒 |

## 4. 未运行的真实 full-session E2E（诚实清单——以下全部未由开发团队运行）

1. **Lightweight A2A 真实投递**：a2a_create/send/reply/read 的 live/durable/resumed 三态 receipt 在真实 DSH 多会话间的端到端行为。
2. **Governed 全流程**：`orchestra_draft → /team approve → orchestra_freeze → orchestra_create` 的真实会话创建（reserved mapping 先于 publish、welcome durable admission）。
3. **Loop → Gate → Closure 全流程**：真实多角色执行 `loop_start → attempt_start → verdict → gate_open → /team decide → close`，含 cap_exhausted、closure 拒绝/批准、terminal 禁写。
4. **cap-exhausted 真实处置**：attempt 2 仍 FAIL → cap_exhausted packet → driver remediation branch 的真人决策流。
5. **resume / replacement**：进程重启后 activate 三分支（live 复用 / persisted resume / missing 替换 + Recovery Packet）与 controller takeover 的真实会话行为。
6. **GUI projection**：dash 中 orchestra_draft 表格卡片、orchestra_team graph 摘要行、orchestra_graph 卡片、driver 里程碑提醒的渲染。
7. **五个 Topology 的真实 multi-session 执行**：见 §5 每模板一节。
8. **浏览器验证清单**：见 §8。

开发团队没有把以上任何一项的运行结果写成 PASS；验收 Session 必须独立执行并记录。

## 5. 五个首发 Topology 的 E2E 场景与验收入口

通用准备：临时 fixture repo；在 DSH 新会话中 `orchestra_draft(topology="<id>", goal="...")` → 检查表格卡片 → `/team approve <draftId>@<revision>` → `orchestra_freeze` → `orchestra_create(frozenRef=...)` → 派活。

### 5.1 feature-development

- **成功场景**（D.1 E2E）：fixture repo 中一个小 feature mission。implementer 改 scope 内文件 → `orchestra_handoff(candidate)` → verifier 运行固定 test/typecheck 并写 evidence → `orchestra_handoff(verification)` → reviewer 先 FAIL（findings）→ implementer 修复 → attempt 2 → reviewer PASS → `orchestra_gate_open` → closure 被拒 → `/team decide <gate> approve` → `orchestra_close completed` → `orchestra_dismiss`。
- **验收**：1) reserved mapping 先于任何 role Session publish；2) 两个 attempt 是不同 DAG 节点、旧 finding 不被覆盖；3) typed handoff 的 message receipt / report / commit/diff/test refs 可重读；4) closure gate 未批准时 closure 被拒、批准后才 terminal completed；5) implementer 越界写、reviewer 伪造 PASS、缺 test evidence、第三轮 attempt 都 fail loud；6) Team/Document/Graph/role phases 与最终 output 一致。
- **失败场景**：cap exhaustion（attempt 2 仍 FAIL → cap_exhausted、无第三轮）；缺 requiredEvidence 的 handoff 拒绝；非 evaluator 伪造 PASS 拒绝。

### 5.2 bug-diagnosis-and-fix

- **成功场景**（D.2 E2E）：fixture 预置一个稳定失败的 test 与最小日志。investigator 先写带 reproduction/rootCause 的 diagnosis → implementer 只改 repair scope → verifier 运行原失败用例与回归用例 → reviewer 首轮拒绝缺失 evidence（FAIL）→ 补齐 → PASS → gate → closure。
- **验收**：1) 无 diagnosis handoff 或 rootCause evidence 时 implementer candidate 不能进入 evaluator；2) original failure 与 regression test 都要有可重读 test refs；3) 错误 diagnosis、越界文件、missing diff、reviewer 伪造 PASS 都拒绝；4) cap_exhausted 后只生成 Driver packet、不生成隐藏下一轮；5) closure 记录 completed/failed/abandoned 语义、不把 blocked 当成功。
- **失败场景**：diagnosis 缺 file evidence、candidate 缺 diff、verification 缺 report → handoff_invalid；findings 目标不在 [investigator, implementer] 内 → 拒绝；BLOCKED 后 closure completed → 拒。

### 5.3 architecture-decision

- **成功场景**（D.3 E2E）：两个候选方案的架构问题。researcher 写带稳定 URL/file refs 的 research brief → architect 写含 alternatives/tradeoffs/impact 的 decision brief → reviewer 首轮指出缺失 evidence → 补齐 → PASS → **PASS 后 closure 仍被拒**（reviewer PASS ≠ 用户批准）→ 用户 `/team decide <gate> accept` → terminal completed。
- **验收**：1) source 文件在 Freeze 后改变不影响已保存 snapshot/digest；2) reviewer PASS 不等于 user approval；3) missing URL/evidence、候选越界、普通 Agent 伪造用户决定都 fail loud；4) decision brief 只能写 report/evidence、不改 runtime code；5) amendment 必须产生新 charter revision、不能直接改 current roster。
- **失败场景**：research-brief 缺 url evidence、decision-brief 缺 report、findings 目标越界 → 拒绝；architect-session 伪造 gate 决定 → permission_denied；researcher/architect 无 tool-bash（读图只读性）。

### 5.4 refactor-and-migration

- **成功场景**（D.4 E2E）：old API 与 new API 兼容 fixture。architect 写 baseline/target/rollback plan → implementer 做最小 slice → verifier 运行 old/new contract tests 和 rollback smoke → reviewer 首轮拒绝缺少旧路径证据 → 补齐 → PASS → gate → closure。
- **验收**：1) baseline commit 和 target diff 可重读且不被新 attempt 覆盖；2) rollback evidence 缺失时 closure 被阻塞；3) 第二 slice 不能越过第一 slice 的 Gate 或改变其 scope；4) cap 后没有隐藏第三次迁移；5) source mutation 不改变已 Freeze 的 migration contract。
- **失败场景**：compatibility-evidence 缺 rollbackResult、migration-plan 缺 slice 声明、verdict 缺 cutoverRecommendation → fail loud；PASS 后遗留 pending handoff → closure 拒。

### 5.5 audit-and-hardening

- **成功场景**（D.5 E2E）：fixture 种入可复现的 authorization/secret-handling/tool-boundary 缺陷。hardening-auditor 只记录 fingerprint/位置/影响/修复要求/reproduction-或-why-not（**不填未来 rescan**）→ investigator 建立 reproduction → implementer 最小 patch → verifier 运行 exploit/regression rescan → reviewer 先拒绝缺少 rescan、再在证据齐全后 PASS → 用户 Gate 后才 completed。
- **验收**：1) audit 只读角色不能直接改代码或风险状态；2) finding fingerprint、rescan 和 residual-risk 可跨 attempt 重读；3) 修复后仍可复现或 rescan 缺失时不得 PASS；4) user risk decision 不能由模型字段伪造；5) closure 后不能新增 hardening attempt、旧 finding/evidence 保留。
- **失败场景**：finding 缺 fingerprint、rescan-evidence 缺 residualRisk、verdict 缺 openFindings → fail loud；缺 rescan 的 BLOCKED 终态 → 无隐藏 retry；hardening-auditor-session 伪造 gate → permission_denied。

## 6. 其他 E2E 场景与 evidence 要求

| 场景 | prompts/步骤 | evidence 要求 |
| --- | --- | --- |
| Lightweight A2A | 两个会话 a2a_create → a2a_send（wake:true/false）→ 目标回复 a2a_reply → 原会话 a2a_read | receipt 三态（live/durable/resumed）可区分；message id 可去重；冷会话 resume 不丢消息 |
| Governed 全流程 | orchestra_draft → `/team approve` → orchestra_freeze → orchestra_create(frozenRef) | frozenRef 精确匹配；approval 必须是 user-command 事件；自然语言「可以」不通过 |
| cap-exhausted | 任一任务型拓扑：attempt 2 仍 FAIL | cap_exhausted packet（unresolvedFindings）产生；无第三次 attempt；driver 只能开 remediation branch |
| resume/replacement | dismiss 后 kill 进程 → orchestra_activate(archive_id) | 三分支 action 显式；替换记录 sessionHistory+reason+Recovery Packet；controller takeover 记录 controllerHistory；旧 archive 字节不变 |
| GUI projection | dash 中调用 orchestra_draft / orchestra_team / orchestra_graph | 表格卡片 8 列；team 卡片含 graph 摘要行；不把 accepted 渲染成 answered |

## 7. 风险与边界

1. **rc.6 public seam 与官方 rc.2 的差异**（TOPOLOGY-CATALOG G.1 兼容矩阵）：本插件针对 `@deepseek-ai/*` rc.6 开发；若目标 DSH profile 是官方 rc.2，peer 版本不匹配可能导致 mount/工具面不一致——升级前核对 profile 的 DSH 版本与 peerDependencies 版本对齐。
2. **本机 profile 同步状态（CP9 任务 2 结果，如实记录）**：`npm pack` 产出 `orchestra-dsh-0.4.0.tgz`，防崩静态检查全绿（dependencies 仅 js-yaml；15 个 peerDependencies 与 devDependencies 全部对齐；tgz 无 @deepseek-ai 副本、无 src/scripts/reports/orchestra）。三个 profile（web / dev / dev-headless）已同步 v0.4.0：profile 依赖改为 `file:<orchestra-dsh-0.4.0.tgz>`（本地 tgz 模式，与仓库既有本地插件一致）+ `minimumReleaseAgeExclude: orchestra-dsh@0.4.0` + 删除全部 lock/state 文件（含 `node_modules/.pnpm/lock.yaml`）后 `pnpm install` 成功。**前置清理**：web profile 曾因既有破坏引用（`talk-like-a-pro-dsh` / `learn-as-you-go-dsh` 的 tgz 路径已迁移）导致 install 失败——按用户指示卸载 talk-like-a-pro-dsh，并把 learn-as-you-go-dsh 路径修复到 `/Users/yuantian/Documents/Developer/learn-as-you-go-dsh/`。三件套验证全部通过：三个 profile 的 node_modules 无 `@deepseek-ai` 实体副本（dev 中 hoisted 的 cosmokit/schemastery 已按文档模式隔离为 `.dup-bak`，回退 host）；`require.resolve('@deepseek-ai/dsh-tools', {paths:['<profile>/node_modules/orchestra-dsh/lib']})` 全部指向 host 路径；dev 实例（4600）health 200 且保持运行（供浏览器验证）。主实例 4599 未重启。
3. **主实例 4599 未重启**（磁盘同步即可，进程保持旧版）。
4. **双实例红线**：任何 `@deepseek-ai/*` 进入 dependencies 或 profile 出现实体副本都会导致 `reading 'prepare'` 崩溃；已污染会话不可修复，需新会话。

## 8. 浏览器验证清单（dash / 4600）

dev 实例已运行于 http://127.0.0.1:4600（v0.4.0 已同步）；主实例 4599 保持旧版进程。

1. `orchestra_draft` 卡片渲染成 8 列 Markdown 表格（角色/preset/sandbox/permission/model/reasoningEffort/compositionTools/orchestraTools）+ 摘要行 `charter draft <id>@<rev> (<status>) digest=...`。
2. 角色执行 handoff/report/verdict 后，driver 会话收到一行 `orchestra: <teamId> <kind> ...` 提醒（新 turn）；`/team decide` 与 `orchestra_close` 不自嗨。
3. `orchestra_team` 卡片含 `graph: <status> ... | loop=... | pending handoffs=... | open gates=... | closure=...` 摘要行，与 `orchestra_graph` 一致。
4. create 后各角色 welcome 末尾含「每个节点完成（交接/verdict/报告）后，向 driver 汇报一行进展…」。
5. 投递不可达（driver 会话关闭）时角色工具调用仍成功（best-effort，仅 host 日志 warn）。
