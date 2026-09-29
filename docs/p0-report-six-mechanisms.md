# P0 · 六项"还没在真机上跑过"的系统机制 live 取证轮（test runner 第 6 轮）

> **作者**：test runner（第 6 任；只执行 driver 设计的这一轮范围、**自己设计每一项的测试方法与夹具**、只取证；不改产品代码、不修缺陷）。
> **候选 commit**：`0b5d3eb`（`docs(ledger): round-20 …`）—— `git log -1 -- src/` = `d58c817`，**`d58c817` 之后零 `src/` 改动**（本轮实测确认）。
> **等价性**：`lib/orchestra.js` sha256 = `af224fe05471cc79b5a0a44a682cbd4b207c08332daab21d59f7ac8e4d5a76ef`，与 dev profile 内 `node_modules/orchestra-dsh/lib/orchestra.js` **逐字节相同**（两侧 shasum 相同，未重新 pack/sync）。
> **硬前提**：`npm test` → `1..284 / # tests 284 / # pass 284 / # fail 0 / # cancelled 0`（exit 0）。
> **判据口径（Owner 原话）**：**只判"每个角色的行为"与"机制是否按设计发生"**；交付物好不好 = 模型能力，**不进判据**，只作观察记录。本报告所有"正常/缺陷"判定都只引用**角色行为 + 机制读数**。
> **未向 Owner 提问**；未改产品代码 / ADR / 计划 / 契约 / 台账；**未碰 4599**；未注册工作区；未用 browser-use；未动 `minecraft-html/`、`artifacts/`、旧 `orchestra/archive/` 与 `charter/`。
> **规模**：六项各跑一次（每项一个 fixture 子目录，跑完清空）；live 操作窗口 13:10 → 13:24（≈14 分钟，另含为项 6① 做的一次实例重启）；共 6 个 driver 会话 + 12 个角色座位（项 6① 的角色座位被重建一次），模型全部 `minimax-cn / MiniMax-M3 / high`（逐会话 `request/header.config` 读出）。

---

## ① 结论（六项逐条：正常 / 有缺陷 / 未取得）

| # | 机制 | 判定 | 一句话 |
|---|---|---|---|
| 1 | **图运行时协议**（loop/attempt/verdict/gate/closure/handoff/loop cap） | **有缺陷** | 全轮 `graph: idle (rev 0)`、`graphRuntime.events=[]`：candidate、verdict、closure 都发生了，**图一件都没记**；gate 从未打开 ⇒ `/team decide` 不可达；闭环写命令（`startLoop`/`startAttempt`/`recordVerdict`/`openGate`/`appendHandoff*`/`recordClosure`/`applyGateFallback`）在 `lib/orchestra.js` 里 **0 个调用点**。附：`orchestra_dismiss` 输出 schema 缺陷（见 F-6-2） |
| 2 | **`orchestra_wait`** | **正常** | 三条设计分支全部按规格发生：无团队 → **fail loud**（`state is missing`）；有结构变化 → **10,102 ms 被唤醒**（因果链有时间戳）；无变化 → **14,999 ms 心跳超时**、不假唤醒 |
| 3 | **`orchestra_add_lanes`（正在跑的队）** | **正常**（含一处证据面缺口 F-6-3） | 不 confirm → 只出计划、状态零变化；confirm → 新角色进 **`reserved`**；**首次派活才物化**（新 sessionId + phase active）；`team.addedLanes` 有审计条目（2 条，带 roleId/lane/addedAt/reason）。缺口：`orchestra_team` 给模型看的**渲染文本不含 `added_lanes`**（结构化值里有） |
| 4 | **混合后端 `execution:"subagent"`** | **正常**（含一处未定 F-6-5） | 落成**原生 continuable 子节点**：session header `origin:"subagent"` / `delegationDepth:1` / `parentSession=<driver>` / `agentPreset:"standard"`；`subagent/descriptor {mode:"continuable",provider:"spawn"}`；**审批钉 `never`**（`source:"delegation"`）；沙箱 `workspace-write, source:"delegation"`；可被派活与回报（reportCount=1，`list_agents` 见 `[ready] — Helper`）；与 session 节点**同队混编**且记录形态可区分。未定：声明的 `toolFilter.deny=["bash"]` 在子节点**模型可见工具表里没有体现**（48 个工具含 bash） |
| 5 | **内置拓扑 `feature-development`** | **正常** | 三个声明角色**全部物化并真的干活**；声明的 route 全部以**真实投递**发生，且 handoff payload 字段与拓扑声明**逐字对上**（candidate: summary/changedFiles/knownRisks；verification: summary/checks/notes ×8 checks；verdict: verdict/unresolvedFindings）；**verdict 由 reviewer 记录**（durable PASS），**closure 由 driver 作出**；`orchestra/receipts/` 落投递回执（`state:"accepted"`, `delivery_mode:"live_inbox"`） |
| 6① | **重激活"替换"分支**（原角色会话不在盘上） | **分支正确 + 一处记录缺陷 F-6-4** | 走的就是 **replacement**（`action:"replaced"`），reserved 角色走 `kept-reserved`；替换会话重建成功：roster 预设 `agentPreset:"orchestra-implementer"` + persona（"实现者"）+ 模型路由齐备，且首条 inbox 是 **Recovery Packet**。缺陷：座位 id 复用 ⇒ 回执打印 `replaced <同一个 id>`，`sessionHistory[].sessionId == role.sessionId`，**替换这件事在记录里不可辨** |
| 6② | **设置面板（client，0.1.6）** | **正常** | 真浏览器里打开设置 → orchestra 面板渲染出**拓扑目录**：host 路由 `/plugins/orchestra-dsh/state` 200（`templates` 11 条 = 10 内置 + 1 global 用户预设），面板逐条列出 name/id/source/描述/roles/owns/routes，无 `state unavailable` |

### 本轮登记的缺陷 / 缺口（只登记，不修）

