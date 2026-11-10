# v0.7.0 — A2A 优先，适配 DSH 0.2.2

目标宿主：**DSH `>=0.2.2-rc.1 <0.3.0`**，Node ≥ 22。本版本不再声明支持旧的 DSH 0.1.x / 0.2.0 接口。

## 主要变化

- **A2A 默认及时投递**：`a2a_send` / `a2a_reply` 默认在忙碌接收方的下一个步骤边界进入，不取消当前工作。`interrupt:false` 保留独立下一回合；`wake:false` 只补充上下文、不唤醒。
- **派生 Session 的思考强度真正持久化**：改用原生 `agent.model.select()`；创建前校验支持的 route/effort；lightweight AgentOptions 保留显式 effort。修复旧接口导致“回执写着 Max，宿主却未记录”的问题。
- **尊重后续 GUI 选择**：lightweight 冷恢复不再用出生蓝图覆盖后来的原生 model selection/request header。既有 governed role 的授权契约保持不变。
- **权限回执更清楚**：分别返回 requested/effective permission preset、sandbox、approval 和 effort。成员仍默认 approval `never`，不等于 Full access；stock preset 被改变审批策略后，GUI 可能显示 custom。
- **投递与状态修复**：waking 投递不能仅写入无 driver 的 Session 后宣称已唤醒；原生恢复失败会报错。并发 cold 消息共享一次恢复、保留各自消息。成功且精确关联的 `a2a_reply` 可以证明 answered，调用意图或失败结果不能。
- **只读回复收据**：幂等 reply 使用与 send 相同的受限 receipt escrow policy。
- **当前 native API**：使用 `startActivation` / `drainChildren`。旧 `persona/toolFilter` native 参数已被宿主移除，现明确拒绝，避免静默丢失能力边界；需要独立人格/工具面时使用声明式 Session preset。
- **Team 保留但弱化**：普通协作无需建队；详细协议按需加载为 `orchestra-teams` skill。设置页以 A2A 为主，Team 折叠为进阶功能，展开后才轮询。Team 工具、批准流程和存储未删除。
- **展示规范**：补齐中英文插件信息和原绘图标，适配当前 locale、主题 token 与 Client 模块边界。

## 升级注意

1. 通过 DSH 原生插件管理器正常升级到 `orchestra-dsh@0.7.0`，按其 activation 结果决定是否需要重启。
2. 升级后用新 Session 验证。A2A 已接受不等于已处理；step steering 也不是固定延迟或不可丢弃承诺。
3. 之前已经排入下一回合的消息不会自动提前；重试同一幂等收据不改变原投递方式。
4. 本版本不会替用户修改 profile、升级宿主、迁移旧 Session，或自动增加 Worker 权限。

## 验证与边界

- Host / Client typecheck、build、**347/347 tests** 通过。
- 包含真实 DSH 0.2.2 AgentLoop 集成对照：默认投递进入同回合下一步骤，显式 queue 进入第二回合；原生 model selection 与 request header 都记录 Max。仅远端模型输出为可控模拟。
- 实际 tgz 校验：93 files，无 node_modules，宿主包不进入 runtime dependencies；中英文 meta、SVG 和 Client factory 完整。
- **未完成**真实 `commandcode + Max`、浏览器 GUI、跨进程重启验收。这些限制随版本公开，不将单测等同于完整安装验收。
- 本次发布不安装或重启用户的 Desktop；由用户通过正常升级流程验收。

制品 SHA-256：`672ce67d912d58d297210e606e17087ccf0821ddefbed5dd5d7a8b55a1871277`。
