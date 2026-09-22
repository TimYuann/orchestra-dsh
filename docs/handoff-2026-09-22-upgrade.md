# Orchestra 0.1.7 升级接续 · 2026-09-22 收尾

> **先读本文，再看 STATE/历史报告。** Owner 本次要求开始收尾，暂不继续安装或浏览器测试。
> 当前源码检查点 **`2f08a05`** 已修过上一份 handoff 的三处 TS 错误，并补了完整恢复链；最终机械复测 **typecheck、295/295维护测试、5/5模型探针、9/9注册工具探针、pack全部通过**。**浏览器、真实 DSH 会话、跨重启、正式 Web 安装均未完成，不能宣告可交付。**
> 插件仍 **0.5.1**；目标宿主 **DSH 0.1.7-alpha.1**；没有 push/tag/publish。第二部分 host 确定性交付层仍只有草案，未实现。

## 1. 用户目标、范围与最新授权

最终目标：Orchestra 能在正式 DSH Web 安装使用。本轮继续的是第一部分：模型继承、动态 mission/lane、角色身份/能力、创建/恢复/停止/A2A、打包与 Web 兼容性；不要转去实现第二部分交付层。

- **主 agent 直接修代码、文档和集成**；subagent 仅探查、搜证、调研、测试。
- 一般子代理用 Sol medium / Sol xhigh；Owner 本轮特别指定**一个 Sol high 执行浏览器测试**，已开一个新鲜测试会话，不是恢复之前的大型 scout。
- **实际 DSH 测试模型统一 MiniMax-M3**，包括 driver、角色 Session 和 native child；明确选择的是“DSH 会话用M3”，测试执行者仍Sol high。机械测试的虚构provider/model不代表真实调用别的模型。
- 每个子代理一个大任务或一组相关小任务，完成结束；新主题fresh context。只为同任务必要复测或基础设施故障恢复续跑原会话，不不断追加跨主题工作。
- Owner **允许迁移实际 credential 值**。仍禁止在输出/日志/报告/仓库中披露值；同一DSH_HOME已有原生store时优先复用引用。不得以此推断可以任意改正式Web或重启正在工作的进程。
- 正式 `web:4599` 的安装/重启窗口**尚未获得具体放行**。目标“最终可安装”不是已执行生产变更。

原始新增需求：`docs/iteration-2026-09-22-role-and-scaling.md`。权限/原生能力原则：`docs/alignment-2026-09-20-next-round.md`、`docs/dsh-native-capabilities.md`。

## 2. Git 与成果分层

| 检查点 | 内容与验证 |
|---|---|
| `bdf1e62` / `16e2ce6` | 初始审阅与Owner追加范围；旧284全绿不能排除后来发现的生产分支缺陷 |
| `6a0f0d8` / `2386304` / `ecd9db7` | 初版0.1.7声明迁移、生命周期及归档重试；早期子报告曾夸大完整性 |
| `3bd275b` | 主agent修正薄driver指引、完整运行时playbook、同catalog生成发布声明；285测试与pack/import通过 |
| `f479b23` | 保留child persona/filter、更换已物化child接管身份、严格drain、统一/team归档、晚到报告superseding快照；292/292 |
| `f54383c` | 模型/lane WIP，曾有3处TS错误，未通过；不要以为该历史错误仍代表后续修复版本 |
| `c58a59c` | 上一份交接/计划草案；本轮所有candidate补丁均以此为base |
| **`2f08a05`** | 本次最终源码检查点，包含14文件/382新增/152删除；与Sol验证的patch SHA完全一致，295维护测试及额外探针/pack通过；live/browser/restart未做 |

本轮不是只改文案。主要生产修改：

