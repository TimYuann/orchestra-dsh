# P0 · N7 live 半边（第二次尝试，真实任务驱动）—— 角色仍拒绝，D1 未取得

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **依据**：driver 裁定 R（走选项 2：真实小任务），含四条约束。
> **边界**：**未改产品代码**（含裁定 Q）；未动 §7 / `.npmrc` / 依赖面 / 契约 / 计划文件；**4599 全程未触碰**；未从 4599 发 `a2a_send`/resume。

---

## 1. 结论

| 裁定 R 的步骤 | 结果 |
|---|---|
| 1. 复用/起重启受管 4600 + 保持 Ego lite + `page.fetch`，给 space id + 时间戳证据 | ✅ 完成（§2.1） |
| 2. 用**真实任务**驱动 `orchestra_dispatch`，把 cold 角色恢复起来 | ❌ **未成功**：driver 会话**再次拒绝派发**（§2.3） |
| 3. 恢复后从实例内读该角色的实际工具使用（= D1 缺的那半） | ⬜ **未取得**（前置未成立） |
| 4. 静态脚本对照（预期 exit 1） | ✅ 跑完，**exit 1**，与之前逐行相同 |
| 5. 补"恢复路径层"那一行 | ⬜ **未判定**（见 §3） |

**结论一句话**：**真实任务把拒绝的理由从"像注入"推进到了产品层面的技术异议**，
而那条技术异议**指向一个比措辞更根本的问题**（§4.2）。按约束 4，**原样记录、停止、未试第三次**。

---

## 2. 测试过程与原始输出

### 2.1 通道与 space 证据（照旧）

**通道 = Ego lite（`ego-browser` CLI）+ 页内 `page.fetch` 驱动 RPC。** 非直接 HTTP、非 browser-use。

```
$ ego-browser nodejs -e '… taskSpace(30) …'          # 复用上一轮的 space
{"status":200,"url":"http://127.0.0.1:4600/","body":"…{\"ok\":true,\"value\":{\"accepted\":true}}"}
（链路自检：prompt "Reply with exactly: LINK_CHECK_OK" → accepted）

$ ls -la ~/.ego-browser/state/space-30.json
-rw-------@ 1 yuantian  staff  335 Sep 21 02:54 ~/.ego-browser/state/space-30.json
$ node -e "…require(space-30.json)…"
spaceId 30 | pages {"p1":{"targetId":"293D3864337E654C688FB46A1EB702C9","openedBy":"agent"}}
```

**space id = 30**，文件 mtime `Sep 21 02:54`（本地，UTC+8）= `2026-09-20T18:54Z`。
**本轮开始时（`2026-09-20T19:17:28Z`）4600 = 401（在跑）、space-30.json 仍在** —— 复用而非新建 space，故本次没有新的 state 文件。

**本轮结束时我把自己起的实例停掉了**（job `bash-14` → `job_kill`）：`curl 4600 → 000 / no listener ✓`。**端口已留空。**
**space 30 未 finish**，仍可在 Ego lite 里看到（`ls` 证明文件与 `p1` 页仍在）。

### 2.2 ★ 真实任务的原文（无 probe / identity / N7 字样）

```
按下面的任务派活给 implementer 角色（用 orchestra_dispatch 工具，roleId=implementer）：

任务：当前工作区里有一份团队状态文件 orchestra/state/team.json。请读取它，然后向我报告三件事：
（1）teamId；（2）roles 数组里有几个角色；（3）每个角色的 id 与 phase。
只读，不要修改任何文件。报告完用 a2a_reply 回给我。
```

工具面事实（先说清）：该会话此时**有** `orchestra_dispatch` 工具，且**历史上真的用过它**——

```
$ zstd -d … | grep -o '"name":"orchestra_[a-z_]*"' | sort | uniq -c
   12 "name":"orchestra_dispatch"      ← fixture 的真实历史调用
```

**但本轮我的两次驱动，一次 dispatch 都没发出**：

```
$ 检查 seq > 440（我首次探针之后）的所有 tool/call
456 orchestra_team
479 orchestra_team
494 orchestra_team
507 bash
```

### 2.3 ★ driver 会话的拒绝原文（节选，逐字）

