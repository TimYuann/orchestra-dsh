# orchestra-dsh 架构决策记录（ADR）

> 本目录把**口述决定**变成可追溯的文本。此前大量决定只活在对话、handoff 与 `STATE.md` 里，
> 新接手的 agent 无法判断某条约束是"设计意图"还是"实现巧合"。ADR 就是那条分界线。
>
> **优先级**：`docs/adr/` 的 Accepted 条目 **优先于** `REQUIREMENTS.md` 正文；
> 与 `REQUIREMENTS.md` 附录 A 冲突时，以**日期更新的一条为准**，并在两边互相留指针。

## 格式

```md
# ADR-NNNN · 标题

- 状态：Accepted | Proposed | Superseded by ADR-XXXX
- 日期：YYYY-MM-DD
- 来源：用户口述 / handoff / 本轮核实（附 file:line 或命令）

## 背景
## 决定
## 后果
## 未决
```

## 索引

| # | 标题 | 状态 | 一句话 |
|---|---|---|---|
| [0001](0001-product-scope-two-halves.md) | 产品范围：两半结构与异质性边界 | Accepted | 插件 = A2A 工作台 + multi-agent workflow；异质性靠 preset/model，不驱动外部 harness |
| [0002](0002-record-home-and-authority.md) | 记录载体与权威来源 | Accepted | 7 类自定义会话事件搬出 session log；**文件即文档** |
| [0003](0003-session-control-surface.md) | 会话管理动作面 | Accepted | 打断 / 归档 / 改名 / 读内容；不做硬停 |
| [0004](0004-a2a-list-discoverability.md) | a2a_list 发现性 | Accepted | 大量会话下要能快速定位目标，而不只是"列出来" |
| [0005](0005-reading-depth-boundary.md) | 阅读深度边界 | Accepted | `a2a_read` 保持有界窥视；深读交 OBELISK |
| [0006](0006-thin-scaffolding.md) | 脚手架方向：轻度替换 | Accepted | 宪章与 graph 记账压成薄核心；批准改为回一句"启动"，不再要求斜杠命令 |
| [0007](0007-node-backend-boundary.md) | 节点后端分界规则 | Accepted | preset/审批/cwd/只读 → session，否则 subagent |
| [0008](0008-graph-model.md) | 图模型 | Accepted | 有界无环图 + 有界 Loop 是唯一回边 |
| [0009](0009-test-environment-discipline.md) | 验证环境纪律 | Accepted | web/4599 永不装未确认插件；测试走 dev/headless |
| [0010](0010-execution-default-open.md) | `execution` 缺省值 | **Proposed** | 未决，不擅自翻默认 |