1. **真实工具契约**：`src/orchestra.ts` 的add-lanes输入改为结构化role schema；lane输出/团队投影共用结构化schema，含mission/owner/职责/参与者；reuse-only lane能返回“0新座位，但新增了lane”。修复上一轮3处类型不一致。
2. **模型选择**：节点显式选择优先；否则从driver当前`session.requestHeader().config`取得实际请求路由，才回退创建options/部署默认。尊重`adapterDefaults.reasoningEffort`，不把模型默认推理强行固化。governed child在reservation冻结继承路由；standalone native child在创建时继承当前请求路由。旧三档偏好模块已删除。
3. **预设**：从typed catalog生成完整发布patch；registry resolution读取真实`compositionInventory()`。加lane允许合法的非builtin native声明预设，不只认固定角色库。
4. **期望与观察分开**：receipt/Team blueprint新增expectedCompositionTools/expectedOrchestraTools/expectedRequiredTools；reserved时空readiness不再变成“需要零个工具”。恢复用持久期望，旧builtin可由catalog补足；未知旧custom无证据则拒绝而不是放宽。
5. **完整冷恢复**：`src/session-blueprint.ts::resumeGovernedSession`使用公开`ctx.agents.resume`，保留setup两参数和同步commit；检查普通Session/cwd/preset，按registry+sessionId合并并发恢复。`src/a2a.ts`的governed resume和`a2a-transport.ts`读到governed marker后的冷恢复共用它。
6. **live校验**：`verifyGovernedAgent`核Session身份/cwd、preset、sandbox/approval、模型路由和工具要求；不通过重挂/事后改权限掩盖不匹配。
7. **marker重试**：同birth contract允许幂等重用，不同身份/权限/模型/工具拒绝覆盖；controller/title/派生permission/createdAt不是birth身份。marker是恢复意图，不证明Agent已发布；真正工具校验仍在native commit。
8. **归档激活/替换**：丢失的Session使用新id+完整governed blueprint，不再把registry解析结果当file preset；query缺席/损坏不能冒充“确定不存在”。恢复成功清除failed phase/diagnostic。新生命周期不继承旧dismissalAttempt。
9. **测试夹具**：整合了测试agent提出的5个维护脚本修正，让fake Agent具备真实ctx/preset/permission/model/tool形状；没有通过删掉产品守卫把测试刷绿。

主要文件：`src/{orchestra,orchestra-state,orchestra-role-presets,session-blueprint,a2a,a2a-transport,subagent-node}.ts`；测试变更位于`test-add-lanes`、`test-fleet-lifecycle`、`test-governed-provisioning`、`test-recovery`、`test-role-preset-roster`、`test-orchestra-preferences`、`test-subagent-node`。

## 3. 公共 API 结论（避免重新踩坑）

### Governed Session恢复

正确公开API是 `ctx.agents.resume({resumeSessionId, agentOptions, setup: preparedBlueprint.setup, signal})`，返回AgentHandle。`AgentSetup(agentCtx, agent)`可以返回同步`commit()`，在Session flush和Agent发布前校验。包装器不能丢第二个参数或commit。

私有的是 `dsh-api-session-controller` 内部 `ApiSessionAgentController.resume/resumeObserved`。泛用UI可用公开`sessionController.resolveAgent`，但它不能注入Orchestra自己的governed setup；解析完后再查已经是发布后。

原生事务只覆盖Agent/Session发布，不涵盖外部JSON文件。失败marker不是已通过证明；已live不能补跑setup冒充原子恢复。

### 模型与身份

- `Agent.options`可能仍是创建时的路由；UI后续变更体现在当前request header。测试覆盖这一反例。
- 默认推理与显式推理不同；不要把adapter default当用户override。
- native child不能重新指定独立preset/cwd/权限，不能重绑旧parent lineage；接管已物化child要新id。
- 0.1.7预设是bundle声明，不再配置roots/file mount。
- shell公开契约是resolve→execute→handle.result()，没有旧run/start。

## 4. 机械验证：准确区分raw与fixture修正

唯一测试agent：`verification-before-completion`，**Sol high**，run `8139acf1-cb0e-432c-8cdd-2e58fe70ad5b`。任务限定为本次Web就绪验证，已完成最终机械检查并结束，不会继续启动浏览器/服务；下一轮fresh测试会话。

| 候选 | 已观察结果 |
|---|---|
| candidate1 | typecheck失败：ActivateResumeOptions把native AgentOptions误写成Record；未运行Node测试 |
| candidate2 | 主agent改为原生AgentOptions，并保留reasoningEffort |
| candidate3 | 新增实际request路由继承；fixture修正后295/295，但额外模型探针发现governed child没有持久化继承路由 |
| candidate4 | 主agent补reservation模型冻结；raw为282/295（13个旧fixture失败），**加fixture-only patch后**295/295；模型探针5/5、registered-schema探针9/9，pack通过 |
| **最终收尾候选 / 2f08a05** | 已包含fixture修正及3处activation状态清理；独立fresh快照typecheck exit0、npm test **295/295**、模型探针**5/5**、registered工具探针**9/9**、pack exit0 |

最终固定输入：
- base：`c58a59c3f262bfff29a02d8e387e0e524009a596`
- patch：`/tmp/orchestra-web-ready-handoff-candidate.patch`
- SHA-256：`f866e1a2d49f917b0858a390875a0eedc0a5548be9203e1faf5e50c33423ce47`

fixture-only patch：`/tmp/orchestra-web-ready-017-c2-fixture-only.patch`，SHA `97e94040f716ae9444bcbb8aa681b7d6b4e88ac79eb1615f2954bf890e8715ef`。主agent仅应用其中`scripts/*`；`probes/*`仍是临时探针，不能误称已进维护套件。