| id | 层 | 现象（可复现的最小读数） | 证据 |
|---|---|---|---|
| **F-6-1** | **图与交接层** | **图运行时协议在 live 面完全不推进**：`lib/orchestra.js` 中 `startLoop(`/`startAttempt(`/`recordVerdict(`/`appendHandoffPending(`/`openGate(`/`recordClosure(`/`applyGateFallback(`/`expireAttempt(` **各 0 个调用点**（只有定义在 `lib/orchestra-graph.js` 内）；唯一活着的写路径是 `sweepBoundedRun`（过期/预算，**没有 attempt 可过期**）与 `resolveGate`（要求 gate 已打开，而 `openGate` 无人调用）。⇒ attempt 不计数、verdict 无人接受、gate 永不打开（`/team decide` 因此不可达）、closure 不进图、typed handoff 不校验 payload。**影响面**：10 个内置拓扑里 **5 个**（feature-development / bug-diagnosis-and-fix / architecture-decision / refactor-and-migration / audit-and-hardening）声明了 `loops=1 gates=1 handoffs=4~5 closure=yes`（`BUILTIN_TOPOLOGIES` 实测计数） | 见 §2.1 |
| **F-6-2** | 工具契约 | **`orchestra_dismiss` 每次（含不带参数）都向模型报错**，而归档副作用**已经发生**：`Error: tool "orchestra_dismiss" returned invalid output: "value.reason" is not a declared property (additionalProperties: false); "value.summary" …`。返回类型 `DismissGovernedTeamResult` 带 `reason`/`summary`（`args.reason ?? "dismissed by controller"` 默认值），而工具 output schema 未声明这两个字段 ⇒ 模型以为收尾失败，重试得到 "already archived" | 两次独立复现：§2.1 #98、§2.6① #103 |
| **F-6-3** | 证据面（表层） | **`orchestra_team` 的渲染文本不携带 `added_lanes`**：结构化值里有（`render` 未引用该字段），模型只看到扁平角色行 ⇒ 现场 driver 自己的结论是"**没有任何字段显式区分原章程角色 vs add_lanes 后加角色**" | §2.3 |
| **F-6-4** | 恢复路径层（记录） | **替换分支复用座位 sessionId** ⇒ 回执读作 `implementer=…344457f6… (replaced, replaced …344457f6…)`（前后同 id），`sessionHistory=[{sessionId: <当前 id>, reason:"session-not-found"}]` ⇒ **"哪个会话被替换"这一信息自我抵消** | §2.6① |
| **F-6-5** | 混合后端（未定） | 声明的 `toolFilter.deny=["bash"]` **未在子节点模型可见工具表中体现**：子节点 `request/header` = **48 个工具（含 bash）**，与父会话一致。DSH 侧实现是 `childCtx.tools.restrict(composition.toolFilter)`（`dsh-subagent/lib/index.js:556`）⇒ **调用点是否拦截未取证**（子节点一次都没试 bash；它自报"filter 真生效"是**模型自述**，不作证据） | §2.4 |
| **F-6-6** | 观察（不判缺陷） | `orchestra_dismiss` 会**中止在跑角色回合**：`turn/end {"reason":{"kind":"aborted","reason":{"kind":"hook","reason":"orchestra_dismiss"}}}`；被归档队的 reviewer 因此没有任何报告落盘（item 1 的 driver 在 reviewer 还在跑时收尾） | §2.1 |
| **F-6-7** | 观察（文案漂移） | 冻结宪章里的角色 `orchestraTools` 仍写 `orchestra_handoff` / `orchestra_verdict`，而这两个名字在 `REMOVED_ORCHESTRA_TOOLS` 里被过滤掉（draft 预览表只剩 `orchestra_report`）⇒ **拓扑声明与 live 工具面不一致**（F-6-1 的同一族） | §2.1、§2.5 |

---

## ② 每项的原始输出与角色行为证据

### 2.1 项 1 · 图运行时协议（fixture `test-graph/`）

**夹具**：内置拓扑 `feature-development` 快照（声明了 loops/gates/closure/typed handoffs）；driver + implementer + reviewer（verifier 保持 `reserved` 不派活）。
**注入**：经 `/api/session/create{cwd}` 建 driver 会话（`session-0a610db0-8598-4f35-a2f8-9ed2051e4262`），`/api/session/prompt` 投四条指令（起草 → 批准 → create → 派活 → 读图+收尾）。

**角色行为证据**（driver 会话 `tool/call` 明细；`readStoredEvents` 解码）：

```
driver TOOLCOUNTS={"orchestra_draft":1,"orchestra_create":1,"orchestra_dispatch":3,"orchestra_team":3,
                   "orchestra_report":1,"orchestra_dismiss":2,"bash":2,"read":1}
#18 CALL orchestra_draft {"topology":"feature-development", …}      → draft-739eada8-…@1 digest=8b706acd…
#33 CALL orchestra_create {"frozenRef":"draft-739eada8-…@1#8b706acd…"} → team-449d05c8
#46 CALL orchestra_dispatch implementer（首次物化）  #75 CALL orchestra_dispatch implementer（R1 派活）
#77 CALL orchestra_dispatch reviewer（新物化）
#95 CALL orchestra_report {"path":"probe-driver-closure.md","content":"driver closure by probe"}
#97 CALL orchestra_dismiss {"reason":…,"summary":…}  → #98 RESULT_ERR INVALID_TOOL_OUTPUT（见 F-6-2）
#102 CALL orchestra_dismiss {}                      → #103 "was already archived …"（副作用已发生）
implementer TOOLCOUNTS={"bash":5,"orchestra_report":1,"a2a_reply":1}   → out.txt + probe-implementer-R1.md + a2a_reply→driver
reviewer    TOOLCOUNTS={"bash":3}  #30 TURN_END {"turn":1,"reason":{"kind":"aborted","reason":{"kind":"hook","reason":"orchestra_dismiss"}}}
```

**机制读数（图，逐阶段原文）**：

`orchestra_team` 第一次（create+dispatch 后有角色已物化）：

```
#61 RESULT team team-449d05c8 (feature-development, active): implementer(running,R0, …), verifier(cold,R0), reviewer(cold,R0)
   | archives: no archives
   graph: idle (rev 0) | no active loop | pending handoffs=0 | cap exhausted=0 | open gates=0 | closure=none
```

`orchestra_team` 第二次（implementer 已交付、reviewer 已 active）：

```
#91 RESULT team team-449d05c8 (…): implementer(running,R1, report=…/probe-implementer-R1.md, …), verifier(cold,R0), reviewer(running,R0, …)
   graph: idle (rev 0) | no active loop | pending handoffs=0 | cap exhausted=0 | open gates=0 | closure=none
```

`team.json`（封存副本 sha `2cb539ca…`）里的图运行时，**整轮结束仍是空的**：

```json
"graphRuntime":{"schemaVersion":1,"runtimeRevision":0,"teamId":"team-449d05c8","charterRevision":1,
  "charterDigest":"8b706acd…","events":[],"updatedAt":1790053864766}
"runtimeProjection":{"graph":{"status":"idle","pendingHandoffs":[],"capExhausted":[],"expiredAttempts":0,
  "budgets":[],"teamBudgetExhausted":false,"openGates":[],"blockedScopes":[],
  "closure":{"status":"none","evidence":[]},"runtimeRevision":0,"stale":false}}
```

**冻结宪章里声明的协议**（`team.json.document.charterRevisions[0].topology.config.protocol`，原文节选）：

```
routes: mission(driver→implementer) candidate(implementer→verifier) verification(verifier→reviewer)
        verdict(reviewer→driver) findings(reviewer→implementer)
handoffs: candidate   requiredPayloadFields=[summary,changedFiles,knownRisks] requiredEvidenceKinds=[commit,diff,test]
          verification requiredPayloadFields=[summary,checks,notes]          requiredEvidenceKinds=[test,diff,file]
          findings    requiredPayloadFields=[summary,findings,repairScope]    requiredEvidenceKinds=[report,diff,message]
          verdict     requiredPayloadFields=[summary,verdict,unresolvedFindings] requiredEvidenceKinds=[report,commit,diff,test]
loops:    implementation-review entry=implementer/candidate_ready evaluatorRole=reviewer maxAttempts=2
          passRoute="verification → human gate → closure" retryRoute="reviewer findings → implementer repair → verifier"
gates:    feature-closure-approval options=[approve,request-changes,stop] blockingScope=[closure] required=true
closure:  owner=driver requiredLoopOutcomes=[implementation-review:passed] requiredVerdicts=[PASS] openGatePolicy=reject
```

