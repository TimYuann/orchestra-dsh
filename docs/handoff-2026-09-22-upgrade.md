# 2026-09-22 交接：0.1.7 升级、角色伸缩与交付层计划

> **下一轮先读本文。当前不是完成态。** 最新源码检查点 **`f54383c`（WIP，编译未通过）**；最后全绿源码 **`f479b23`（292/292）**。版本仍 `0.5.1`，没有发布/推送/tag。
> 本文保存事实、边界和下一步；需求正文见 `iteration-2026-09-22-role-and-scaling.md`，历史缺陷见 `review-2026-09-22-plugin-and-delivery.md`。不要把阶段报告或子代理 completed 当最终验收。

## 1. Owner 要求与最新分工

- 第一部分本轮实现：DSH 0.1.7-alpha.1 迁移；A2A/编排生命周期修复；driver 选择直接做、native subagent、少量独立 Session 或 team；运行中新 mission 入现有 team 的 lane；角色 persona 要有方法差异、交接闭环且薄；可发现的新 preset 编写 playbook。
- 第二部分本轮**只优化 host 确定性交付层计划，不实现**。用户授权修正旧冻结设计，要求下一轮执行者无需猜关键契约。
- **主 agent 直接实现、改计划、集成。Subagent 只探查、搜证、调研、测试；新派发仅 Sol medium / Sol xhigh。** 不再启动 Luna/Terra，也不再让子代理实施代码或计划。
- 每个子代理只做一个大任务或一组相关小任务，完成即结束；新主题用 fresh context。原会话续跑仅用于同任务必要复测或传输故障恢复，避免反复扩题导致压缩。
- 权限和成本沿当前授权；不推送、不发布、不批量迁移历史会话。测试预算可充足，不用苛刻工具/token限额制造半成品。

## 2. 环境与绝不能碰的边界

- 全局 DSH 已获授权升级并验证为 **0.1.7-alpha.1**。CLI：`~/.nvm/versions/node/v22.22.2/bin/dsh`。
- 升级收据/备份：`/tmp/orchestra-dsh-upgrade-0922-152122/{baseline.json,result.json,npm-global-install.log}`。升级当时原 web/dev 配置 hash 未变。
- 本项目唯一测试目标：**dev-orchestra:4600**；已从官方 web 模板初始化，**本轮尚未安装/启动 Orchestra 新制品**。
- 兄弟项目使用 **dev-trinity:4601**。原共享 **dev**、正式 **web/4599**（既有进程）与历史会话不动。
- `@deepseek-ai/*` 只入 peer/dev，runtime由host单实例提供；profile不可装出第二份核心实体包。新制品安装后必须检查解析路径、health、浏览器和新会话，再跨重启派活。
- 本地 `AGENTS.md`、`STATE.md`、`DSH-INTEGRATION.md` 是 **Git ignored**；已同步，但持久交接以本 tracked 文档为准。

## 3. 本轮源码检查点

| commit | 实际内容 / 边界 |
|---|---|
| `bdf1e62` | 初始全插件审阅与文档；当时284测试全绿，随后证明不少生产分支仍坏 |
| `16e2ce6` | Owner追加角色/伸缩范围（需求文档） |
| `6a0f0d8` | 0.1.7依赖/registry/client/V4适配，角色声明、初版lane；**阶段报告曾夸大完整性** |
| `2386304` | 懒加载/回合停止/dismiss等初步修复；仍有durable roundtrip和恢复缺口 |
| `ecd9db7` | 稳定dismissalAttempt id；后证实只比identity会漏晚到报告 |
| `3bd275b` | 主agent修正driver指引（不强制图/任务卡、不虚构runtime cap）；运行时加载完整SKILL.md；构建从typed catalog生成完整preset声明，消除12套声明与catalog漂移；285/285 |
| `f479b23` | normalize保留/复制child persona和filter；接管更换已物化childId并留history；严格drain错误传播；两个/team归档分支共用dismiss；CAS重试遇晚到报告显式生成superseding快照；新增7回归，292/292 |
| **`f54383c` WIP** | 删除旧三档偏好模块/exports；driver实际模型及推理继承、节点显式优先、草案冻结展示路由；lane工具补mission字段、owner/责任及复用成员render。**有3处TS阻断，尚无行为通过结论。** |

