# P0 · N7b live 轮报告（① 真绿 + D1 live 半边 + R-6 marker 读侧）

> **作者**：test runner（verifier，第 2 任）。
> **依据**：`docs/review-rounds-ledger.md` §26 live 轮前置 + 裁定 Z（集合比对）+ R-2（compositionRowIds）+ 分析 §4.1–4.3 / §8 R-6。
> **候选 commit**：`ffa23fc`（HEAD，工作树干净；第 13 轮 `1f8659c`/`2d362bc` 为其祖先）。
> **通道**：**Ego lite**（`ego-browser` skill，TaskSpace **id=33**）+ 页内 `page.fetch` 驱动 4600 的 JSON-RPC API。非 browser-use、非无头。
> **产品代码零改动**（未改 `src/`/`lib/`/脚本/契约/ADR/台账；仅写本报告）。未碰 4599。

---

## ① 结论（一句话，可判真假）

**三样全取到**：
(a) **G-P0 ① 真绿** —— 新 fixture `orchestra_N7b` 上 `verify-role-identity.mjs` **exit 0**，`IDENTITY_OK … rows=11 tools=11`，**无** `(no recorded composition to cross-check)` / `recorded composition is absent`；team.json 该角色 `blueprint.compositionRowIds` 长度 **11**（R-2 端到端证实，cross-check 真在比集合）。
(b) **D1 live 半边成立（正面）** —— 进程重启后，经**产品路径**（driver `orchestra_dispatch`）唤醒**同一**冷角色会话，重启时间戳之后该会话出现**成功**的组合工具 `tool/call`（`read`+`bash`，完成 R2 复核、verdict PASS），且实例日志**不出现** `was published without joining an agent preset` ⇒ 冷角色恢复后**带得回**角色组合。
(c) **R-6 = memory store** —— a2a 传输的 marker 读侧**不读磁盘 marker**：主测试（`presetSource:file` + **不存在**的 `presetPath`）`a2a_send` **成功**（若读侧有 fs，by-file 挂不存在路径必失败）；对照 ii（**真实** `presetPath` 指向另一预设）`a2a_send` 成功后角色仍以 **header 预设**（reviewer）行事，marker **未被消费**。与 §2.5 代码预测（a2a ctx 无 `fs` inject）一致。

---

## ② 测试过程与原始输出

### 硬前提：pack + sync 到 HEAD（全绿 + 等价性）

```
git status --porcelain                 # 空（干净）
git rev-parse HEAD → ffa23fc2be13d206450842fc46093a2f52364341
repo lib/orchestra.js      = 50c5d6b9125539d9…（HEAD）
dev profile lib/orchestra.js = c469b7245bf7b549…（旧，需换）

npm run typecheck → exit 0
npm run build      → exit 0（lib/orchestra.js 仍 50c5d6b9…，确定性）
npm test           → 1..272 / # tests 272 / pass 272 / fail 0 / cancelled 0   exit 0（符合期望）
npm pack --cache /tmp/dsh-npm-cache → orchestra-dsh-0.5.1.tgz  79 files  333.9 kB  shasum 99772580…

dev profile 同步（只加不改；dsh-trinity 行未动；本会话 policy=danger-full-access，无需 escalation）：
  dependencies = {"dsh-trinity":"file:…dsh-trinity-2.3.0-rc.2+handler-fix.tgz","orchestra-dsh":"file:…orchestra-dsh-0.5.1.tgz"}
  rm -rf node_modules/orchestra-dsh + 删三 pnpm 状态文件 + pnpm install（added 123，Done in 1.7s，exit 0）

三件套：
① ls @deepseek-ai/ → cosmokit  schemastery（仅此二，无回归）
② require.resolve('@deepseek-ai/dsh-tools',{paths:[…/orchestra-dsh/lib]}) → …/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js（host）
③ 插件副本 dependencies = {"js-yaml":"^4.1.0"}（无 @deepseek-ai）；health：root 带 token→303 / 不带→401
R-2 修复在位：grep -c compositionRowIds lib/orchestra.js → 7

等价性核验（"证据绑 HEAD"唯一凭据）：
  shasum -a 256 <profile>/…/lib/orchestra.js = 50c5d6b9125539d9db2e4fba967c0286227779da1f40794c4508585cfe9c6f20
  shasum -a 256 repo/lib/orchestra.js         = 50c5d6b9125539d9db2e4fba967c0286227779da1f40794c4508585cfe9c6f20
  diff → 空（identical）
```

### fixture + 实例 + 通道

- fixture `~/Documents/agentWorkspace/artifacts/projects/orchestra_N7b` 新建（mtime `2026-09-21T19:27:46Z` 本地）。
- 4600 起为受管后台作业（job `bash-16`）；Ego lite **新 space id=33**，开于 `2026-09-21T11:30:38Z` UTC；证据 `~/.ego-browser/state/space-33.json`（`spaceId:33`、`pages:{"p1":{"targetId":"95870FBAA5301C917D5EE5DBD2DC1276","openedBy":"agent"}}`、`initialized:true`）。**未 finish。**