**逐条对照判据**：

| 判据 | 期望（设计） | 实测 | 判定 |
|---|---|---|---|
| 图事件是否按协议推进 | loop 开、attempt 计数 | `events=[]`、`runtimeRevision=0`、`no active loop` | **不正常** |
| attempt 怎么计数 | 首次 dispatch/candidate ⇒ attempt=1 | 无 attempt（`expiredAttempts=0`，无 deadline 行） | **不正常** |
| verdict 被谁接受 | reviewer 记 PASS/FAIL ⇒ loop 收 verdict | reviewer 只产出文本报告；图上无 verdict | **不正常** |
| gate 如何放行/拒绝 | loop PASS ⇒ gate 打开 ⇒ `/team decide approve` | `open gates=0`，全程**没有 gate** ⇒ `/team decide` 无对象 | **不正常（不可达）** |
| closure 由谁作出 | driver 记 closure（requiredVerdicts/Evidence 校验） | driver 只能写自由文本 `orchestra_report` + `orchestra_dismiss`；`closure.status=none` | **不正常** |
| handoff 是否带 payload | 按 handoffs 契约校验字段 | 角色间无 typed handoff；实现物是 `orchestra_report` 文件 + `a2a_reply` 文本 | **不正常（未发生）** |
| loop cap | `maxAttempts=2` 到顶走 `cap_exhausted` | 无 attempt ⇒ cap 不可达 | **未取得（依赖上游）** |

**闭环写命令 0 调用点（产品代码读数，非推测）**：

```
$ for n in startAttempt recordVerdict appendHandoffPending openGate recordClosure startLoop applyGateFallback sweepBoundedRun resolveGate initializeGraphRuntime; do
    printf "%-22s %s\n" "$n" "$(grep -rl "\b$n(" lib/*.js | tr '\n' ' ')"; done
startAttempt           lib/orchestra-graph.js
recordVerdict          lib/orchestra-graph.js
appendHandoffPending   lib/orchestra-graph.js
openGate               lib/orchestra-graph.js
recordClosure          lib/orchestra-graph.js
startLoop              lib/orchestra-graph.js
applyGateFallback      lib/orchestra-graph.js
sweepBoundedRun        lib/orchestra-graph.js lib/orchestra.js
resolveGate            lib/orchestra-graph.js lib/orchestra.js
initializeGraphRuntime lib/orchestra-graph.js lib/orchestra.js
```

（同一族证据：`src/session-blueprint.ts:500` 的 `REMOVED_ORCHESTRA_TOOLS` 明确移除了 `orchestra_handoff` / `orchestra_verdict` / `orchestra_loop_start` / `orchestra_attempt_start` / `orchestra_gate_open` / `orchestra_gate_fallback` / `orchestra_close` / `orchestra_graph` / `orchestra_graph_reconcile`；draft 预览表把 implementer 的 `orchestraTools` 收窄成只剩 `orchestra_report`，而**冻结宪章文本里这两个名字仍在**。）

**影响面（内置拓扑声明计数，`lib/orchestra-topology.js` 实测）**：

```
duo                     loops=0 gates=0 handoffs=0 closure=no
trio                    loops=0 gates=0 handoffs=0 closure=no
oracle                  loops=0 gates=0 handoffs=0 closure=no
four-role-dev           loops=0 gates=0 handoffs=0 closure=no
architect-dev           loops=0 gates=0 handoffs=0 closure=no
feature-development     loops=1 gates=1 handoffs=4 closure=yes     ← 本轮实跑
bug-diagnosis-and-fix   loops=1 gates=1 handoffs=5 closure=yes
architecture-decision   loops=1 gates=1 handoffs=5 closure=yes
refactor-and-migration  loops=1 gates=1 handoffs=5 closure=yes
audit-and-hardening     loops=1 gates=1 handoffs=5 closure=yes
```

⇒ **10 个内置拓扑里 5 个把 loops/gates/handoffs/closure 写给用户看，而 F-6-1 使这四样在 live 面都不发生。**

**交付物（只作观察，不进判据）**：`out.txt` = `GRAPH_PROBE_OK`，`od -c` 16 进制 14 字节无换行；`orchestra/reports/probe-implementer-R1.md` 1237 B。

**封存哈希**（`/tmp/r6/freeze/item1/`）：driver log `cc8ed775…` · implementer log `523c58e9…` · reviewer log `70ba409f…` · team.json `2cb539ca…` · archive `375f2a3c…` · records.json `407f00a0…` · out.txt `e7a2ac7d…`。

**该项起始/终态 `ls`**：起始 `total 0`（空目录）；终态 `out.txt (14B)` + `orchestra/{archive,charter,reports,state}`（`state/team.json` 415 B = 归档标记）。

---

### 2.2 项 2 · `orchestra_wait`（fixture `test-wait/`）

**夹具**：同一 driver 会话内三段探针（无团队 / 有结构变化 / 无变化）；拓扑 `trio`（只 dispatch implementer）。

**机制读数（三段工具返回原文）**：

```
A 无团队：  #17 CALL orchestra_wait {"timeoutMs":15000}
           #19 RESULT Error: orchestra_wait requires an active Team at
             ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/test-wait
             (state is missing); waiting with nothing to wait on would just burn the timeout     [isError:true]
           同时 team.json 不存在（ENOENT 已核）

C 有结构变化： #96 CALL orchestra_dispatch {"roleId":"implementer", …}  t=1790053958798
              #97 RESULT dispatched … (newly provisioned)
              #101 CALL orchestra_wait {"timeoutMs":180000}           t=1790053960072
              #103 RESULT orchestra_wait team-09d36c54: a change was committed after 10102ms
                           — inspect orchestra_team / reports               t=1790053970183
              #108 CALL orchestra_team → implementer(running,R1, report=…/wait-probe-R0.md, …)

D 无变化：  #131 CALL orchestra_wait {"timeoutMs":15000}               t=1790053980020
           #132 RESULT orchestra_wait team-09d36c54: heartbeat interval reached after 14999ms
                        — inspect team progress
```

**因果链（谁改了 → 谁醒了，时间戳）**：

```
13:12:38.798  driver orchestra_dispatch（物化 implementer）
13:12:40      implementer 写 out.txt（mtime 1790053960）
13:12:50      implementer orchestra_report → orchestra/reports/wait-probe-R0.md
              （mtime 1790053970；同一写入把 reportCount 记进 team.json ⇒ store 提交）
13:13:00.072  driver orchestra_wait 注册（baseline revision 0）
13:13:10.183  wait 返回 changed=true，waited_ms=10102   ← 恰好是那次 report 提交
13:13:12.373  driver 复读 orchestra_team：implementer(running,R1, report=…wait-probe-R0.md)
```

补充（同一轮内的机制旁证，driver 自己观察到）：除 `orchestra_wait` 外，插件还把 `orchestra: team-… report written` 作为**主动通知**投给 driver（`user/message source.kind="a2a" form="relay" senderSessionId=<implementer>`）——**同一个写入事件的两个观察面**（wait 同步拿到 / runtime 主动推送）。

**判据**：等待者被结构变化唤醒 ✓；无团队 fail loud ✓（错误文本 + `isError:true`）；无变化不假唤醒 ✓（14999 ms heartbeat）。**判定：正常。**

