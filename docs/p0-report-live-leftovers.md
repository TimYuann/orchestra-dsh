# P0 · 批 1 live 遗留清零轮（test runner 第 4 轮）：D2-a 步骤 3 + S4 steer 机会项 + R-6 修正配方

> **作者**：test runner（第 4 任，只执行 driver 设计的测试、只取证；不改代码、不自选路径）。
> **候选 commit**：`07010bfdbddd3a849c7b00862a585e9a66ff273a`（HEAD，`git status --porcelain` 空）；本轮实测的 `lib/orchestra.js` = **`d58c817` 的构建**（`af224fe0…`）。
> **依据**：`docs/review-rounds-ledger.md` **§31（裁定 AJ/AK + 批 1 现状：live 遗留）**、**§30（裁定 AG：步骤 3 为何必须补）**、**§29（测试文件夹纪律）**、**§27（裁定 AC：R-6 上次为何失败）**；`docs/plan-0.8.0-execution.md` **§4.8 D2-a 步骤 2/3**。
> **本轮唯一结果**：批 1 的 live 遗留清零 —— **D2-a 步骤 3 已闭合**。
> **未向 Owner 提问**；未改产品代码 / ADR / 计划 / 契约 / 台账；未做 §4.8 步骤 5（裁定 AJ）。

---

## ① 结论（一句话，可判真假）

**必做项取到**：在 `approval` 被钉成 `never` 的真实角色会话上，一次**真实的提权请求**（`write` + `sandbox_permissions:"workspace-write"` + `justification`）产生了 **`approval/asked{id:85a03f50-3637-491a-a477-4ba5f58c350e}`** 与 **`approval/decided{同 id, outcome:"rejected"}`** 的**成对**记录，两条都落在**同一个 turn 2**（`turn/start@73` … `turn/end@109`），工具**即时**返回确定性拒绝（`isError:true`，`Error: the user rejected escalating this operation to "workspace-write"`），回合**正常收束**。随后 `verify-d2-approval.mjs --session <该会话> --expect-policy never` ⇒ **exit 0**、汇总行 **`hanging 0 dangling 0`**（本轮日志里**确实有**这一对，成对断言**不再空转**）；`--self-test` ⇒ **exit 1**。

**机会项 1（S4 steer）：未触发** —— 两个回合都以 handoff 收束（turn 1 有 `orchestra_report`+`a2a_reply`，turn 2 有 `a2a_reply`），steer 提示文本在会话日志里**零命中**。**未为此另造场景**。

**机会项 2（R-6 修正配方）：结论与上一轮相反 —— 读侧有 `fs`（marker 被读到并被使用）**。主测（逐字段合法 marker，`presetPath` 指向**不存在**的路径）⇒ `a2a_send` **失败**，错误逐字点名 marker 自己的 `agentPreset` 与 `presetPath`：`agent-presets: preset "orchestra-v04-implementer-v1" failed to mount: config file not found: /nonexistent/roster/orchestra-v04-implementer-v1/agent.cordis.yml`；基线（无 marker）⇒ 成功；阳性对照（真实 `presetPath`）⇒ 成功。**未取到**"角色改用 marker 指定预设行事"的信号（角色自报仍是 Reviewer），故**不夸大**：阳性对照只证明**不失败**，"marker 被读"由主测证明。

---

## ② 测试过程与原始输出（原始命令 + 原始输出，不转述）

### 2.1 硬前提：4600 换成当前 HEAD（全绿 + 等价性核验）

