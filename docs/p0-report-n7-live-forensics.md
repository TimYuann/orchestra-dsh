# P0 · N7 live 取证轮报告（Part A 归因 + Part B 部分完成）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **依据**：`docs/adr/0009-test-environment-discipline.md`、`docs/review-rounds-ledger.md` §17、`docs/plan-0.8.0-execution.md` §4.7。
> **fixture（driver 更正后的正确工作区）**：`~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E`（两个大写 E），`team-f01da153`。
> **测试协议遵守**：Ego lite（非 browser-use）、多轮用 `page.fetch("/api/session/prompt", …)` 驱动、只在 dev（4600）实例操作、**4599 全程未触碰**。
> **本轮未改一行产品代码**。

---

## 1. 结论

| 段 | 结论 |
|---|---|
| **Part A 归因** | ✅ **完成**，结论明确：**（i）当前代码的真缺陷**（不是遗留数据）—— 见 §3 |
| **Part B live 半边** | 🟡 **部分完成**：拿到了 live 实例的**真实工具调用**证据；**重启前后对照未做**（阻断点见 §2.6） |

**两条异常的真实性质（修正 §17 的表述）**：

- §17 说"`sessionHistory` 把**当前**会话 id 记成被替换过的"。**实测更精确**：history 里那两条 `session-898f7481-…`（reason `materialization-failed`）记录的**不是"当前会话"**，而是**两次失败物化中被抛弃的会话 id**；而 `team.json` 的 `role.sessionId` 字段**恰恰因为这个缺陷停在一个从未被写盘的 id 上**。两条异常是**同一个缺陷的两个面**。
- 因此 §17 的"① 当前 id 进 history"与"② history 里有不存在的会话目录"，正确读法是一句：**物化失败时团队状态不前进，于是 `role.sessionId` 钉在一个幽灵 id 上**。

---

## 2. 测试过程与原始输出

### 2.0 ⚠️ 替用户批准的动作声明（ADR-0009 要求）

**本轮我没有执行 `/team approve`。** 原因见 §2.6：既存 `team-f01da153` 已经是 **active**，无需再批准；而我要做的工具面校准用的是既存 `standard` 会话。

⇒ **本轮不存在"替用户批准"的动作**。ADR-0009 §3 的测试 seam 我**没有使用**。这一点必须在报告里显式说明，以免外部验收者误读（ADR-0009 结论段明文要求）。

### 2.1 打开实例（Ego lite，非 browser-use）

```
$ ego-browser nodejs -e '… page.goto("http://127.0.0.1:4600/?token=…") …'
{ spaceId: 29, label: 'p1', url: 'http://127.0.0.1:4600/', title: '激活归档团队角色状态 — DeepSeek Harness' }
```

### 2.2 RPC 通道确认（ADR-0009 §"多轮真实会话怎么驱动"）

```
$ page.evaluate → fetch("/api/session/prompt", { method:"POST", …, method:"session/prompt", … })
{"type":"server-response","result":{"ok":true,"value":{"accepted":true}}}
```

**一次探路失败留痕**：我先试了 `session/list`，服务端明确拒绝并回显端点归属：

```
{"result":{"ok":false,"error":{"code":"gateway/bad-request",
 "message":"method \"session/list\" does not match endpoint \"session/prompt\""}}}
```

⇒ RPC **按端点**受理方法，不是一个通用 method 分发器。这条对后续轮次有用。

### 2.3 live 会话选择（必须是 `orchestra_E2E` 工作区的会话）

`standard` 是 driver 壳（不属于任何角色），故用它做校准会话：

```
session-62156e05-2700-441e-b9ab-c28a3ebe1cac   cwd = …/artifacts/projects/orchestra_E2E
```

### 2.4 真实模型往返（证明通道可用）

```
$ session/prompt → "Reply with exactly: PROBE_ALPHA_OK"
{"type":"assistant/message","seq":447,"data":{"turn":9,"step":1,"message":{"content":[{"type":"text","text":"PROBE_ALPHA_OK"}]}}}
{"type":"turn/end","seq":449,"data":{"turn":9,"reason":{"kind":"completed"}}}
```

### 2.5 ★ 一次真实角色工具调用（Part B 步 4 的校准，只做到"调用前"）

```
$ session/prompt → "Call the orchestra_team tool now …"
{"type":"tool/call","seq":456,"name":"orchestra_team","arguments":"{}"}
tool/result 文本开头：
  "team team-f01da153 (trio, active): implementer(cold,R1, report=~/Documents/ag…"
{"type":"turn/end","data":{"turn":10,"reason":{"kind":"completed"}}}
```

**这条证据说明**：live 实例上 **`orchestra_*` 工具面可用、真实模型能调用、结果能回来**；且 `orchestra_team` 读到的是**正确的团队**（`team-f01da153`，与 fixture 一致）。

⚠️ **它的边界**：这证明的是**工具面还在**，**不是**"重启后角色身份完整"。校准要求的是**重启之后再调一次**——那一步没做（§2.6）。
⚠️ **另一条重要读数**：结果里 `implementer(cold, …)` —— **该角色当前是 cold（无活代理）**。这本身就是 live 半边的起点状态。

