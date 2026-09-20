# DSH 原生能力对照（改动前必读）

> **用途**：把"DSH 已有的能力不要自己造"变成可查的东西。任何涉及**会话生命周期、预设与组合、消息投递、审批与提问、命令执行**的改动，先查这张表。
> **结论口径**：以 DSH 0.1.5-rc.2 安装体（`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`）源码为准；出处见 §4。
> ⚠️ 标记的是本次复核**实际踩到或查明**的坑。

---

## 1. 能力对照表

| 能力 | DSH 原生提供 | 插件自建现状 | 结论 |
|---|---|---|---|
| 角色预设名册 | 三个扫描根：包内 shipped（system）、部署 `config.roots`、`~/.dsh/.agent-presets`（user）。发现过程**不做记忆化** → 往已扫描的根里放目录**立即生效**。**运行期无注册 root 的 API** | 自建 `~/.dsh/orchestra/catalog-presets/`，**不进名册**，按文件路径直接挂载 | **替换**：进名册。⚠️ 名册外挂载 = 重启后恢复不了身份 |
| 预设目录的健康判据 | 目录里只需有 `agent.cordis.yml`；**包名行从部署基线解析，不从预设目录解析**（不需要自带 `package.json`/`node_modules`） | 同上 | 可直接搬。实证：插件那批"只有 YAML"的目录作为名册根时 **12/12 健康** |
| 组合挂载 | DSH 自己的会话激活路径**自动** `resolve + mount` | 手写 setup；⚠️ 有一处 `agents.resume` **不带 setup** → 空壳（DSH 有官方告警） | **替换 + 全路径核对** |
| 组合核对 | 行/插件名：`agentPresets.compositionInventory()`；工具名：`standingKeyFor(id)` + `tools.schemas/get`（无需 agent）；会话侧：`sessionProjections.stateOf(session,'agentPreset')` | 仅治理路径上有 `composedPreset` 校验 | **补齐**：所有建会话/恢复路径都要核对 |
| 投递与唤醒 | `sessionController.prompt({sessionId, mode})`（任意会话、自动 resume）、`agents.get(id)` + `Agent.send/steer` | 自建 `deliverMessage` + `tryResume` | **机制替换，语义保留** |
| 冷恢复 | `agents.resume({resumeSessionId})`、`sessionController.prompt` | 自建 `tryResume` | 同上 |
| 投递回执 | 只有 `accepted` + inbox 事件（`agent/inbox/inserted/claimed/discarded`） | 自建"已认领 / 已回答"生命周期 | **保留**——这是插件独有价值 |
| 模型侧的跨会话通信 | ⚠️ 原生模型工具**只能沿直连父子边** | 自建 A2A（跨目录、任意会话） | **保留模型面**。注意：正因为原生模型工具被限制在父子边，这层不能整体删除 |
| 审批（提权） | 策略只有 `ask` / `never` + 一条"受理者"链；⚠️ **整条链没有超时**，唯一寿命控制是取消信号 | 仅在治理路径上钉 `never` | 钉死要**覆盖所有创建路径**；受理者方案见 `docs/alignment-2026-09-20-next-round.md` §2.1 |
| 向用户提问 | 独立链路（`ask_user_question`）；⚠️ **同样没有超时** | 未使用 | **禁止进入角色预设**（角色目前本来就没有该工具） |
| 回合结束信号 | `turn/end` 只说"为什么结束"；⭐ `agent/turn-stopping` 在回合关闭前被 **await** 派发，监听者 `agent.steer()` 可让回合**再走一步** | 用 `agent/status` 的 running→idle **事后推断**停摆 | **替换**：改用 `turn-stopping` |
| 子代理委派 | `startContinuable` / `sendMessage` / `toolFilter` / `persona` / `drainContinuable*`；授权仅直连父子边 | 支持 `subagent` backend | 按需复用（原生子代理不能承接任意会话寻址） |
| 宿主执行命令 | `ctx.shell.resolve/run/start`：显式 `workdir`/`env`/沙箱策略，**以宿主进程身份**运行 | **从不执行任何命令** | 需要"系统自己跑验收"时复用；证据若要可回放，需经会话走 `tools.execute`（结果持久化为 `tool/result`） |
| git / worktree | ❌ **完全没有**（全树搜索结论） | 无 | 只能调外部 git，或不做 |

---

## 2. 使用禁忌（本次踩过或查明的）

1. **不要裸调 `agents.resume` 而不带 setup**——DSH 会用"空的全局层"发布这个 agent，且只发一条告警。
2. **不要把 orchestra 角色预设留在名册之外**——重启即掉身份，且没有任何代码会发现。
3. **不要给角色预设加"询问用户"的工具行**——无超时，等于给无人值守埋一个死结。
4. **不要在无人值守路径上依赖"会有人回答"**——审批与提问都没有超时；必须自带截止时间与默认答案。
5. **不要把"运行中变空闲"当作停摆的唯一信号**——`turn-stopping` 能在关闭前拦下。
6. **不要重造投递/唤醒/冷恢复**——这三件事 DSH 原生有；只有"消息生命周期"与编排语义才值得自建。

---

## 3. 一句话判据

任何"要不要自己造"的问题，先问：**DSH 有没有对应的服务、事件或 API？**
有 → 用它的；没有 → 明确记录"DSH 不具备，故自建"，并写明代价。两者都不做（含糊地既自建又依赖原生）是本次几个缺陷的共同形态。

---

## 4. 证据出处（包 / 文件 / 行）

- **名册与发现**：`dsh-agent-presets/lib/index.js:1240`（Config schema）、`:1300`（根顺序）；`lib/types/discovery.js:35/48/56`（合成文件、用户目录、shipped 根）
- **目录健康判据**：`discovery.js:154/111/117`（包名从 harnessBase 解析）、`:147`（何种情况才算 broken）
- **自动重挂**：`dsh-api-session-controller/lib/index.js:354-365`（composeAgent）、`:398`（resumeObserved）
- **无 setup 即空壳**：`dsh-agent-loop/lib/index.js:1849-1856`（setup 可选）；`dsh-agent-presets/lib/index.js:1320-1323`（官方告警原文）
- **组合核对**：`dsh-agent-presets/lib/types/index.d.ts:149`（compositionInventory）、`:383`（standingKeyFor）；`dsh-tools/lib/types/index.d.ts:655/676`
- **审批**：`dsh-user-approval/lib/index.js:63-66/155-157/177-191`；`lib/types/types.d.ts:37/48/76`
- **提问**：`dsh-user-questions/lib/index.js:20-21/53`（仅 abort，无超时）
- **回合信号**：`dsh-session/lib/types/types.d.ts:249-273`；`dsh-agent-loop/lib/index.js:965-975`（turn-stopping）
- **执行**：`dsh-shell/lib/types/index.d.ts:48-76`；`dsh-shell/lib/types/types.d.ts:34-84`
- **委派**：`dsh-subagent/lib/types/index.d.ts:117/132/161/296`；`continuation-activation.js:293-299`（直连父边授权）
- **投递/恢复**：`dsh-api-session-controller/lib/types/index.d.ts:138`；`dsh-agent/lib/types/runtime-types.d.ts:176-209`

> 完整调研过程与"证据 → 结论"的推导见 `reports/dsh-native-capability-findings.md`。