```
$ git status --porcelain                 # （空）
$ git rev-parse HEAD
07010bfdbddd3a849c7b00862a585e9a66ff273a

$ shasum -a 256 lib/orchestra.js ~/.dsh/profiles/dev/…/lib/orchestra.js      # 换之前
af224fe05471cc79b5a0a44a682cbd4b207c08332daab21d59f7ac8e4d5a76ef  lib/orchestra.js       ← d58c817 的构建
4c41ef7f38a416526d926d98cf55e081fb4af10950743d80112beebd6268594d  …/profiles/dev/…        ← 上一轮构建

$ npm run typecheck   → TYPECHECK_EXIT=0
$ npm run build       → BUILD_EXIT=0（重建后 lib/orchestra.js 仍是 af224fe0…，确定性）
$ npm test            → 1..284 / # tests 284 / # pass 284 / # fail 0 / # cancelled 0   TEST_EXIT=0
$ npm pack --cache /tmp/dsh-npm-cache → total files 79 / shasum 80c013e748914634ed925d1f5d12817fbae694de
$ shasum -a 256 orchestra-dsh-0.5.1.tgz
56e8ac68cfde89d39f2d538272cf870c319fa76a869f4165bc11f92b109f4c10

$ cd ~/.dsh/profiles/dev && rm -rf node_modules/orchestra-dsh && rm -f node_modules/.modules.yaml \
    node_modules/.pnpm-workspace-state-v1.json node_modules/.pnpm/lock.yaml && pnpm install
Progress: resolved 121, reused 120, downloaded 1, added 123, done       Done in 1.6s using pnpm v11.24.0

等价性核验（“证据绑 HEAD”唯一凭据）：
$ shasum -a 256 <profile>/lib/orchestra.js lib/orchestra.js
af224fe05471cc79b5a0a44a682cbd4b207c08332daab21d59f7ac8e4d5a76ef  <两侧相同>
$ diff <两侧>   → （空 = identical）
三件套：@deepseek-ai/ 只有 cosmokit  schemastery；require.resolve('@deepseek-ai/dsh-tools',{paths:[…/lib]})
        → …/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js（host）；插件 dependencies = {"js-yaml":"^4.1.0"}
        profile dependencies/bundles 未动（dsh-trinity 行原样）
```

### 2.2 环境（A：起始态原文）+ 实例 + 通道

```
$ ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/          # 起始态
total 0
drwxr-xr-x   4 yuantian  staff  128 Sep 22 00:58 .
drwxr-xr-x@ 19 yuantian  staff  608 Sep 22 00:36 ..
drwxr-xr-x@  5 yuantian  staff  160 Sep 19 04:26 artifacts
drwxr-xr-x@  7 yuantian  staff  224 Sep 19 04:26 orchestra

端口基线：4599 = PID 14248 / 401；4600 = none / 000
起 4600（受管后台作业 bash-22）：dsh --profile dev --port 4600 --no-open
   → dsh web: http://127.0.0.1:4600/?token=pr5i-34bkRngJDU8LNq1OIpgyPxLJonFt0aQCnn5VLc
通道 = Ego lite（ego-browser skill）TaskSpace id=35 + 页内 page.fetch；非 browser-use、非无头。
```

### 2.3 建队（C）：驱动自起草 → 短肯定句批准 → create → 首次派活懒加载

```
POST /api/session/create {request:{cwd:"…/orchestra_E2E/test-a"}}
{"ok":true,"value":{"sessionId":"session-afefed65-b81a-426e-a192-577bbb5fb9c2","agentPreset":"standard"}}

driver turn 1：orchestra_draft → draft-c0a3d219-a2f9-481e-b08c-c21afb81d4fc@1；turn/end
（计划消息单独一条，driver 正确识别“这不是批准”并继续等；随后投**裸**「批准」⇒ 批准被记录）
driver turn 3：orchestra_create {"frozenRef":"draft-c0a3d219-…@1#82c4e756…"} → orchestra_dispatch {"roleId":"reviewer",…}

物化后的 team 记录（`orchestra/state/team.json`）：
teamId team-b14140b8  status active  controller session-afefed65-b81a-426e-a192-577bbb5fb9c2
ROLE {"id":"reviewer","phase":"active","sessionId":"orchestra-team-b14140b8-f952d90d-1cd1-44fa-8aa5-672df98ffd0e",
      "sandbox":"read-only","pinnedApproval":"never","approval":"ask","rowIds":11,"history":0}

$ ls ~/.dsh/sessions | grep -i "test-a"
--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_E2E-test-a--     ← slug 保留大小写（ls 核实）
```

（⇒ **裁定 AH 的 `pinnedApproval:"never"` 已在记录里**，与 `approval:"ask"`（权限预设声明值）并存。）

### 2.4 角色第一轮：正常干活 + 一次普通写入被**沙箱模式**拒绝（回合收束）

