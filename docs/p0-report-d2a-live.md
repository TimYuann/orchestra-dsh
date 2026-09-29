# P0 · D2-a live 轮（test runner 第 3 轮）：`approval: "never"` 钉死效应的真机取证

> **作者**：test runner（第 3 任，只执行 driver 设计的测试、只取证；不改代码、不自选路径）。
> **候选 commit**：`d88cd3fd127e853f84f2b490935ce2a2b8e512aa`（HEAD，`git status --porcelain` 空）。
> **依据**：`docs/plan-0.8.0-execution.md` §1 的 **D2 行** + **§4.8 D2-a / D2-c**；`docs/review-rounds-ledger.md` **§27（D1 live 通道事实）/ §28（S4+D2-a 复跑）/ §29（裁定 AF 测试文件夹纪律）**；`docs/p0-report-s4-d2a.md`（仪器用法）。
> **本轮唯一判据**：③ `verify-d2-approval.mjs --session <角色会话目录> --expect-policy never` ⇒ **exit 0 + `hanging 0 dangling 0`**；④ `--self-test` ⇒ **exit 1**。
> **锚点纪律**：全部用 **commit + 符号**（宿主行号已漂过，不引行号）。
> **未向 Owner 提问**；未改产品代码 / ADR / 计划 / 契约 / 台账。

---

## ① 结论（一句话，可判真假）

**两个结果都取到了**：③ 在**两条可达路径**（懒加载物化 + `orchestra_dismiss`→`orchestra_activate` 重激活）所落的**同一个**角色会话目录上 **exit 0**、汇总行 **`hanging 0 dangling 0`**；④ `--self-test` **exit 1**（校准检出 `dangling=detected`，且它自己的配对基线同时印 `APPROVAL_OK … hanging 0 dangling 0` ⇒ 仪器不是恒红）。**首波路径在产品里不可达**（只有定义、零产品调用点，附 grep 原文 + tripwire 用例）。

**同时如实登记一条与判据原文的偏差（不改判、原样带回）**：§4.8 D2-a **步骤 1** 的字面判据是「blueprint 记录的 `approval === "never"`」，**实测命中不了** —— `team.json` 里该角色的 `blueprint.approval = "ask"`；被钉成 `never` 的是**会话的有效策略**（会话日志 `approval/policy@0 = {"policy":"never"}`）。见 §2.6 与 §③ 的分层定位。

---

## ② 测试过程与原始输出（原始命令 + 原始输出，不转述）

### 2.1 硬前提：4600 换成当前 HEAD（全绿 + 等价性核验）

```
$ git status --porcelain            # （空）
$ git rev-parse HEAD
d88cd3fd127e853f84f2b490935ce2a2b8e512aa

$ shasum -a 256 lib/orchestra.js ~/.dsh/profiles/dev/node_modules/orchestra-dsh/lib/orchestra.js   # 换之前
4c41ef7f38a416526d926d98cf55e081fb4af10950743d80112beebd6268594d  lib/orchestra.js
50c5d6b9125539d9db2e4fba967c0286227779da1f40794c4508585cfe9c6f20  ~/.dsh/profiles/dev/…/lib/orchestra.js

$ npm run typecheck      → TYPECHECK_EXIT=0
$ npm run build          → BUILD_EXIT=0（tsdown：lib/client.js 12.23 kB）
$ npm test               → 1..279 / # tests 279 / # pass 279 / # fail 0 / # cancelled 0   TEST_EXIT=0

$ npm pack --cache /tmp/dsh-npm-cache
package size: 342.0 kB / total files: 79
shasum: 511e9abe2cbf21295c6bd7927f8c6ab1ce032c85
$ shasum -a 256 orchestra-dsh-0.5.1.tgz
6ae8dda102250b77d06c9bf8a3ae7aea2577f620f371b7fbd3df42c2a97fdb2b  orchestra-dsh-0.5.1.tgz

$ cd ~/.dsh/profiles/dev && rm -rf node_modules/orchestra-dsh && rm -f node_modules/.modules.yaml \
    node_modules/.pnpm-workspace-state-v1.json node_modules/.pnpm/lock.yaml && pnpm install
Progress: resolved 121, reused 120, downloaded 1, added 123, done
Done in 1.4s using pnpm v11.24.0
INSTALL_EXIT=0
```