**封存哈希**（`/tmp/r6/freeze/item2/`）：driver log `386b4d73…` · implementer log `b984c84f…` · team.json `f66b05e2…` · report `7e1ea382…` · out.txt `edca08f3…`。
**起始/终态 `ls`**：起始 `total 0`；终态 `out.txt (13B)` + `orchestra/{charter,reports,state}`（报告 65 B）。

---

### 2.3 项 3 · `orchestra_add_lanes`（fixture `test-lanes/`）

**夹具**：拓扑 `trio` 建队 → driver 先自己 graft 了一条 `probe-writer` lane 并派活（团队处于"正在跑"）→ 我脚本再注入两次 `add_lanes`（`verifier-extra`：不 confirm 一次、confirm 一次）→ 再派活给新车道。

**机制读数（两次调用返回原文）**：

```
plan（不 confirm）：#104 CALL orchestra_add_lanes {"roles":[{"roleId":"verifier-extra","preset":"orchestra-v04-verifier-v1",
                    "sandbox":"read-only","lane":"audit","purpose":"独立复核 out.txt …"}],"reason":"探针：往正在跑的队上加一条车道"}
                 #105 RESULT orchestra_add_lanes: plan for team team-e18d20b5 (nothing changed yet) —
                        verifier-extra via orchestra-v04-verifier-v1 [read-only] lane=audit.
                        Ask the user once, then call again with confirm: true.
                 同时 team.json 未变：roles=[implementer:reserved, reviewer:reserved, probe-writer:active]，addedLanes 仍 1 条

confirm：         #116 CALL orchestra_add_lanes {… 同参数 …, "confirm":true}
                 #117 RESULT orchestra_add_lanes: 1 lane(s) added to team-e18d20b5 as reserved —
                        verifier-extra. Dispatch one to materialize it.

首次派活才物化：  #144 CALL orchestra_dispatch {"roleId":"verifier-extra", …} → "dispatched … newly provisioned"
                 team.json：verifier-extra phase reserved → active，sessionId 变为
                 orchestra-team-e18d20b5-f2c46928-4173-4d20-91e3-0f8c1f1ab17b（新物化）
```

**审计条目（`team.json.addedLanes` 原文）**：

```json
[{"roleId":"probe-writer","phase":"probe","lane":"probe-write","addedAt":1790054175199,
  "reason":"本轮 mission goal 即 orchestra_add_lanes 探针：写一行文本文件。在 trio 基线之上 graft 一条 probe-write lane…"},
 {"roleId":"verifier-extra","lane":"audit","addedAt":1790054205785,
  "reason":"探针：往正在跑的队上加一条车道"}]
```

**角色行为证据**：driver `TOOLCOUNTS={"orchestra_add_lanes":4,"orchestra_dispatch":3,"orchestra_team":5,…}`；新车道角色 `probe-writer` 交付 `out.txt` + `orchestra/reports/probe-write-R1.md`（reportCount=1），`verifier-extra` 交付 `audit-verify-R1.md`；`a2a_list` 能看到新角色线程（`orchestra-team-e18d20b5-55556a89… [role: probe-writer] (active, team=team-e18d20b5/probe-writer)`）。

**缺口 F-6-3（模型可见面）**：现场 driver 被问"`orchestra_team` 里有没有任何字段/句子指出 verifier-extra 不在原章程里"时的原话：

> "所以 orchestra_team 的当前返回是一个'扁平角色状态视图'，**没有**任何字段显式区分'原章程角色 vs add_lanes 后加角色'。要分辨 verifier-extra 是 graft 上去的，只能靠间接线索（`(trio, active)` 标签 + 角色数对不上），或者靠外部记录（`orchestra/charter/records.json` / `team.json` 的 added_lanes 历史）。"

代码侧对应：`orchestra_team` 的结构化值含 `added_lanes: team.addedLanes ?? []`（`src/orchestra.ts:5099`，注释写明"The board says so explicitly"），但 `render` 只输出一行角色/图/归档文本，**不引用 `added_lanes`**。

**判据**：新角色进 reserved ✓；首次派活才物化 ✓；`team.addedLanes` 有审计 ✓；"显式说明不在原章程里" → **结构化值成立、模型可见面不成立**（记 F-6-3）。**判定：机制正常，证据面有缺口。**

**观察（不进判据）**：driver 与 `probe-writer` 都把报告写到同一路径 `orchestra/reports/probe-write-R1.md`，后写覆盖先写（driver 自己发现并记录"race 现象…无数据竞争损失"）。

**封存哈希**（`/tmp/r6/freeze/item3/`）：driver log `e5702aa3…` · probe-writer `a5e52c9f…` · implementer `b4782548…` · verifier-extra `35adb4c3…` · team.json `6b9cd075…` · out.txt `39e152d7…`。
**起始/终态 `ls`**：起始 `total 0`；终态 `out.txt (14B)` + `orchestra/{charter,reports,state}`（两份报告）。

---

### 2.4 项 4 · 混合后端 `execution:"subagent"`（fixture `test-subagent/`）

**夹具（我自己写的 inline topology，先离线过校验器 `validateTopology(cfg) → []`）**：

```json
{"id":"mixed-backend-probe","controller":{"id":"driver"},"roles":[
 {"id":"implementer","name":"Implementer","preset":"orchestra-v04-implementer-v1","sandbox":"workspace-write",
  "compositionTools":["tool-bash","tool-fs"],"orchestraTools":["orchestra_report"],"welcome":"…"},
 {"id":"helper","name":"Helper","execution":"subagent",
  "persona":"你是 helper 节点（原生 sub-agent 后端）：只给可核对的事实与证据路径，一句话结论。",
  "toolFilter":{"deny":["bash"]},
  "runtime":{"provider":"minimax-cn","model":"MiniMax-M3","reasoningEffort":"high"},"welcome":"…"}],
 "protocol":{"ownership":{"scope":"driver","implementation":"implementer","closure":"driver"},
  "routes":[{"kind":"mission","from":"driver","to":["implementer","helper"]}],
  "completion":{"owner":"driver","rule":"driver acceptance"}}}
```

**子节点属性（子会话日志 header 原文）**：

```json
{"type":"session","version":3,"id":"orchestra-team-940ce550-64005c7c-55eb-410e-a51a-dea1b8fb7cda",
 "createdAt":1790054138890,"cwd":"…/test-subagent","parentSession":"session-6781fe6b-3e07-47ea-bd85-9f2627fa96b1",
 "isSeeded":false,"origin":"subagent","delegationDepth":1,"agentPreset":"standard"}
#0 subagent/descriptor {"version":3,"mode":"continuable","provider":"spawn","label":"Helper",
                        "agentProvider":"minimax-cn","agentModel":"MiniMax-M3","agentReasoningEffort":"high"}
#1 sandbox/mode   {"mode":"workspace-write","source":"delegation"}
#2 approval/policy{"policy":"never","source":"delegation"}
#3 agent/inbox/spliced …（dispatch 欢迎词）
```

**与 session 后端节点的记录差异（`team.json.roles` 原文，同一队）**：

