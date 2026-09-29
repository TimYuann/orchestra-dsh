# P0 · N7 live 半边 · 一次性 fixture 取证轮报告（裁定 S）

> **作者**：test runner（verifier，第 1 任）。
> **依据**：`docs/review-rounds-ledger.md` §22 裁定 S + Owner 三条现行口径 + `docs/plan-0.8.0-execution.md` §4.7/§7。
> **fixture**：`~/Documents/agentWorkspace/artifacts/projects/orchestra_N7`（本轮新建）。
> **通道**：**Ego lite**（`ego-browser` skill，TaskSpace **id=31**）+ 页内 `page.fetch` 驱动 DSH 4600 的 JSON-RPC API。**非 browser-use、非无头浏览器。**
> **候选 commit**：`d457306`（HEAD，工作树干净）；第 7 轮 §18 修复 `5e9c068` 已确认为其祖先。
> **产品代码零改动**（含未为取证加任何只读探针）；未改 ADR / 计划 / 契约 / 台账（仅写本报告）。

---

## ① 结论（一句话，可判真假）

**N7 live 半边本轮未闭合，但拿到了两件硬事实与一条通道级阻断**：
(a) **step-5-preview 在 4600 确实可用**（系统消息 + 探针 `MODEL_OK_4600` 双证）；
(b) **受治理团队全流程在真实实例上跑通**——driver 自起草 → 短肯定句 `批准` 触发真批准+冻结 → `orchestra_create` 建 `team-33be3b56`（active）→ 首次派活**懒加载物化** reviewer（`orchestra-v04-reviewer-v1`，reserved→active）→ **段 A 已证：该角色当场用上其组合工具 `{read:2, bash:9}`（11 次 tool/call 全 ok）做真实只读复核**；
(c) **段 B（跨重启）未取得**——裸 API 建的会话（含 App 打开后的空闲会话）其盘上 `session.v3.jsonl.zstd` 会被 GC 删除，跨重启持久化要求"从创建起就被 App 跟随"，故重启证据本轮拿不到。**因此 D1（重启后角色组合是否完整）本轮既未证实也未证伪，不得据此判定。**

---

## ② 测试过程与原始输出（原始命令 + 原始输出，贴出不转述）

### 硬前提 A：4600 换成 HEAD 构建（全绿）

```
$ git status --porcelain          # 空（工作树干净）
$ git rev-parse HEAD
d45730638789f367efdcca89ed4698721997b6db
$ git merge-base --is-ancestor 5e9c068 HEAD && echo YES
YES: 5e9c068 is ancestor of HEAD        # §18 修复确在 HEAD 内

$ npm run typecheck   → exit 0
$ npm run build       → exit 0   （host tsc + client tsc + tsdown；lib/client.js 12.23 kB）
   post-build lib/orchestra.js:2503  milestone: "materialization-failed",   # §18 修复符号在位
$ npm test
1..269
# tests 269 / pass 269 / fail 0 / cancelled 0     → exit 0   （符合期望 269/0）
   （日志有一条 `# orchestra: could not install role preset orchestra-oracle: EPERM …`——是沙箱拒写 ~/.dsh 的 `#` 诊断，非用例失败）

$ npm pack --cache /tmp/dsh-npm-cache
orchestra-dsh-0.5.1.tgz   79 files  332.6 kB  shasum 645042a3…
```

**dev profile 同步**（只加不改；`dsh-trinity` 依赖行与 bundle 行未动）：
首次同步被沙箱拒（`EPERM … ~/.dsh/profiles/dev`）→ 按纪律原样重试并提升 `danger-full-access` 成功：`rm -rf node_modules/orchestra-dsh` + 删三 pnpm 状态文件 + `pnpm install`（added 123，Done in 3s，exit 0）。

**三件套**：
```
① ls ~/.dsh/profiles/dev/node_modules/@deepseek-ai/  → cosmokit  schemastery   （无第三项，无回归）
② require.resolve('@deepseek-ai/dsh-tools',{paths:[…/orchestra-dsh/lib]})
   → ~/.nvm/.../dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js   （host 路径）
