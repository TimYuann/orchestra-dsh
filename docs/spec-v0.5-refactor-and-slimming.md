# orchestra-dsh v0.5 极简瘦身与重构执行规格书

> 编制时间：2026-09-16  
> 基线版本：`0.1.5-rc.2`（注：官方远端最新 0.1.6-alpha 尚不稳定，本项目严格锁定 0.1.5）  
> 目标：拔除过度工程的重型记账仪式，将插件重构为符合人类生产直觉的“薄核心协作引擎”。

---

## 1. 核心架构重构指导思想

1. **两半结构独立可用（各占 50%）**：
   * **A2A 底座（跨进程沟通管理）**：赋予所有会话平等的沟通、打断、停止、阅读能力。独立可用，支撑轻量短平快任务。
   * **Orchestra 车道编排**：长在 A2A 底座之上，以“车道（Lane）”为单元，支撑多节点、有界小循环的复杂研发任务。
2. **彻底放弃微观状态机，让出 Driver 上下文**：
   * 严禁让 Driver 充当底层图事件的“打卡员”（废除 17 种微观图事件 RPC 调用）。
   * 前线节点自治：`A (调研) → [B (开发) ⇄ C (Review)] → 汇报 Driver`，节点间直接交接硬事实，B 与 C 在前线形成最多 2 轮自洽闭环，Driver 保持静默。
3. **资产内外双轨制**：
   * **内部账本（插件底座现场）**：收纳在工作区根目录 **`.orchestra/`**，只存会话映射、回执、超时守护数据。
   * **外部资产（业务治理文档）**：严格服从项目既有规范（如根目录 `PROGRESS.md`、`docs/receipts/`），如实产出并由 Git 跟踪。
4. **用聪明护栏取代死板 Budget**：
   * **尝试上限（Attempt Cap = 2 轮）**：同一任务代码修改超过 2 轮直接熔断弹回 Driver；
   * **20 分钟心跳防僵死（Stall Heartbeat）**：Worker 超过 20 分钟完全无动静，底座唤醒 Driver 巡查，杜绝断网失联。

---

## 2. 削减与清理清单（必须删除的代码与工具）

### 2.1 彻底拔除的微观状态机工具（共 17 个）
从 `src/orchestra.ts` 中移除以下工具的注册及其底层无用实现：
1. `orchestra_loop_start`
2. `orchestra_attempt_start`
3. `orchestra_verdict`
4. `orchestra_handoff`
5. `orchestra_gate_open`
6. `orchestra_gate_fallback`
7. `orchestra_graph_reconcile`
8. `orchestra_reconcile`
9. `orchestra_decision`
10. `orchestra_document`
11. `orchestra_charters`
12. `orchestra_graph`
13. `orchestra_close`（直接合并入任务终结或自然归档）
14. `orchestra_apply_amendment`（动态车道无需复杂的正式修订案）
15. `orchestra_freeze`（白话批准后直接进入就绪态）
16. `orchestra_spawn`（目前第一行无条件抛错的死工具，彻底移除）
17. `orchestra_create` 中关于一次性锁死全部 Roster 的臃肿校验。