**等价性核验（"证据绑 HEAD"的唯一凭据）**：

```
$ shasum -a 256 ~/.dsh/profiles/dev/node_modules/orchestra-dsh/lib/orchestra.js lib/orchestra.js
4c41ef7f38a416526d926d98cf55e081fb4af10950743d80112beebd6268594d  ~/.dsh/profiles/dev/node_modules/orchestra-dsh/lib/orchestra.js
4c41ef7f38a416526d926d98cf55e081fb4af10950743d80112beebd6268594d  lib/orchestra.js
$ diff <两者>                       → （空 = identical）
```

**三件套 + D2-a 符号在位**：

```
$ ls ~/.dsh/profiles/dev/node_modules/@deepseek-ai/
cosmokit
schemastery
$ node -e 'const {createRequire}=require("module");const r=createRequire("…/profiles/dev/node_modules/orchestra-dsh/lib/index.js");console.log(r.resolve("@deepseek-ai/dsh-tools"))'
~/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js   ← host
$ node -e 'console.log(JSON.stringify(require("…/orchestra-dsh/package.json").dependencies))'
{"js-yaml":"^4.1.0"}
$ grep -c "pinApprovalNever" …/orchestra-dsh/lib/session-blueprint.js    → 1
$ grep -c "compositionRowIds"  …/orchestra-dsh/lib/orchestra.js          → 7
$ node -e '…package.json…'   # dependencies + bundles
{"dsh-trinity":"file:…dsh-trinity-2.3.0-rc.2+handler-fix.tgz","orchestra-dsh":"file:…orchestra-dsh-0.5.1.tgz"}
bundles: ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-trinity","orchestra-dsh"]   ← 只加不改，未动 dsh-trinity
```

### 2.2 环境（A：起始态原文）+ 起实例 + 通道

```
$ ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/          # 起始态
total 0
drwxr-xr-x   4 yuantian  staff   128 Sep 18 14:40 .
drwxr-xr-x@ 19 yuantian  staff   608 Sep 22 00:36 ..
drwxr-xr-x   5 yuantian  staff   160 Sep 19 04:26 artifacts
drwxr-xr-x   7 yuantian  staff   224 Sep 19 04:26 orchestra
```

- 建 `test-a/`（`mkdir -p …/orchestra_E2E/test-a`，exit 0）。
- 起 4600 为**受管后台作业**（job `bash-20`）：`dsh --profile dev --port 4600 --no-open`
  → `dsh web: http://127.0.0.1:4600/?token=<redacted>`；`curl 4600 → 401`（无 token）。
- 通道 = **Ego lite**（`ego-browser` skill，TaskSpace **id=34**）+ 页内 `page.fetch`；**非 browser-use、非无头**。
- 端口基线：起实例前 `lsof 4599 → node PID 14248 (LISTEN)`、`curl 4599 → 401`、`curl 4600 → 000`。

### 2.3 建队（C：driver 自起草 → 短肯定句批准 → create → 首次派活懒加载物化）

```
$ POST /api/session/create  {request:{cwd:"…/orchestra_E2E/test-a"}}
{"ok":true,"value":{"sessionId":"session-02045f9d-6e43-4c2a-8238-e4a3be600ad6","agentPreset":"standard"}}

driver turn 1：orchestra_draft → draft-4a5a6617-64a7-4753-94c9-1295508af9b4@1；turn/end {"turn":1,"reason":{"kind":"completed"}}

（第一次批准失败 —— 归因于**我的输入**，不是产品：批准必须是**整条消息**且 ≤40 字。
 符号：`src/orchestra.ts` 的 `AFFIRMATIVE_REPLY` / `AFFIRMATIVE_MAX_LENGTH = 40` /
 `approvePendingDraftFromUserMessage` 的 `text.length > AFFIRMATIVE_MAX_LENGTH` 与 `AFFIRMATIVE_REPLY.test(text)`。
 原文：`Error: cannot create a team: approval_required: frozen charter draft-4a5a6617-…@1#2e219cf6… is missing or not durably approved and frozen`）