### 2.6 为什么第 3 步（重启）没做 —— 阻断点可判定

重启 4600 需要**进程控制**。实测：

```
$ ps aux | grep dsh      → /bin/ps: Operation not permitted（沙箱不允许）
$ timeout …              → timeout: command not found
```

⇒ **我没有能力停止/拉起那个实例**：它不是我起的后台作业，我也没有进程控制权限。
**重启是 Part B 步 3 的硬前置**，缺它则步 4 的"重启后"无从谈起、步 6 的 before/after 对照不成立。

**另有一条独立阻断**：`compositionInventory` 在**宿主侧**（`dsh-agent-presets` / `dsh-host-plugin-inventory` / `dsh-tool-cordis` 里都有它），而**本插件产品代码里零命中**：

```
$ grep -rn "compositionInventory" src/*.ts
（零输出）
```

⇒ 从**插件侧**（也就是从 `orchestra_E2E` 那个工作区的会话里）**拿不到** `compositionInventory`。要"从实例内取"只有两条路：(a) 宿主 cordis 检查工具（我的会话在 4599，不是 4600 实例，跨实例不行）；(b) 改插件代码加一个只读探针 —— **本轮明令不许改产品代码**。故本步未做。

---

## 3. Part A：两条异常的归因（**结论：(i) 当前代码的真缺陷**）

### 3.1 原始数据（`team-f01da153`）

```
difficulty-implementer  phase=active  sessionId=session-898f7481-21d7-4f8f-ba49-be3717865bf6  hist=3
   {"sessionId":"orchestra-team-f01da153-ec3b09cb-5331-4446-b900-b281363239f4","replacedAt":1789795957954,"reason":"session-not-found"}
   {"sessionId":"session-898f7481-21d7-4f8f-ba49-be3717865bf6","replacedAt":1789796202687,"reason":"materialization-failed"}
   {"sessionId":"session-898f7481-21d7-4f8f-ba49-be3717865bf6","replacedAt":1789796205666,"reason":"materialization-failed"}

difficulty-reviewer     phase=reserved sessionId=session-28accce1-c417-4877-b9c0-381ca53a1220  hist=1
   {"sessionId":"orchestra-team-f01da153-9d4b7f3c-596c-49f7-8e46-b11902eea149","replacedAt":1789795958395,"reason":"session-not-found"}
```

**磁盘核对**（这一步把两条异常合成了一条）：

```
EXISTS  orchestra-team-f01da153-ec3b09cb-…    ← ❌ 不存在！
MISSING orchestra-team-f01da153-ec3b09cb-5331-4446-b900-b281363239f4
EXISTS  session-898f7481-21d7-4f8f-ba49-be3717865bf6
EXISTS  其余四个 orchestra-team-f01da153-* 角色会话
```

### 3.2 写入点（`src/` 全仓只有两处写 `sessionHistory`）

**写入点 1 —— `src/orchestra.ts`，`materializeRole` 的失败分支**（`reason: "materialization-failed"`）：

```ts
?(created
  ? {
      sessionHistory: [
        ...r.sessionHistory,
        { sessionId: r.sessionId, replacedAt: Date.now(), reason: "materialization-failed" },
      ],
    }
  : {}),
```

**写入点 2 —— `src/orchestra.ts`，重激活的替换分支**（`reason: "session-not-found"`）：

```ts
const oldSessionId = role.sessionId;
role.sessionId = created.sessionId;                      // ← 先前进
role.sessionHistory = [
  ...role.sessionHistory,
  { sessionId: oldSessionId, replacedAt: Date.now(), reason: "session-not-found" },
];
```

### 3.3 为什么这是**当前代码**的缺陷（三条证据）

**证据 1｜产生它的代码就是当前代码，且从未被改过。**

```
$ git log --oneline -S'materialization-failed' -- src/orchestra.ts
6bd8d9b feat(v0.5.1): …

$ git log --oneline -3 -L 3130,3145:src/orchestra.ts
6bd8d9b feat(v0.5.1): …      ← 该写入点由这一个提交引入，此后无改动
```

`6bd8d9b` 是**当前 HEAD**（`git log` 顶部即它）。⇒ 写这段数据的逻辑**today 仍然一模一样地在跑**。

**证据 2｜时间线不构成"旧构建"的辩护。** 三条 `replacedAt` 分别落在
`2026-09-19T05:32:37Z` / `05:36:42Z` / `05:36:45Z` —— 正是 v0.5.1（`6bd8d9b`）交付当天。
**旧数据 + 当时的代码 = 当前代码**（证据 1 已证两者同一）。

**证据 3｜缺陷是可推导的，不依赖数据**：写入点 1 记录的是 **`r.sessionId`（团队状态里的那个值）**，而失败分支里**新会话已经创建成功**（`created !== undefined`）、团队状态却**没有前进到新会话**（`phase` 被重置为 `reserved`，`sessionId` 未改）。
⇒ 下一次重试会**再建一个新会话**，而 `r.sessionId` **仍是同一个旧值** ⇒ **同一 id 被反复写进 history**。
数据里那两条**完全相同的 `session-898f7481-…` + 相隔 3 秒**，正是这个循环的指纹。

