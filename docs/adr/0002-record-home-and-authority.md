# ADR-0002 · 记录载体与权威来源

- 状态：Accepted
- 日期：2026-09-15
- 来源：handoff §3（用户已批准方向）+ 2026-09-15 确认 P0 优先

## 背景

插件把 7 类自定义事件写进了会话日志。DSH 的持久化读取路径
（`dsh-session-persistence` 的 `validateStoredEvents`）对未知事件类型是**整份拒绝**：

```
session "session-77e87a69-…" contains event type "orchestra/blueprint" (seq 1)
unknown to this harness and not marked ignorable; refusing to interpret the log
```

`KNOWN_SESSION_EVENT_TYPES` 是构建期常量集合，没有第三方扩展点；`Session.append()` 无法设置
信封的 `ignorable`（只有 seed 路径 `assertSessionEventEnvelope` 接受它）。**仓库外插件写不出
"可被未知读者安全跳过"的事件** —— 因此任何自定义事件类型都会让日志在重读时作废。

后果不是边缘情况：受治理角色会话全带 blueprint 标记，driver 会话带 charter/gate 记录，
所以**每一个我们创建的会话在重启后都读不回来**（GUI 打开、`ctx.agents.resume()` 冷恢复、
`sessionQuery.readSession` 全废）。而 `orchestra/a2a-accepted` 写的是**目标会话**——
包括不属于本插件的会话，即我们在让别人变哑。

## 决定

1. **这 7 类记录一律搬出 session log**，落到 `<cwd>/orchestra/` 下的自有文件存储：

   | 会话事件 | 新家（候选） | 用途 |
   |---|---|---|
   | `orchestra/a2a-accepted` | `orchestra/receipts/<sha256(长度前缀的 target)\0messageId>.json` ✅ **已落地** | 投递回执（幂等） |
   | `orchestra/blueprint` | `orchestra/blueprints/<sessionId>.json` | 轻量会话的组合快照，冷恢复用 |
   | `orchestra/governed-blueprint` | 同上 | 受治理版 |
   | `orchestra/charter-draft` | `orchestra/charter/<teamId>.json` | 宪章草案（revision） |
   | `orchestra/charter-approved` | 同上 | 唯一的硬批准记录 |
   | `orchestra/charter-frozen` | 同上 | 冻结 revision |
   | `orchestra/gate-decision` | `orchestra/gates/<teamId>.json` | 人工门决定 |

2. **权威来源转移（用户明确批准）**：宪章等记录从"**会话日志即文档**"变成"**文件即文档，
   会话只是操作它的人**"。这个语义变化必须写进 JSDoc 与相关文档 —— 它改变了恢复语义：
   恢复不再依赖重放会话日志，而是读文件；会话丢了不丢文档。
3. **并发写沿用既有 CAS 形状**：`fs.writeText(target, json, expected /* FsWriteIntent */)`
   （`src/orchestra-state.ts:697`），回执类用 `createIfAbsent` 天然获得幂等。
4. **不得借壳**：不把内容塞进 harness 已认识的事件类型（`data` 会按该类型 schema 校验），
   也不发明新的会话事件类型。
5. **`orchestra/a2a-accepted` 优先**（止血）：它是唯一写在**别人**会话里的记录。
   ✅ 已完成（2026-09-15）。回执改由**注入**的 `ReceiptStore` 承载
   （`src/receipt-store.ts`），transport 保持"无 fs / 无 cwd"的自述边界。
   落地时修正了一处自己的设计错误：用裸分隔符拼接 (target, messageId) **不是单射**
   （key 自身可含分隔符），已改为长度前缀 —— 由 `scripts/test-receipt-store.mjs` 抓出。

## 后果

- **验收判据（不可替代）**：创建一个会话 → **重启实例** → 该会话仍能被 GUI 打开、
  且 `sessionQuery.readSession` 能读出内容。这正是当前失败的动作。
- 已知坏数据只有上一个 session 造的探针 `session-77e87a69-5b9c-4908-a7ea-cd330de45b41`，
  可删；交接声明没有真实用户数据被污染。
- 迁移**不是**一次性数据搬迁：旧格式的读取路径（`receiptFromEvents`、`charterEventsOf`、
  `blueprint` 折叠）要一并删除或降级，否则"事件仍是权威"会在恢复时复活。
- `orchestra_document` / `orchestra_charters` 的读取实现从"读自己的会话日志"改为"读文件"，
  这意味着**driver 会话不再独占地持有文档**，为 ADR-0006 的薄核心留了路。

## 验收结果（2026-09-15）

**已通过。** 判据是"新建的会话在重读时仍被宿主接受"。

- 工具：`scripts/check-session-readable.mjs`。它**不自己实现判据**，而是直接把日志交给
  宿主自己的 `validateStoredEvents`（`dsh-session-persistence`）+ 宿主自己的
  `KNOWN_SESSION_EVENT_TYPES`。任何它接受的日志，宿主就会打开。
  `--self-test` 会先证明它能识破一个已知坏的事件类型 —— 一个永远说"没问题"的检查器
  看起来是一样的。
- **正样本**：在真实实例（headless profile + 临时 overlay 补上 preset roster）里用
  `a2a_create(execution="session")` 建出的会话 `session-960a215a-…` → **ACCEPTED**。
  它的组成记录落在 `orchestra/blueprints/<sessionId>.json`（文件），日志里
  **零个** `orchestra/*` 事件。
- **负样本（防止检查器说谎）**：上一版建出的 `session-edf07121-…` → **REFUSED**，
  报错与当初一模一样：`unknown event type "orchestra/charter-draft" (seq 22)`。
- **全量扫描**：本机 95 个已存会话，**93 个干净，2 个被拒**。

> 交接文件说"唯一已知的坏会话是探针 `session-77e87a69-…`"。**不准确** ——
> 实测还有一个 `session-edf07121-…`（在 `--private-tmp-orchestra-headless-e2e--` 下，
> 带 `orchestra/charter-draft`）。两个都在开发团队自己的 E2E 临时目录里，**不涉及用户真实工作**，
> 但"只有一个"这个说法是错的。两个都保持原样未删（它们只是打不开，不会扩散）。

## 未决

无。文件布局的最终命名以实现为准，若与 `ActiveTeamStateStore` 的既有约定冲突，
以"同目录、同 CAS 形状"为约束重新命名，并回写本表。
