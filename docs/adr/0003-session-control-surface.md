# ADR-0003 · 会话管理动作面

- 状态：Accepted
- 日期：2026-09-15（2026-09-16 v0.5 补充）
- 来源：用户口述（2026-09-15/16）+ 实时 service 目录核实

## 背景

审计曾判定"不能停、不能关、不能改名"，用户当场纠正：

> 现在 A2A 里边这个 send 工具似乎是可以打断的。……管理动作要丰富一点，要可用。
> 不过它不是一个特别紧凑、要求特别高的 feature。

核实结果（`src/a2a-transport.ts:257-258`）：`a2a_send(interrupt:true)` 走 `live.steer(message)`，
**是真正的回合内打断**（插到目标最近一个 step 边界），不是"best-effort 的假打断"。
在 v0.5 架构对齐中，针对失控、陷入死循环的会话，进一步核实了 `Agent.cancel` 具备即时掐断能力。

用创造模式查询本机 0.1.5-rc.2 的**实时 service 目录**，宿主实际给出：

| 动词 | API | 插件现状 |
|---|---|---|
| 打断（steer） | `Agent.steer` ← `a2a_send(interrupt:true)` | ✅ 已用 |
| **硬停 / 秒级终止** | `Agent.cancel(cause, { keepInbox: false })` ← `a2a_stop` | ✅ v0.5 已接 |
| 打断子节点 | `subagents.interrupt(targetSessionId, authority)` | ⚠️ 只用于收尾 drain |
| 打断队友 | `agentTeams.interrupt(caller, targetName)` | ❌ 官方实验组，本插件不依赖 |
| **归档会话** | `workspaceController.archiveSession` / `workspaceRegistry.archiveSession` | ❌ 平台有，未接 |
| **改名** | `sessionTitle.rename(session, title)` | ❌ 平台有，未接 |
| fork 会话 | `sessions.fork(source, boundary, childSessionId)` | ❌ 未接 |

## 决定

1. 目标动作面 = **打断（已有）+ 硬停 / 终止（`a2a_stop`）+ 渐进翻阅（`a2a_read`）**。
2. **支持硬停**：通过宿主 `Agent.cancel(cause, { keepInbox: false })` 落地 `a2a_stop`。不仅中止当前 turn 推理，还清空队列中的待处理消息，确保跑飞的会话秒停并恢复为 `idle`。
3. 归档与改名若后续需要，直接接 `workspaceRegistry` / `sessionTitle` 的既有服务，不自建文件状态。
4. 范围纪律：极简可用，无额外状态机开销。

## 后果

- Driver 拥有强制控制权：当 Worker 发生失控、死循环时，可通过 `a2a_stop` 掐断；
- 配合 `a2a_list`（按活跃时间排序 + `query` 检索）与 `a2a_read`（倒序渐进披露），形成完整的会话观测与治理闭环。

## 未决

无。