driver turn 3（投**裸**「批准」后）：
  orchestra_create {"frozenRef":"draft-4a5a6617-…@1#2e219cf6…"}
  orchestra_dispatch {"roleId":"reviewer","laneId":"probe-pin-approval-never","task":"读 /Users/yuan…"}
  turn/end {"turn":3,"reason":{"kind":"completed"}}
```

**物化结果（`test-a/orchestra/state/team.json`，路径② 懒加载后的记录）**：

```
teamId team-e574cfbd   status active   controllerSessionId session-02045f9d-6e43-4c2a-8238-e4a3be600ad6
ROLE {"id":"reviewer","phase":"active","sessionId":"orchestra-team-e574cfbd-3181d637-01dd-4e02-be65-5b5e4cbf8508",
      "sandbox":"read-only","history":0,"approval":"ask","rowIds":11}
```

```
$ ls ~/.dsh/sessions | grep -i "test-a"
--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_E2E-test-a--          ← slug 保留大小写（ls 核实，未凭猜）
$ ls -la <slug>/
orchestra-team-e574cfbd-3181d637-01dd-4e02-be65-5b5e4cbf8508
session-02045f9d-6e43-4c2a-8238-e4a3be600ad6
```

### 2.4 D（§4.8 D2-a 步骤 2）：注入"必然触发写入"的动作

派给只读角色的 mission 含"把结论追加写入 cwd 下的 `notes.md`"。角色**照做**并尝试写入（原始输出，取自会话日志 `readStoredEvents`）：

```
40 CALL  bash {"command":"printf '%s\\n' '## pinApprovalNever — 结论：是，把 approval 钉成 never' >> notes.md && echo \"APPEND_OK\" && tail -3 notes.md",
               "workdir":"…/orchestra_E2E/test-a"}
41 RESULT {"…":[{"type":"text","text":"[stderr]\nbash: notes.md: Operation not permitted\n[sandbox: file access denied under read-only mode]\n[sandbox: escalation available — retry this command once with sandbox_permissions…"}]}
```

⇒ **确定性拒绝**（不是"等待中"）；`notes.md` **确未生成**（`ls test-a/` 只有 `orchestra/`）。角色随后 `orchestra_report`（`orchestra/reports/review-pin-approval-never.md`，sha256 `cd44a1081db14fed…`）+ `a2a_reply` 回报 `verdict: PASS（断言本身）/ notes.md 写入: BLOCKED`，**未改写措辞重试**。

### 2.5 E（路径③ 重激活）：`orchestra_dismiss` → `orchestra_activate`

```
driver turn 7：orchestra_dismiss {"reason":"…"} → orchestra_dismiss {} → orchestra_activate → orchestra_team
turn/end {"turn":7,…}
```

```
$ ls -la test-a/orchestra/archive/
team-team-e574cfbd-1790009784936-f294be63-7d83-4215-a2cf-e1816eb796d8.json     ← 归档快照落地
$ node -e '…读 team.json…'
teamId team-e574cfbd   status active
ROLE {"id":"reviewer","phase":"active","sessionId":"orchestra-team-e574cfbd-3181d637-01dd-4e02-be65-5b5e4cbf8508",
      "sandbox":"read-only","history":0,"approval":"ask","rowIds":11}
