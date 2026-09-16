# ADR-0007 · 节点后端分界规则

- 状态：Accepted
- 日期：2026-09-15
- 来源：handoff §4.1（用户口述，此前不在任何文件里）+ `REQUIREMENTS.md` 附录 A P3

## 背景

2026-09-12 之前，插件的角色**只能**是完整可见会话（规格明文排除 subagent）。
M1 之后节点可由两种后端承载，但分界规则此前只活在对话里。

分界**不是偏好，是原生强制**（2026-09-15 用实时 service 目录复核仍然成立）：
原生 subagent 子节点 join 父的 **live** preset，审批策略在委派边界被钉死 `never`，
沙箱在委派时冻结，且不能被通用 Session 路由寻址。

## 决定

1. **分界规则**：需要以下任一 → **必须可见 Session**，否则用 subagent（更便宜）：
   - 自己的 Agent Preset（composition / 工具面 / prompt 段）
   - 能向用户请求审批
   - 自己的 cwd
   - 真正的只读保证
2. **只读节点必须是 session**：子节点沙箱收窄不到 read-only；
   `toolFilter` 只是**可用性收窄，不构成权限保证**（bash 仍可写）。
   绝不能对一个 subagent 节点声称"只读"——那是安全 bug，不是配置偏好。
3. **有 preset 就要问用户**：当一个节点看起来需要角色专属 preset 时，
   **明确询问用户要不要把这个 preset 做进 DAG**。这是用户的组合、用户的成本、用户的决定 ——
   不静默替他决定，也不为了回避提问而挑一个通用节点。
4. 该规则必须**同时**落在三处：driver 可教文本（原则 section + skill）、
   topology validator（fail loud）、以及 `execution` 字段的实际分支。

## 后果

- **subagent 节点只能与 driver 通信**（原生只授权直接父子边）：
  任何涉及 subagent 节点的边都必须**经 driver 转达**，画成别的样子描述的是
  "一条永远发不出去的消息"。这是 P10 校验规则，也是原则文本里 REACHABILITY 那一条。
- 用户自写 preset 可直接在 DAG 中使用（已验证：`a2a_create(agentPreset=…)` 能挂
  `~/.dsh/.agent-presets/` 里用户自己的 preset）。
- GUI 呈现天然不同：session 节点是侧边栏平级行，subagent 节点挂在父会话下。
  这是平台行为，不试图抹平，但要在 `orchestra_team` 里标注清楚后端类型。

## 未决

`execution` 的缺省值 —— 见 ADR-0010（Proposed，不擅自翻）。
