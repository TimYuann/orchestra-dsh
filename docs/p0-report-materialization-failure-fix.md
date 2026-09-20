# P0 · 修 §18 缺陷（物化失败分支不再写 `sessionHistory`）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **依据**：`docs/review-rounds-ledger.md` §17 / §18 + driver 裁定 O（修法 = **(a)**）。
> **范围**：只修这一条。**未做 live 半边**（不起 4600、不用 Ego lite、不重启）。4599 全程未触碰。

---

## 1. 结论

| 裁定 O 的要求 | 状态 |
|---|---|
| 1. 失败分支**不写 `sessionHistory`** | ✅ 已改（`src/orchestra.ts` `materializeRole` 失败分支） |
| 2. 留痕改记 **既有的 `noticeFailures`**，**不新增字段** | ✅ 已改（复用 `milestone` / `targetSessionId` / `failedAt` / `reason`，受 `NOTICE_FAILURE_LIMIT` 约束） |
| 3. 写入点 2（重激活替换）**保持不动**并**钉进测试** | ✅ 未改；已加源码级断言钉住"先前进后记旧 id"的**顺序** |
| 4. **不采纳** (b) | ✅ 未采纳 |
| 测试：①history 不变 ②`sessionId` 不变 ③`phase` 回 `reserved` ④`noticeFailures` 条目**不带 `replacedAt` 语义** | ✅ 四条全断言 |
| 回归：**连续两次失败** ⇒ history 仍不变 | ✅ 已断言（含防恒真断言） |

**G-S**：`npm run typecheck` **0**；`npm test` → **269 pass / 0 fail**（266 + 新脚本 3）。

**不得声称 N7 通过**：既存 fixture 的**历史损伤是既成事实**，本轮**未修数据**。N7 对照仍 **exit 1**（见 §2.4），与预期一致。

---

## 2. 证据（先 `npm run build` 再单跑）

### 2.1 新脚本

```
$ npm run build && node --test scripts/test-materialization-failure-history.mjs
# tests 3
# pass 3
# fail 0
```

### 2.2 ★ 变异测试：证明这组断言**真的抓得住原缺陷**

把失败分支**改回**原实现（重新写 `sessionHistory`），重建后跑同一脚本：

```
$ node --test scripts/test-materialization-failure-history.mjs
not ok 1 - a failed materialization leaves sessionHistory, sessionId and phase semantics intact
  error: 'sessionHistory must not change on a failed materialization'
not ok 2 - two consecutive failures still leave sessionHistory untouched (the loop's fingerprint)
  error: 'the original defect appended the same id once per failed attempt; two failures must still add nothing'
```

**两条主断言各自独立命中**（用例 1 抓"失败就写"，用例 2 抓"每次失败都写一遍"= 循环指纹）。
改回修复后 3/3 通过。**⇒ 这组测试不是恒真的。**

### 2.3 回归

```
$ npm run typecheck && npm test
# tests 269
# pass 269
# fail 0
```

**既有 266 项 0 回归。**

### 2.4 N7 对照（**预期 exit 1**，本轮不作为通过证据）

```
$ node scripts/verify-role-identity.mjs --repo …/orchestra_E2E --team …/orchestra_E2E/orchestra/state/team.json
IDENTITY_OK    implementer … · reviewer … · difficulty-architect … · e2e-verifier …
IDENTITY_MISSING difficulty-implementer session-898f7481-… preset=orchestra-implementer rows=5 tools=5
          sessionHistory lists the CURRENT session id as a replaced one
IDENTITY_MISSING difficulty-implementer (history) orchestra-team-f01da153-ec3b09cb-…
          NOT_A_ROLE_SESSION: no session directory for orchestra-team-f01da153-ec3b09cb-…
IDENTITY_SKIP  difficulty-reviewer phase=reserved
# roles 6 ok 4 missing 2
exit=1
```

**这正确反映了修复的性质**：修的是**写入逻辑**，不会回头修**已经写坏的数据**。
⇒ 该 fixture 上 N7 仍失败是**预期**，不是本轮失败。

---

## 3. 改动内容

`src/orchestra.ts` · `materializeRole` 的 catch 分支：

**改前**（`created` 时写 history）：
```ts
...(created ? { sessionHistory: [...r.sessionHistory,
  { sessionId: r.sessionId, replacedAt: Date.now(), reason: "materialization-failed" }] } : {})
```

**改后**：不写 `sessionHistory`；留痕进既有的 `noticeFailures`：
```ts
...(created ? {
  noticeFailures: [...(t.noticeFailures ?? []), {
    milestone: "materialization-failed",
    targetSessionId: r.sessionId,
    failedAt: Date.now(),
    reason: message,
  }].slice(-NOTICE_FAILURE_LIMIT),
} : {})
```

