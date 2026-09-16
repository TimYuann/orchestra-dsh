# ADR-0001 · 产品范围：两半结构与异质性边界

- 状态：Accepted
- 日期：2026-09-15
- 来源：用户口述（2026-09-15），修正 `REQUIREMENTS.md` 附录 A 的单中心叙事

## 背景

插件的前身动机是**替代 herdr**：herdr 能并排管理多个 agent shell，提供会话之间互相浏览、
互相阅读的工具，但它的痛点是 **workload 仍然要人来编**。

2026-09-12 的附录 A 把产品重心写成"多 agent 推进编排的**设计方法 + 执行**"，
并把 A2A 降级为"编排使用的传输机制"（附录 A.5）。这个表述丢了前一半：
**多会话工作台本身就是一等能力**，不是编排的附属品。

另一处需要澄清的是"异质性"。审计曾把"不能驱动 pi / codex / Claude Code"记为缺口，用户明确否认：

> 我不是要它驱动不同的 harness，我只需要驱动会话就可以了。这些会话本来就可以通过命令
> 去定义它的 preset、定义它使用什么样的 provider、什么样的模型、什么样的思考强度，这就够了。

## 决定

1. 产品由**两半**构成，都是一等能力，不互为附属：
   - **A2A 工作台**：多会话的发现、管理、通信、阅读（治理无关，随时可用）。
   - **multi-agent workflow**：编排原则 + 三步流程 + 执行运行时（本插件自研打磨的部分）。
2. **异质性的边界是"DSH 会话"**：不同 preset / provider / model / reasoningEffort 由会话创建时
   逐项固定（`a2a_create` 已支持 `presetId`/`agentPreset`/`permissionPreset`/`provider`/`model`/`reasoningEffort`）。
3. **不做**驱动外部 CLI agent（pi / codex / Claude Code）的适配层；这不是本插件的目标。

## 后果

- `REQUIREMENTS.md` 附录 A.5 的"降级"表述被本 ADR 部分取代：A2A 是**并行的一等能力**，
  同时**也是**编排使用的传输机制。两句话不冲突，但不能只用后者。
- 审计提出的"缺口 2/3（不能驱动异质 harness、缺管理动作）"**撤销**：前者是非目标，
  后者另立 ADR-0003。
- 上下文成本记录：`a2a` 与 `orchestra` 两个 prompt section **都是全局注册**
  （`src/a2a.ts:1122`、`src/orchestra.ts:4891`），即每个会话都要为这两半付费。
  今后新增 prompt 段必须按此计价。

## 未决

无。