**最终验证快照**：`/tmp/orchestra-web-ready-017-final.f1Wcab`。
**最终候选制品**：`/tmp/orchestra-web-ready-017-final.f1Wcab/orchestra-dsh-0.5.1.tgz`，SHA-256 **`a9745496d7b2a2f5758d2b7af43b116d5ee42197519c0217958b56aef689f178`**，npm SHA-1 `6217f05c4fc698ca47f2336835cde5ae4bc039e6`；78文件，351.9kB，runtime dependency仅js-yaml，22 peers，无src/scripts/probes/node_modules。

最终日志：`/tmp/orchestra-web-ready-017-final-{typecheck,test,probes,pack}.log`。验证窗口2026-09-22 10:04 UTC；macOS15.6、Node22.22.2、npm10.9.7、Git2.49.0。

该包是**机械验证候选，不是正式Web发布包**；其中README仍来自c58a59c快照，安装解释以当前仓库handoff为准。下一轮最终交付应从含最新文档的干净提交重新pack并记录新hash。不要误用更早candidate4包。

任何新Agent都必须区分：typecheck/unit绿色 ≠ 完整host组合健康 ≠ browser挂载 ≠跨重启角色身份。后四项本轮未完成。

## 5. 环境、配置与credential迁移

### 宿主与profile

- 全局DSH已升级并核验 **0.1.7-alpha.1**；Node **v22.22.2**。全局CLI `~/.nvm/versions/node/v22.22.2/bin/dsh`。
- 本项目 **dev-orchestra:4600**：由官方web模板初始化。**本轮只修改了该profile的本地配置，没有安装Orchestra依赖，没有启动DSH服务。** 最近检查4600未监听。
- **dev-trinity:4601** 归兄弟项目；本轮收尾检查已未监听，启停原因不作推断，仍不能擅自启停/改配置。
- 正式 **web:4599 / PID14248** 未被本轮重启或修改；原共享dev也未动。下次操作仍先重新查PID，不把旧PID当新授权。
- `@deepseek-ai/*`只在peer/dev；实际运行必须从宿主单实例解析。插件版本不自动bump到0.8.0。

### 重要的0.1.7 Settings迁移事实

DSH的legacy importer读取全局`~/.dsh/settings.yaml`，先rename为`.imported`，再写入**当前profile**。Trinity侧核验：高置信其第一次0.1.7启动消费了这份全局文档。现在原文件不存在，`.imported`存在。

因此新dev-orchestra及未来web**不会自动继承旧全局设置**。不要把`.imported`改回原名，也不要整份复制dev-trinity。按entry id迁入各profile；当前composition不接收的section可能被跳过，不能说“文件imported了，所以所有配置都迁好了”。例如`web-search-deepseek`在legacy存在但未进dev-trinity patch。

### 本轮已实际做的配置变更

在`~/.dsh/profiles/dev-orchestra/cordis.patch.yml`（权限0600）加入：
- `llm-pi-ai`：从只读legacy文档迁入4个provider配置，包含4个现有credential引用；使用同一DSH_HOME的原生store，不主动改写credential store。
- `agent-default-model`：`provider: minimax-cn`，`model: MiniMax-M3`；没有照抄已不适用的旧reasoningEffort设置。

没有在消息、日志、报告或仓库输出凭据值。**这只证明配置/引用已迁入，不证明所有ref都已可解析或真实调用成功**；需启动后用原生credentials.describe仅采configured/source/writable，并用M3完成实际回合。

回滚备份：`/tmp/orchestra-web-ready-20260922.IxMPkM/dev-orchestra/`，含原package.json、cordis.patch.yml、pnpm-workspace.yaml。只恢复本profile自己拥有的改动，不回滚其他profile或全局settings。

配置hash：
- dev-orchestra原patch：`ef189a8c27db6d63930aa3046a3040482e952eafcb7487c644d508e8d461f027`
- 新patch：`1fae677a21cbbf776b830928f4014a35f842f6e8448cd065dfcf311ee196071d`
- dev-orchestra package（仍无插件dependency）：`6c2c44877ae1a4a037441aca62c07f37d9d2eed058af4ae96869b82b6a82d393`
- web package：`ec33e2b6cd7646c4ca02544bbd17bd2d4bb491e6e3baaf388a10bc195923589b`；web patch仍为上述空patch hash。

最初全局升级收据：`/tmp/orchestra-dsh-upgrade-0922-152122/`。不含本轮profile配置迁移的最终结论，两个阶段不要混用。

## 6. 下一轮的具体执行顺序

