# Orchestra A2A for DSH

让 DSH 中的独立 Agent 会话互发任务、讨论问题、交回结果。**日常协作直接用 A2A，不需要先创建团队。**

Orchestra Team 仍然保留，适合需要章程批准、固定角色和交接记录的进阶工作流。

[发布说明](<UPDATE-v0.7.0.md>) · [GitHub Releases](https://github.com/TimYuann/orchestra-dsh/releases) · [npm](https://www.npmjs.com/package/orchestra-dsh)

## 安装与升级

- 当前版本：**0.7.0**。
- 宿主要求：**DSH `>=0.2.2-rc.1 <0.3.0`**，Node ≥ 22。开发与集成测试固定在 DSH 0.2.2-rc.1，不代表所有未来版本都已验证。
- 在 **DSH 原生插件管理器**中安装或更新 `orchestra-dsh`，按安装结果提示决定是否重启。更新会影响所选 profile 下的会话，生效后建议用新会话检查。

不要为了安装插件，手动改写 profile 的依赖或补丁文件。DSH / Cordis 由宿主提供，插件通过 peer dependencies 使用它们；在 profile 中安装另一份核心包可能导致双实例加载和工具执行故障。

## 从一次普通协作开始

直接告诉主 Agent：

> 在当前项目创建一个只读协作者，检查消息投递的实现和测试。给它明确的检查范围，让它通过 A2A 回复结论；你继续处理其它工作，不用建队。

典型过程是：

1. `a2a_create` 创建独立 Session，取得 Session ID。
2. `a2a_send` 向它发送任务，说明范围、输入、检查方法和结果接收者。
3. 协作者用 `a2a_reply` 回复原始消息。
4. 主 Agent 收到回复后继续工作；有需要时用 `a2a_read` 查看最近的对话。

**创建 Session 不等于已经派发任务。**独立 Session 创建后，还需要向它发送任务。协作者运行期间可以继续做独立工作；如果只剩等待回复，就结束当前回合，而不是持续轮询。

### 指定模型、Max 与只读权限

下面是 `a2a_create` 的示例参数：

```json
{
  "execution": "session",
  "cwd": "/absolute/project/path",
  "permissionPreset": "read-only",
  "provider": "commandcode",
  "model": "deepseek/deepseek-v4.1-flash",
  "reasoningEffort": "max",
  "title": "检查 A2A 消息投递"
}
```

`commandcode` 是部署中配置的 provider ID，不是插件内置服务。请换成你自己的 provider/model，并确认模型支持所选思考强度。0.7.0 在宿主 LLM 服务可用时预校验这些参数，不支持就明确报错，不静默降档。

## 消息什么时候会被处理？

0.7.0 调整了 `a2a_send` 和 `a2a_reply` 的默认行为，解决主 Agent 长期工作时，回复一直排在“下一回合”的问题。

| 发送方式 | 行为 |
|---|---|
| 默认参数 | 在忙碌接收方的**下一个步骤边界**进入；空闲接收方被唤醒 |
| `interrupt: false` | 排到独立的下一回合，等待当前回合结束 |
| `wake: false`（仅 send） | 只补充上下文，不唤醒；同时传 `interrupt: true` 也不会唤醒 |

这里的 steering **不会取消正在执行的模型请求或工具**，也不是固定延迟承诺。长请求、长工具调用、取消或步骤拒绝，都可能使消息延迟；取消、拒绝后的清理或插件卸载也可能丢弃待处理的 steering。

如果目标没有运行中的 Agent，waking 投递会尝试原生恢复；宿主无法取得 writer 时明确报错，不会仅写入消息就宣称已经唤醒。插件不会绕过宿主的会话写入所有权保护。

之前已经排队的消息不会因为升级自动提前；重试同一份幂等收据，也不会改变原消息的投递方式。

### 接受、取用和回答是三件事

- `accepted`：投递已被接受，**不等于对方已读取或任务已完成**。
- `claimed`：有接收方取用消息的会话事件作为证据。
- `answered`：有精确关联的回复证据，不是仅凭对方结束了回合。

要关联回答，`a2a_reply` 的 `reply_to` 应使用收到的**完整 message ID**，`to` 指向原始发送者。正常成功的 reply 可以证明回答；只调用过工具、回复失败、回复给别人，或使用“上一条消息”这样的描述性标记，都不能证明该条消息已回答。

重试同一个发送意图时，可以复用 idempotency key；新任务请用新 key。幂等机制避免重复投递，不替代任务验收。

## 权限与思考强度

**文件沙箱和审批策略是两套设置。**

独立 Session 可以在创建时选择 `permissionPreset`。协作者默认使用 `approval: never`，避免无人值守时停在审批提示上；这不意味着获得 Full access。例如，原生 `workspace-write` 预设如果默认允许提问审批，被改为 never 后，DSH 可能把实际组合显示为 **custom**。

0.7.0 的创建结果分别报告请求的预设、实际生效的预设、sandbox、approval、模型和思考强度，不再只给一个容易误解的预设名。

模型选择通过原生 `model/selection` 记录，供执行和 GUI 使用。创建后仍通过 **DSH 原生会话控件**调整权限、模型或思考强度；`a2a_create` 是创建工具，不是更新已有会话的工具。轻量 Session 冷恢复会尊重后续原生模型记录，不拿出生蓝图覆盖用户的新选择。受治理角色则继续遵守其单独批准的固定契约。

## A2A 工具

| 工具 | 用途 |
|---|---|
| `a2a_create` | 创建独立协作者 Session；也可显式选择 native subagent |
| `a2a_send` | 按 Session ID 发送消息，同一宿主中可跨工作目录 |
| `a2a_reply` | 向原始发送者回复，并关联 incoming message ID |
| `a2a_list` | 搜索和发现 Session，优先列出当前工作目录，带团队/归档信息 |
| `a2a_read` | 渐进读取最近的对话，不默认倾倒完整历史 |
| `a2a_status` | 查询有证据支撑的投递、取用和回答状态 |
| `a2a_stop` | 取消目标当前工作，并清空其待处理消息 |

### 独立 Session 与 native subagent

日常 A2A 协作默认使用 `execution: "session"`：它有独立预设、工作目录和文件沙箱，可由其它独立会话通过 A2A 寻址。

`execution: "subagent"` 使用宿主的父子委派机制，需要 `prompt` 才能启动。它不是任意独立 Session 的替代品，通信要遵守原生父子边界。本插件不提供 native child 的独立权限控制。

DSH 0.2.2 已移除旧 native activation 请求中的 `persona/toolFilter` 字段。旧请求会明确失败，不会悄悄丢掉声明的工具边界。需要独立人格或工具面的协作者，请使用声明式 Session preset。

## 进阶：Orchestra Team

当你确实需要批准章程、组织固定角色、共享任务车道或归档交接记录时，再使用 `/team`。普通“协作、委派”不自动进入建队流程。

流程仍然保留：**讨论目标 → 草拟章程 → 用户批准 → 派发角色 → 检查报告 → 停止并归档**。只有真实用户批准产生的 `frozenRef` 才能创建团队，模型不能自行批准。

- `orchestra_draft` / `orchestra_create`：提出并创建获批团队。
- `orchestra_dispatch` / `orchestra_send` / `orchestra_report`：派发、通信与交接。
- `orchestra_add_lanes`：预览新任务车道，用户同意后应用。
- `orchestra_team` / `orchestra_dismiss` / `orchestra_activate`：查看、归档与恢复。
- `orchestra_topologies`：查看角色预设与拓扑模板；`orchestra_wait` 仅供 headless/scripted 等待。

每个工作目录仍只允许一个活跃 Orchestra Team。Team 工具和已有数据没有删除，详细流程通过 `orchestra-teams` skill 按需加载；设置页把团队信息放在折叠的进阶区，展开后才轮询。

运行记录保存在 `<cwd>/orchestra/`。拓扑声明本身不强制执行审查期限、专业验收或发布权限；计划中的确定性交付层不是已交付功能。

## 验证范围

0.7.0 已通过 Host/Client typecheck、build 和 **347 项测试**，包含真实 DSH 0.2.2 AgentLoop 的对照：默认 A2A 在同回合的下一步骤进入，显式 queue 在第二回合进入，模型选择和请求头都包含 Max。该测试只模拟远端模型输出，Agent、Inbox、Session、projection 和 driver 使用原生实现。

**尚未完成真实 commandcode + Max、浏览器 GUI 和跨进程重启验收。**这些测试不能由单测或 slot 注册替代。更多证据与边界见[本轮升级记录](<docs/upgrade-2026-11-10-a2a-first.md>)。

## 开发

```bash
npm install --ignore-scripts --package-lock=false
npm run typecheck
npm test
npm pack --cache /tmp/dsh-npm-cache
```

测试使用隔离存储；不要让两个宿主同时驱动同一个 Session。安装使用 DSH 插件管理器，Client 改动需对安装后的实际页面做浏览器检查。

## 许可

[MIT](<LICENSE>) © 2026 TimYuann。图标为原创，同样按 MIT 分发。DSH 是独立项目，遵循其自身许可。