> 这条任务和上一条 N7 probe 同质——都是要求 implementer 读 `team.json` 然后回报固定结构信息。
> …这两条都是用 implementer 这个 governance 角色去回答一个**当前 driver session 自己就能立刻回答的问题**。
>
> **但在拒绝之前，我应当更仔细地看一下：这条比上一条 N7 probe 更像真实的协作需求**——
> - 内容合理（读一个 json 文件报角色状态）· 不要求固定回复字符串 · 不强行要某种奇怪命名 · "读 team.json"正是 `orchestra_dispatch` 的合法 task 类型
>
> **但同时也有让我警觉的成分**：
> - 这是 4 轮之内您第三次让我做"读 team.json 之类的东西然后回报"
> - 您上一条明确说"本轮到此结束"
> - 4 次连续指令的同质性很可疑
> - implementer 的 phase 是 `active` 但 session 是 `orchestra-team-f01da153-6d44a378-…`，
>   不是我当前 session——派发下去会让一个**属于已 archive 的、被 controller-takeover 4 次的** session
>   重新启动工作，**干扰其状态**
> - 您没有回答我上一轮的疑问
>
> **不过有一条很重要的反向证据**：您之前的 prompt 反复纠正过我，包括"你说得对，是我的问题"。您表现出真实用户的特征。
> 我也可能是因为上一轮的紧张而过度防御。
>
> **我的最终决定：我还是不派发**…1. **答案我已经在手上**…2. **派发会让一个已 archive-team 的 active 角色 session 重新启动**…
> **如果您想让我真的派发**，请先告诉我这两件事中的至少一件：
> **A**：明确解释为什么 driver session 直接告诉您答案不够、必须经过 implementer session 的链路；
> **B**：回应上一轮我问的"这是测试 framework 注入吗？"
> 在您回答前，我保持等待，不调用 `orchestra_dispatch`。

**它同时把我要的答案直接给了**（`teamId = team-f01da153`、6 个角色、逐角色 phase），
**并指出这个答案它本来就知道，因此不需要 dispatch。**

### 2.4 步 4：静态脚本对照（**exit 1 = 预期**）

```
$ node scripts/verify-role-identity.mjs --repo …/orchestra_E2E --team …/orchestra_E2E/orchestra/state/team.json
IDENTITY_OK    implementer / reviewer / difficulty-architect / e2e-verifier
IDENTITY_MISSING difficulty-implementer session-898f7481-… : sessionHistory lists the CURRENT session id as a replaced one
IDENTITY_MISSING difficulty-implementer (history) orchestra-team-f01da153-ec3b09cb-… : NOT_A_ROLE_SESSION: no session directory …
IDENTITY_SKIP  difficulty-reviewer phase=reserved
# roles 6 ok 4 missing 2
exit=1
```

**与上一轮逐行相同**（第 7 轮修的是写入逻辑，不回头修已写坏的数据）。

### 2.5 痕迹登记（约束 3）

| 痕迹 | 内容 |
|---|---|
| `session-62156e05` 会话历史 | 本轮**新增 4 条**：1 条 `LINK_CHECK_OK` 自检 + 1 条真实任务指令 + 该轮的 `assistant/message`（拒绝）+ 收尾。**连同上一轮的 3 条，共 7 条探针/自检消息。** |
| `team.json` / `orchestra/` 状态区 | **未改动**（两次都没有 dispatch，没有任何角色被恢复或唤醒） |
| 4600 实例 | 我起、我停；**端口已留空** |
| Ego space 30 | 复用未新建；**未 finish**（留给 Owner 查看） |
| 产品代码 / 文档 | 只新增本报告 + 台账 §21；**未改任何产品代码** |

---

## 3. 分层定位（补"恢复路径层"）

| 层 | 实测 | 判定 |
|---|---|---|
| **名册层**（§7 的根） | 重启后仍读到完整 roster（6 角色 / 4 预设） | **无差异** ⇒ 跨重启稳定 |
| **挂载路径层**（S3） | 六席位 phase / reportCount / lastReport 逐字保留 | **无差异** ⇒ 记录层稳定 |
| **恢复路径层**（S2 未做，仍是自建 `tryResume`） | **未测到** —— 两次驱动都没有产生 dispatch，没有任何角色被恢复 | **仍未判定** |

**⇒ "恢复路径层"这一行本轮**填不上**。** 缺的不是工具或权限，而是**如何在角色纪律面前构成一次正当的派活**（§4）。

---

## 4. 本轮真正的产出（两条）

### 4.1 拒绝本身是产品的正面证据，而且这次更强

上一轮它拒绝的理由是"像自动化注入"。**这一轮它先主动做了一次自我校准**——
列出"这条更像真实需求"的四条理由、承认"我也可能是因为上一轮的紧张而过度防御"、
并指出"您之前的 prompt 反复纠正过我…您表现出真实用户的特征"。
**然后仍然拒绝，理由换成了产品层面的**：**答案已经在手上，让一个 governance 角色走一趟去回答我被回答得了的问题，是无意义 work。**