### 建队（driver 自起草；短肯定句批准）

- driver 会话 `session-5364d7f8-1ee8-417f-b9fb-efd62cdc9c73`（cwd=N7b）自起草 topology `session-log-scan-duo`：controller=driver，**唯一角色** `reviewer` preset=`orchestra-v04-reviewer-v1` sandbox=`read-only`；mission = 构建 `scan-tool-calls.mjs`（读 DSH session log 打印 tool/call 数 + error 数），driver 建 v1、唯一只读 reviewer 独立复核（作者不自审）。
- draft `draft-58c942de-54bb-44f3-8015-b76a4e5c850a@1`；短肯定句 `批准` 投给起草会话 → records.json 落 `orchestra/charter-approved`（source=user-reply，digest `add2ee30…`）。
- `orchestra_create` → `team-e310ff28`（active，controller=session-5364d7f8）；reviewer **reserved** → 首次派活 → **active**（懒加载物化）。
- **team.json 该角色 blueprint（R-2 端到端证据）**：
  ```
  compositionRowIds = ["persona","agent-instructions","tool-fs","tool-fs-search","tool-bash","skill-filesystem","tool-skill","compaction","compaction-basic","command-compact","tool-result-pruner"]
  compositionRowIds length: 11
  ```

### ① G-P0 ①（物化后，期望真绿）

```
$ node scripts/verify-role-identity.mjs --repo <N7b> --team <N7b>/orchestra/state/team.json
IDENTITY_OK    reviewer orchestra-team-e310ff28-640ef76f-fda0-4c01-b0e4-6c98a322a256 preset=orchestra-v04-reviewer-v1 rows=11 tools=11
# roles 1 ok 1 missing 0
VERIFY_EXIT=0
```
无 `(no recorded composition to cross-check)`、无 `recorded composition is absent` ⇒ cross-check 真在比集合（R-2 落地）。

### 段 A（重启前，正对照）

reviewer 会话盘上日志（`readStoredEvents` 解）`…/orchestra_N7b--/orchestra-team-e310ff28-640ef76f-…/session.v3.jsonl.zstd`：
```
header.agentPreset=orchestra-v04-reviewer-v1  cwd=<N7b>  events=88  turnEnd=true
tool histogram = {"bash":11,"read":2,"orchestra_report":1,"a2a_reply":1}
15 tool/call 全 ok（11:51:00–11:56:01Z）：read×2、bash×11、orchestra_report（R1 落 review-scan-tool-calls-R1.md）、a2a_reply（verdict）
R1 VERDICT: PASS（含 Finding N1：callId fallback 路径）
```
⇒ 懒加载物化的角色当场用上组合工具完成真实独立复核。

### 重启 + 段 B（D1 live 半边）

- **pre-restart**：`2026-09-21T11:59:38Z` / `19:59:38+0800`；停 4600（job kill + kill PID）→ `curl 4600 → 000`，4599 未动（401）。
- 段 A 封存：reviewer log sha256 `38da3c51…`（139826 B）；driver log `90c29e71…`。
- **post-restart**：job `bash-17`，`2026-09-21T12:01:36Z`；`curl 4600 → 303`；重启后 baseline：实例日志 `was published without joining an agent preset` = **0**。
- 唤醒 driver（`session-5364d7f8`，`12:03:08Z`）真实下一步：「按 reviewer 的 N1 意见改一版，再请它复核」→ driver `orchestra_activate` + `edit:7`（修 N1）+ `orchestra_dispatch`（R2）。
- **段 B 判据 ①**：reviewer **同一会话**在重启时间戳（12:01:36Z）之后：
  ```
  POST-RESTART tool histogram = {"read":2,"bash":3}  → R2 期间累计 10 次 tool/call，全 ok（12:06:03–…）
  R2 VERDICT: PASS（N1 closed，report review-scan-tool-calls-R2.md，loop closed）
  ```
- **段 B 判据 ②**：实例日志 `was published without joining an agent preset` = **0**（主通道+对照全程）。
- 段 B 封存：reviewer log sha256 `9071a876…`（201742 B，mtime `20:08:10Z`）→ `/tmp/n7b-segB-reviewer.zstd`；driver log `4a88b9ea…`。

### R-6（marker 读侧；段 B 封存后做）

写 marker `<N7b>/orchestra/blueprints/orchestra-team-e310ff28-640ef76f-….json`。