1. **核最新源码与测试收据**：git status/log，阅读本文件末尾最终结果。不要重新安装依赖或撤销本轮fixture修正。临时探针若丢失，从维护测试/证据重建，不据此放弃验证。
2. **必要的补充自动测试**：优先把临时registered-lane/model探针的新增用例整合进维护脚本；检查同birth marker重试/不同birth拒绝、native setup commit失败不发布、真实默认replacement路径，不只测注入mock。
3. **制品**：从干净源码快照build/pack；本仓旧`lib/`可能残留已删除`orchestra-preferences.*`，不要直接把旧构建目录打包。验证generated preset patch、完整SKILL.md、相对import、无host实体副本、版本/哈希。
4. **仅安装dev-orchestra**：备份配置，使用pnpm profile约定（hoisted、autoInstallPeers:false），依赖指向准确tgz并启用bundle。验证从插件lib解析到host。正式web/旧dev不动。
5. **一个fresh Sol high做browser验收**：给它准确制品/hash、4600实例身份/可停止重启的PID或monitor、认证状态文件路径、独立`/tmp`workspace；所有实际会话只用minimax-cn/MiniMax-M3。认证值不进入报告。使用agent_browser；按项目要求读ego-browser指导，不用拥挤browser-use CDP。
6. **必须真实观察**：设置面板加载/无console错误；新driver真实message→tool→response；建队→首次派活；reuse-only新mission/lane及owner；Session persona/tools/read-only/never审批；child persona/filter与续派；strict停止/归档；重启后再派活的身份与工具完整性；可行时缺失Session replacement。
7. **正式Web放行**：先给Owner准确的dev证据、剩余风险、安装/配置迁移和回滚步骤，确认安装/重启窗口。逐entry核effective config与credential状态，不把“依赖装上”当功能可用。
8. **最后同步文档**：只有真实通过才更新“可直接装Web”。发布、版本bump、push/tag另行授权。

## 7. 明确未完成/已知边界

- **浏览器、真实provider回合、dev服务冷启动、跨重启、正式web安装：未做。** 本轮收尾是Owner指定的中断点，不是验收完成。
- 存量file-only preset/缺少expected字段的未知custom角色不能无证据重建；报错后走明确批准的新实例交接，不能为了旧mock让守卫变松。
- marker是恢复意图，非外部文件ACID；native commit和真实工具/策略仍须核验。
- 部分legacy/source-count测试已更新为新入口，不能再恢复旧root/file-mount或三档模型以满足历史断言。
- 新增lane不是自动并发调度器；图attempt/cap仍声明性，不假称host已执行交付门。

## 8. 第二部分交付层草案保持原状态

当前不实施、不扩张。v2三个文件已整理，但仍有9项设计阻断：启用权威；shell dialect/quoting；canonical/validation sandbox root；repo共享claim CAS；完整commit材料与重复parent；CAS/reset精确witness；ref_updated与最终receipt分层；host observer来源+light可重复性；所有旧工具/root/bus兼容矩阵与安全验证worktree位置。

这些内容在上一轮最后一次批量edit失败后**没有全部应用**；三个文件顶部已标DRAFT。下一轮若只完成Web可用性，不要因此顺手实现交付层。权威入口为`docs/plan-0.8.0-execution.md`，完整搜证见下。

## 9. 证据与文件索引

- 原始完整搜证（九个源码缺口+public resume裁定+v2九项阻断）：`/Users/yuantian/.pi/agent/sessions/--Users-yuantian-Developer-orchestra-dsh--/subagent-artifacts/outputs/14914f7b-24f3-4c0a-95ed-fb14ad389ffc/evidence/remaining-source-gaps.md`。
- 前一阶段验证历史：同目录`checkpoint-tests.md`（含285、292以及后来失败的WIP；按snapshot读取）。
- 本次Sol high run：`8139acf1-cb0e-432c-8cdd-2e58fe70ad5b`；已完成并停止。最终报告：`/Users/yuantian/.pi/agent/sessions/--Users-yuantian-Developer-orchestra-dsh--/subagent-artifacts/outputs/8139acf1-cb0e-432c-8cdd-2e58fe70ad5b/validation/web-ready-017.md`。报告的整体NO-GO指**未执行live验收**，不是自动测试失败；不要引用其中主观分数替代具体证据。
- 目标发布包：`tmp/0.1.6alpha2-to-0.1.7alpha1/b/node_modules/@deepseek-ai/`；审计全文同目录上一级`UPGRADE-ADAPTATION.md`。全局host已变新版本，不能当旧版证据。
- 当前摘要与原生能力：`docs/upgrade-0.1.7-alpha.1-implementation.md`、`docs/dsh-native-capabilities.md`。
- `AGENTS.md`、`STATE.md`、`DSH-INTEGRATION.md`是Git ignored本地上下文；已同步，但接续事实以本tracked文档和提交为准。

建议skills：`plugin-upgrade`、`plugin-test`及version-migration-testing、`plugin-release`、`writing-for-agents`、`pi-subagents`、`agent-browser-usage`/`ego-browser`。不要因加载skill而重做全部历史审计或扩大验证到未授权profile。