```
54 CALL  write {"file_path":"…/test-a/notes.md","content":"…pinApprovalNever 核验结论…"}
55 RESULT Error: [sandbox: file access denied under read-only mode]
          [sandbox: escalation available — retry this exact operation once with sandbox_permissions …]   ← 该回合 asked=0
59 CALL  orchestra_report → 64 CALL a2a_reply
71 turn/end {"turn":1,"reason":{"kind":"completed"}}
```

### 2.5 ★ D（必做注入）：真实提权请求 ⇒ `asked`/`decided` **成对** + 回合正常收束

驱动按要求派活："请对 `notes.md` 再执行一次写入，并带上 `sandbox_permissions:"workspace-write"` 与 `justification:"验收 orchestra 插件在 approval=never 下的提权行为所需的一次性写入"`……拿到结论后如实回报，不要再次重试。"

**原始事件行（角色会话，`readStoredEvents` 解出）**：

```
73 turn/start {"turn":2}
85 CALL  write {"file_path":"…/test-a/notes.md", …}          ← 带 sandbox_permissions + justification
86 approval/asked   {"id":"85a03f50-3637-491a-a477-4ba5f58c350e","toolName":"write",
                     "callId":"call_00_drhTD6ooApjIjqrZJB5R5826",
                     "reason":"escalate sandbox to workspace-write: 验收 orchestra 插件在 approval=never 下的提权行为所需的一次性写入"}
87 approval/decided {"id":"85a03f50-3637-491a-a477-4ba5f58c350e","outcome":"rejected"}
88 RESULT {"turn":2,"step":2,…,"content":[{"type":"text","text":"Error: the user rejected escalating this operation to \"workspace-write\""}],"isError":true}
109 turn/end {"turn":2,"reason":{"kind":"completed"}}
```

**逐条对判据**（§4.8 D2-a 步骤 3/4）：

| 判据 | 期望 | 实测 |
|---|---|---|
| 同 `id` 成对 | 是 | ✅ `85a03f50-3637-491a-a477-4ba5f58c350e` 两侧相同 |
| 同一 `turn/start`…`turn/end` 区间 | 是 | ✅ 同属 turn 2（`turn/start@73` / `turn/end@109`） |
| `outcome` 落在集合 | `{allowed-once, rejected, cancelled, unavailable}` | ✅ **`rejected`** |
| 回合正常收束 | 有 `turn/end` 且在 `decided` 之后 | ✅ `decided@87` < `turn/end@109` |
| 确定性结论（非"等待中"） | 即时拒绝 | ✅ 同一 step 内返回 `isError:true` 的确定性错误 |

### 2.6 E｜③ 判据（清理之前）+ ④ 校准

```
$ node scripts/verify-d2-approval.mjs --session ~/.dsh/sessions/--Users-yuantian-…-orchestra_E2E-test-a--/orchestra-team-b14140b8-f952d90d-1cd1-44fa-8aa5-672df98ffd0e --expect-policy never
APPROVAL_OK    /Users/yuantian/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_E2E-test-a--/orchestra-team-b14140b8-f952d90d-1cd1-44fa-8aa5-672df98ffd0e hanging 0 dangling 0
# sessions 1 ok 1 missing 0 hanging 0 dangling 0 problems 0
EXIT=0

$ node scripts/verify-d2-approval.mjs --self-test
# self-test: baseline log /tmp/verify-d2-approval-0dmwgW/session-calibration-paired
APPROVAL_OK    /tmp/verify-d2-approval-0dmwgW/session-calibration-paired hanging 0 dangling 0
# self-test: perturbed log …-unpaired (one approval/decided removed)
          dangling_approval: ask-calibration for tool bash was asked at seq 5 in turn 1 and never decided
# self-test dangling=detected
EXIT=1
```

**该会话日志的事实（`readStoredEvents` 原文）**：

```
agentPreset=orchestra-v04-reviewer-v1   events=160（终态）
turn/end: [1,2,3,4,5]      approval/policy: 1 条 → [{"policy":"never"}]
approval/asked=1  approval/decided=1
```

（**与上一轮的关键差异**：上一轮 `asked=0`（写入被 read-only 沙箱挡下、模型未提权）⇒ 成对断言空转；本轮 `asked=1` 且成对 ⇒ **不再空转**。）