### 2.2 ADR 状态同步
* [ADR-0001](file:///Users/yuantian/Developer/orchestra-dsh/docs/adr/0001-product-scope-two-halves.md)：保持 Accepted。
* [ADR-0002](file:///Users/yuantian/Developer/orchestra-dsh/docs/adr/0002-record-home-and-authority.md)：保持 Accepted（文件即文档已落地）。
* [ADR-0003](file:///Users/yuantian/Developer/orchestra-dsh/docs/adr/0003-session-control-surface.md)：更新并补充 `a2a_stop`（调用 `agent.cancel()`）。
* [ADR-0006](file:///Users/yuantian/Developer/orchestra-dsh/docs/adr/0006-thin-scaffolding.md)：保持 Accepted，确认本规格书为其终局落地。
* [ADR-0007](file:///Users/yuantian/Developer/orchestra-dsh/docs/adr/0007-node-backend-boundary.md)：保持 Accepted。
* [ADR-0008](file:///Users/yuantian/Developer/orchestra-dsh/docs/adr/0008-graph-model.md)：保持 Accepted，微观事件退场，车道 DAG 确立。
* [ADR-0009](file:///Users/yuantian/Developer/orchestra-dsh/docs/adr/0009-test-environment-discipline.md)：保持 Accepted。
* [ADR-0010](file:///Users/yuantian/Developer/orchestra-dsh/docs/adr/0010-execution-default-open.md)：状态由 Proposed 变更为 **Accepted（维持默认独立 Session）**。

---

## 3. 工具重塑与新增规范（瘦身后的核心工具集）

重构后，插件对外暴露的工具精简收敛为以下核心组合：

### 3.1 A2A 工具组（基础跨进程管理）
1. **`a2a_list`（增强）**：
   - 默认按当前项目（CWD）最近活跃时间降序排列；
   - 暴露 `cwd`、`lastActivity`（如 "2m ago"）、`role`；
   - 新增 `query` 参数：支持按会话名称关键词秒级筛选历史会话。
2. **`a2a_send`**：
   - 发送消息给目标 Session，支持 `interrupt: true` 进行回合内打断插话；返回幂等回执。
3. **`a2a_stop`【新增】**：
   - 参数：`sessionId: string`, `reason?: string`
   - 实现：调用 `@deepseek-ai/dsh-agent` 上的 `agent.cancel(cause, { keepInbox: false })`，立刻掐断推理并清空待办，使会话秒停归入 idle。
4. **`a2a_read`（增强）**：
   - 实现**倒序渐进披露**；默认读取目标最近 1~2 轮交互摘要；支持按需扩大翻阅窗口。
5. **`a2a_create`**：
   - 基础会话创建工具，支持指定 preset、model、reasoningEffort 等。
6. **`a2a_status` / `a2a_reply`**：
   - 保持现状。

### 3.2 Orchestra 工具组（极简车道编排）
1. **`orchestra_draft`**：
   - 起草车道计划草案（包含 Lane 目标、参与角色、预计环节与循环上限）。
2. **自然语言批准（系统级监听）**：
   - 用户在对话中回复“启动”、“可以”、“ok”，监听器自动识别并将草案解冻，Driver 被叫醒。
3. **`orchestra_dispatch`【核心重塑工具】**：
   - 参数：`roleId: string`, `task: string`, `options?: { laneId?: string, preset?: string, timeoutMs?: number }`
   - 语义：按需派发任务。如果对应角色的 Session 尚不存在，底座自动根据 preset 拉起并登记到 `.orchestra/` 映射表中；若已存在，直接投递任务指令；自动绑定 20 分钟心跳超时守护。
4. **`orchestra_wait`（带心跳巡查）**：
   - 参数：`timeoutMs?: number`（默认 `20 * 60 * 1000` 即 20 分钟）
   - 语义：Driver 挂起等待。前线任何 Worker 提交报告时提前唤醒；若无事达到 20 分钟，自动超时唤醒 Driver 开展例行巡查。
5. **`orchestra_report`**：
   - 前线 Worker 向 Driver 或下一个环节交接 Hard Fact 的标准化渠道（写入报告文件，触发 wait 唤醒）。
6. **`orchestra_team`（客观核验看板）**：
   - 输出当前团队客观事实：各角色会话状态、活跃心跳、对应 Git Commit 是否真实存在、收据文件是否已在磁盘生成。
7. **`orchestra_dismiss` / `orchestra_activate`**：
   - 结案归档与换代复苏。
8. **`orchestra_topologies`**：
   - 列出可用拓扑与车道模板。

---

## 4. 开发与测试纪律（硬红线）

1. **依赖铁律**：
   - 所有的 `@deepseek-ai/*` 只能进 `peerDependencies` 与 `devDependencies`，**绝对不能进 `dependencies`**（防止双实例加载瘫痪工具）。
2. **打包命令**：
   - 本机 `~/.npm` 权限已损坏，打包必须执行：
     ```bash
     npm pack --cache /tmp/dsh-npm-cache
     ```
3. **前端 Slot 注入门控**：
   - 在 `src/client/index.tsx` 中注册设置面板，必须使用：
     ```ts
     ctx.slots.inject("settings.section", () => ctx.slots.register(...));
     ```
4. **测试环境与端口纪律**：
   - **绝对不碰 4599（主生产 Web Profile）**；
   - 测试必须安装在 `~/.dsh/profiles/dev` 下；
   - 启动测试实例：
     ```bash
     scripts/dev-instance.sh 4600
     ```
   - 注意：`dev` profile 与另一个项目共享，同步安装时**绝对不能删除其原有的 `dsh-trinity` bundle 和依赖**；
   - 建议使用 **`ego-browser` (ego-lite)** 打开 `http://127.0.0.1:4600` 进行真实端到端测试。