sessionHistory(top) null
```

⇒ **重激活 resume 了同一个 sessionId**（`sessionHistory` 为空、无替换）。**resume 被观测到**（同一日志的新事件，原文）：

```
58 agent/inbox/spliced {"target":"next-step",…"Your team has been ARCHIVED (archive_id=team-team-e574cfbd-1790009784936-…, path=/User…"}
60 agent/inbox/spliced {"target":"next-turn",…"You are running on orchestra, as role \"Reviewer\".\nYour driver … is session session-02045f9d…"}
61 turn/start {"turn":2}
66 CALL  a2a_reply {…"[reviewer / team-e574cfbd] 收到 reactivation 通知 —— 这是激活消息，不是任务，因此我**不启动任何新工作**，在此待命。…"}
72 turn/end {"turn":2,"reason":{"kind":"completed"}}
```

### 2.6 F1｜③ 判据：`--session <角色会话目录> --expect-policy never` ⇒ exit 0

**两条可达路径落在同一个角色会话目录**（② 的 `turn 1` = seq 4–57；③ 的 resume = seq 58–72），故判据在该目录上跑：

```
$ node scripts/verify-d2-approval.mjs --session ~/.dsh/sessions/--Users-yuantian-…-orchestra_E2E-test-a--/orchestra-team-e574cfbd-3181d637-01dd-4e02-be65-5b5e4cbf8508 --expect-policy never
APPROVAL_OK    ~/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_E2E-test-a--/orchestra-team-e574cfbd-3181d637-01dd-4e02-be65-5b5e4cbf8508 hanging 0 dangling 0
# sessions 1 ok 1 missing 0 hanging 0 dangling 0 problems 0
EXIT=0
```

**该会话日志的事实（两条路径跑完后，最终态；`readStoredEvents` 原文）**：

```
role log: mtime=Sep 22 00:56:44 2026 size=96024
events=73  agentPreset=orchestra-v04-reviewer-v1
turn/end=2   approval/asked=0   approval/decided=0
approval/policy@0 {"policy":"never"}
toolCalls={"grep":2,"bash":2,"read":3,"orchestra_report":1,"a2a_reply":2}
```

⚠️ **诚实限定（重要）**：本轮 live 日志里 **`approval/asked` = 0**。角色的写入是被 **read-only 沙箱模式**拒绝的（`[sandbox: file access denied under read-only mode]`），模型**没有**发起带 `sandbox_permissions` 的提权，因此"`asked`/`decided` 成对"这条不变式**在真实新数据上未被喂到**（形式上真、实则空转）。承担该分支的是**两条对照**：④ `--self-test`（删掉一条 `decided` ⇒ 必须报 `dangling_approval`）与 F3 的真实 `ask` 负对照。

### 2.7 F1′｜blueprint 记录 `approval` 与有效策略的偏差（**登记，原样带回**）

```
$ node -e '…roles[0].blueprint…'
"permissionPreset": "workspace-write", "effectivePermissionPreset": "custom", "approval": "ask",   ← 记录
$ 会话日志：0 approval/policy {"policy":"never"}                                                    ← 有效策略
```

符号归因（读码，非猜测）：`src/session-blueprint.ts` 的 `approval: permissionSpec.approval`（blueprint 记录构造处），而 `permissionSpec` 来自 `permissions.resolve(permissionPreset)` ⇒ 该字段记的是**权限预设的声明值**（本部署 `workspace-write` → `ask`），**不是** `pinApprovalNever` 在 setup 期钉进会话的有效值。
⇒ §4.8 **D2-a 步骤 1** 的字面判据（"blueprint 记录的 `approval === "never"`"）**在当前实现下命不中**；命中的是"会话有效策略 = `never`"（③ 脚本正是查这一条）。**判定留给 driver**，本轮不改判、不动代码。

### 2.8 F2｜④ 校准：`--self-test` ⇒ exit 1

```
$ node scripts/verify-d2-approval.mjs --self-test
# self-test: baseline log /tmp/verify-d2-approval-mogbrc/session-calibration-paired
APPROVAL_OK    /tmp/verify-d2-approval-mogbrc/session-calibration-paired hanging 0 dangling 0
# self-test: perturbed log /tmp/verify-d2-approval-mogbrc/session-calibration-unpaired (one approval/decided removed)
          dangling_approval: ask-calibration for tool bash was asked at seq 5 in turn 1 and never decided