- **主测试**：`agentPreset=orchestra-v04-implementer-v1`（≠ header 的 reviewer）、`presetSource:"file"`、`presetPath` = **不存在**路径。对该角色 `a2a_send`：
  ```
  a2a_send RESULT: message 2aa1f509-… accepted for orchestra-team-e310ff28-… (resumed_inbox); no answer awaited
  实例日志 host warning = 0；无 mount / preset 错误
  ```
  ⇒ 冷恢复**未读** marker（否则 by-file 挂不存在路径会令投递失败）。
- **对照 (i) 基线**：段 B 的 `orchestra_dispatch`（无 marker）成功唤醒角色 ⇒ 无 marker 投递成功。
- **对照 (ii)**：marker 改 `presetPath` = **真实** `orchestra-v04-implementer-v1/agent.cordis.yml`（存在）。`a2a_send` 成功（`resumed_inbox`），host warning=0；角色随后以 **reviewer**（header 预设）回「mission remains closed (R2 PASS)… standing by for future dispatch」——**未**变成 implementer。
  ⇒ marker 即便路径真实也**不被消费**。

⇒ **a2a marker 读侧 = memory store**（与 §2.5 一致：`src/a2a.ts` 的 `inject` 无 `"fs"` ⇒ `resolveRecordFileSystem` 返回 undefined）。

---

## ③ 分层定位（名册层 / 挂载路径层 / 恢复路径层）

| 层 | 实测 | 判定 |
|---|---|---|
| **名册层（§7 根）** | ① 的 `rows=11 tools=11` 证明预设经名册解析出 11 行；角色物化后用上组合工具证明名册 by-id 挂载成功。（本轮硬前提是 pack+sync，**未重跑**独立 `verify-role-presets-roster.mjs`；名册层由 ① + 物化间接证实） | **成立**（live）；独立名册探针本轮未重跑（见④） |
| **挂载路径层（materialize）** | reviewer 首次派活懒加载物化 reserved→active，段 A 立刻用上 `read`+`bash`+`orchestra_report`+`a2a_reply` | **热运行时挂载路径正确** |
| **恢复路径层（跨重启）** | 重启后经产品路径 `orchestra_dispatch` 唤醒**同一**冷角色会话，重启时间戳后成功 `tool/call`（read+bash，R2 PASS），且实例日志无 `was published without joining an agent preset` | **带得回组合（正面）**；恢复走的是 **header 预设投影**（R-6 证明非 marker） |

> 诚实边界（`capability-boundaries.md` #5/#6）：段 B 只证"**恢复后角色仍能使用角色工具完成工作**"；**不等于**"组合逐项等于预期"（后者由静态脚本 cross-check 覆盖，即 ① 的 `rows=11` 集合比对）。两者合起来才是 D1 的完整证据，本轮**两项都拿到**。

---

## ④ 未做 · 未验证（如实）

| 项 | 状态 |
|---|---|
| **独立名册探针** `verify-role-presets-roster.mjs` | **本轮未重跑**（本轮硬前提是 pack+sync，非名册根；名册层由 ① `rows=11` + 角色物化间接证实）。上轮（round-10）已 12/12 + 负对照非恒真 |
| **① 在最终 team.json 上** | 收尾时 driver 已 **closure + archive** 团队，故重跑 ① 得 `no roles[]` exit 2——这是**归档后的正确形态**；① 的绿是**物化时**（11:53Z）捕获的 exit 0 |
| **D1 ③ 三路径一致性 / R-7** | **未做**（依赖 D2 给懒加载/重激活补 blueprint；本轮只经懒加载路径） |
| **F-D1-5（activate 替换分支按文件挂载）** | **未做**（R-5 已由 driver 裁为延后；本轮未触发重激活替换） |
| **S4 / D2 / D3 / 裁定 Q / G-BUDGET** | **未做**（本轮不做清单） |
| **成本** | 实例跨 4 个 stint（`bash-16`/`17`/`18` + 一个 `&` 孤儿）累计约 **55 分钟**（贴 ≤60 上沿）；fixture 内模型调用约 **10–12 次**（≤15 内）。超支原因：段 B 与 R-6 各需一次重启以保证角色 **cold**（marker 只在冷恢复被读），共 3 次重启 |
| **R-6 读侧** | **已判定为 memory store**；但这是 a2a 传输的 marker 读侧，**不代表** governed setup 的写侧（写侧由分析轮归因 + 控制项证明是通的） |

---

## ⑤ 下一跳建议（driver 定夺）