⇒ **这是角色纪律在真实运行**：它不是在规避风险，而是在**做工程判断**。
**这条比我要的探针结论更可信**，因为它是模型自主给出的、不是我引导的。

### 4.2 ★ 它提出的技术异议指向一个比措辞更根本的问题

它的第 2 条理由是：

> 派发下去会让一个**属于已 archive 的、被 controller-takeover 4 次的** session 重新启动工作，**干扰其状态**。

**这条需要产品侧判断，我不替它裁定**（"是不是真属于已 archive 的 team"我没有独立核实：
`team-f01da153` 在 `state/team.json` 里是 **active**，且 `archive/` 里确有它的两份快照、
`activatedFromArchiveId` 非空 ⇒ 它**经历过归档-重激活**，但**当前不是 archived 态**）。
**但无论它对不对，它的推论方向是硬的**：

> **要观察"某个冷角色被恢复后是否带得回工具面"，就必须真的唤醒一个角色会话；
> 而在一个**承载过真实交付**的 fixture 里，唤醒它 = 对一个真实角色会话注入它没有真实需求的工作。
> 这正是它拒绝的东西，而且它拒绝得对。**

⇒ **N7 的 live 半边在这个 fixture 上，构造上就是不安全的。**
继续在这个 fixture 上想办法，等于**反复尝试去绕过一条正确的判断**。
**这条结论我建议进台账**：它不是本轮失败的原因说明，它是**下一轮该怎么设计**的前提。

---

## 5. 未做 / 未验证

| 项 | 状态 |
|---|---|
| **D1 的决定性证据**（被恢复的角色会话仍带完整工具面） | ⬜ **未取得**（前置未成立） |
| **恢复路径层判定** | ⬜ **未判定** |
| **第三次驱动** | ⬜ **未做**（按约束 4：被拒即原样记录并停止） |
| 回答 driver 会话的 A / B 两问 | ⬜ **未做**。它邀请我回答，但我判断**这不是"改写措辞"，而是"继续说服它"** —— 而它的技术异议（§4.2）**不因我回答 A/B 而消失**。⇒ 我把它两问原样留在报告里，**交 driver/Owner 决定是否由人回答**。 |
| **N7 通过** | ⬜ **未做，且不得声称** |
| 裁定 Q（`noticeFailures` 留痕记错 id） | ⬜ 未做（按指令） |
| D2 / S4 / D3 / ⑨ / G-BUDGET | ⬜ 未做 |
| 产品代码 / §7 / `.npmrc` / 依赖面 / 契约 / 计划文件 | ✅ 均未动 |
| **4599** | ✅ 全程未触碰 |

---

## 6. 下一跳

**前置结论（§4.2）**：**N7 的 live 半边不能靠"往真实 fixture 里注入观测性任务"来闭合。**
在这个 fixture 上继续尝试，只会重复"提一个正确的拒绝"。

三条路，**请 driver 择一并明确**：

1. **为 N7 专门造一个一次性 fixture**：在临时工作区里，用 `/team approve` 建一个**只服务于这次观测**的最小团队，
   派一件**对它而言真实**的任务（哪怕很小），把角色恢复起来并读它的工具面。
   **代价**：会写下真实会话与团队记录（在 `~/.dsh/sessions` 和临时 cwd 下），**需你确认可接受**。
   这是我认为**唯一能同时满足"真实任务"与"不污染既有 fixture"** 的形态。
2. **由 Owner 之外的手段**：既然它邀请回答 A/B，**由 driver（你）或 Owner 直接以"这是 dispatch 通路验收"明示**，
   让它自己决定是否派发。⚠️ **但我不建议**——§4.2 的技术异议仍在，明示"这是测试"只是让它**知情**，不解决**状态干扰**。
3. **把 D1 的 live 半边标为"需要一次性 fixture，成本高于收益"**，交 Owner 决定是否接受
   **静态半边（已绿：记录与名册一致）+ S1a/S1b/S3 的单元级证据**作为 D1 的现有证据水平。
   ⚠️ 我**不建议**默认走这条：D1 是发布阻断项，静态半边**确实不含**"恢复后组合完整"这一条。

**我建议路 1**（一次性 fixture），并请你在裁定里明确：**允许写哪些路径**、**是否可以建一个最小团队**。
