# ADR-0010 · `execution` 的缺省值

- 状态：**Accepted（维持默认独立 Session）**
- 日期：2026-09-16
- 来源：docs/spec-v0.5-refactor-and-slimming.md / 用户共识（2026-09-16）

## 背景

`RoleConfig.execution: "auto" | "session" | "subagent"`。

- `auto` = 「声明了 preset → session，没声明 → subagent」，正是 ADR-0007 的分界规则。
- 但翻默认值会把**用户自写的、无 preset 的旧拓扑**静默改成 subagent
  （失去独立审批与只读保证），而**项目铁律禁止静默降级**。

当前实现：缺省 `session`（维持独立 Session，零破坏性降级风险）。

## 决定

**Accepted：维持默认独立 Session。** 
经过 2026-09-16 架构对齐，正式确立缺省为 `session`。独立会话具备完整自治边界、原生工具集和独立上下文，符合前线工人自治与车道派发架构。

## 后果

- 用户拓扑与动态车道缺省均保持安全、隔离的独立 Session；
- 无静默降级隐患；
- 与 ADR-0007 明确互补。

## 未决

已决。维持缺省 `session`。