1. **D1 可判**：本轮 ①（记录侧带行 id、cross-check 集合比对真绿）+ 段 B（恢复侧重启后组合带得回、无宿主 warning）**两面都拿到** ⇒ driver 可对 D1 的 live 半边作判定；静态半边由 ① 覆盖。
2. **R-6 收敛 §2.5**：a2a marker 读侧 = **memory store** ⇒ 冷恢复永远走 **header 预设投影**（这正是段 B 组合带得回的真正机制）。建议写进 `docs/dsh-native-capabilities.md` 或分析结论，并据此判断"marker 读侧"是否需要单独修（它当前对恢复无贡献，但因写侧从未被可达路径调用，暂非发布阻断）。
3. **D1 ③ / R-7**：依赖 D2 给三路径补 blueprint 后再判；`test-role-blueprint-single-prepare.mjs` 的 tripwire 会提示那一刻。
4. **建议**：把"API prompt 通道不触发 slash 命令、批准用短肯定句"与"marker 只在冷恢复读、当前为 memory store"两条固进方法学/能力对照。

---

## 通道（Ego lite space 证据）

- **Ego lite**（`ego-browser` skill），TaskSpace **id=33**；证据 `~/.ego-browser/state/space-33.json`（`spaceId:33`、`pages:{"p1":{"targetId":"95870FBAA5301C917D5EE5DBD2DC1276","openedBy":"agent"}}`、`initialized:true`、`userControlPending:false`）。**space 33 未 finish**，Owner 在 Ego lite 里能看到它。打开 URL：`http://127.0.0.1:4600/?token=<启动日志 token>`（本轮结束已停 4600，端口 000；token 随实例重启变化）。
- 实际通道 = **Ego lite + 页内 page.fetch**（非 browser-use、非无头）。

---

## 痕迹登记

**新建**：
- fixture `~/Documents/agentWorkspace/artifacts/projects/orchestra_N7b`（mtime `2026-09-21T19:27:46Z`）。
- 会话（cwd=N7b）：driver `session-5364d7f8-…`、reviewer `orchestra-team-e310ff28-640ef76f-…`。
- 团队 `team-e310ff28`（active → 收尾 closure + archive）；R1/R2 报告 `orchestra/reports/review-scan-tool-calls-R{1,2}.md`；交付物 `scan-tool-calls.mjs` + `README.md` + `fixtures/`（4 个合成 session）；`orchestra/archive/` 两份快照 + `closure.md`。
- R-6 marker：`orchestra/blueprints/orchestra-team-e310ff28-640ef76f-….json`（**测试人工写入**，先用不存在路径、后改真实路径；sha 最终 `75e3e5e1…` 前的中间态 `6baa8b9d…`）。
- Ego TaskSpace id=33（未 finish）；4600 受管作业 `bash-16/17/18` + 一个 `&` 孤儿（PID 23969，已杀）。

**改动/落盘**：dev profile 刷新为 HEAD 构建（等价性已核 `50c5d6b9…`）；本报告 `docs/p0-report-n7b-live-round.md`。

**未动（已核，前后 sha 一致）**：
- `orchestra_E2E/orchestra/state/team.json` = `5b8efdf9…`（前==后）。
- `orchestra_N7/orchestra/state/team.json` = `cad1b5a7…`（前==后）。
- `~/.dsh/storages/workspace.json` = 8 workspaces，无 N7b/N7（本轮未改）。
- 4599 未碰（401，PID 14248）；产品代码 / ADR / 计划 / 契约 / 台账未改。

**4600 已停**：`curl 4600 → 000`，无 4600 进程；4599 仍在（401）。

---

## 本轮完整命令清单（关键者）

```
git status --porcelain ; git rev-parse HEAD ; shasum lib/orchestra.js ~/.dsh/profiles/dev/node_modules/orchestra-dsh/lib/orchestra.js
npm run typecheck ; npm run build ; npm test ; npm pack --cache /tmp/dsh-npm-cache
cd ~/.dsh/profiles/dev && rm -rf node_modules/orchestra-dsh && rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json node_modules/.pnpm/lock.yaml && pnpm install
ls ~/.dsh/profiles/dev/node_modules/@deepseek-ai/ ; require.resolve('@deepseek-ai/dsh-tools',{paths:[…/orchestra-dsh/lib]}) ; shasum + diff 等价性
dsh --profile dev --port 4600 --no-open   （受管作业 bash-16/17/18）
ego-browser nodejs -e '… taskSpace(33) … page.goto(token URL) … page.fetch("/api/session/create"|"/api/session/prompt"|"/api/session/page") …'
node scripts/verify-role-identity.mjs --repo <N7b> --team <N7b>/orchestra/state/team.json
node --input-type=module -e 'import { readStoredEvents } …' <sessionDir>   （解盘上日志取 tool/call）
写/改 R-6 marker（node fs.writeFileSync <N7b>/orchestra/blueprints/<roleSessionId>.json）
（善后）job_kill bash-16/17/18 ; kill 23969 ; curl 4600→000 ; shasum 两个受保护 fixture 的 team.json
```

---

**报告完毕，原样回 driver。** 产品代码零改动；未碰 4599；两个受保护 fixture 未动；4600 已停、端口留空；Ego space 33 未 finish。