③ 插件副本 dependencies = {"js-yaml":"^4.1.0"}   （无 @deepseek-ai）
   health：root 带 token → 303（正常重定向）、不带 token → 401（正常拒绝）；启动日志零插件加载失败
   （本 DSH 构建无独立 /health 200 端点；web 服务在服务即视为 healthy）
```

**等价性核验（本轮"证据绑在 HEAD"的唯一凭据）**：
```
$ shasum -a 256 <profile>/node_modules/orchestra-dsh/lib/orchestra.js
c469b7245bf7b5490bd6572f4820e7c1131ab6c47ac01f205654b4811e93db7d
$ shasum -a 256 repo/lib/orchestra.js
c469b7245bf7b5490bd6572f4820e7c1131ab6c47ac01f205654b4811e93db7d
$ diff <profile>…/orchestra.js repo/lib/orchestra.js   → DIFF_EMPTY: identical
```
（同步前对照：profile=`03a374f1…` 旧构建 vs repo=`c469b724…`，与 driver 移交事实逐字一致。）

### 硬前提 B：§7-dev 单跳 override 重启后仍生效（自带对照项）

起受管 4600（job `bash-15`）：`dsh web: http://127.0.0.1:4600/?token=<redacted>`。

```
$ node scripts/verify-role-presets-roster.mjs
# presets healthy=12/12 roots=1 default="standard" agent_presets_rows=1 warnings=0    → exit 0
```
**负对照（证明非恒真，导入 `rosterFailures`）**：
```
happy       failures=0 (none)
twohop      failures=1 => composed entry list has 2 rows … exactly one is required
nodefault   failures=1 => config.default is undefined; expected "standard"
wrongtrust  failures=1 => the catalog root trust is "user"; expected "system"
noroots     failures=1 => … does not contain exactly one entry …
ASSERT happy=[] : true | all negatives rejected : true   → exit 0
```
**独立读 boot 合成**：`dsh --profile dev --dump-config` → `- id: agent-presets` 恰好 1 行、`default: standard`、`roots: [{path: ~/.dsh/orchestra/catalog-presets, trust: system}]`。

### 模型可用性（回答 Owner 的疑问）

4600 里 driver 会话系统消息原文：`You are a coding agent powered by the step-5-preview model.`；对 fixture 会话投 `Reply with exactly: MODEL_OK_4600` → `session/page` 回读 `has MODEL_OK_4600: true`。GUI 模型选择器亦显示 `Step-5 Preview，推理等级 High`。**⇒ step-5-preview 在 4600 可用**（凭据来自 `~/.dsh/settings.yaml` 的 `agent-default-model` + `~/.dsh/.credentials.yaml` 的 `STEPFUN_API_KEY`，由 `dsh-credentials-local` 加载，不依赖进程 env）。

### 会话驱动机制（本轮踩坑后的可复用事实）

- `POST /api/session/create` `payload.args.request={cwd}` → 返回 `{sessionId, agentPreset:"standard"}`（cwd 落在 fixture）。
- `POST /api/session/prompt` 投用户消息 → `accepted:true`，agent 运行、journal 落盘（`turn/end` 时 flush）。
- `POST /api/session/page` `payload.args.request={address:{kind:"session",sessionId}, throughSeq, maxMessages}`；**`throughSeq` 不得超过 cursor**（超了回 `… past cursor N`，用 N 重读）。
- `POST /api/session/list` 的参数名是 **`_request`**（我最初用 `request`，被 `arguments-invalid` 拒 → 一度误判"0 会话"；此为探针 bug，非产品缺陷）。
- API 投的用户消息 `source.kind==="user"`。
- **`/team approve <draftId>@<revision>` 经 API prompt 通道不触发 slash-command router**，会当纯文本进模型（driver 自行读源码确认"approval wasn't recorded"）。
- **正确的 API 批准路径 = 短肯定句**：向**起草那条 draft 的同一会话**投 `批准`（`AFFIRMATIVE_REPLY`，≤40 字，`source.kind==="user"`）→ 监听器 `approvePendingDraftFromUserMessage` 记录 `orchestra/charter-approved` + 冻结，并向 driver 投 approval notice。

