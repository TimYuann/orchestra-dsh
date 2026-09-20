# UPDATE v0.5.1 — 自适应团队、失败路径收口、停摆兜底

**日期**：2026-09-19
**口径**：`docs/alignment-v0.5.1-ux.md`（与用户逐条对齐后的记录，与本文件冲突时以它为准）
**测试**：`npm run typecheck` 0 错误；`npm test` **248/248 通过**（2026-09-20 复核重跑确认）；真实 E2E 见 §3

> **2026-09-20 复核补充**：本版已提交为 `6bd8d9b`（未推送、未打 tag、未发布）。
> 独立复核判定**一处发布阻断项**——懒加载 / 重激活创建的角色会话在进程重启后失去角色组合（只剩宿主全局工具），
> 修法与下一轮口径见 `docs/alignment-2026-09-20-next-round.md`，复核原文 `reports/review-v0.5.1-6bd8d9b-R1.md`。

---

## 1. 这一版解决什么

v0.5.0 的闭环能走通，问题集中在 corner case 与"代码改了、教模型的文案没改"的漂移。
v0.5.1 先与用户做了一次逐条 UX 对齐（判定：**一个工作目录只有一个 team，但 team 必须是动态的**），
然后按对齐结论实现。

---

## 2. 改动清单

### 2.1 团队是动态的：`orchestra_add_lanes`（新工具）

第二个目标不再是"开第二个 team"，而是**往正在跑的那张图里加车道**。

- **两段式**：第一次调用（不带 `confirm`）只返回计划——
  每个角色的 `roleId / preset / sandbox / phase / lane / model / 一句话职责`；
  用户点头后第二次调用带 `confirm: true` 才落盘。
- **选角色，不套拓扑**：`preset` 必须是一个真实存在的角色预设（未知 id 直接报错并列出全部可用 id），
  driver 自己决定拆几个角色、串行还是并行、每个角色几轮上限。
- **新角色进入 `reserved`**：加车道不创建任何会话，第一次派活才物化，所以"规划一条车道"的成本是 0。
- **审计轨迹**：每次加车道记进 `team.addedLanes`（roleId / phase / lane / addedAt / reason），
  `orchestra_team` 输出的 `added_lanes` 会把它显示出来——
  一个"悄悄超过批准范围"的花名册是读者必须能发现的东西。
- **权限**：只有 controller 能改花名册； teammates 不能给自己扩编。

### 2.2 两个新角色

| 预设 | 角色 | 沙箱 | 能做什么 | 不能做什么 |
|---|---|---|---|---|
| `orchestra-v04-planner-v1` | planner | read-only | 把一个已批准的目标拆成可执行的 Task Card（context / changedFiles / acceptanceCriteria / verificationSteps） | 不实现、不验收自己的拆解 |
| `orchestra-v04-oracle-v1` | oracle | read-only | 回答一个被升级上来的不确定性（mission 解释冲突、架构争议、高影响取舍），给出推荐 + 理由 + 置信度 + 影响 | 不给 verdict、不拥有 closure、不接管车道 |

角色目录由此从 7 个 v0.4 预设变为 **9 个**（另有 3 个 legacy 只读兼容）。

### 2.3 `/team` 重入仲裁重写

- 工作目录里已有活跃 team 时，**一定**把情况摆出来，并给出**一个二选一**：
  继续旧目标（接管并接着做）／归档旧目标（它的目标、记录、报告都保留，以后能被重新找出来激活）。
- **`/team force-archive` 从代码里删除**。是否"旧目标还重要"是只有用户能做的判断，
  插件的工作是把情况讲清楚，而不是提供一个需要用户记住的逃生命令。
- "_继续_"在有角色仍在运行时被拒绝：在运行中的角色底下插入新目标是必须避免的交错。
- 归档顺序固定：**先停全部存活角色 → 再发布归档 → 最后清活跃状态**。

### 2.4 懒加载失败可恢复

`reserved → provisioning → active` 是**预写标记**，`provisioning` 不再是休息态。

- 建会话失败 → 报清楚角色、原因、以及**章程给它钉的模型**；
- 角色退回 `reserved`（真建过会话则记进 `sessionHistory`），**下次派活重建**，而不是向一个不存在的会话投递；
- 提示 driver：换模型要**先问用户**，且替换只作用于这一次，不写回任何偏好文件。

### 2.5 模型路由不再偷换

- 偏好文件（项目级 `orchestra/preferences.json` 优先、全局 `~/.dsh/orchestra-preferences.json` 兜底）
  **只在它真的存在时才生效**；
- 不存在时回落到**该部署自己配置的默认模型**，而不是套一份硬编码的 deepseek 阶梯；
- 草案与建队两条路径的判定逻辑一致，用户批准的模型就是 provision 钉的模型。

### 2.6 停摆兜底（真实 E2E 现场发现）

**现场事实**：E2E 的 implementer 干完了全部工作、报告用文件工具直接落盘，
然后既没调 `a2a_reply` 也没调 `orchestra_report` 就结束了回合——
driver 收不到任何唤醒信号，团队静默停摆，UI 上看不出异常。

运行时兜底（`ctx.on("agent/status")`）：只在 **running → idle** 转变时触发；
角色**已有待处理输入**时跳过；每次停摆只发一条；通知明确说明"它没有交报告也没有回话"，
并让 driver 自己去核对产物或把它要回来。**已实测该通知真的投递到 driver 会话并从停摆恢复。**

### 2.7 其他收口