# self-test dangling=detected
EXIT=1
```

### 2.9 F3｜真实数据负对照（只读，未起实例）：仪器**该失败时会失败**

```
$ ls -d ~/.dsh/sessions/--Users-yuantian-…-orchestra_N7--/orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f
…/orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f
$ stat -f "%Sm  %z bytes" <上>/session.v3.jsonl.zstd
Sep 21 19:30:37 2026  103858 bytes

$ node scripts/verify-d2-approval.mjs --session <上> --expect-policy ask
APPROVAL_MISSING …/orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f hanging 0 dangling 1
          dangling_approval: 09ecc459-0155-476b-9910-5d64016869c7 for tool bash was asked at seq 64 in turn 1 and never decided
# sessions 1 ok 0 missing 1 hanging 0 dangling 1 problems 1
EXIT=1
```

⇒ **非 0 + `dangling 1` + 点名 `09ecc459-0155-476b-9910-5d64016869c7`**，与 brief 的预期逐字一致。

### 2.10 首波路径**在产品里不可达**（自己核一次，贴证据）

```
$ grep -rn "provisionGovernedPlans" src/ | grep -v "^src/orchestra.ts.*export"
（无输出；exit=1）

$ grep -rn "provisionGovernedPlans" src/
src/orchestra.ts:2665:export async function provisionGovernedPlans(
```

⇒ `src/` 内**只有定义行**，**零产品调用点**（调用点全在 `scripts/test-governed-provisioning.mjs`）。本仓 tripwire 用例同时钉住这一点：

```
$ node --test scripts/test-role-blueprint-single-prepare.mjs
ok 4 - S1b: criteria 1 and 3 are BLOCKED on D2 — two of the three paths build no blueprint at all
# tests 4 / # pass 4 / # fail 0
```

⇒ **可达路径 = 两条（懒加载、重激活）；首波 = 不可达**。未为凑"三条"而伪造首波路径。

### 2.11 日志封存（复制 + sha256；宿主会追加，原文件不可指望不动）

```
$ cp <slug>/orchestra-team-e574cfbd-…/session.v3.jsonl.zstd /tmp/d2a-live/sealed/role-e574cfbd.zstd
$ cp <slug>/session-02045f9d-…/session.v3.jsonl.zstd        /tmp/d2a-live/sealed/driver-02045f9d.zstd
$ shasum -a 256 /tmp/d2a-live/sealed/*.zstd <两个原文件>
055484b39c9a9fcb338ce0e18ba4555eaf7c40ca4fb096b87331703c725d9851  /tmp/d2a-live/sealed/driver-02045f9d.zstd
1be91b2d302964502e03cab11ad4ee5f98207bb7ee37650f6a316155e99889ed  /tmp/d2a-live/sealed/role-e574cfbd.zstd
1be91b2d302964502e03cab11ad4ee5f98207bb7ee37650f6a316155e99889ed  <原文件 role>          ← 副本 == 原件
055484b39c9a9fcb338ce0e18ba4555eaf7c40ca4fb096b87331703c725d9851  <原文件 driver>        ← 副本 == 原件
```

（清理后再核一次：两个原文件哈希**未变** ⇒ 封存时点 == 收工时点。）

### 2.12 善后（G）：停实例 + 文件级清理 + 起始/终态两次 `ls`

```
$ kill <4600 PID 26693>; curl -s -o /dev/null -w "4600=%{http_code}\n" http://127.0.0.1:4600/
4600=000
$ curl … 4599 → 4599=401          （4599 全程未碰，PID 14248 未变）
$ lsof -nP -iTCP:4600 -sTCP:LISTEN | wc -l → 0

$ rm -rf ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/test-a
rm exit=0

$ ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/          # 终态（原文）
total 0
drwxr-xr-x   4 yuantian  staff  128 Sep 22 00:58 .
drwxr-xr-x@ 19 yuantian  staff  608 Sep 22 00:36 ..
drwxr-xr-x@  5 yuantian  staff  160 Sep 19 04:26 artifacts
drwxr-xr-x@  7 yuantian  staff  224 Sep 19 04:26 orchestra

$ ls -d …/orchestra_E2E/test-a
ls: …/test-a: No such file or directory   (exit=1)

$ ls -la …/orchestra_E2E/orchestra/        # E2O 未动
archive(Sep 19 13:42) charter(Sep 19 15:32) reports(Sep 19 15:18) state(Sep 22 00:36) tasks(Sep 19 13:36)
```

⇒ **起始态 == 终态**（两个目录项不变，`test-a/` 已删除）。

---

## ③ 分层定位（名册层 / 挂载路径层 / 恢复路径层）

| 层 | 本轮实测 | 判定 |
|---|---|---|
| **名册层** | 角色预设 `orchestra-v04-reviewer-v1` 经名册解析出 **11 行**（`blueprint.compositionRowIds` 长度 11，逐项 `persona…tool-result-pruner`）；角色当场用上组合工具（`grep`×2 / `bash`×2 / `read`×3 / `orchestra_report` / `a2a_reply`×2）；日志 `header.agentPreset = orchestra-v04-reviewer-v1` | **成立**（本轮**未**独立重跑 `verify-role-presets-roster.mjs`，见④） |
| **挂载路径层（懒加载物化）** | `orchestra_create` 后角色 `phase=reserved` → **首次派活**物化为 `active`，`turn 1`（seq 5–57）跑完并 `turn/end{completed}`；**有效策略已钉 `never`**（`approval/policy@0`） | **成立**：钉死发生在建会话路径上，写入被**确定性拒绝**且回合正常收束 |
| **恢复路径层（重激活 resume）** | `orchestra_dismiss` 落归档快照 → `orchestra_activate` **resume 同一 sessionId**（`sessionHistory` 空、无替换）；日志 seq 58 归档通知 → seq 60 重激活通知 → `turn/start{turn:2}` → `turn/end{turn:2}`；`approval/policy` 仍**恰好一条 `never`**（幂等，未重复钉） | **成立**：跨归档/重激活的回合不悬挂、审批策略保持 |

**诚实边界（与 brief 口径一致）**：本轮证的是「**审批被钉死后，这两条路径上的回合不悬挂**」 —— **不等于**「所有路径零悬挂」（首波不可达，未测；D2-b 已延后），**也不等于**「审批成对这条不变式在真实新数据上被喂到了」（live 日志 `asked=0`，该分支由 ④ 与 F3 承担），**更不等于**「宿主不会提示可申请提权」（实测工具结果里**确实**带了 `[sandbox: escalation available …]` —— 正是 `capability-boundaries.md` **#1** 说的"不保证模型不会尝试"；另见 **#7**：写入是被**沙箱模式**拒绝的，不是被审批策略拦下的）。

---

## ④ 未做 · 未验证（如实列举）

| 项 | 状态 |
|---|---|
| **D2-a 步骤 5**（把某条路径改回 `ask` 再跑一次 ⇒ `turn/end` 不出现） | **未做**（brief 明令本轮不做：要改产品代码 + 重新打包，属 repair 的活）。其作用由 **④ `--self-test`**（exit 1 + `dangling=detected`）与 **F3 真实 `ask` 负对照**（exit 1 + `dangling 1` + 点名）承担，**两条都取到了**。 |
| **live 数据上的 `approval/asked`/`decided` 成对** | **未喂到**：两条路径的 live 日志 `asked=0`（写入被 read-only **沙箱模式**拒绝，模型未发起提权）。**不得**把这写成"成对已在真机验证"。 |
| **"带 `sandbox_permissions` 调 `bash`"这一支的活体注入** | **未做**：本轮按 brief 只注入**一次**写入动作（§4.8 D2-a 步骤 2 的另一支），且 brief 明令不许改写措辞重试。 |
| **首波路径** | **不可达（已核，附证据）**：`grep -rn "provisionGovernedPlans" src/` 只有定义行 `src/orchestra.ts:2665`；tripwire `test-role-blueprint-single-prepare.mjs` `ok 4`。**未伪造第三条路径。** |
| **§4.8 D2-c 步骤 2**（读节点记录留 `approvalFacts[]`） | **延后**（台账 §27 裁定 AA：`orchestra/nodes/*` 是批 2 产物）。本轮交 D2-c = 步骤 1（成对 + `outcome` 集合 + 回合闭合）与步骤 3（删一条 `decided` ⇒ 非 0），由 ③/④ 承载。 |
| **blueprint 记录 `approval === "never"`（D2-a 步骤 1 字面）** | **命不中（登记为发现）**：记录是 `ask`（= 权限预设声明值），有效策略才是 `never`。见 §2.7。 |
| **S4 的 steer 真机实证** | **未做**（brief 列为本轮不做，登记为后续 live 项）。 |
| **R-6 的修正实验** | **未做**（brief 列为非阻断、排后）。 |
| **独立名册探针** `verify-role-presets-roster.mjs` | **未重跑**（本轮硬前提是 pack+sync，非名册根；名册层由 11 行 + 角色实际用上组合工具间接证实）。 |
| **D3 / ⑨ / G-BUDGET / 裁定 Q / D2-b** | **未做**（brief 不做清单）。 |
| **工作区注册 / `attachSession` / 可见性** | **零动作**（§29 纪律）。 |
| **`~/.dsh/sessions/` 下本轮会话日志** | **保留未删**：它们是本报告判据的原始载体（§29 已确立该口径）。`test-a/` 已文件级删除。 |

---

## ⑤ 下一跳建议（driver 定夺）

1. **③ 与 ④ 均已命中期望码** ⇒ 按 brief 口径，本轮唯一结果已取到，可收工进判定。**但** §2.7 的偏差（记录 `approval` vs 有效策略）与 §2.6 的限定（live `asked=0`）**建议 driver 在判 ③ 时显式处置**：③ 的字面判据（脚本 exit 0 + `hanging 0 dangling 0`）成立；若要把 **D2-a 步骤 1** 也判绿，须先裁定 §2.7 是"记录层缺陷"还是"计划判据写法与实现语义不符"。
2. **一次把 `asked/decided` 喂到真机**的最小配方（非本轮范围，供 driver 排期）：派一个任务，**明确要求**角色"带 `sandbox_permissions: "workspace-write"` 重试一次写入"。在 `never` 钉死下，预期是一次**即时 `rejected`** + 成对的 `asked/decided` + 正常 `turn/end` —— 那才是 D2-a 步骤 3/4 的正面实证。
3. **`--self-test` 与真实负对照已各自非恒真**；若要把 F3 那条"真实悬挂日志"从盘上历史变成 durable 夹具，形态见 `docs/p0-report-s4-d2a.md` §④ 已登记的候选（自带合成日志 + `zstd`）。

---

## 附 A｜通道（space 证据）

- **Ego lite**，TaskSpace **id=34**；证据文件 **`~/.ego-browser/state/space-34.json`**（**存在**，`-rw------- 335 B`，**mtime `Sep 22 00:50:54 2026`**）：
  `{"browserInstanceId":"browser-host:12340","spaceId":34,"usedLabels":["p1"],"initialized":true,"userControlPending":false,"pages":{"p1":{"targetId":"A0FFDF1496E4152660F6AC8022166198","openedBy":"agent"}}}`
- 打开 URL：`http://127.0.0.1:4600/?token=<redacted>`（实例已停，token 随重启变化）。
- 实际通道 = **Ego lite + 页内 `page.fetch`**（`/api/session/create` · `/api/session/prompt` · `/api/session/page`）；**非 browser-use、非无头**。space 34 **未 finish**（沿用 §27 已接受的口径；Owner 口径明确"不需要 Owner 去看"）。

## 附 B｜痕迹登记

**新建（本轮）**
- `~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/test-a/`（`00:49` 建，`00:58` 删）。
- 会话（cwd=test-a）：driver `session-02045f9d-6e43-4c2a-8238-e4a3be600ad6`；角色 `orchestra-team-e574cfbd-3181d637-01dd-4e02-be65-5b5e4cbf8508`（preset `orchestra-v04-reviewer-v1`）。
- 团队 `team-e574cfbd`（active）：charter `records.json`（8735 B）、`state/team.json`（sha256 `be107ecac9c6a04f794454ecc3520ea3a283b66a2ae93f849f05558b9ab136ce`）、归档快照 `orchestra/archive/team-team-e574cfbd-1790009784936-….json`、角色报告 `orchestra/reports/review-pin-approval-never.md`（sha256 `cd44a1081db14fed…`）。
- **全部随 `test-a/` 一并删除**（文件级善后，§29）。
- 本地：`orchestra-dsh-0.5.1.tgz`（重建，sha256 `6ae8dda102250b77d06c9bf8a3ae7aea2577f620f371b7fbd3df42c2a97fdb2b`）；`/tmp/d2a-live/`（驱动脚本 + `sealed/` 两份日志副本）；Ego TaskSpace id=34。
- 本报告 `docs/p0-report-d2a-live.md`。

**改动**
- dev profile `node_modules/orchestra-dsh` 刷新为 HEAD 构建（等价性已核 `4c41ef7f…`；`dsh-trinity` 行与 bundles **未动**）。
- `~/.dsh/sessions/--Users-yuantian-…-orchestra_E2E-test-a--/` 下两个会话目录（**保留**，判据原始载体）。

**删除**
- `test-a/` 整目录（含 charter / state / archive / reports）。

**未动（已核）**
- `orchestra_E2E/orchestra/`（E2O）：`ls -la` 五个子项 mtime 全为 Sep 19，`state/` 仍为空（`Sep 22 00:36` = 本轮之前）。**未注册工作区、未挂 `attachSession`、无可见性动作。**
- 4599（PID 14248）：起实例前 `401`、收工时 `401`，**全程未碰**。
- 产品代码 / `src` / `lib` / ADR / 计划 / 契约 / 台账：**零改动**（本轮只写本报告）。
- `orchestra_N7` 的会话日志：只读（F3 负对照），哈希与 mtime 未变（`Sep 21 19:30:37` / 103858 B）。

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
dsh --profile dev --port 4600 --no-open            # 受管后台作业 bash-20
ego-browser nodejs -e '… taskSpace(34) … page.goto(token URL) … page.fetch("/api/session/create"|"/api/session/prompt"|"/api/session/page") …'

# 判据
node scripts/verify-d2-approval.mjs --session <test-a 角色会话目录> --expect-policy never
node scripts/verify-d2-approval.mjs --self-test
node scripts/verify-d2-approval.mjs --session <N7 reviewer 会话目录> --expect-policy ask
node --test scripts/test-role-blueprint-single-prepare.mjs
grep -rn "provisionGovernedPlans" src/ ; grep -rn "provisionGovernedPlans" src/ | grep -v "^src/orchestra.ts.*export"
node --input-type=module -e 'import { readStoredEvents } from "…/scripts/check-session-readable.mjs" …' <sessionDir>

# 封存 / 善后
cp <两个 session.v3.jsonl.zstd> /tmp/d2a-live/sealed/ ; shasum -a 256 <原件与副本>
kill <4600 PID> ; curl 4600 ; curl 4599 ; lsof -nP -iTCP:4600 -sTCP:LISTEN
rm -rf ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/test-a
ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/
```

**成本**：实例存活 `00:49 → 00:57`（约 **8 分钟**，≤40）；模型回合 = driver 7 个 turn + 角色 2 个 turn = **9**（≤12）；未做第二次注入、未改写措辞重试。

---

**报告完毕，原样回 driver。** 产品代码零改动；未碰 4599；E2O 未动；4600 已停（`000`）；`test-a/` 已文件级清理并贴起始/终态 `ls`。本地 commit，未推送（等 Owner）。