### 2.7 F｜机会项 1：S4 steer —— **未触发**

```
EVENT_HISTOGRAM={"approval/policy":1,"sandbox/mode":2,"session/title":1,"agent/inbox/spliced":4,"turn/start":2,
 "step/start":16,"system/message":1,"user/message":5,"request/header":1,"request/context":1,"assistant/message":16,
 "tool/call":19,"tool/result":19,"step/end":16,"workspace/changes":2,"turn/end":2,"approval/asked":1,"approval/decided":1}
STEER_TEXT_HITS=0          ← 搜的是 steer 提示原文 "without handing anything back"（符号：roleTurnStallPrompt）
```

⇒ 两个回合都**交了东西**（turn 1：`orchestra_report`+`a2a_reply`；turn 2：`a2a_reply`），guard 的前提"回合关闭且未交回"**从未成立**，故 steer 未发生。**未为此另造场景**（brief 明令）。

### 2.8 G｜机会项 2：R-6 修正配方（三条读数）

> **一处与 brief 字面序列的偏离（如实声明）**：brief 写"重启一次，然后基线 → 主测 → 阳性对照"。**marker 只在冷恢复时被读**（热会话走 `live_inbox`，见 §2.8 的 `resumed_inbox` 对照），基线那一步会把角色**热起来**，使后两步测不到读侧。故我在**每一步之前各重启一次**（共 3 次），让三次 `a2a_send` 都打在**冷会话**上。这不是"换路子重试"，是让每条设计好的测量有效。

**主测 marker（逐字段合法，用宿主自己的 parser 自检通过 —— 这是 §27 裁定 AC 上次失败的原因）**：

```
$ node -e '…写 <test-a>/orchestra/blueprints/orchestra-team-b14140b8-….json…'
WROTE …/orchestra/blueprints/orchestra-team-b14140b8-f952d90d-1cd1-44fa-8aa5-672df98ffd0e.json   size=765
$ node --input-type=module -e 'import { parseGovernedBlueprint } from "…/lib/session-blueprint.js" …'
PARSE_VALID=true
parsed.agentPreset=orchestra-v04-implementer-v1 presetSource=file
parsed.presetPath=/nonexistent/roster/orchestra-v04-implementer-v1/agent.cordis.yml
```

（字段：`schemaVersion:1` `mode:"governed"` `teamId` `roleId` `topologyId` `controllerSessionId` `agentPreset`（**另一个真实名册预设**）`permissionPreset` `effectivePermissionPreset` `approval` `topologySource:"bundled"` `sandbox:"read-only"` `provider` `model` `createdAt`（数字）`cwd` + `presetSource:"file"` `presetPath`（不存在）`presetTrust:"system"`；**不含** `createdBySessionId`/`topology`/`roles`。marker sha256 = `14e6c4eb6a9214f5d22f5a18d7f8f5a32e1f2d029c9b205e418a5d570c6b118c`。）

**三条读数（全部是对冷角色 `a2a_send` 的原样返回）**：

```
[基线]  无 marker、blueprints/ 目录不存在（ls 已核）
  seq 260 a2a_send {"to":"orchestra-team-b14140b8-…","message":"ping: baseline（无 marker）…"}
  seq 261 RESULT  "message 76204324-04ad-42d8-9a7a-d8adb614798a accepted for orchestra-team-b14140b8-… (resumed_inbox); no answer awaited"
  ⇒ 成功；角色随后同一 header 预设（orchestra-v04-reviewer-v1）正常应答

[主测]  marker 的 presetPath = 不存在路径
  seq 282 a2a_send {"to":"orchestra-team-b14140b8-…","message":"ping: main-marker …"}
  seq 283 RESULT  Error: agent-presets: preset "orchestra-v04-implementer-v1" failed to mount:
                  config file not found: /nonexistent/roster/orchestra-v04-implementer-v1/agent.cordis.yml
                  (/nonexistent/roster/orchestra-v04-implementer-v1/agent.cordis.yml)          isError: true
  ⇒ **失败且错误含 mount 类字样** ⇒ 按 brief 的判据：**读侧有 fs（marker 被读到）**

[阳性对照]  同形状，presetPath = 真实存在的
  ~/.dsh/orchestra/catalog-presets/orchestra-v04-implementer-v1/agent.cordis.yml（2334 B，ls 已核）
  seq 303 a2a_send {"to":"orchestra-team-b14140b8-…","message":"ping: positive-control …"}
  seq 304 RESULT  "message 392999c9-203d-4b0c-bf68-14192f2e707f accepted for orchestra-team-b14140b8-… (resumed_inbox); no answer awaited"
  ⇒ 成功（不失败）
  角色随后自报（a2a_reply@153）："收到 —— 身份/预设：Reviewer（角色 roleId: reviewer；team-b14140b8 main lane；
   read-only 沙箱；DSH composition strategy: standard）。"
  ⇒ **未取到"角色改用 marker 指定预设行事"的外部信号** ⇒ 按 brief 口径：**阳性对照只证明"不失败"**
```