```json
{"id":"implementer","execution":"session","phase":"active",
 "sessionId":"orchestra-team-940ce550-09fac775-…","parentSessionId":null,
 "sandbox":"workspace-write","preset":"orchestra-v04-implementer-v1",
 "blueprint":{"…":"…","pinnedApproval":"never"},"reportCount":1}
{"id":"helper","execution":"subagent","phase":"active",
 "sessionId":"orchestra-team-940ce550-64005c7c-…","parentSessionId":"session-6781fe6b-…",
 "sandbox":"inherited","preset":null,"blueprint":null,"reportCount":1}
```

**派活与回报（角色行为）**：

```
driver #43 CALL orchestra_dispatch {"roleId":"implementer", …} → "dispatched … newly provisioned"
driver #45 CALL orchestra_dispatch {"roleId":"helper", …}      → "dispatched … newly provisioned"
driver #108 CALL list_agents {"scope":"children"}
       #109 RESULT "orchestra-team-940ce550-64005c7c-55eb-410e-a51a-dea1b8fb7cda [ready] — Helper"
driver #96 RESULT orchestra_team … helper(cold,R1, report=…/mixed-subagent-report.md, …)
子节点侧：write mixed-subagent.txt + read + orchestra_report（reportCount=1）+ send_message 回父
driver 收到："Background subagent orchestra-team-940ce550-64005c7c… finished … Its closing message: …"
```

**混编差异（实测读数）**：session 角色有 preset/blueprint/独立沙箱、`list_agents` 看不到；subagent 角色无 preset/无 blueprint、沙箱 `inherited`、审批 `never`、作为**直接子节点**出现在 `list_agents`，且只与直接父（driver）通信。两者在同一次 dispatch 里并行接受任务、各自落产物与报告。

**F-6-5（未定项）**：我读子节点 `request/header`：`{"config":{"provider":"minimax-cn","model":"MiniMax-M3","reasoningEffort":"high"},"tools":[48 个]}`，`HAS_BASH=true`，工具名与父会话一致。而子节点自己的报告写的是 *"toolFilter.deny = ["bash"] was applied at materialization… Effect: the bash tool name is removed from the child's prompt AND refuses to execute. I did not attempt to call bash…"* ⇒ **模型自述与工件读数冲突**；DSH 侧实现是 `childCtx.tools.restrict(composition.toolFilter)`（`dsh-subagent/lib/index.js:556`），**调用点是否拦截本轮未取证**（这是本轮唯一"声明的可调项未被观测到"的点，原样登记）。

**封存哈希**（`/tmp/r6/freeze/item4/`）：driver log `a15ad64c…` · implementer log `70ab6f04…` · helper 子节点 log `5e1aafe9…` · team.json `b056b802…` · 两份报告 `dc010f8e…` / `8cf78cf2…` · 产物 `ca550d01…` / `7f5dd3a8…`。
**起始/终态 `ls`**：起始 `total 0`；终态 `mixed-session.txt (16B)` + `mixed-subagent.txt (17B)` + `orchestra/{charter,reports,state}`。

---

### 2.5 项 5 · 内置拓扑 `feature-development` 端到端（fixture `test-topology/`）

**夹具**：`orchestra_draft{topology:"feature-development"}` → 短肯定句「批准」→ `orchestra_create` → 三条 dispatch 一次性发出（按拓扑声明的 route）。
driver = `session-56d6d59c-a34b-4d4b-b6a3-32547cd02907`；队 `team-a3bb9efa`。

**角色行为证据（每条 route 的真实投递，`readStoredEvents` 原文）**：

```
implementer TOOLCOUNTS={"write":1,"read":1,"bash":2,"orchestra_report":2,"a2a_reply":2,"a2a_send":1}
  #54 CALL a2a_send {"to":"orchestra-team-a3bb9efa-3fdfb517-…（verifier）",
        "message":"{\"summary\":\"Wrote out.txt containing a single line FEATURE_PROBE_OK\",
                    \"changedFiles\":[\"out.txt\"],\"knownRisks\":[]}",
        "idempotencyKey":"implementer-candidate-R1"}                       ← candidate 交接，字段与契约逐字对上
  #25/#59 orchestra_report → implementer-out.txt-R1.md / implementer-candidate-R1.md
verifier    TOOLCOUNTS={"bash":16,"a2a_list":1,"orchestra_team":1,"orchestra_report":1,"a2a_send":1,"a2a_reply":1}
  #67 CALL a2a_send {"to":"…d81baa27…（reviewer）", "message":"{\"summary\":…,\"checks\":[…8 条…],\"notes\":[…12 条…]}"}
  #73 RESULT "keys: ['checks','notes','summary'] / checks count: 8 / notes count: 12"
  #62 orchestra_report → verifier-checks-R1.md（只列 command/exit/scope，未发 PASS/FAIL ← 与拓扑"verifier 不发 verdict"一致）
reviewer    TOOLCOUNTS={"bash":6,"read":4,"a2a_list":2,"orchestra_report":1,"a2a_send":2}
  #71 CALL orchestra_report {"path":"reviewer-verdict-R1.md", …}   ← 报告首行 "## Verdict\nPASS"
  #76 CALL a2a_send {"to":"session-56d6d59c-…（driver）",
        "message":"{\"summary\":\"Reviewer R1 verdict for out.txt probe\",\"verdict\":\"PASS\",\"unresolvedFindings\":[]}"}
driver      TOOLCOUNTS={"orchestra_draft":1,"orchestra_create":1,"orchestra_dispatch":4,"orchestra_team":3,
                        "orchestra_report":2,"read":5,"bash":4,"write":2}
  #121/#178 orchestra_report → closure-R1.md / closure-driver-R1.md（driver 收束）
```

**落盘产物（机制读数，不判质量）**：`orchestra/reports/` = `implementer-out.txt-R1.md` / `implementer-candidate-R1.md` / `verifier-checks-R1.md` / `reviewer-verdict-R1.md` / `closure-R1.md` / `closure-driver-R1.md`；**投递回执** `orchestra/receipts/0b972d72….json`：

```json
{"message_id":"implementer-candidate-R1","target_session_id":"orchestra-team-a3bb9efa-3fdfb517-…",
 "accepted_at_ms":1790054262820,"delivery_mode":"live_inbox","state":"accepted"}
```

**逐条对照拓扑声明**：

| 声明 | 是否真的执行 | 读数 |
|---|---|---|
| `roles: implementer / verifier / reviewer` | ✅ 三个都物化并干活 | 各自 reportCount 2 / 1 / 1；`orchestra_team` 三行都在 |
| `routes: mission / candidate / verification / verdict` | ✅ 四条都发生 | driver→3 角色 dispatch；implementer→verifier `a2a_send`；verifier→reviewer `a2a_send`；reviewer→driver `a2a_send` |
| `handoffs[].requiredPayloadFields` | ✅ 逐字带上 | candidate=summary/changedFiles/knownRisks；verification=summary/checks/notes；verdict=summary/verdict/unresolvedFindings |
| `ownership.review_verdict = reviewer` | ✅ | PASS 由 reviewer 写进 durable 报告；verifier 明确被要求"不发 PASS/FAIL"且实际未发 |
| `completion.owner = driver` + `closure` | ✅（产品路径） | driver 写 closure 报告并留档；**但图的 closure 仍 `none`（见 F-6-1）** |
| `loops: implementation-review` / `gates: feature-closure-approval` | ❌ 未执行 | `graph: idle (rev 0) | no active loop | open gates=0 | closure=none` |