- **删除 `workspace.json` 磁盘回退**：那是 workspace 领域的文件，
  `attachSession` 才是它的写入口（校验规范 cwd 必须等于工作区 path、拒绝未知 id、做无效账号剪枝）；
  自己 read-modify-write 会绕过全部校验并撞上领域写链。
- **Task Card 承诺与实现对齐**：architect/planner 是只读角色，唯一写通道是 `orchestra_report`（落 `orchestra/reports/`）；
  **由 driver 落盘 `orchestra/tasks/`**。原先三处要求只读角色写 `orchestra/tasks/` 的文案是空转的。
- **phase/lane 交叉校验**：声明了 `phases` / `lanes` 却让角色指向不存在的 id，草案阶段就报错并列出已声明 id
  （不声明就自由命名的旧拓扑不受影响）。
- **口径同步**：`package.json` description、README、`orchestra_dispatch` / `orchestra_draft` 工具描述全部按实现改写。

---

## 3. 真实 E2E 验证（2026-09-19，4600 dev 实例 + ego-browser）

环境：`provider: minimax-cn`、`model: MiniMax-M3`、`推理等级: Default`，
工作区 `~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E`。

| 验证项 | 结果 |
|---|---|
| `/team` 目标问询 → 草案 → 自然语言批准（"启动"） | ✅ 批准回执、freeze、建队全通 |
| **reserve-only 建队 + 懒加载物化** | ✅ 建队后 `team.json`：implementer `active`、reviewer **`reserved`**（零会话创建）；派发 reviewer 时才物化 |
| 草案卡片角色蓝图表 | ✅ 渲染 5 列（无 phase/lane 时如设计般回落）；两角色模型均为 `minimax-cn/MiniMax-M3` |
| **反应式唤醒** | ✅ driver 派发后交还回合、零 `orchestra_wait`；implementer 的 `orchestra_report` 原生唤醒 driver 并自动派发 reviewer |
| 报告记账 | ✅ `reportCount` / `lastReport` / `reports[]` 正确；先落盘再原子记账 |
| reviewer 独立性 | ✅ reviewer 用黑盒用例测出 **driver 任务卡里 3 处算法预期写错**（评审者不是作者） |
| `orchestra_dismiss` + handoffSummary | ✅ 归档含完整 mission/document/graphRuntime/roles/reports 与 reason/summary |
| **`orchestra_add_lanes`（plan-only → confirm）** | ✅ 第一次调用只返回计划、磁盘无变化；confirm 后 3 个新角色以 `reserved` 加入**同一个 team**，`addedLanes` 三条记录齐全 |
| **停摆兜底** | ✅ driver 会话里出现 `orchestra: <team> stalled <role> finished its turn without filing a report...`，团队从停摆恢复 |
| 产物可玩性（真机交互） | ✅ 三色反馈、屏幕键盘联动、状态栏提示全部正确 |

**过程中发现并修掉的缺陷（两条都是真实 E2E 现场暴露的）**：
0. **只读角色的写通道与审批挂起**：只读角色用通用 `write` 工具写报告 → 只读沙箱拒绝 →
   工具结果提示"可以升级权限" → 它发起**权限升级审批** → 无人值守**没有人能回答** →
   角色回合永不结束 → **整个团队挂在一个没人听得见的问题上**，
   而且这种挂起**连停摆兜底都抓不到**（角色始终是 `running`，从不进入 `idle`）。
   修正三处：角色纪律写进 persona（持久化证据只用 `orchestra_report` 工具，被拒就在回复里说明，不要升级）；
   同一条纪律跟着 `orchestra_dispatch` 的派发消息走（覆盖 legacy 预设）；
   治理角色会话一律 `setApprovalPolicy(session, "never")`，把静默挂起变成当场明确拒绝
   （新增 **peer** 依赖 `@deepseek-ai/dsh-user-approval@0.1.5-rc.2`）。
1. 角色"干完不交报告"导致的静默停摆（§2.6，已加运行时兜底）；
2. 词表可玩性缺陷——原 200 词表缺 CRANE / SLATE / STARE / AROSE 等黄金开局词，
   玩家输入被拒（纯函数测试发现不了，必须真机玩）。E2E 中已扩到 11779 词。

---

## 4. 诚实清单（未做 / 未验证）

1. **加车道不写章程修订**：它改的是 `team.json` 的角色席位 + `addedLanes` 审计轨迹，
   `document.charterRevisions` 仍然只记批准时那张图。若将来要求"审计轨迹必须等于章程"，需要接进 charter amendment。
2. **停摆兜底的去重是进程内的**：`runningRoles` 是插件实例的内存集合，重启后为空。
   后果是"重启前已经停摆的回合"不会被回溯通知（不会误报，只会少报一次）。
3. **`planner` / `oracle` 的 persona 只做了第一版**：它们能通过目录校验、能进团队、能被派活，
   但 personae 本身是要长期打磨的资产，这一版没有经过多轮实战调优。
4. **4600 实例在验证过程中被重启过多次**；4599（web profile）只做了安装，**没有重启**，等用户早上亲自验收。
5. ~~**本版仍未提交到 git**~~ —— 已提交为 `6bd8d9b`（未推送、未打 tag、未发布）；工作树干净。
6. **已经产生的 `approval/asked` 会持久化在会话日志里并跨进程存活**：E2E 里那个只读 architect
   因此永久卡住，重启 4600 也没能自动恢复（该 session 属于上一个服务器进程）。
   新构建不会再产生这种请求，但"恢复会话时主动作废悬挂审批"这件事没有做。