**R-6 判定（按 brief 给定判据，逐字）**：主测"失败且错误含 mount/invalid 类字样" ⇒ **读侧有 `fs`（marker 被读到）**。上一轮"读侧 = memory store"的结论**在形状合法的 marker 下不成立**（§27 裁定 AC 已先记为"实验被形状校验混淆"，本轮为该记号的修正实验）。

### 2.9 起始/终态两次 `ls` + 善后（H）

```
$ kill <4600 PID 77011>; curl 4600 → 4600=000 ; curl 4599 → 4599=401 ; lsof 4600 listeners = 0
$ rm -rf ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/test-a
rm exit=0

$ ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/          # 终态（原文）
total 0
drwxr-xr-x   4 yuantian  staff  128 Sep 22 02:08 .
drwxr-xr-x@ 19 yuantian  staff  608 Sep 22 00:36 ..
drwxr-xr-x@  5 yuantian  staff  160 Sep 19 04:26 artifacts
drwxr-xr-x@  7 yuantian  staff  224 Sep 19 04:26 orchestra

test-a: NO (deleted)
E2O 未动：orchestra/{archive Sep19 13:42, charter Sep19 15:32, reports Sep19 15:18, state Sep22 00:36, tasks Sep19 13:36}
          artifacts/{2048 Sep18 17:11, snake Sep18 14:41, wordle Sep19 14:32}
```

### 2.10 日志封存（复制 + sha256；停实例后原文件哈希已复核）

```
$ shasum -a 256 /tmp/d2a-r4/sealed/*.zstd
441a653f82d014e643650bcf1b8abd17fb63bef79e5fc58807df472453d71cc4  driver.zstd          （R-6 之前的驱动日志）
0d813aa193c6d88016fbea4002f566fddecf9061389451e1af6799b22b5db9af  role-final.zstd      （角色日志，终态）
d6457ef88755c230ded4991ef80b892467d691f9979e619c3c33a182ea2fada6  role-turn1-2.zstd    （角色日志，§2.5 证据时点）
0f5a8a7a3b429ac14059334bcce9bea404592f49b095b8aa946199583717ab64  driver-final.zstd    （驱动日志，终态）

停实例后对盘复核：
role-final  0d813aa1…  == 封存值（未再追加）
driver      R-6 期间被宿主追加过 ⇒ 441a653f… → 0f5a8a7a…（**这正是"封存必须复制"的理由**，已补封终态）
停实例后 ③ 再跑一次：APPROVAL_OK … hanging 0 dangling 0   EXIT=0（最终读数）
```

---

## ③ 分层定位（名册层 / 挂载路径层 / 恢复路径层）