**封存哈希**（`/tmp/r6/freeze/item5/`）：driver `d39a7466…` · implementer `bcaa4938…` · verifier `f96561f4…` · reviewer `98506ffd…` · team.json `404cf00a…` · 六份报告（如 `9b01a8c9…` closure、`4e32b7bd…` verdict、`f9c5849a…` checks）· receipt `68fa8b1b…` · out.txt `899933c8…`。
**起始/终态 `ls`**：起始 `total 0`；终态 `out.txt (16B)` + `orchestra/{charter,reports,receipts,state}`。

---

### 2.6 项 6 · 两条边角

#### ① 重激活的"替换"分支（fixture `test-reactivate/`）

**夹具构造（"归档后原角色会话不在盘上"）**：

```
1) trio 建队 team-5b0b14b1 → dispatch implementer（物化 orchestra-team-5b0b14b1-344457f6-…）
   → implementer 交付 out.txt(20B) + orchestra/reports/reactivate-probe.md（reportCount=1）
2) driver #102 CALL orchestra_dismiss {} → #103 RESULT_ERR（F-6-2；副作用已发生）
   归档文件：orchestra/archive/team-team-5b0b14b1-1790054511670-b662f109-….json（12509 B）
3) 停实例（curl 4600 → 000）→ 删角色会话目录 → 重启实例
   $ ls -la ~/.dsh/sessions/<slug>/orchestra-team-5b0b14b1-344457f6-…/
     -rw-------  1 yuantian  staff  36214 Sep 22 13:22 session.v3.jsonl.zstd
     sha256 bc27f219a5971a437f9d317b908e89be3f5241ba2fefe272ffff24bf5e09ccc3
   $ rm -rf <该目录>
   $ ls -la ~/.dsh/sessions/<slug>/          → 只剩 session-45acde0f-…（角色目录已不在）
   $ ls -la <该目录>  → No such file or directory
   $ stat  <该目录>  → stat: No such file or directory
```

**激活读数（重启后，冷恢复的 driver 会话里调用）**：

```
#126 CALL orchestra_team {} → "no active team; archives: team-team-5b0b14b1-1790054511670-b662f109-… （重激活替换分支探针…）"
#138 CALL orchestra_activate {"archiveId":"team-team-5b0b14b1-1790054511670-b662f109-5f97-440b-a5de-e81d215ea9d7"}
#139 RESULT team team-5b0b14b1 reactivated from team-team-5b0b14b1-1790054511670-… (active):
        implementer=orchestra-team-5b0b14b1-344457f6-… (replaced, replaced orchestra-team-5b0b14b1-344457f6-…),
        reviewer=orchestra-team-5b0b14b1-b1025dd4-… (kept-reserved)
```

**替换后的 `team.json`**：

```json
{"id":"implementer","phase":"active","preset":"orchestra-implementer","sandbox":"workspace-write",
 "sessionId":"orchestra-team-5b0b14b1-344457f6-a4d5-4a37-915a-575e73e2f917",
 "sessionHistory":[{"sessionId":"orchestra-team-5b0b14b1-344457f6-a4d5-4a37-915a-575e73e2f917",
                    "replacedAt":1790054593647,"reason":"session-not-found"}],"reportCount":1}
{"id":"reviewer","phase":"reserved","sessionId":"orchestra-team-5b0b14b1-b1025dd4-…","sessionHistory":[]}
```

**新会话的身份与组合（"按名册挂载"的 live 读数）**：

```
$ ls -la <角色会话目录>   → session.v3.jsonl.zstd 29856 B  mtime Sep 22 13:23:20（旧的是 36214 B / 13:22:15）
HEADER={"type":"session","version":3,"id":"orchestra-team-5b0b14b1-344457f6-…","createdAt":1790054593616,
        "cwd":"…/test-reactivate","isSeeded":false,"delegationDepth":0,
        "agentPreset":"orchestra-implementer"}          ← 名册预设 **id**（不是文件路径）
#0 approval/policy {"policy":"never"}   #1 sandbox/mode {"mode":"workspace-write"}
#2 session/title {"title":"implementer · 重激活替换分支探针：原角色… · test-reactivate"}
#3 agent/inbox/spliced → "You are running on orchestra, as role \"Implementer\". …
      Your previous session (orchestra-team-5b0b14b1-344457f6-…) no longer exists,
      so you were re-created as a replacement. team_id: team-5b0b14b1 …"      ← Recovery Packet
system/message 含实现者 persona（"你作为 implementer（实现者）…"）+ 模型路由 minimax-cn/MiniMax-M3/high
```

**"按文件挂载 vs 按名册挂载"（候选缺陷 R-5/F-D1-5）的 live 结论**：
- **分支判定**：走的是 replacement（不是 resume / failed），`session-not-found` 被正确识别，reserved 角色正确走 `kept-reserved`。
- **挂载身份**：替换会话的 durable meta 是 **`agentPreset:"orchestra-implementer"`（名册 id）**，且组合真的生效（persona 文本 + 工具面 + 模型路由都在）——E-6 之前"按文件挂载 ⇒ 无 discovery / 无身份 / 冷恢复空壳"的失败形态**本轮未复现**。
- **代码路径读数**：`src/orchestra.ts` 替换分支 `resolvePresetFile(...) → createRoleSession({kind:"create", presetFile, …})`；`src/role-preset-mount.ts` 的 `mountRolePreset` **只在 override 文件（`project`/`global` 来源）时走 `mountPreset`（by file）**，其余一律 `agentPresets.mount(ctx, id)`（by id）。两者一致。
- **名册层读数**：`node scripts/verify-role-presets-roster.mjs` → `# presets healthy=12/12 roots=1 default="standard" agent_presets_rows=1 warnings=0`（exit 0）。

**F-6-4（记录缺陷）**：座位 sessionId 被复用 ⇒ 回执 `replaced <同一个 id>`、`sessionHistory[].sessionId` 等于当前 `role.sessionId`。**"替换发生过"这件事在记录层不可辨**（只有 `replacedAt` + `reason` 能提示），一个 reader 无法据此知道该角色的对话历史已经丢失。

**起始/终态 `ls`**：起始 `total 0`；终态 `out.txt (20B)` + `orchestra/{archive,charter,reports,state}`（`state/team.json` 12766 B = 激活后的活队）。

#### ② 设置面板（client 0.1.6，真浏览器）

通道：Ego lite TaskSpace **45**，页面 `p1` → `http://127.0.0.1:4600/?token=…`（真 Chromium，非无头）。