主要新/改文件：`src/orchestration-principles.ts`、`skills/orchestra-preset-authoring/SKILL.md`、`scripts/build-role-presets.mjs`、`presets/orchestra-roles.patch.yml`、`src/orchestra{,-state}.ts`、`src/session-blueprint.ts`、相关回归脚本和package。删除 `src/orchestra-preferences.ts` 后，在旧本地lib目录打包时留意残留的已编译文件；干净快照构建没有该问题，不要把旧lib当新产物。

## 4. 最新验证与当前编译阻断

测试由Sol medium在临时 `git archive` 快照执行，链接现有node_modules，无安装或profile操作。

- `3bd275b`：285/285、typecheck/build/pack/import通过；目标native registry接受12声明的plugin/config，但缺完整服务图，**不是实际角色激活证据**。
- `f479b23`：292/292、typecheck通过；7个新增回归已先在旧版观察失败再变绿。覆盖正式dismiss、/team新目标和terminal归档、晚到报告、child配置读回和接管身份。
- `f54383c` 与被测patch SHA完全一致：`92ce7e4568a985eddaaab743a0917b6116977fae07a2ea3a121cf3dfe31ed0a1`。typecheck与npm test均exit2；**npm test停在build，Node tests未执行**。

先修 `f54383c` 的三处类型/契约不一致：

1. `orchestra_add_lanes.output.schema.lane` 写成generic json，renderer却按结构体访问；应把真实lane字段声明为结构化schema（或在经过显式校验后缩窄类型），不要用盲目any掩盖合同。
2. `roles.items` 是generic json，execute却声明`AddLanesArgs`；让输入schema/解析与handler类型一致。
3. `orchestra_team` 的added_lanes投影/schema未补ownerRoleId，renderer提前读取它；投影、schema和返回一并补齐。

当前计数：旧偏好测试5个换为新模型路由5个，净变化0；预计仍292，尚未验证。不要为了旧三档行为回退产品要求。

## 5. 第一部分仍未完成（按优先级）

### A. 完整 blueprint 与恢复（原搜证#3/#4）

- reservation时receipt的tools readiness是**空的观察值**；不能把它持久化后当作期望工具要求。单独保存expected composition/orchestra tools/row ids，重建时用expected字段或可核的catalog，不传空数组把检查绕掉。
- `resolveRolePresetFile` 需读target registry `compositionInventory()`，核实际声明而不是只resolve(id)。生成声明只解决静态漂移，不代替runtime核对。
- archived Session replacement当前把registry的`{source:"dsh",path:""}`当presetFile传递，被目标版明确拒绝。必须新sessionId + 完整governed blueprint + governed create；修默认生产分支，不只修注入mock。
- governed冷恢复正确公开API是 **`ctx.agents.resume({resumeSessionId,agentOptions,setup:preparedBlueprint.setup,signal})`**。`AgentSetup` 两参数 `(agentCtx,agent)`，必须保留返回的同步`commit()`；commit在Session flush/Agent publication之前校验。
- 私有的是SessionController内部`ApiSessionAgentController.resume/resumeObserved`，不是public AgentRegistry.resume。泛用/UI可用sessionController.resolveAgent，但它没有注入governed setup的参数。
- 直接resume需检查持久化header不是native child、cwd/角色身份匹配，按sessionId合并并发恢复；已live的Agent只能核验或拒绝，不假称补跑setup。保留需要dispose的handle。
- setup写的外部blueprint文件不属于DSH原子发布事务；commit失败时不能把遗留marker当“验证通过”。处理pending/失败记录或明确把marker当待核恢复意图。
- archived activation不能沿用上一生命周期的dismissalAttempt作为新交付身份；检查并清理该活动字段，历史留在原archive。

### B. 模型/lane当前WIP后续检查（#1/#8）

修完三处TS后，跑真实registered tool的schema→execute→render测试。验证Session/native child与不同部署默认的model/reasoning，节点显式值，草案批准前后driver切换不偷换展示值，reuse-only lane不添座且保留mission/owner/purpose。检查新preset是否真能经正常加lane路径使用：当前addLanes仍只承认builtin catalog，不能让playbook生成的合法native preset在这里被一概挡住。

### C. 必做运行验证

第一部分自动测试通过后，主agent安装**最终**制品到dev-orchestra；测试agent在明确授予的实例/工作区上跑browser注册、new Session、persona/tools/权限、native child过滤与续派、strict stop、跨重启再次派活。未做这些之前不称升级完成。

## 6. 第二部分文档：已重写，但仍有9处待修