| 层 | 本轮实测 | 判定 |
|---|---|---|
| **名册层** | 角色预设 `orchestra-v04-reviewer-v1` ⇒ 记录 `compositionRowIds` **11 行**；角色实际用上 `grep/glob/read/bash/write/orchestra_report/a2a_reply`（工具名与 11 行集合一致） | **成立**（未独立重跑 `verify-role-presets-roster.mjs`，见④） |
| **挂载路径层（懒加载物化）** | `orchestra_create` 后 reviewer `reserved` → 首次派活物化 `active`；记录带 `pinnedApproval:"never"`；会话日志 `approval/policy@0 = {"policy":"never"}`（**仅一条**）；turn 1 正常收束 | **成立** |
| **恢复路径层（冷恢复 + 提权请求）** | 同一会话跨 3 次进程重启被反复冷恢复：`a2a_send` 返回 `resumed_inbox` ⇒ 走的是**恢复路径**；恢复后 `approval/policy` 仍**恰好一条 `never`**（幂等）；步骤 3 的 `asked`/`decided` 就发生在**恢复后的 turn 2** | **成立**；恢复路径上"提权不挂起 + 即时确定性拒绝"**首次在真实数据上兑现** |
| **恢复路径层（marker 读侧，R-6）** | 冷恢复时插件**读到了** marker 并按其 `presetPath` 发起 by-file mount（主测失败文本点名该路径）；文件存在时不失败；但角色**未**改用 marker 指定的预设行事 | **读侧有 fs（翻转上一轮结论）**；"消费后行为"半边**未取到** |

**诚实边界（`capability-boundaries.md`）**：本轮证的是"**在 `never` 钉死的路径上，真实提权请求会得到即时确定性结论、审批成对、回合不悬挂**"。**不保证**模型不会尝试提权（**#1**：实测第一次普通写入的工具结果里**确实**带 `[sandbox: escalation available …]`，模型正是被这句提示引导去提权的）；**不保证**"所有路径零悬挂"（首波不可达，见 §30/上一轮证据；D2-b 延后）。**#7** 仍然成立：第一次写入是被**沙箱模式**拒绝的，不是被审批策略拦下的。

---

## ④ 未做 · 未验证（如实列举）

| 项 | 状态 |
|---|---|
| **§4.8 D2-a 步骤 5**（把某路径改回 `ask` 重跑反例校准） | **未做**，且**按 §31 裁定 AJ 不再排进 live 轮**（需临时改产品码 + build/pack/sync/重启 = repair 的活）。**替代证据两条，均已复现**：④ `--self-test`（含内部干净基线 `APPROVAL_OK`）⇒ exit 1 + `dangling=detected`；上一轮那条**真实历史 `ask` 负对照** ⇒ exit 1 + `dangling 1` + 点名 `09ecc459-…`。 |
| **S4 steer 的真机实证** | **未触发**（本项只试一次，brief 明令不另造场景）。steer 的前提"回合关闭且未交回 driver"在真实角色上**本就不该频繁成立** —— 真要实证需专门造一个"空手收束"的角色回合，**登记为后续 live 项**。 |
| **R-6 的"marker 被消费后角色改用该预设行事"** | **未取到外部可核信号**：阳性对照成功，但角色自报身份仍是 Reviewer、header preset 未变。**只写"不失败"**，不写成"预设被切换"。 |
| **⑨ `test-tier0-predicate.mjs`** | **未做** —— §30 裁定 AI：批 1 **不可诚实判定**，延后（landing = 批 2 / G-P2）。 |
| **G-BUDGET** | **未做** —— 裁定 AI：延后（landing = P2-2 节点记录 + E2/E3 决策记录之后）。 |
| **D2-b（§4.8 六用例）** | **未做** —— 已随 E2/E3 移出批 1（landing = 批 2 / G-P2）。 |
| **D2-c 步骤 2**（节点记录 `approvalFacts[]`） | **未做** —— `orchestra/nodes/*` 是 P2-2 批 2 产物（§27 裁定 AA）。本轮 D2-c = 步骤 1（成对 + outcome 集合 + 回合闭合）+ 步骤 3（`--self-test` 删一条 `decided`）。 |
| **R-5（F-D1-5）** | **未做**（裁定 W：延后，landing = 批 2 或下次动 a2a）。**但本轮为它取到一条一线数据**：冷恢复时 by-file mount **会**按记录/标记里的 `presetPath` 无条件展开（见 §2.8 主测），与 F-D1-5 的符号描述一致 —— **归因与处置留 driver**。 |
| **独立名册探针** `verify-role-presets-roster.mjs` | **未重跑**（本轮硬前提是 pack+sync；名册层由 11 行 + 角色实际用上组合工具间接证实）。 |
| **首波路径** | **不可达**（§30 与上一轮已核：`grep -rn provisionGovernedPlans src/` 只有定义一处、产品调用点 0）。本轮未复跑该 grep。 |
| **工作区注册 / `attachSession` / 可见性** | **零动作**（§29 纪律）。 |
| **成本** | 实例存活 ≈ **9.4 分钟**（首启 `01:59:31`（space 文件 mtime）→ 终态 `02:08:52`（清理时刻），含 3 次重启；起停共 4 次）≤50；**模型回合 = driver 13（`turn/end` = 1..13）+ 角色 5（=1..5）= 18**，**超出 brief 的"约 15"**。超支来源如实登记：① 驱动自身对角色 R1 报告的反应回合（4–6）；② R-6 三步各需一次冷重启 ⇒ 3 次派发 + 3 个角色回合；③ 步骤 3 的派发与回报。**未做任何重复尝试**。 |