```
机制读数：page.fetch("/plugins/orchestra-dsh/state") → ROUTE_STATUS=200
         ROUTE_TOPLEVEL_KEYS=["templates","teams"]   ROUTE_TEMPLATE_COUNT=11
         ROUTE_TEMPLATE_IDS=architect-dev(3), architecture-decision(3), audit-and-hardening(5),
           bug-diagnosis-and-fix(4), duo(1), feature-development(3), four-role-dev(3),
           hybrid-probe(2), oracle(1), refactor-and-migration(4), trio(2)   （source 全为 global）

客户端读数：click button[aria-label="设置"] → dialog "设置"（导航项：通用设置/模型/内置插件/
           Agent 预设/Provider 密钥/已归档会话/orchestra/打开配置文件/关闭）
           click text="orchestra" → 面板渲染：
           "orchestra / 多角色拓扑协作 · 内置组织与角色恒显，团队实例尽力而为（轮询）…
            编排 · Orchestrations / 版型 · Templates
            Feature Development (feature-development · global)
              把已批准的 feature mission 变成…；Loop PASS 且用户 Gate approve 后才收束
              roles: Implementer (implementer), Verifier (verifier), Reviewer (reviewer)
              owns: implementation→implementer, verification→verifier, review_verdict→reviewer,
                    user_decision→driver, closure→driver · routes: mission: driver→implementer;
                    candidate: implementer→verifier; verification: verifier→reviewer;
                    verdict: reviewer→driver; findings: reviewer→implementer"
           （其余 10 条同格式列出；无 "state unavailable"、无 loading 卡死）
```

**判据**：面板存在 ✓、渲染出拓扑目录 ✓（11 条 = 10 内置 + 1 个 global 用户预设 `hybrid-probe`）、每条带 roles/owns/routes ✓。**判定：正常。**（`source` 全为 `global` 是观察：内置拓扑实际由 `~/.dsh/orchestra/topologies/` 提供。）

---

## ③ 分层定位

| 层 | 本轮实测 | 判定 |
|---|---|---|
| **名册层** | `verify-role-presets-roster.mjs` → `healthy=12/12 roots=1 default="standard" agent_presets_rows=1 warnings=0`；本轮用到的 `orchestra-implementer` / `orchestra-reviewer` / `orchestra-v04-{implementer,verifier,reviewer}-v1` 全部可解析；**替换会话的 durable meta 记的是预设 id**（`agentPreset:"orchestra-implementer"`），不是文件路径 | **成立** |
| **挂载路径层** | 三条建会话路径（首波 `orchestra_create` / 懒加载 `orchestra_dispatch` / 重激活 replacement）**都真的组合出了 persona + 工具面 + 显式模型路由**（system message 里能看到角色 persona 文本；`request/header.config` 全是 `minimax-cn/MiniMax-M3/high`）；`pinnedApproval:"never"` 在 blueprint 与子节点 `approval/policy` 两处都在 | **成立** |
| **恢复路径层** | 跨重启冷恢复：driver 会话经 `session/prompt` 自动 resume 后照常调工具；`orchestra_activate` 命中 replacement 分支、发 Recovery Packet、reserved 角色 `kept-reserved`、新会话重新挂上名册预设。**新发现**：座位 id 复用让"替换"在记录里不可辨（F-6-4） | **成立（记录有缺陷）** |
| **图与交接层** | **交接半边成立**：`a2a_send`/`a2a_reply`/`orchestra_report`/`orchestra/receipts`（`state:"accepted"`, `live_inbox`）都有真实投递与落盘；route 与 payload 字段按拓扑声明逐字发生（项 5）。**图半边不成立**：loop/attempt/verdict/gate/closure 全轮 `idle (rev 0)`、`events:[]`；闭环写命令 0 调用点（F-6-1）；`orchestra_team` 的图读数只能当"永远 idle"读 | **一半成立、一半缺失** |

---

## ④ 未做 · 未验证（如实列举）

| 项 | 状态 |
|---|---|
| **loop cap 实跑**（`maxAttempts=2` 到顶 → `cap_exhausted`） | **未取得**：无 attempt ⇒ cap 不可达（依赖 F-6-1）；本轮**没有**为了凑读数去改产品代码或注入内部函数 |
| **gate 的 approve / reject 实跑**（`/team decide <gate> <option>`） | **未取得（不可达）**：全程 `open_gates=0`；slash 命令也不能经 API prompt 通道下发（已知事实）。仅取到"没有 gate 可 decide"这一读数 |
| **typed handoff 的 payload 校验是否真的会拒**（缺字段/错 kind） | **未取得**：live 面没有 typed handoff 入口；角色用的是自由文本 `a2a_send` |
| **`toolFilter` 的调用点拦截**（F-6-5） | **未定**：子节点工具表含 bash；子节点未尝试调用被 deny 的工具；DSH 侧 `childCtx.tools.restrict` 是否在调用点拒绝**未取证** |
| **`orchestra_add_lanes` 的模型可见面**（F-6-3） | **已取证但只在表层**：结构化值 vs render 文本的差异由现场 driver 的自述 + `render` 代码两侧证据支撑；**未**去读 DSH 平台把 tool value 传给模型的完整路径（那属于平台层） |
| **两项边角之外的 `hybrid-probe`（global 用户拓扑）** | **未跑**：它已存在于 `~/.dsh/orchestra/topologies/`（上一轮 P10 夹具，runtime 写的是 `provider:"command"`），本轮按 Owner 口径"每项只跑一次"未启用它，改用自建 inline 拓扑（模型路由显式 `minimax-cn/MiniMax-M3/high`） |
| **其余内置拓扑**（`bug-diagnosis-and-fix` / `architecture-decision` / `refactor-and-migration` / `audit-and-hardening`） | **未跑**：本轮只跑 `feature-development`（brief 要求"至少跑它"）。它们在 `orchestra_topologies` 与设置面板里可见、声明完整 |
| **可见性 / 工作区注册** | **按 brief 不做**（会话经 API 建，不进工作区分组；可见性不是本轮判据） |
| **交付物质量** | **不进判据**：本轮所有产物（`GRAPH_PROBE_OK` / `WAIT_PROBE_OK` / `LANES_PROBE_OK` / `MIXED_*` / `FEATURE_PROBE_OK` / `REACTIVATE_PROBE_OK` 一行文本）只作"角色真的干了活"的观察 |
| **成本** | 实例 12:57 → 13:24 ≈ 27 分钟（≤4 h）；模型回合：6 个 driver 会话 + 9 个角色会话（≤150 回合的 runner 预算未触顶） |
| **我自己的图像审阅** | 本轮无需图像判据（全部读数为文本/JSON/文件元数据），未使用 `read_image` |

---

## ⑤ 下一跳建议（driver 定夺）

1. **F-6-1 是本轮最重的一条**：图运行时协议在 live 面**完全没有接线**（写命令 0 调用点），而 **10 个内置拓扑里有 5 个**（feature-development / bug-diagnosis-and-fix / architecture-decision / refactor-and-migration / audit-and-hardening）在宪章里声明了 loops/gates/closure，`orchestra_topologies` 与设置面板也把"Loop PASS 且用户 Gate approve 后才收束"写给用户看。**建议二选一**：(a) 接线（把 `orchestra_handoff`/`orchestra_verdict`/gate/closure 的模型面命令补回来，或在既有工具上挂图命令）；(b) 明确降级——从拓扑声明与文案里删掉 loops/gates/closure，只保留 ownership/routes/completion，避免"声明了却不发生"。**这一条已经不是"未验证"，是"声明与实现不一致"。**
2. **F-6-2（`orchestra_dismiss` 每次报错）应最先修**：一行 schema 修补（output schema 加 `reason`/`summary`，或从返回值里去掉这两个字段）。现状是**每次正常收尾都向模型报一次假失败**，而副作用已经发生——模型会重试、会向用户报告"归档失败"。
3. **F-6-3 / F-6-4 是"证据面"缺陷，建议一并修**：`orchestra_team` 的 render 里点出 graft 车道（如 `+added:verifier-extra(audit)`），`sessionHistory` 记一个可区分的 `replacedSessionId`（或换成 `seatId` + `instanceId` 两字段）。两条都直接影响"人/模型能不能发现名册变化与身份丢失"。
4. **F-6-5 值得一次小实验**：让一个 `toolFilter.deny=["bash"]` 的子节点**真的调用一次 bash**，看是"工具不在表里"还是"调用被拒"。这是唯一能把"原生可调项到底有没有生效"钉死的一步。
5. **项 2/3/4/5/6② 这五项可以在下一轮拿来做回归基线**：它们的夹具与判据都在本报告里，读数是可复算的（封存日志 + sha256 已登记）。