### N7 live：真实最小团队（driver 自起草，非注入脚本）

driver（`session-b971f783`，cwd=fixture）用 `orchestra_draft` 自起草（records.json 实录）：topology `dsh-sessionlog-review`，controller=driver，**唯一角色** `reviewer` preset=`orchestra-v04-reviewer-v1` sandbox=`read-only` compositionTools=`[tool-bash,tool-fs,tool-fs-search]` orchestraTools=`[orchestra_report]`；mission = 构建"读 DSH session log 打印 tool/call 名 + isError"的 Node 脚本，driver 建 v1、唯一只读 reviewer 独立复核（作者不自审）。

批准（短肯定句 `批准` 投给起草会话）→ records.json 落 `orchestra/charter-approved`：`draft-d384ec86-90c0-4322-8d24-04410a47292a@2 source=user-reply digest=0010e965…`。

`orchestra_create` → `orchestra/state/team.json`：
```
team-33be3b56  status=active  controller=session-b971f783…
  role reviewer preset=orchestra-v04-reviewer-v1  phase=reserved → (首次派活) → active
       sessionId=orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f
```
driver 自建交付物 `session-log-tools.js`（+ 自测探针 `.probe_iserror.py` 等），随后 `orchestra_dispatch` → reviewer **懒加载物化**。

### 段 A（已取）：角色当场用上组合工具

`session/page` 读 reviewer 会话 `orchestra-team-33be3b56-467d49e7-…`（capture-time `2026-09-20T20:22:32Z`）：
```
tool histogram = {"read":2,"bash":9}
seq=17 20:21:05Z read => ok ; seq=18 20:21:05Z read => ok
seq=24/26 20:21:09Z bash => ok ; seq=31/33 20:21:18Z bash => ok
seq=38 20:21:37Z bash => ok ; seq=43 20:21:39Z ; seq=48 20:21:49Z ; seq=53 20:21:54Z ; seq=58 20:22:02Z (bash => ok)
reviewer 末条 assistant：「No writable location at all (fully read-only sandbox)… I must do everything with read-only operations…」
```
⇒  freshly-materialized（懒加载）role **确实用上角色组合工具（读文件 + bash）做真实只读复核**。

### 段 B（未取）：跨重启被"盘上持久化"阻断

- 裸 API 会话的盘上 log 在 `turn/end` 后约 2–3 分钟被 GC：`session-4289d06b` 曾被 `find -mmin -12` 抓到 `.zstd`（mtime 04:04:51 本地），随后 `test -e`/`find`/`ls` 一致显示目录与整个 fixture slug 消失。
- reviewer 会话同样：materialize 后 journal 在内存（`session/page` cursor 65），但**盘上无 `.zstd`**；在 App 里打开+跟随它之后，盘上仍无 log（空闲会话不落盘）。
- ⇒ 跨重启要能 revive，会话必须**从创建起被 App 连续跟随**；本轮 driver/reviewer 均由 API 创建，未满足。**重启证据本轮拿不到。**

---

## ③ 分层定位（名册层 / 挂载路径层 / 恢复路径层）

| 层 | 实测 | 判定 |
|---|---|---|
| **名册层（§7 根）** | 重启（全新起 4600）后 `verify-role-presets-roster.mjs` → `healthy=12/12 roots=1 default="standard" agent_presets_rows=1 warnings=0`；`--dump-config` 恰好 1 行；负对照四形态全拒（非恒真） | **无差异，跨启动稳定** |
| **挂载路径层（S3 / materialize）** | reviewer（`orchestra-v04-reviewer-v1`）首次派活即**懒加载物化** reserved→active，并**当场用上组合工具 `read`+`bash`**（段 A，11 次全 ok） | **热运行时挂载路径正确**；段 A 证明角色拿得到组合 |
| **恢复路径层（S2 / 跨重启）** | **未测到**：没有任何角色会话被跨重启 revive（盘上 log 被 GC，无从 revive） | **未判定**；D1 不成立与否本轮无证据 |