---

## ⑤ 下一跳建议（driver 定夺）

1. **D2-a 步骤 3 可判闭合**：真实提权请求 ⇒ 即时 `rejected` + 同 id 成对（同回合）+ 回合收束 + ③ 仍 `hanging 0 dangling 0`。批 1 的 live 遗留（§31 列的必做项）**已清零**。
2. **R-6 需要一次结论更正**：读侧**有 fs**。这条直接关系 **R-5 / F-D1-5**（"重激活替换分支按文件挂载"）—— 本轮已实测"冷恢复会按标记里的 `presetPath` 发起 by-file mount"。建议 driver 决定是否把 R-5 从"候选缺陷"升级，并给它一个**含真实预设文件**的对照配方（本轮阳性对照只能证不失败）。
3. **一条待解释的观察**（不夸大为缺陷）：marker 挂载成功、但角色**未**改用 marker 指定的预设行事（自报 Reviewer）。可能是 header 预设投影优先、或 marker 挂载只作用于别的作用域 —— **归因需读码 + 可判实验，属 analyzer 的活**。
4. **steer 若要实证**，需要一个"角色空手收束"的专门场景（本轮不造）；建议与 R-5 的活体实验合并成一趟，避免再单开一轮。
5. **批 1 交付报告**可据此把 G-P0 ③ 的"两条可达路径 + 真实提权成对"写成**已闭合**，并把 ④/⑨/G-BUDGET 三项显式延后逐条写入（裁定 AI）。

---

## 附 A｜通道（space 证据）

- **Ego lite**，TaskSpace **id=35**；证据文件 **`~/.ego-browser/state/space-35.json`**（**存在**，`-rw------- 335 B`，**mtime `Sep 22 01:59:31 2026`**）：
  `{"browserInstanceId":"browser-host:12340","spaceId":35,"usedLabels":["p1"],"initialized":true,"userControlPending":false,"pages":{"p1":{"targetId":"451CB607271845B7C559F111177F3229","openedBy":"agent"}}}`
- 实例 URL（首启 token）：`http://127.0.0.1:4600/?token=pr5i-34bkRngJDU8LNq1OIpgyPxLJonFt0aQCnn5VLc`（重启后 token 变化；实例已停）。页内 `page.fetch` 在重启后仍可用（同一 space 复用 p1，未换 space）。
- 实际通道 = **Ego lite + 页内 `page.fetch`**（`/api/session/create` · `/api/session/prompt` · `/api/session/page`）；**非 browser-use、非无头**。space 35 **未 finish**（沿用 §27/§30 已接受口径；Owner 口径"不需要 Owner 去看"）。

## 附 B｜痕迹登记

**新建（本轮）**
- `~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/test-a/`（`01:58` 建，`02:08` 删）。
- 会话（cwd=test-a）：driver `session-afefed65-b81a-426e-a192-577bbb5fb9c2`；角色 `orchestra-team-b14140b8-f952d90d-1cd1-44fa-8aa5-672df98ffd0e`（preset `orchestra-v04-reviewer-v1`）。
- 团队 `team-b14140b8`（active）：`orchestra/charter/records.json`、`orchestra/state/team.json`、`orchestra/reports/`（角色报告）、**人工写入的 R-6 marker** `orchestra/blueprints/orchestra-team-b14140b8-….json`（sha256 `14e6c4eb…`，**测试残留、非插件产物**）。
- **全部随 `test-a/` 一并删除**（§29 文件级善后）。
- 本地：`orchestra-dsh-0.5.1.tgz`（重建，sha256 `56e8ac68…`）；`/tmp/d2a-r4/`（驱动脚本 + `sealed/` 四份日志副本）；Ego TaskSpace id=35。
- 本报告 `docs/p0-report-live-leftovers.md`。