---

## 附 A｜通道

- **Ego lite TaskSpace id=45**（name `orchestra six-mechanisms live probe (round 6)`），页面 `p1`；**真 Chromium**（非无头），全程只用 `page.fetch`（`/api/session/create` · `/api/session/prompt` · `/api/session/page`）与 `page.click/snapshot/evaluate`（仅项 6②）。
- **实例**：`dsh --profile dev --port 4600 --no-open`（受管后台作业 `bash-31`）；token `http://127.0.0.1:4600/?token=<redacted>`。
  **项 6① 需要中断**：停实例（`curl → 000`）→ 删角色会话目录 → **重启**（作业 `bash-37`，新 token `…?token=<redacted>`）。
- **4599 全程未碰**：`lsof :4599` = PID 14248，`curl → 401`（起实例前 / 收尾后各一次）。
- **收尾**：4600 停掉（`curl → 000`）。

## 附 B｜痕迹登记

**新建（全部在 `/tmp/r6/`，仓库外）**：`/tmp/r6/run-item*.mjs`（6 个 driver 流程脚本 + 3 个 tail/status 读脚本）· `/tmp/r6/prelude.mjs`（RPC/等待/取证 harness）· `/tmp/r6/extract.mjs` `times.mjs` `childinspect.mjs` `replacement.mjs`（离线解码器）· `/tmp/r6/evidence/*.txt`（4 份原始输出）· `/tmp/r6/freeze/{item1..item6a}/`（**封存副本 + sha256**，见各项小节）。
**修改**：无（产品代码 / ADR / 计划 / 契约 / 台账 / 设置面板相关配置一律未动；`~/.dsh/settings.yaml`、`~/.dsh/storages/workspace.json` 未动）。
**删除**：
- 六个 fixture 子目录（每项跑完即清）：`test-graph/`、`test-wait/`、`test-lanes/`、`test-subagent/`、`test-topology/`、`test-reactivate/`；另有一个通道冒烟目录 `test-smoke/`（3 分钟冒烟用，当场清掉）。
- **项 6① 的夹具动作**：删除 `~/.dsh/sessions/…-test-reactivate--/orchestra-team-5b0b14b1-344457f6-…/`（旧 36214 B，sha `bc27f219…`），**目的就是构造"会话不在盘上"**；该会话随后被 replacement 分支重建（29856 B）。
**新增会话（6 个 driver + 12 个角色座位，其中项 6① 的角色座位重建过一次 ⇒ 18 份日志在盘 + 1 份被删）**：见各项小节里的 sessionId；会话日志留在 `~/.dsh/sessions/`（**未删**），封存副本在 `/tmp/r6/freeze/`。
**未动（已核）**：`orchestra_E2E/artifacts/` · `minecraft-html/`（sha `6d342da4…` 未变）· `orchestra/archive/` + `orchestra/charter/` · 4599。

## 附 C｜完整命令清单（关键者）

```bash
# 硬前提与等价性
git log --oneline -3 ; git log --oneline -1 -- src/ ; git diff --stat d58c817..HEAD -- src/
shasum -a 256 lib/orchestra.js ~/.dsh/profiles/dev/node_modules/orchestra-dsh/lib/orchestra.js
npm test                                   # → 1..284 / # pass 284 / # fail 0

# 实例（受管后台作业）
lsof -nP -iTCP:4599 -sTCP:LISTEN ; curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4599/
dsh --profile dev --port 4600 --no-open    # bash-31；项 6① 前停、后重启（bash-37）
curl -s -o /dev/null -w "4600:%{http_code}" http://127.0.0.1:4600/     # 收尾 → 000

# 每项：建会话 → 投指令 → 读事件
ego-browser nodejs -e "$(cat /tmp/r6/run-itemN.mjs)"
#   页内 page.fetch：session/create{cwd} · session/prompt{mode:"queue"} · session/page{throughSeq≤cursor}
#   离线解码：node /tmp/r6/extract.mjs <sessionDir>…   （经 scripts/check-session-readable.mjs 的 readStoredEvents）
#   时间戳因果链：node /tmp/r6/times.mjs <sessionDir> <seq>…
#   子节点属性：node /tmp/r6/childinspect.mjs <子会话目录>

# 项 6①：构造 + 激活
rm -rf ~/.dsh/sessions/<slug>/<role-session>            # 删除前 ls + shasum + stat 已留证
node /tmp/r6/replacement.mjs <重建后的角色会话目录>

# 项 6②：设置面板
ego-browser nodejs -e "$(cat /tmp/r6/item6b-settings.mjs)"   # 路由 + 打开设置
ego-browser nodejs -e "$(cat /tmp/r6/item6b-panel.mjs)"      # 点 orchestra 面板 + 读渲染文本

# 名册层核对
node scripts/verify-role-presets-roster.mjs   # → healthy=12/12 roots=1 warnings=0

# 封存
find /tmp/r6/freeze/itemN -type f | sort | xargs shasum -a 256
```

## 附 D｜起始 / 终态 `ls`

```
# 起始（12:57–13:24 之间，各 fixture 建目录时）
$ ls -la …/orchestra_E2E/                      $ ls -la …/orchestra_E2E/test-graph（及 test-wait/test-lanes/test-subagent/test-topology/test-reactivate）
  artifacts     (Sep 19)                         total 0
  minecraft-html(Sep 22)                         drwxr-xr-x 2 yuantian staff 64 … .
  orchestra     (Sep 19)                         drwxr-xr-x 5 …              .. （空目录）

# 终态（每项跑完、清空前已贴各项终态 ls；下面是全局终态）
$ ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/
total 0
drwxr-xr-x   5 yuantian  staff  160 Sep 22 13:24 .
drwxr-xr-x@ 19 yuantian  staff  608 Sep 22 00:36 ..
drwxr-xr-x   5 yuantian  staff  160 Sep 19 04:26 artifacts
drwxr-xr-x   3 yuantian  staff   96 Sep 22 03:30 minecraft-html
drwxr-xr-x   7 yuantian  staff  224 Sep 19 04:26 orchestra
```

---

**报告完毕，原样回 driver。** 产品代码零改动、缺陷只登记不修；未碰 4599；六个 fixture 子目录已按 brief 清空；4600 已停（`curl → 000`）。本地 commit，未推送（等 Owner）。