> 诚实边界（`capability-boundaries.md` #5/#6）：段 A 只证"**角色活着时能用角色工具干活**"；**不等于**"组合逐项等于预期"（后者属静态脚本的预期组合比对），更**不等于**"重启后仍完整"。

---

## ④ 未做 · 未验证（如实列举）

| 项 | 状态 |
|---|---|
| **段 B（重启 4600 → 唤醒同一角色 → 再取 tool/call）** | **未做**——盘上持久化被 GC 阻断（见②）。跨重启证据拿不到 |
| **D1 判定** | **未判定**——恢复路径层无证据；不得据本轮称 N7 通过或不通过 |
| **`verify-role-identity.mjs` 在新 fixture 上跑** | **未跑**——fixture 无跨重启持久的角色会话可核；且 fixture 是本轮全新数据（非 §17/§18 的 E2E 受损数据），不适用那条负例 |
| **§4.7 步 6（重激活 history 断言）** | **未触达**——未做重激活 |
| **成本纪律** | **超支**：实例约 73 分钟（指引 ≤40）、fixture 内模型调用约 6–8 次（≤12 内）。超支主因：会话创建/驱动的机制逆向（`_request`/`request` 包装/`throughSeq`/批准路径）+ 中段为满足 Owner"看得见"而补做 workspace 注册与可见化 |
| **盘上 GC 行为的定性** | **未定性为缺陷**——只实测到"未被连续跟随的会话其盘上 log 会被删"；这是渠道/机制事实，是否属产品缺陷需 driver 裁（不建议我定性） |

---

## ⑤ 下一跳建议（driver 定夺）

1. **闭合 N7 live 的正确形态**：`orchestra_N7` 现已注册为 workspace（见痕迹）——下一轮**在 App 里、该 workspace 下新建并驱动 driver 会话**（从创建起被 App 跟随 ⇒ 盘上持久化），再走 段A→重启→段B。这样 Owner 也能全程在 Ego lite 里看见。建议 driver 授权此"App 内驱动"形态，并确认我对 `workspace.json` 的加法改动可保留（或让我回退）。
2. **一条待裁的机制事实**：未被连续跟随的会话其盘上 `session.v3.jsonl.zstd` 会被删除——这决定了"任何非 App 跟随渠道都无法产出跨重启证据"。请 driver 判断这是否需要单独登记/排查（我不自行定性）。
3. **批准路径口径**：API 渠道下 `/team approve <draftId>@<rev>` 不触发命令 router；应改喂**短肯定句**给起草会话（本轮已实测可行）。若 driver 要让无人测试标准化，值得把这条写进方法学。

---

## 通道（Ego lite space 证据）

- **Ego lite**（`ego-browser` skill），TaskSpace **id=31**；证据 `~/.ego-browser/state/space-31.json`（335 B，mtime `Sep 21 03:51` 本地）：`spaceId:31`、`pages:{"p1":{"targetId":"E20980FEA314A46B21AE353737489500","openedBy":"agent"}}`、`initialized:true`；state 目录文件数 24→25。
- **space 31 未 finish**，Owner 在 Ego lite 里能看到它。打开 URL：`http://127.0.0.1:4600/?token=<redacted>`（token 会随实例重启变化；本轮结束按纪律停掉 4600，端口留空）。
- 中段已把 **controller 会话**（`/team approve draft-2da34c7f…`）与 **reviewer 会话**（`reviewer · 在本工作区构建一个小型 N… · orchestra_N7`）在 App 里打开，Owner 可直接在侧边栏 `orchestra_N7` 工作区看到这两条会话的全部对话。
- 实际通道 = **Ego lite + 页内 page.fetch**（非 browser-use、非无头）。