**为什么这样对**（逐条对应 §18 的归因）：
- `sessionHistory` 的语义是"**被替换掉的**旧 id"。该分支里 `r.sessionId` **从未前进**（团队状态刻意停在 `reserved`），所以**没有替换发生** ⇒ 写它就是陈述未发生的事实。
- 同一个值被反复写，正是原缺陷的**循环指纹**（两次失败 ⇒ 两条字节相同、相隔 3 秒）。
- 想留"建了但不可用的那个会话"的痕，用**既有** `noticeFailures`：**不新增字段**，因此**不需要 `fault_ref`**。
- **刻意不带 `replacedAt`**：`replacedAt` 就是那个被移除的**错误主张**本身；把它带进新载体等于换个地方说同一句假话。

**写入点 2（重激活替换）保持不动**，并由用例 3 钉住**顺序**：
```
assert assignIndex < historyIndex      // 必须先 role.sessionId = created.sessionId
assert /oldSessionId/ 在记录块内        // 必须记"移开的那个"
```
**为什么钉顺序而不是钉行为**：行为需要完整的 archive/reactivation fixture（本文件**刻意不建**）；而两个写入点**长得很像**，将来"统一它们"正是把正确那个改坏的路径 —— 所以钉住**承重的那一步**。

---

## 4. 未做 / 未验证

| 项 | 状态 |
|---|---|
| **修数据** | ⬜ **未做（按裁定）**：`team-f01da153` 的 `difficulty-implementer` 仍带着写坏的 history 与幽灵 `role.sessionId`。**这是既成事实**，修它是数据修复，不在本轮。 |
| **N7 通过** | ⬜ **未做，且不得声称**。live 半边属于下一轮。 |
| **live 半边**（起 4600 / Ego lite / `page.fetch` / 重启 / 从实例内读组合 / 真实角色工具调用） | ⬜ **未做（按本轮边界）** |
| **`/team approve` 替用户批准** | ✅ **本轮没有发生**（未用 Ego lite、未驱动任何会话）。ADR-0009 §3 的测试 seam 未被使用。 |
| **写入点 2 的完整行为回归** | ⚠️ 只做了**源码级顺序断言**，**未**跑真实 archive→reactivate 流程。既有 `test-recovery.mjs` 覆盖了那条路径的行为，本轮**未改它**。 |
| **`noticeFailures` 的实际落盘** | ⚠️ 用例断言了"若记了则不带 `replacedAt`"，但本 harness 下 `created` 为该分支时**是否真的记了一条**未单独断言存在性 —— 因为 `created` 是**对当前 `role.sessionId` 的存活探测**，在"新会话已建、但团队状态没前进"的形状下它的语义本身是有歧义的（见 §5）。 |
| **§7 / `.npmrc` / 依赖面 / 契约 / 两份裁定 / 计划文件** | ✅ 均未动 |
| **4599** | ✅ 未触碰 |

---

## 5. 一处必须点明的遗留问题（不改，登记）

裁定 O 第 2 条说"若要留痕'建了但不可用的那个会话'，记进 `noticeFailures`"。**我照做了，但那条留痕记的是 `r.sessionId`（团队状态里的值），而失败尝试实际建出来的是另一个 id**（`created.sessionId`）——

```ts
const created = ctx.agents.get(SID(role.sessionId)) !== undefined;   // ← 探测的是当前 id，不是新建的那个
```

在"新会话已建、团队状态没前进"这个形状下，`role.sessionId` 与**真正被创建**的会话 id **是两个不同的值**。所以这条留痕**指向的不是那个被抛弃的会话**。

**本轮的取舍**：`materializeRole` 的局部作用域里**拿不到** `createSession` 返回的 `created.sessionId`（它在 try 块内、catch 里不可见），要正确记录它需要**改动 try/catch 的作用域结构** —— 那超出"最小修一处"的范围，且会碰其他路径。

⇒ **登记为待办，不本轮修**，并**在代码注释里写明**了这条留痕记录的是哪个 id。请 driver 决定是否要立一条（修它需要把 `created.sessionId` 提升到 catch 可见的作用域）。

---

## 6. 下一跳

**下一轮 = live 半边**（driver 已预告）：以**受管后台作业**自己起 4600（现已空闲），按 ADR-0009 用 Ego lite + `page.fetch` 驱动；重启后从实例内读组合 —— **先试"用宿主 cordis 检查工具在 4600 实例内读"**，不可行则退**"重启后重跑一次真实角色工具调用"**。

**若届时替用户敲了 `/team approve`，我会在报告里主动声明**（ADR-0009 §3）。