**改动**
- dev profile `node_modules/orchestra-dsh` 刷新为 HEAD 构建（等价性 `af224fe0…`；`dsh-trinity` 行与 bundles **未动**）。
- `~/.dsh/sessions/--Users-yuantian-…-orchestra_E2E-test-a--/` 新增 2 个会话目录（**保留**，判据原始载体）。
- 4600 起停共 **4 次**（jobs `bash-22`/`23`/`24`/`25`，全部已停）。

**删除**：`test-a/` 整目录（charter / state / reports / blueprints）。

**未动（已核）**
- `orchestra_E2E/orchestra/`（E2O）与 `orchestra_E2E/artifacts/`：`ls -la` 子项 mtime 全为 Sep 18/19（`state/` 仍是 `Sep 22 00:36` = 本轮之前）。**未注册工作区、未挂 `attachSession`、无可见性动作。**
- 4599（PID 14248）：起实例前 401、收工 401，**全程未碰**。
- 产品代码 / `src` / `lib`（重建产物与已提交状态一致）/ ADR / 计划 / 契约 / 台账：**零改动**（本轮只写本报告）。
- 上一轮（`e574cfbd`）与更早的会话日志：只读未动。

## 附 C｜完整命令清单（关键者）

```bash
# 硬前提
git status --porcelain ; git rev-parse HEAD
shasum -a 256 lib/orchestra.js ~/.dsh/profiles/dev/node_modules/orchestra-dsh/lib/orchestra.js
npm run typecheck ; npm run build ; npm test ; npm pack --cache /tmp/dsh-npm-cache
cd ~/.dsh/profiles/dev && rm -rf node_modules/orchestra-dsh && rm -f node_modules/.modules.yaml \
  node_modules/.pnpm-workspace-state-v1.json node_modules/.pnpm/lock.yaml && pnpm install
shasum -a 256 <profile>/lib/orchestra.js lib/orchestra.js ; diff <两者>
ls <profile>/node_modules/@deepseek-ai/ ; require.resolve("@deepseek-ai/dsh-tools",{paths:[…/lib]})

# 环境 / 实例 / 通道
ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/ ; mkdir -p …/orchestra_E2E/test-a
dsh --profile dev --port 4600 --no-open                     # 受管后台作业（起停 4 次）
ego-browser nodejs -e '… taskSpace(35) … page.goto(token URL) … page.fetch("/api/session/create"|"/api/session/prompt"|"/api/session/page") …'

# 判据
node scripts/verify-d2-approval.mjs --session <角色会话目录> --expect-policy never
node scripts/verify-d2-approval.mjs --self-test
node --input-type=module -e 'import { readStoredEvents } from "…/scripts/check-session-readable.mjs" …' <sessionDir>

# R-6 配方（每步之前重启一次以保证角色 cold）
node -e '…写 <test-a>/orchestra/blueprints/<roleSessionId>.json …'
node --input-type=module -e 'import { parseGovernedBlueprint } from "…/lib/session-blueprint.js" …'   # PARSE_VALID 自检
（驱动侧）a2a_send → 读回原样返回；基线 / 主测 / 阳性对照各一次

# 封存 / 善后
cp <两个 session.v3.jsonl.zstd> /tmp/d2a-r4/sealed/ ; shasum -a 256 <原件与副本>
kill <4600 PID> ; curl 4600 ; curl 4599 ; lsof -nP -iTCP:4600 -sTCP:LISTEN
rm -rf ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/test-a
ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/
```

---

**报告完毕，原样回 driver。** 产品代码零改动；未碰 4599；E2O 未动；4600 已停（`000`，无残留监听）；`test-a/` 已文件级清理并贴起始/终态 `ls`。本地 commit，未推送（等 Owner）。
