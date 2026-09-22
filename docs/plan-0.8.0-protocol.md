# 交付层执行协议 · v2 导航

> 2026-09-22。本文不再维护第二套任务地图或覆盖规则。
> **开始实现**读 [`plan-0.8.0-execution.md`](plan-0.8.0-execution.md)；**查字段、Git/证据/权限语义**读 [`plan-0.8.0-delivery-layer.md`](plan-0.8.0-delivery-layer.md)。旧 S/P/V/O 编号见 Git 历史；遇到冲突以 v2 的明确修正为准。
> **当前v2有9项未修设计阻断；源码2f08a05已通过机械验证但未验收真实Web/跨重启；先读 `docs/handoff-2026-09-22-upgrade.md`，不能直接进入交付层实施。**
> 当前只优化交付层计划，未实现新交付层。第一部分升级状态见 `upgrade-0.1.7-alpha.1-implementation.md`，不是从计划推断。

## 工作分工

主 agent 直接实现、修订计划和集成；subagent 用于探查、搜证、调研和测试，一般新派发仅Sol medium / Sol xhigh；Owner另指定单个Sol high浏览器验收，实际DSH会话统一MiniMax-M3。主仓保持一个源码写者。测试对固定 commit 或带 hash 的差异快照进行，不能把边改边测的输出算作最终版本证明。每个子代理只做一个大任务或一组相关小任务，完成后结束；新主题fresh context，不不断追加导致无谓压缩。

旧编排中的 Luna/Terra 实现/文档 writer 步骤已经被 Owner 取代，不继续启动。不将此 harness 配置写成 Orchestra 产品的角色模型默认值。

## 看结果，不看任务状态标签

| 返回事实 | 主 agent 动作 |
|---|---|
| 通过且有对应快照/命令/证据 | 检查是否覆盖本次变更，再集成；子会话“completed”本身不是证据 |
| 自动测试通过，live/browser/restart 未测 | 标明 PENDING-RUNTIME，在授权 dev 实例安排测试，不能发布完成声明 |
| 测试失败 | 先保留失败命令/输出/候选身份；主 agent 定位和修改，测试 agent 复跑原失败 |
| scope 未完成、验收 rejected | 保留阶段成果，按明确缺项继续；不降低标准凑通过 |
| 传输/工具/运行基础设施错误 | 记录实际原因和部分差异；同协议恢复原可续会话，不偷偷换 CLI 或改宿主配置 |
| 需要新的权限或不可逆操作 | 停在该边界问 Owner；测试失败不能产生授权 |
| 交付已产生副作用但落账失败 | 按 exact expectedNew 对账，不以普通重试掩盖事实 |

主 agent 应核对子会话摘要与源码/真实产物一致；声明“已改指引”“已加载 playbook”“已验证完整组合”都需要可见的对应行为。

## 有界交接格式

- Outcome：完成、部分完成或阻断；不要混用。
- Snapshot：commit、dirty diff/hash、host 版本、测试工作区/profile。
- Evidence：实际命令、exit code、报告/日志/制品路径；敏感信息脱敏。
- Residual：哪些行为未验证、哪些失败已复现、需要谁做什么。
- Next：一个具体入口/动作；不复制完整计划。

报告/通信本身也有成本；总动作含失败、取消、消息与返工，新增治理动作单独统计。图里声明的 attempt/cap 不等于当前 host 已有强制执行。

## 不变的宿主边界

- `dev-orchestra:4600` 是本项目测试目标；`dev-trinity:4601` 属兄弟项目；原 dev/web、4599、历史会话保持不动。
- 原生 child 消息沿 parent edge；独立 Session A2A 不能直接冒用 child sessionId。
- `@deepseek-ai/*` 只入 peer/dev，运行期使用宿主单实例。
- 未知关键运行前提不是 PASS；自报 stdout、角色自报 SHA、hash 相同都不能自动证明完整输入或真实外呼。
- DSH 0.1.7 preset 是声明注册，不是旧目录 roots；shell 是 resolve→execute→handle.result()，不是旧 run/start。