本轮把旧1300行互相覆盖的执行计划缩成v2：契约=`plan-0.8.0-delivery-layer.md`，唯一执行入口=`plan-0.8.0-execution.md`，protocol只保留导航。已明确optional/off默认、先最小light纵切、exact commit而非tree、拒绝checked-out target、expectedNew恢复、默认全量重跑和unknown前提不合格。

**这些文档是DRAFT，不是今晚可直接无疑义执行的最终版。** Sol xhigh发现以下阻断；最后一次尝试批量修改因edit exact-match失败，**未应用**，不可误以为已修：

1. **启用权威缺失**：明确部署默认off、maxLevel/allowedRefs/授权id与撤销检查，agent不能自己提供authorization。
2. **shell quoting未定**：0.1.7仅command字符串，无argv/quote API；首版限定明确POSIX dialect并统一参数quote，未知dialect拒绝。
3. **sandbox root接口假设**：resolve只有session/mode，root随Session cwd；host验证repo/attempt后从公开policy结构派生准确teamRoot/validationRoot，不能传不存在的root参数，须核enforcement。
4. **light单写者没有共享CAS**：每个node独立文件不互斥；需要一个repo级index/claim及恢复/显式abandon规则。
5. **commit可重建性/退化输入**：持久化完整commit材料/对象原文与明确canonical JSON算法；C==M/候选已集成不能录下Git会丢弃的重复parent。
6. **M不能证明CAS未发生**：外部reset回expectedOld会误触发重推。选择并授权原子Git侧witness（reflog精确attempt记录或同update-ref事务的专属marker ref）；无可靠witness则人工对账。
7. **receipt/postcheck矛盾**：立即ref_updated收据与最终committed/merged_validation_failed收据分层，状态枚举/必需postCheckRefs/idempotency同步。
8. **observer来源与可重复性**：host封闭observer registry；stdout reader非network observer。light仅接纳安全可重复检查，不把do_not_repeat延后却允许不可重复外部动作。
9. **R0根兼容矩阵不全**：bus keys、A2A roster/receipt/blueprint、web发现都要接同一root；明确仅linked旧队/重复副本的拒绝或授权迁移；验证worktree移到commonDir或host私有根，避免成为用户repo的untracked输入。

保持已做对的顺序：Candidate/manifest/intent → runner →独立审查→精确CAS→恢复；不要因此添加通用工作流/依赖分析/沙箱系统。对应原生shell确为 **resolve→execute→handle.result()**，不是旧run/start。

## 7. 可复用证据与下一步入口

- 当前源码/计划搜证全文（含public resume裁定与B1–B9）：`/Users/yuantian/.pi/agent/sessions/--Users-yuantian-Developer-orchestra-dsh--/subagent-artifacts/outputs/14914f7b-24f3-4c0a-95ed-fb14ad389ffc/evidence/remaining-source-gaps.md`。
- 自动测试收据（末尾含最新失败）：同目录 `checkpoint-tests.md`。旧段有285、292成功，**不能套给当前WIP**。
- 当前失败快照：`/tmp/orchestra-f479b23-model-lane.KpX6TB`。其`probes/regression-model-routes.mjs`与`probes/regression-registered-lanes.mjs`已经写好，因build失败尚未执行，可复用并集成维护测试。
- 最后全绿快照：`/tmp/orchestra-3bd275b-integrated.ZXD5Xn`。初步制品 `/tmp/orchestra-ecd9db7-checkpoint.yC635u/orchestra-dsh-0.5.1.tgz` 对应更早3bd275b，**不是当前最终包**。
- 精确宿主包对照：`tmp/0.1.6alpha2-to-0.1.7alpha1/{a,b,UPGRADE-ADAPTATION.md}`；global已是目标版，不能拿它当旧版证据。
- 所有本轮子任务均已settled；不再向原长会话追加新主题。新测试/搜证使用fresh Sol配置。

**接手第一动作**：读本文→git status/最新日志→修§4三处TS→固定快照让Sol测试→主agent完成§5 A恢复链→实际dev验证；并修§6计划阻断再独立检查。不要先安装坏掉的WIP，不要先实现第二部分。

建议按需加载skills：`plugin-upgrade`、`plugin-test`（含version-migration-testing）、`plugin-release`（pack/install）、`writing-for-agents`（角色/指引）、`pi-subagents`（新鲜有界测试派发）、`agent-browser-usage`/`ego-browser`（真实浏览器验证）。