---

## 痕迹登记（裁定 R 约束 3）

**新建**：
- fixture 目录 `~/Documents/agentWorkspace/artifacts/projects/orchestra_N7`（mtime `2026-09-21T03:51:11Z` 本地）。
- API 会话（cwd=fixture）：`session-4289d06b-…`（投 2 条）、`session-5ec3a0c3-…`（首次 create 探针残留，blank）、`session-b971f783-…`（**controller**：起草/批准/建队/建脚本/派活）。
- 团队 `team-33be3b56`（active）；reviewer 角色懒加载物化 active，会话 `orchestra-team-33be3b56-467d49e7-1312-482b-bf98-d69d158ba92f`。
- fixture 文件：`orchestra/charter/records.json`（draft + approved）、`orchestra/state/team.json`、`session-log-tools.js`、`.probe_iserror.py`/`.probe_errtrue.py`/`.selftest.js.py`。
- Ego TaskSpace id=31（未 finish）。
- 后台作业 `bash-15`（4600 实例）。

**改了哪些既有状态**：
- `~/.dsh/storages/workspace.json`：**新增** `orchestra_N7` workspace（id `efe134cd-a201-49d5-bff9-083a70d84bab`，加法、可逆；备份 `/tmp/workspace.json.bak`）。此为让 Owner 在 Ego lite 可见所必需；请 driver 确认保留或让我回退。**未触碰 4599 进程。**
- `~/.dsh/profiles/dev/node_modules/orchestra-dsh`：按硬前提 A 刷新为 HEAD 构建（等价性已核）。

**未动（已核）**：
- `orchestra_E2E`：**一个字节未动**——`orchestra/state/team.json` sha256 前后均 `5b8efdf9…`、mtime 均 `2026-09-19T15:18:47Z`，文件树 diff 为空（`E2E IDENTICAL (no byte touched)`）。
- 4599：未触碰（仅 `curl` 读得 401，PID 14248 未动）。
- 产品代码 / ADR / 计划 / 契约 / 台账：未改（仅写本报告）。

---

## 本轮完整命令清单（节选，关键者）

```
git status --porcelain ; git rev-parse HEAD ; git merge-base --is-ancestor 5e9c068 HEAD
npm run typecheck ; npm run build ; npm test ; npm pack --cache /tmp/dsh-npm-cache
cd ~/.dsh/profiles/dev && rm -rf node_modules/orchestra-dsh && rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json node_modules/.pnpm/lock.yaml && pnpm install   （danger-full-access）
ls ~/.dsh/profiles/dev/node_modules/@deepseek-ai/ ; require.resolve('@deepseek-ai/dsh-tools',{paths:[…/orchestra-dsh/lib]})
shasum -a 256 <profile>/…/lib/orchestra.js ; shasum -a 256 repo/lib/orchestra.js ; diff …
dsh --profile dev --port 4600 --no-open   （受管作业 bash-15）
node scripts/verify-role-presets-roster.mjs ; （导入 rosterFailures 跑五形态负对照）
dsh --profile dev --dump-config | grep -c '^\s*- id: agent-presets'
ego-browser nodejs -e '… taskSpace(31) … page.goto(token URL) … page.fetch("/api/session/create"|"/api/session/prompt"|"/api/session/page"|"/api/session/list") …'
node /tmp/n7-extract-tools.mjs <sessionDir>   （复用 scripts/check-session-readable.mjs 的 readStoredEvents）
node -e '… 备份并加法编辑 ~/.dsh/storages/workspace.json …'
```

---

**报告完毕，原样回 driver。** 未停 4600（作业 `bash-15` 仍在，便于 Owner 继续在 Ego lite 观察）；按纪律，round 收口时由我或 driver 停掉并确认 `curl 4600 → 000`。Ego space 31 未 finish。