### 3.4 由此产生的**真实后果**（比 §17 描述的更严重）

1. **`role.sessionId` 指向一个从未落盘的幽灵会话**（`…ec3b09cb-…` 目录不存在）。
   ⇒ 任何按 `sessionId` 找这个角色的路径（投递、恢复、身份核对）都会指向空。
2. **history 被写坏**：同一 id 重复、且其中一条与 `role.sessionId` 相同。
   ⇒ §17 报的"把当前 id 记成被替换过的"是这个的**症状**，不是独立的第二条缺陷。
3. **`materialization-failed` 这个 reason 语义不清**：它写的是"被替换掉的 id"，但在失败路径上那个 id **并没有被替换**（团队状态没前进）。
   ⇒ 记录**陈述了未发生的事实**——与 `capability-boundaries.md` 那类"声明不实"同族。

### 3.5 处置（按 driver 指令：**只归因，不修**）

**登记为待办项，本轮不修。** 建议的修法方向（**未实现、未验证，仅供裁定**）：
失败分支要么**不写 sessionHistory**（因为没有替换发生），要么**把团队状态前进到新建的 `created.sessionId`** 并记录**真正被抛弃的那个** id。
两者语义不同，**需 driver 裁**——我不自行选边。

---

## 4. 未做 / 未验证

| 项 | 状态 |
|---|---|
| **Part B 步 1**（改动前的 `compositionInventory`，从实例内取） | ⬜ **未做**：该符号在插件产品代码里**零命中**，从 `orchestra_E2E` 的会话里取不到；宿主侧检查工具只能连我自己这个实例（4599），跨不到 4600。**红线也不允许我从 4599 侧操作 dev 会话。** |
| **Part B 步 2**（重激活既存团队） | ⬜ **未做**（依赖步 1 的 before 基线；且重激活会改 fixture 状态，没有基线就是盲改） |
| **Part B 步 3**（重启 4600） | ⬜ **未做 —— 硬阻断**：无进程控制（`ps` 被沙箱禁止；该实例不是我起的作业） |
| **Part B 步 4**（重启后再取 inventory + 一次真实角色工具调用） | 🟡 **只做到"调用前"**：已证明 live 实例上 `orchestra_*` 工具面可用（§2.5），**未做重启后的那一次** |
| **Part B 步 6**（before/after 分层定位） | ⬜ **未做**（无 before，无 after） |
| **`--self-test` / 静态脚本在正确 fixture 上的重跑** | ⬜ **未做**。§17 已记录 exit 1；本轮**没有重跑**（我的浏览器轮次没有引入新代码，重跑预期仍 exit 1，但**未实测**） |
| **§4.7 步 6**（重激活后 `sessionHistory[]` 必须有条目 + 对旧 id 再核） | ⚠️ **部分**：静态脚本已实现该分支；本 fixture 的 history 分支**确实被执行到了**（§17 的 `(history)` 行即它），**但它是失败的那一侧**。**包含"history 存在且一致"的正向用例仍未跑到。** |
| **§7 / `.npmrc` / 依赖面 / 契约 / 计划文件 / S4 / D2 / G-BUDGET** | ✅ 均未动 |

---

## 5. 下一跳

**Part B 要往下走，缺的不是代码而是两样东西**，请 driver 择一并明确：

1. **进程控制权**：让 4600 由**我以受管后台作业的方式**启动（这样我能停、能拉），或在重启窗口由你操作。
   注意：ADR-0009 说 4600 与 `dsh-web-search-chained` **共享 profile**，重启前需确认那个项目没在用。
2. **一个能从实例内读到组合的入口**。三条路，各有代价：
   - (a) **允许我加一个只读探针**（改产品代码，本轮被禁）——最直接，但破"不改代码"的约束；
   - (b) 用**宿主 cordis 检查工具**在 4600 实例内跑（需要一个 4600 侧的 agent 会话替我执行，即"用 dev 实例的 agent 去查 dev 实例"）；
   - (c) **接受 Part B 的替代形态**：不做 `compositionInventory`，改为在**重启后**对同一角色会话重跑 §2.5 那次真实工具调用 —— 这证的是"工具面还在"，比 inventory 弱，但**仍能判掉 (c) 恢复路径没带 setup**。

**我倾向 (b) 或 (c)**：都不需要改产品代码，也都不需要额外权限。**(a) 只在 (b)(c) 都被否决时才动用。**

**另有两条待裁**：
- **§3.5 的修法方向**（失败分支不写 history / 或推进团队状态）：见 §3.5，两选一。
- **Part A 的缺陷是否进批 1**：它是**当前代码的真缺陷**且会造成幽灵 sessionId，但它**不在 P0 冻结范围**（P0 = D1/D2/D3/D4/E1/E4）。我按"范围外 ⇒ 登记不修"处置，请确认。
