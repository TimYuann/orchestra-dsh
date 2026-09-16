# ADR-0009 · 验证环境纪律

- 状态：Accepted
- 日期：2026-09-15
- 来源：用户口述（2026-09-15）+ handoff §5/§6，含一次端口指派变更

## 背景

用户的日常实例在 **web profile / 端口 4599**。用户明确说明**不得在那里安装未确认的插件**：

> 这个会话没挂这个插件很正常，因为 DSH 每次更新，如果你挂载了若干个插件，
> 它就有可能导致启动不起来。所以我们是不在当前你这个 profile（web）下装没有通过确认的插件的。

**端口指派在 2026-09-15 被用户改过**：handoff §5 与 `AGENTS.md` 都写"4600 属于
`dsh-web-search-chained`，orchestra 用 4601"；用户本轮指定 **4600**。
核实：当时只有 4599 在监听，4600/4601 均空闲 —— 另一个项目的实例没有在跑，所以指派是安全的。

## 决定

1. **web profile（4599）永不安装本插件**，除非用户明确确认。它是用户的日常环境，
   插件崩了会连带整个实例起不来。
2. **验证实例**：
   - `dev` profile（**与 `dsh-web-search-chained` 共享**）：端口 **4600**。
     改动该 profile 时**只加不改** —— 绝不删它的 `dsh-trinity` 依赖与 bundle 行。
   - `headless` profile：已装本插件，可脚本化复现（每次全新进程、跑完退出）。
     注意它是 bare fs，sandbox/escrow 行为与 web 不同 —— headless 全绿 ≠ enforcing 后端可用。
3. **批准门的测试 seam（危险，必须显式记录）**：受治理流程需要一次 `/team approve`，
   而那是**用户命令**。为了能自主验收，本轮授权在**测试实例**上由 agent 代敲。
   - 这**只是测试 seam，不是产品行为**。产品路径不变：批准仍必须是用户动作。
   - 只能在 dev / headless 实例上做；**绝不在用户真实实例上**用自动化替用户批准
     （那等于 agent 自我批准，规避产品唯一的硬控制点）。
   - 实现方式按可行性择一：headless 的输入通道把 `/team approve` 当作**用户输入**投喂
     （最干净，会话日志里它确实是一条用户命令），或用 ego-browser 操作 dev 实例 GUI。
4. **E2E 模型统一**：`provider: command`、`model: deepseek/deepseek-v4.1-flash`、effort `max`。
5. **改代码/package.json 后的三件套**（历史事故教训，不可省）：
   `npm pack --cache /tmp/dsh-npm-cache`（本机 `~/.npm` 权限已损坏）→ 同步 profile →
   验证 profile 无 `@deepseek-ai` 实体副本 → **新会话**实测。
6. `@deepseek-ai/*` **绝不进 `dependencies`**（双实例加载 → 所有工具调用崩溃）。

## 后果

- README 里"dev 实例 :4600"与 `AGENTS.md` 的"4601"漂移，以本 ADR 为准统一到 **4600**；
  两份文档都要改，不能留矛盾。
- 任何"替用户批准"的动作必须在报告里**主动声明**，否则外部验收者会把它误读成产品能力。

## 多轮真实会话怎么驱动（2026-09-15 发现，很有用）

headless 每次都是**一次性**的：一个会话只吃到一条用户消息，之后无法再对它说话。
所以"先有计划、再有用户回复"这种验证，headless 做不到。

Web 实例可以。界面自己用的是 `/api/*` 上的 JSON-RPC，发送一条用户消息就是：

```js
await page.fetch("/api/session/prompt", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    type: "client-request",
    rpcId: crypto.randomUUID(),
    method: "session/prompt",
    payload: { args: { request: {
      requestId: crypto.randomUUID(),
      sessionId: "session-…",          // 任何已存在的会话
      mode: "queue",
      content: [{ type: "text", text: "启动" }],
      clientTimeZone: "Asia/Shanghai",
    } } },
  }),
});
```

要点：

- 用 `page.fetch`（在页面里发），**不用**自己处理登录 cookie。
- `sessionId` 可以是**任意**已存会话，包括别的 cwd、别的 profile 建的 —— 只要那个实例能读到它。
- 这样就能脚本化"多轮对话"，不必去点界面。点界面很贵：driver 起草前可能连问 5 个问题，
  逐个点完再等起草，成本远超验证本身。
- 这套办法是 2026-09-15 验证"回一句启动就算批准"时趟出来的，此后做多轮 E2E 都应优先用它。

## 未决

无。
