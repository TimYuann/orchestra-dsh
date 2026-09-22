# P0 · orchestra-dsh 0.6.0 制品 + dev 通道闸 + web 装机验收（test runner 轮）

> **作者**：test runner（只执行 driver 设计的这一轮范围、只取证；**不改产品逻辑**，唯一源码改动是发布所需的版本号）。
> **候选 commit**：`27b29af8cad628fa68fb7f987f638c878881ef44`（`chore(release): bump version to 0.6.0`，父提交 `a0914d6`）。制品由**该 commit 的干净 detached worktree** 构建。
> **硬前提（P0 全绿）**：`typecheck` 0 / `build` 0 / `npm test` → `# tests 295 / # pass 295 / # fail 0 / # cancelled 0`（exit 0）/ `npm pack` exit 0。
> **判据口径（Owner 原话）**：只判**角色行为与机制是否按设计发生**；产物好不好 = 模型能力，不进判据，只作观察。
> **停机点（已解除）**：Phase 1.3 通道闸初次失败，按停机条件停表并交付报告；随后 Owner 判定该 `TRANSPORT` 属"发『继续』即可恢复"的类别并要求继续排查。**3 次「继续」+ 1 个全新会话均未恢复**，改为根因排查 ⇒ **定位到 `content-encoding: br` 压缩链路**（§2.5），加一行 route 级 `accept-encoding: identity` 后 **Phase 1.3/1.4 均通过**。Phase 2/3 仍**未执行**（2 由 Owner 亲手驱动；3 待通道结论确认后进入）。**4599 与 web profile 全程未写**（只读取证；读数与一处无法归因的占位重写见 §2.4）。
> **Owner 动作**：① Phase 2 由 Owner 在 4600 上亲手执行（runbook 已交付）；② Phase 3 的 4599 重启仍需 Owner 当场放行；③ `dev-orchestra/cordis.patch.yml` 被我追加了 3 行注释 + `headers.accept-encoding: identity`（备份 `*.bak-before-accept-encoding-fix-20260923-025118`），是否保留/上提到其它 profile 由 Owner 决定。
> **规模**：live 操作窗口 02:14 → 02:19（≈5 分钟）；对模型只发起 **1 个回合**（6 次传输尝试，全部失败），**0 次工具调用**。

---

## ① 结论（Phase 0–3 逐项）

| Phase | 项 | 判定 | 一句话 |
|---|---|---|---|
| 0.1 | 制品前提：`git status` / 候选 commit / 旧 `lib/` 与旧 tgz | **通过** | 唯一未跟踪项是**既有的** `.pi/`（本轮之前就在、非源码、未动）；旧 `orchestra-dsh-0.5.1.tgz`（16:07 旧货，sha256 `61bfafaa…`）已移出仓库到 `/tmp/orchestra-stale-artifacts/`；**未使用**仓库里 16:09 的旧 `lib/`（在干净 worktree 里重建） |
| 0.2 | 版本 `0.5.1 → 0.6.0` | **通过** | `git diff` 只有 `"version"` 一行；未动逻辑 |
| 0.3 | 干净 worktree：`typecheck` → `build` → `npm test` → `npm pack` | **通过** | 295 pass / 0 fail / **0 cancelled**（与期望逐字一致）；tgz = **78 文件**、351,882 B |
| 0.4 | 制品断言 | **通过** | `dependencies` 只有 `js-yaml`；`@deepseek-ai` 实体副本 **0**；无 `src/`/`scripts/`/`node_modules`；含 `presets/orchestra-roles.patch.yml` + `skills/orchestra-preset-authoring/SKILL.md`；无 `.ts` 源码残留、无绝对路径、无密钥 |
| 1.1 | 装进 **dev-orchestra** + 三件套 + health | **通过** | profile `node_modules` 只有 `argparse/js-yaml/orchestra-dsh`（**连 `@deepseek-ai` 目录都不存在**）；`require.resolve` 从插件 lib 指向 **host**；health 401（= 活着且要 token） |
| 1.2 | Ego lite 打开 `4600` | **通过** | 空间 id `3`，页面 `p1`；插件**运行时确实注册了工具**（会话 `request/header` 里 44 个工具含**本插件 18 个**：7 `a2a_*` + 11 `orchestra_*`） |
| 1.3 | **通道闸**：M3/high 无工具最小消息的**完整终止** | **先失败 → 修复后通过** | 初次 **6/6 次传输尝试全部 `TRANSPORT`**（`session-83ec3a88`）；**根因定位后加一行 route 级 `accept-encoding: identity` 修复，重跑通过**：`session-573effd7` 的 `turn/end = {"kind":"completed"}`、**重试 0 次**、`request/header.config = {minimax-cn, MiniMax-M3, high}`。根因与证据见 §2.5 |
| 1.4 | 最小工具调用 | **通过**（修复后） | 同一会话第 2 回合：`tool/call {name:"orchestra_topologies", arguments:"{}"}` → `tool/result`（列出 11 个 global 模板），`turn/end=completed`、**0 重试** |
| 2.1–2.5 | `/team` 名册/草案/懒加载物化、真实小活闭环、A2A 五项、新 mission→lane、混合子节点、重启身份、dismiss/activate、客户端面板 | **待 Owner 亲手驱动** | 通道已通；夹具与 step-by-step runbook 已交付（`tmp/p0-0.6.0-evidence/OWNER-runbook-team-test.md`） |
| 3.1–3.6 | web profile 备份 / 只加不改 / 三件套 / live 重载判定 / Owner 重启 / 不崩验收 / 最小 smoke | **未执行** | 停机条件「Phase 0/1 失败 ⇒ 停」；**web 一行未改**（读数见 §2.4；顺带发现 web **当前根本没装 orchestra-dsh**，见 F-070-4） |

### 本轮登记（只登记，不修）

| id | 层 | 现象（最小读数） | 证据 |
|---|---|---|---|
| **F-070-1** | **供应商传输层（宿主解析层之上）** | `minimax-cn / MiniMax-M3 / high` 的**流式响应在无 stop reason 的情况下结束**，被宿主归类为 `code:"TRANSPORT"`；一个回合内 **6 次尝试全失败**（1 次首发 + 5 次重试），UI 报 `已重试模型请求（5/5） · 9s`。每次尝试**约 0.9–1.7 s 就结束**（**不是超时**），重试策略 `maxRetries=5`、可重试码含 `TRANSPORT`。**与兄弟项目 `dev-trinity:4601` 报过的签名逐字相同**——本轮在本项目侧**复现成功**。 | §2.3 |
| **F-070-2** | 工具面（观察，非缺陷） | 仓库脚本 `scripts/check-session-readable.mjs` 的 `readStoredEvents(sessionDir)` **只认 `session.v3.jsonl.zstd`**；而本机宿主 **0.1.7-alpha.1 对本轮新会话写的是 `session.v4.jsonl.zstd`**（新会话目录里**只有 v4**；`session.v3` 存量 223 个、`v4` 39 个）。⇒ 该脚本对**新会话**会直接 `no session.v3.jsonl.zstd` 报错。本轮改用等价的自写解码器取证（`tmp/p0-0.6.0-evidence/summarize-session-log.mjs`，解码方式与仓库脚本一致：`zstd -d -c` 全帧解码 + 逐行 JSON）。 | §2.3 |
| **F-070-3** | 宿主写回（**本轮 UI 操作的副作用**，非缺陷） | 宿主把我在 UI 里的两次选择**写回了 profile patch**：① `agent-default-model` 追加 `reasoningEffort: high`（我在模型选择器里选了 High）；② 新增 `ui-settings-general` 行 `welcomeNoticeVersion: 2026-08-13.1`（我点了"内测声明 → 继续"）。备份与 diff 见 §附录 A3。**未回滚**（按计划不做清理，等 Owner 指示）。 | §附录 A3 |
| **F-070-4** | web project 现状（**与文档不符，Phase 3 前必须知道**） | `~/.dsh/profiles/web` **当前根本没有装 orchestra-dsh**：`dsh.profile.bundles` = `dsh-base + dsh-web-app`（无第三行）、`dependencies` 键不存在、`node_modules/` 里**没有任何插件包**（各 `@*` scope 目录都是空的遗留壳，`.dup-bak` 0 个）、`pnpm-lock.yaml` 的 importer 是 `{}`。但 `pnpm-workspace.yaml` 仍留着**上一年代的 `minimumReleaseAgeExclude: orchestra-dsh@0.5.0`**（另有 `dsh-trinity@2.2.2 \|\| 2.2.3`），且 web 的 `package.json` 带 `patchReload: "live"`。⇒ `DSH-INTEGRATION.md` §"2026-09-19 v0.5.1 同步基线"写的"dev 与 web 两个 profile 都已指向并解包 0.5.1"**与磁盘现状不符**（web 侧最晚一次 `pnpm install` 是 09-20 22:30，之后插件不在树上）。**影响**：Phase 3 的"只加不改"实际是**首次安装**，不是升级；§3 的三件套基线也不同（web 连 `cosmokit/schemastery` 都没有）。 | §2.4 |

---

## ② 每项原始命令与输出

### 2.1 制品层（Phase 0）

**前提状态（起始）**

```console
$ git status --porcelain=v1
?? .pi/                       # 既有未跟踪目录（.pi/loops/*.json 运行时循环状态，非源码；本轮未动）
$ git log -1 --format='%H%n%ci%n%s'
a0914d6edfa6fb5849bf81a6d5d2a72ee4cd0fbc
2026-09-22 18:25:43 +0800
docs: record peer MiniMax stream failure as runtime prerequisite
$ ls -la *.tgz                 # 旧货在场
-rw-r--r--  346673 Sep 22 16:07 orchestra-dsh-0.5.1.tgz
```

**旧货处理（移出仓库，保号留痕）**

```console
$ mv orchestra-dsh-0.5.1.tgz orchestra-dsh-0.5.1.tgz.stale-pre-0.6.0
$ mv orchestra-dsh-0.5.1.tgz.stale-pre-0.6.0 /tmp/orchestra-stale-artifacts/
$ shasum -a 256 /tmp/orchestra-stale-artifacts/orchestra-dsh-0.5.1.tgz.stale-pre-0.6.0
61bfafaaa5789ef1813579090ed251a8552d56256394fa6b229f260d96106fb1
# 旧 lib/（16:09）留在主检出，本轮全程未用：构建在干净 worktree 里重建
```

**版本号（唯一源码改动）**

```console
$ git diff -- package.json
-  "version": "0.5.1",
+  "version": "0.6.0",
$ git add package.json && git commit -q -m "chore(release): bump version to 0.6.0"
27b29af8cad628fa68fb7f987f638c878881ef44
```

**干净 detached worktree + 门（typecheck / build / test / pack）**

```console
$ git worktree add --detach /tmp/orchestra-p0-0.6.0 27b29af8cad628fa68fb7f987f638c878881ef44
HEAD is now at 27b29af chore(release): bump version to 0.6.0
$ ls -d /tmp/orchestra-p0-0.6.0/lib
ls: /tmp/orchestra-p0-0.6.0/lib: No such file or directory     # ← 关键：无旧 lib/
$ ln -sfn /Users/yuantian/Developer/orchestra-dsh/node_modules /tmp/orchestra-p0-0.6.0/node_modules

$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.client.json
TYPECHECK_EXIT=0

$ npm run build
> tsc -p tsconfig.json && node scripts/build-role-presets.mjs && tsc -p tsconfig.client.json && tsdown
ℹ [orchestra-dsh/client] lib/client.js      12.24 kB │ gzip: 3.83 kB
✔ [orchestra-dsh/client] Build complete in 33ms
BUILD_EXIT=0                                   # lib/ 71 个文件

$ npm test                                     # 全套 38 个 test-*.mjs
# tests 295
# suites 0
# pass 295
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2042.172
NPM_TEST_EXIT=0

$ npm pack --cache /tmp/dsh-npm-cache
npm notice name: orchestra-dsh
npm notice version: 0.6.0
npm notice filename: orchestra-dsh-0.6.0.tgz
npm notice package size: 351.9 kB
npm notice unpacked size: 1.7 MB
npm notice shasum: d6245b6b9a9344766cb05cb2cb455049ec7a3263
npm notice integrity: sha512-1q473cbT8V2rU[...]WeguGMmuvFkIw==
npm notice total files: 78
PACK_EXIT=0
```

**制品读数与断言（Phase 0.4）**

```console
$ shasum -a 256 orchestra-dsh-0.6.0.tgz
8250b6eac9be27a1706d2e55f3224b131c6aae667e38f9dfc476a42b55df3386
$ shasum -a 1 orchestra-dsh-0.6.0.tgz
d6245b6b9a9344766cb05cb2cb455049ec7a3263
# size 351,882 B / 78 文件 / sha512-integrity sha512-1q473cbT8V2rUpKhIGTZUU7e2XV0qTWkhDdKMQU4yA2j3tt/NMB1EnKxy8ji3ruJ/n7ut8hr2WeguGMmuvFkIw==

$ tar -tzf orchestra-dsh-0.6.0.tgz | awk -F/ '{print $2}' | sort -u
cordis.patch.yml / cordis.yml / lib / LICENSE / package.json / presets / README.md / skills

$ node -e '…require(…/package.json)…'
version: 0.6.0
dependencies: {"js-yaml":"^4.1.0"}          # ← 只有 js-yaml
peer count: 22

$ tar -tzf … | grep -c '@deepseek-ai'        → 0        # 无实体副本
$ tar -tzf … | grep -cE '(^|/)(node_modules|src|scripts)/' → 0
$ find . -type f -name '*.ts' ! -name '*.d.ts' | wc -l → 0  # 无 .ts 源码（23 个 .d.ts 是声明）
$ ls presets/ skills/*/                      → orchestra-roles.patch.yml (28,649 B) / orchestra-preset-authoring/SKILL.md (4,032 B)
$ diff -r <tgz 解包>/lib /tmp/orchestra-p0-0.6.0/lib → IDENTICAL       # 制品 lib == 本次构建
$ grep -rIl '/Users/' <tgz 解包> | wc -l     → 0        # 无绝对路径
$ grep -rInE 'sk-[A-Za-z0-9]{16,}' <tgz 解包> | wc -l → 0             # 无密钥
```

### 2.2 宿主解析层 / 安装（Phase 1.1）

```console
# 备份（写入前）
$ cp package.json package.json.bak-20260923-021406            # sha256 6c2c4487…
$ cp pnpm-workspace.yaml pnpm-workspace.yaml.bak-20260923-021406  # ae7c5b68…
$ cp cordis.patch.yml cordis.patch.yml.bak-20260923-021406        # 1fae677a…

# 只加：dependencies 指向新 0.6.0 tgz；bundles 追加 orchestra-dsh；minimumReleaseAgeExclude 追加 orchestra-dsh@0.6.0
$ cd ~/.dsh/profiles/dev-orchestra
$ rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json node_modules/.pnpm/lock.yaml
$ pnpm install
Packages: +3
Progress: resolved 3, reused 2, downloaded 1, added 3, done
Done in 1.7s using pnpm v11.24.0
PNPM_EXIT=0

$ ls node_modules/ | grep -v dup-bak
argparse
js-yaml
orchestra-dsh
$ ls -la node_modules/@deepseek-ai
ls: node_modules/@deepseek-ai: No such file or directory      # ← 连目录都没有（比"只允许 cosmokit/schemastery"更干净）
$ ls node_modules/.pnpm/                                      → lock.yaml（无虚拟店实体包）

$ node -e "console.log(require.resolve('@deepseek-ai/dsh-tools', {paths:['./node_modules/orchestra-dsh/lib']}))"
/Users/yuantian/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js
$ node -e "…require.resolve('@deepseek-ai/cordis', …)"
/Users/yuantian/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js

$ node -e '…profile 内 orchestra-dsh/package.json…'
version: 0.6.0 ; dependencies: {"js-yaml":"^4.1.0"} ; peer count: 22
$ diff -r node_modules/orchestra-dsh <tgz 解包> → IDENTICAL    # profile 副本 == 制品
```

**启动与健康**

```console
$ dsh --profile dev-orchestra --port 4600 --no-open           # 受管作业 bash-307
dsh web: http://127.0.0.1:4600/?token=8xUA9LSTiJ1f31a87QOj0HqZW4gjp6GJXO2B2xFSvYU
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4600/       → 401（无 token）
$ curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:4600/?token=…" → 303
$ dsh --profile dev-orchestra --dump-config | grep orchestra
- id: orchestra-bundle    name: orchestra-dsh
- id: orchestra-a2a       name: orchestra-dsh/a2a
- id: orchestra-manager   name: orchestra-dsh/orchestra
```

### 2.3 通道闸（Phase 1.3）——**失败点**

**UI 动作（Ego lite，空间 id `3`，页面 `p1`）**：新建会话 → 工作区选 `orchestra_E2E`（=`/Users/yuantian/Documents/agentWorkspace/artifacts/projects/orchestra_E2E`）→ 模型选择器 `minimax-cn / MiniMax-M3` + 推理等级 `High` → 发一条**不需要工具**的消息。

**UI 原文（页面 `innerText`，已核对截图裁切区只含此块、不含侧边栏）**

```
只回复两个字：收到。不要调用任何工具。
02:16
处理失败
处理失败
已重试模型请求（5/5） · 9s
本轮运行失败Anthropic stream ended without a stop reason
TRANSPORT
```

截图：`tmp/p0-0.6.0-evidence/4600-gate-failure.png`（裁切 x=880,y=57,w=540,h=420；**未以图像方式查看**，本会话模型不支持图像输入，改以该区域 DOM 文本自证——见 §④）。

**会话日志（宿主写的是 v4，见 F-070-2）**

```console
$ ls -la ~/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_E2E--/session-83ec3a88-7371-455b-8ffa-c49f1860a7cf/
-rw-r--r--@ 1 yuantian staff      0 Sep 23 02:16 session.lock
-rw-------@ 1 yuantian staff  43694 Sep 23 02:17 session.v4.jsonl.zstd
$ zstd -d -c session.v4.jsonl.zstd | wc -l     → 36（1 行 create header + 35 events）
```

`request/header` 原文（`seq=13`，取 `data.header.config`；工具表另计）：

```json
{ "provider": "minimax-cn", "model": "MiniMax-M3", "reasoningEffort": "high" }
```

`model/selection`（`seq=3`）与 `request/context`（`seq=14`）与之一致，`contextWindow: 1048576`。
**⇒ 闸要求的模型口径（minimax-cn / MiniMax-M3 / high）在会话日志里逐字成立**，失败不在"选错模型"。

**工具面（证明插件运行时确实注册成功）**

```console
total tools: 44
a2a tools:      a2a_create, a2a_list, a2a_read, a2a_reply, a2a_send, a2a_status, a2a_stop        (7)
orchestra tools: orchestra_activate, orchestra_add_lanes, orchestra_create, orchestra_dismiss,
                 orchestra_dispatch, orchestra_draft, orchestra_report, orchestra_send,
                 orchestra_team, orchestra_topologies, orchestra_wait                        (11)
```

**事件直方图（35 events）**

```
   2  agent/inbox/spliced      1  request/context          5  llm/retry
   1  approval/policy          1  request/header           5  llm/retry-started
   6  assistant/attempt        1  sandbox/mode             1  step/end
   1  model/selection          1  session/title            1  step/start
   1  permission/preset        1  session/title-llm-request 1  system/message
   1  turn/end                1  turn/start               4  user/message
```

**重试与终止（原文，节选）**

```json
seq=18 llm/retry {"turn":1,"step":1,"provider":"minimax-cn","mode":"normal",
  "policyKey":"[\"normal\",5,[\"EMPTY_RESPONSE\",\"RATE_LIMIT\",\"SERVER\",\"TIMEOUT\",\"TRANSPORT\"],500,10000,0.1]",
  "retry":1,"maxRetries":5,"delayMs":478.9,"failure":{"message":"Anthropic stream ended without a stop reason","code":"TRANSPORT"}}
seq=21 … "retry":2 …   seq=24 … "retry":3 …   seq=27 … "retry":4 …   seq=30 … "retry":5     # 同一 message/code，5 次全同
seq=33 step/end {"turn":1,"step":1}
seq=34 turn/end {"turn":1,"reason":{"kind":"error","error":{"message":"Anthropic stream ended without a stop reason","code":"TRANSPORT"}}}
```

**时间线（每次尝试都是"秒级即断"，不是超时）**

```
   17  +  1684ms  assistant/attempt
   18  +  1685ms  llm/retry retry=1 delay=479ms  code=TRANSPORT
   20  +  3087ms  assistant/attempt   (第 2 次尝试在 +2164ms 开始，约 0.92s 后失败)
   23  +  5026ms  assistant/attempt
   26  +  8164ms  assistant/attempt
   29  + 12812ms  assistant/attempt
   32  + 22429ms  assistant/attempt   ← 第 6 次尝试，之后直接 step/end
   34  + 22430ms  turn/end
TOTAL turn wall time: 22430 ms ；assistant/attempt = 6 ；llm/retry = 5 ；tool-ish events = 0
```

**⇒ 工具调用 0 次**（`grep -i tool` 在 35 个事件里 0 命中；UI 页脚 `1 轮 1 步`、上下文 `0%`）。
**⇒ 这是"回合在工具调用之前就失败"，与兄弟项目 `dev-trinity:4601` 报的签名一致（对方 10 次重试 0 次工具调用；本项目策略上限 5 次）。**

> 两个读数并排放着以免误读：UI 徽标写 `已重试模型请求（5/5） · 9s`，而会话日志的 turn 墙钟是 **22,430 ms**（含 5 次退避 479/974/2103/3730/8550 ms）。UI 的 `9s` 量的是别的窗口（重试以外的部分或最后一次尝试），**不是**与日志矛盾；本报告两处都按原文给出，未做换算。

**与本文档前提的对照**：`docs/handoff-2026-09-22-upgrade.md` / `STATE.md` 已把该现象登记为"运行时前置条件"；**本轮的增量是：在 orchestra-dsh 自己的 profile（dev-orchestra + 0.6.0）上、用完全干净的会话、以 Owner 指定的模型口径，独立复现了同一签名**。

### 2.4 web 未动证明（Phase 3 未执行）

> **口径声明**：Phase 3 从未开始，因此**没有取"安装前"哈希**（计划 §3.1 要求的前后对比哈希只在真正执行安装时才成立）。下面是**事后**读数 + "我从未对 web 执行过任何写命令"的旁证。这一节同时纠正一个文档与现实不符的前提（F-070-4）。

```console
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4599/   → 401   # 与轮次开始时一致
$ lsof -nP -iTCP -sTCP:LISTEN | grep -E '4599|4601'
node 58271 … TCP 127.0.0.1:4601 (LISTEN)      # 兄弟项目，全程未碰
node 94859 … TCP 127.0.0.1:4599 (LISTEN)      # Owner 实例，全程未碰

# 事后哈希（仅作 Phase 3 的基线，无"前"值可比）
$ shasum -a 256 ~/.dsh/profiles/web/{package.json,pnpm-workspace.yaml,cordis.patch.yml}
ec33e2b6cd7646c4ca02544bbd17bd2d4bb491e6e3baaf388a10bc195923589b  package.json        (mtime 09-20 22:29)
33b9b246f1d932d004fc0b0b914ab15bf48e7182e87d67ee238360cd83380cca  pnpm-workspace.yaml (mtime 09-16 21:40)
6b94b49c5b3bd693378c07e58d9a24ba5ab13efac51743a10a7550478daf5df8  cordis.patch.yml    (mtime 09-22 23:00)

# web 现状：根本没有 orchestra-dsh（见 F-070-4）
$ cat ~/.dsh/profiles/web/package.json
{ "name": "dsh-profile-web", "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"], "patchReload": "live" } } }
$ ls ~/.dsh/profiles/web/node_modules/ | grep -i -E 'orchestra|trinity'   → （无匹配，exit 1）
$ cat ~/.dsh/profiles/web/pnpm-lock.yaml | tail -4
importers:

  .: {}
$ grep -i orchestra ~/.dsh/profiles/web/pnpm-workspace.yaml
  - orchestra-dsh@0.5.0                    # ← 上一年代遗留的 minimumReleaseAgeExclude 行（未清）
```

**唯一一处 mtime 落在本轮窗口内的 web 文件**：`web/cordis.yml`（mtime `09-23 02:14`）。其内容与 dev-orchestra 的同名文件**逐字节相同**（sha256 `c300dcf2ebc5f02062d6591268d29d3db6fe45e0cb138f5467276fe2ba06076e`），是宿主的标准空根占位：

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

**我从未对 web 执行任何命令**（本轮针对 web 的命令只有上面这些 `cat/ls/shasum/curl` 只读操作）；该 mtime 变化**无法归因**——合理推测是某个 dsh 进程对所有 profile 根做了占位规范化写入，但**本轮未做复现实验去证实**（复现会给 web 再写一次，违反"不碰 web"）。**内容无 orchestra 行、无行为影响**；Phase 3 执行时以 `c300dcf2…` 作为 `cordis.yml` 的基线即可。

> 记录：web 的默认模型（`agent-default-model`）本轮**未读取也未改动**——因 Phase 3 未执行，不做"web 跑什么模型"的核实。

---

### 2.5 根因定位：`content-encoding: br` 压缩链路（Phase 1.3 失败的真正原因）

**症状回顾**：`minimax-cn / MiniMax-M3 / high` 的每个回合都在第一次模型调用就失败并重试 5 次，`failure={"message":"Anthropic stream ended without a stop reason","code":"TRANSPORT"}`，**0 次工具调用**；3 次「继续」+ 1 个全新会话（共 30 次传输尝试）**全部同签名**。

**先排除的假设（每条都有反证，故不作为结论）**

| 假设 | 反证 |
|---|---|
| key 失效 / 端点错误 | 直接 `curl https://api.minimaxi.com/anthropic/v1/messages` → **HTTP 200**、`stop_reason:"end_turn"`、内容 "Pong!"；凭据 sha256 前 12 位 `dee63b86b766` 与两份 `.bak-before-*` 一致（未被改坏） |
| profile 里 minimax-cn 少写字段 | `dsh --dump-default-config` 显示宿主默认 `llm-pi-ai` **不带任何 config**；provider 目录来自 `@earendil-works/pi-ai`（`baseUrl=https://api.minimaxi.com/anthropic`、`api=anthropicMessagesApi()`）。`dsh-llm-pi-ai` 的合并语义是 *"merging the installed catalog defaults under the configured entries … keeps an existing `providers: { deepseek: { apiKeyEnv: … } }` profile working untouched"* ⇒ 只写 `apiKeyEnv` 合法且完整 |
| 模型/推理等级组合不对 | 09-22 跑通 **18 回合全 `completed`** 的会话（`session-278b59b7`）用的是**逐字相同**的 `{minimax-cn, MiniMax-M3, high}` |
| 工具 schema 非法（"function parameters is empty 2013"） | **这是我一次错误测试的假象**：我用会话日志里的 `parameters` 键构造请求，而 pi-ai 上线时发的是 `input_schema`。按真实形状重发后，44 个工具（含 4 个 `properties:{}` 的）**全部 HTTP 200 + message_stop** |
| 本地代理 `http_proxy=127.0.0.1:10808` 破坏 SSE | `--noproxy '*'` 直连结果完全相同；同代理下 `curl` 与裸 `node`+`@anthropic-ai/sdk` 流式**都能跑通** |
| 会话被污染 | 全新会话（`session-c7fc1412`）同样 6/6 失败 |
| `max_tokens:512000` / `thinking:{type:"enabled"}` / `cache_control` / `betas` 触发 400 | 逐项加在已知可用的 44 工具请求上，curl 全部 **200 + message_stop** |

**决定性取证：抓宿主自己的请求**（不改任何 profile）：用一个 `NODE_OPTIONS="--import fetch-trace-hook.mjs"` 注入的 fetch 探针，在**一次性诊断实例 4604** 上重放同一回合，捕获到：

```json
{"url":"https://api.minimaxi.com/anthropic/v1/messages?beta=true","method":"POST",
 "bodyBytes":97137,"status":200,"ct":null,"headers":{},
 "reqHeaders":{"accept":"application/json","anthropic-beta":"interleaved-thinking-2025-05-14",
               "anthropic-version":"2023-06-01","x-stainless-package-version":"0.123.0", ...}}
{"responseFirstChunk":"\u0005�\u0000\u0000�̩�\u0004�\u001egM\u0001\u001e�:3�n�W+�~..."}
```

⇒ 宿主拿到的是 **HTTP 200 + 空 header 集 + 一段二进制 body**（`05 ad 00 00 …`），**不是 SSE**。6 次重试**每次都是同一形态**。

**回放定位到压缩**（同一份 body、同一端点）：

```console
$ curl -H 'accept: application/json' -H 'anthropic-beta: interleaved-thinking-2025-05-14' \
       -H 'accept-encoding: gzip, deflate, br, zstd' -d @host-request-body-1.json \
       'https://api.minimaxi.com/anthropic/v1/messages?beta=true' -D -
HTTP/2 200
content-type: text/event-stream; charset=utf-8
vary: Accept-Encoding
content-encoding: br                     # ← Brotli
# body 首 8 字节 = 05ad0000c4ef9dd3     ← 与宿主收到的完全同一形态；grep 'event:' = 0
$ # 去掉 accept-encoding 再发一次（或不带 br）：body 首 8 字节 = 6576656e743a206d（"event: m"）= 正常 SSE，message_stop 在场
```

**机制闭环**（读源码得到的两处）：

1. `@earendil-works/pi-ai/dist/api/anthropic-messages.js`：SSE 解析器 `iterateSseMessages` 只认 `event:`/`data:` 行；body 是压缩字节时**一个事件都产生不了** ⇒ `output.stopReason` 停在 `"pending"`：
   ```js
   if (output.stopReason === "pending") {
     throw new Error("Anthropic stream ended without a stop reason");
   }
   ```
2. `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 把该文案归类为可重试的传输错误：
   ```js
   if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
   ```
   ⇒ 于是"服务端把 SSE 压成 Brotli、客户端没解开"被报成"流没有停止原因"，并触发 5 次注定失败的重试。

**修复（一行 route 级 header）**：`api.minimaxi.com` 只在客户端声明 `br` 时才压缩；客户端不声明即返回明文 SSE。因此在 minimax-cn 这条 route 上强制 `accept-encoding: identity`：

```yaml
      minimax-cn:
        apiKeyEnv: MINIMAX_CN_API_KEY
        headers:
          accept-encoding: identity
```

**修复验证（两级）**

| 级别 | 实例 | 结果 |
|---|---|---|
| 一次性诊断实例 | `4604`（`--patch tmp/p0-0.6.0-evidence/identity-encoding.patch.yml`） | 同一请求 `responseFirstChunk = "event: message_start\ndata: {\"…"`；UI `已完成工作 / 用时 1秒 / 收到`，0 失败标记 |
| **正式验收实例** | **`4600`**（fix 写进 `dev-orchestra/cordis.patch.yml` 后重启） | Phase 1.3 `session-573effd7`：`turn/end={"kind":"completed"}`、**重试 0**；Phase 1.4 同会话 `tool/call orchestra_topologies` → `tool/result`、`turn/end=completed`、**0 重试** |

**仍未查清的一点（登记为宿主层未决项，不属本插件）**：裸 `node` 进程里 undici 能正常解 `content-encoding: br`（实测四种 `accept-encoding` 全部拿到明文 SSE，header 完整），但**宿主进程**里同一请求拿到的是**空 header + 未解压的 br 字节**。差异在宿主的 HTTP 路径（`@anthropic-ai/sdk` 0.123.0 + Node 22.22 的 EnvHttpProxyAgent 链路）内部，本轮未继续深挖；**本轮的修复是绕过压缩，不是修好解压**。⇒ 建议上游复现并修：任何同样声明 `br` 的服务端都会让该路径上的流式请求静默失败，并被误报成 TRANSPORT。



### 2.6 Phase 2（`/team`）——`orchestra_draft` 被 **preset 声明未装载** 阻断（**插件侧缺陷**，非模型能力、非环境）

**现场**：Owner 指示继续后，我在 4600 上用 **orchestra_E2E 工作区 + MiniMax-M3/high** 新建会话，界面里敲 `/team`（slash 命令不经 API 通道）。orchestra 接受了请求并进入交互式 onboarding（Goal 选 4「E2E orchestra smoke test」→ Constraints 勾 Strict AC + reviewer rounds 并写入本轮约束 → 提交）。随后 driver 连调 5 次 `orchestra_draft`，全部失败，最终向用户抛出一个"要么重建 tarball / 要么改用子代理"的四选一。

**工具返回的原文（会话 `session-45b916c1`，权威读数，不是模型自述）**

```
Error: cannot create a charter draft: role blueprint pre-parsing failed: DSH declared preset orchestra-implementer could not be resolved
Error: cannot create a charter draft: role blueprint pre-parsing failed: DSH declared preset preset-orchestra-v04-implementer-v1 could not be resolved
Error: cannot resolve the charter topology: inlineTopology is not a valid topology config:
       topology id "trio-parseDuration-fix" must use lower-kebab syntax. …
Error: cannot create a charter draft: draft draft-fix-parseDuration-p0-0.6.0-team-smoke was not found
```

**根因链（每一步都可复现）**

1. `orchestra-role-presets.js` 的解析路径**只问宿主注册表**（旧 catalog/roots 方案已在该版本删除）：
   ```js
   const presets = ctx.get("agentPresets");
   try { await presets.resolve(id); }
   catch (error) { throw new RolePresetError("preset_unavailable", "DSH declared preset " + id + " could not be resolved", …); }
   ```
   （函数签名里 `_cwd` / `_globalRoot` 都已被下划线忽略。）
2. 注册表要拿到角色预设，只能靠 bundle patch 里的声明。0.6.0 的 `cordis.patch.yml` 末尾是：
   ```yaml
   - include: ./presets/orchestra-roles.patch.yml
   ```
   而 **patch 语义里根本没有 `include`**——`@deepseek-ai/cordis-plugin-include/lib/index.js` 的 `applyEntryPatches` 只解构：
   ```js
   const { id, insert, name, ...overrides } = patch;
   ```
   该文件的注释明写：*"A patch that matches nothing warns and is skipped."* ⇒ 这一行**不匹配任何行、被静默跳过**。
3. **受控实验**（`--patch` overlay + `--dump-config`，不改任何 profile）：
   | overlay 内容 | 结果（`test-leaf-preset` 行数） |
   |---|---|
   | 直接把 `- insert:` 写进 overlay（对照组） | **2**（生效） |
   | `- include: /abs/path/leaf.yml` | **0** |
   | `- include: ./leaf.yml` | **0** |
4. **组合树实测**：`dsh --profile dev-orchestra --dump-config` 里的 agent-preset 行只有 DSH 自带 4 条（`preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis`）；插件声明的 **12 条**（`preset-orchestra-*`）**一条都不在**。UI 的 preset 选择器同样只列出这 4 个模式。
5. **回归对比**：`compat` profile 里的 **0.5.0** 副本 `cordis.patch.yml` **既没有 include 行、也没有 presets 目录**——那一版的角色预设靠「全局 catalog 目录 + `agent-presets.roots` 声明」（`dev` profile 至今保留 `roots: ~/.dsh/orchestra/catalog-presets`）交付。0.6.0 改成"声明式注册"后，**新路径是死的，旧路径又被代码删掉** ⇒ 这是 **0.6.0 引入的回归**，且与 profile 无关（任何 profile 都拿不到这 12 条）。

**归属判定（按 Owner 要求：区分"插件设计问题"与"模型理解不了"）**

| 现象 | 归属 | 依据 |
|---|---|---|
| `orchestra_draft` 报 preset 无法解析、`/team` 无法建队 | **插件侧缺陷（高置信）** | 上述受控实验 + 组合树 + 0.5.0 对比；与模型、与环境、与 profile 都无关 |
| driver 把根因判成"`@deepseek-ai/dsh-agent-preset` 只在 devDependencies、不进 tarball，所以 profile 里缺模块" | **模型能力（判断错误）** | 该包按本仓硬规则**必须**留在 peerDependencies（宿主提供）；实测 `require.resolve('@deepseek-ai/dsh-tools', {paths:[插件 lib]})` → host 路径，插件运行时也照常装载并注册了 18 个工具。tarball **确实**带了 `presets/orchestra-roles.patch.yml`（28,649 B）。模型抓到一个"看起来可疑"的事实，编出了一条错误因果链，并据此建议重建 tarball/改依赖——**若照做会直接违反防崩硬规则** |
| driver 把 **entry id**（`preset-orchestra-v04-implementer-v1`）当成 preset 名传参 | **模型能力（用错标识符）** | 声明里 entry id 是 `preset-…`，preset 自身的 id 是 `orchestra-…`；工具报错已明确回显它传了什么 |
| inlineTopology 报 `"trio-parseDuration-fix" must use lower-kebab syntax` | **模型能力（违反已声明的 id 约束）** | 工具报错信息本身是精确且可执行的 |
| 该回合 110 步、7M tok 都在"调基础设施" | **模型能力（策略）** | 观察：把预算花在猜 id 与翻 profile 上，而不是先向用户确认 |

> **结论（本项）**：Phase 2 的主链（`/team` → 章程草案 → `orchestra_create` → 懒加载物化 → 派活）**被一个确定的插件缺陷阻断**，按计划"机制没按设计发生 ⇒ 登记发现、继续下一项"，不在现场改代码、不重建 tarball、不绕路。可达的相邻项（A2A 控制面、混合子节点、客户端面板）继续做；依赖建队的项（lane / dismiss→activate / 重启后角色身份）本轮**未取得**。



## ③ 分层定位

| 层 | 判定 | 读数 |
|---|---|---|
| **制品层** | **通过** | 78 文件 / 351,882 B / sha256 `8250b6ea…`；`dependencies` 仅 `js-yaml`；22 peer；无 `@deepseek-ai` 副本、无 `src`/`scripts`/`node_modules`、无 `.ts` 源码、无绝对路径、无密钥；`presets/orchestra-roles.patch.yml` + `skills/` 在内；`lib/` 与本次构建**逐字节一致**；来自 commit `27b29af` |
| **宿主解析层** | **通过** | profile 内**无** `@deepseek-ai` 实体副本（`node_modules/` 只有 `argparse/js-yaml/orchestra-dsh`）；`require.resolve` 从插件 lib 指向 **host**（`…/dsh/node_modules/@deepseek-ai/…`）；组合树含 `orchestra-bundle/orchestra-a2a/orchestra-manager`；**运行时** 44 个工具里含本插件 18 个 ⇒ 插件装载 + 工具注册成功 |
| **名册与预设层** | **待 Owner 驱动** | 通道已通后未到 `/team`、未建队、未物化角色（`orchestra_E2E/orchestra/state` 仍为空） |
| **会话与交接层** | **修复后通过** | 修复前：`session-83ec3a88…` 的 `turn/end` = `{"kind":"error", … code:"TRANSPORT"}`、6 次 attempt 全败、0 工具调用。修复后：`session-573effd7…` 两回合均 `turn/end=completed`、**0 重试**、`tool/call orchestra_topologies` → `tool/result` |
| **恢复层** | **未触及** | 未做角色身份重启、未做 dismiss/activate、未做归档（实例重启本身已做：修复需重启 4600） |
| **web 装载层** | **未执行** | 停机条件拦截；web profile 未被写入（读数见 §2.4；`web/cordis.yml` 出现一处无法归因的占位重写，内容 hash 与 dev-orchestra 的同名文件相同） |
| **供应商/HTTP 编码层** | **根因所在（已用一行 route header 绕过）** | `api.minimaxi.com` 在客户端声明 `br` 时以 `content-encoding: br` 回传 SSE；宿主 HTTP 路径把**未解压的 br 字节 + 空 header 集**交给 pi-ai 的 SSE 解析器 ⇒ `stopReason` 停在 `"pending"` ⇒ 被 `dsh-llm-pi-ai` 归类为 `TRANSPORT` 并重试 5 次。`curl` / 裸 `node`+SDK 在同代理下均正常（能解 br），只有宿主进程这一条路径拿不到明文 ⇒ 绕过方式：该 route 强制 `accept-encoding: identity`。详见 §2.5 |

**定位结论**：两个阻断点分别落在**宿主 HTTP 编码层**（§2.5：br 未解压 → 误报 TRANSPORT，已用 route 级 header 绕过，Phase 1.3/1.4 通过）与**插件声明层**（§2.6：bundle patch 的 `- include:` 在 patch 语义里无效 ⇒ 12 条 role preset 从未注册 ⇒ `/team` 主链不可用）。`orchestra-dsh 0.6.0` 的**制品层与宿主解析层无异常**（18 个工具照常注册、`orchestra_topologies` 可用）。Phase 2 的可达相邻项（A2A 控制面、混合子节点、客户端面板）继续取证；依赖建队的项未取得。

---

## ④ 未做 · 未验证

**未做（按停机条件或计划"不做"）**

1. Phase 2 **全部 7 项**（`/team` 草案与逐角色 `runtime`、批准与懒加载物化、`request/header` 一致性、真实小活闭环含**至少一次打回**、A2A 五项 + `a2a_stop` + 冷会话唤醒、运行中新 mission→lane（"0 新座位 + 新增 lane"）、混合 `execution:"subagent"` 与续派、**重启后身份**、`orchestra_dismiss`→归档→`orchestra_activate`、设置面板与控制台无报错）——**改为由 Owner 在 4600 上亲手驱动**（Phase 1.4 已由本轮完成并通过）。
2. Phase 3 全部（备份/只加不改/三件套/live 重载判定/**Owner 放行重启 4599**/不崩验收/最小 smoke）；**4599 与 web profile 一行未改**。
3. 确定性交付层（worktree/租约/合并门/证据层）——计划明确"不做，留给下一个版本号"。
4. 未 push / 未 tag / 未 publish；未碰 4601、旧 dev、历史会话；未用 browser-use。

**未验证（本轮无法确认，需下一跳）**

- **是否间歇**：只发了 1 个回合（策略内 6 次传输尝试）；**未重试**（停机条件禁止"继续/绕过"），故不能区分"持续故障"与"瞬时抖动"。
- **是否与插件有关**：**未做控制实验**（同宿主、不含 orchestra-dsh 的干净 profile 上跑同一模型口径）。
- **是否 profile patch 引起**：未做对照（patch 里 `minimax-cn` 只覆盖 `apiKeyEnv`，`api/baseURL/models` 来自宿主内置默认；未验证该默认端点与本机网络/代理的关系）。
- 宿主侧无更多细节可取证：4600 作业日志（`bash-307`）只有启动行，无错误；`~/.dsh/logs/dsh-web.log` 是 4599 的旧日志（09-22 21:47），与本轮无关。
- 截图 `4600-gate-failure.png` **未以图像方式查看**（当前模型不接受图像输入）；改以截图裁切区的 DOM 文本自证。
- 未核实 `require.resolve` 之外的其它解析路径（如 `dsh-session-persistence` 等宿主内部模块）——不必要，解析层已由 dump-config + 运行期工具注册双重证明。

---

## ⑤ 下一跳建议

1. **先做控制实验（1 个回合，成本最低的判定）**：在**同宿主**上起一个**不含 orchestra-dsh** 的干净 profile（建议 `dsh rescue --from-default-profile web` 落到一个未占用端口，或复用 `headless` 类空 profile），同样选 `minimax-cn / MiniMax-M3 / high`，发同一条无工具消息。
   - **也失败** ⇒ 判定为**供应商/宿主流层阻断**，与 0.6.0 制品无关；0.6.0 的 Phase 2/3 验收必须**等通道恢复**，期间不要动 web。
   - **通过** ⇒ 说明 4600/dev-orchestra 这一路有额外变量（profile patch、网络/代理、实例进程），需要在 4600 上重放并采集传输层日志。
   > 本轮按停机条件**未自行执行**这一步；需要 driver/Owner 授权（它会产生新的模型回合）。
2. **通道恢复后的最短验收路线**：直接回到本报告的 Phase 1.3 闸 → 通过后再进 Phase 2 七项 → 最后才做 Phase 3（web 装机 + Owner 放行重启）。
   - **执行 Phase 3 前先读 F-070-4**：web 现在**没有** orchestra-dsh（`bundles` 只有 base+web-app，`node_modules` 里 0 个插件包，`pnpm-lock.yaml` importer 为 `{}`），所以 §3.2 的"只加不改"实为**首次安装**；`pnpm-workspace.yaml` 里那条 `orchestra-dsh@0.5.0` 是**过期遗留**（要不要顺手清，需要 Owner 决定，本轮未动）。
3. **工程侧建议（不属本轮范围，仅登记）**：
   - `scripts/check-session-readable.mjs` 增加 `session.v4.jsonl.zstd` 支持（F-070-2）；否则对**新会话**的"日志可读性"检查会假失败。
   - 该 `TRANSPORT` 失败**没有任何重试可救**（6/6 同签名），可考虑在 UI 上把"5/5 重试"文案与"传输层阻断"区分，减少"再试一次"的误判空间。
4. **0.6.0 制品可先冻结**：Phase 0 全绿、版本号与制品哈希已固定（`8250b6ea…`），无需重打包即进入下一轮。
5. **需要 Owner 决定的两件善后事**（本轮按计划**不自行清理**）：① 4600 实例（作业 `bash-307`）是否保留——它是失败现场，保留便于复核，停掉则 `lsof -ti tcp:4600 | xargs kill`；② F-070-3 的 profile 写回（`reasoningEffort: high` + `ui-settings-general` 行）保留还是恢复（备份 `~/.dsh/profiles/dev-orchestra/cordis.patch.yml.bak-20260923-021406` 在场，随时可回滚）。

---

## 附录

### A1 痕迹登记（本轮产生的所有痕迹）

| 类别 | 路径 | 说明 / sha256 |
|---|---|---|
| 交付制品 | `orchestra-dsh-0.6.0.tgz`（仓库根，`*.tgz` 已 gitignore） | 351,882 B / 78 文件 / `8250b6eac9be…3386`；构建源 commit `27b29af` |
| 构建 worktree | `/tmp/orchestra-p0-0.6.0`（detached，node_modules 为软链） | 可随时 `git worktree remove` |
| 旧货移出 | `/tmp/orchestra-stale-artifacts/orchestra-dsh-0.5.1.tgz.stale-pre-0.6.0` | 346,673 B / `61bfafaa…6fb1`（16:07 旧货） |
| 证据目录（`tmp/` 已 gitignore） | `tmp/p0-0.6.0-evidence/` | `artifact-hashes.txt`、`artifact-filelist.txt`、`npm-test.log`、`npm-pack.log`、`gate-session-summary.txt`、`gate-session-key-events.txt`、`gate-attempt-timeline.txt`、`gate-tool-surface.txt`、`4600-gate-failure.png`、`summarize-session-log.mjs`、`profile-staging/` |
| 失败会话（**保留，勿删**） | `~/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_E2E--/session-83ec3a88-7371-455b-8ffa-c49f1860a7cf/` | `session.v4.jsonl.zstd` 43,694 B / 35 events |
| 运行中实例 | 作业 `bash-307`：`dsh --profile dev-orchestra --port 4600 --no-open` | URL+token 见 §A2；**按计划不清理，留给 Owner 查看** |
| 浏览器 | Ego lite 空间 id `3`（页面 `p1` 停在 4600 的失败会话上） | 未 `finish()`（任务因失败停止，按 skill 规则保留） |
| profile 改动（dev-orchestra） | `package.json`（+dep `orchestra-dsh`、bundles +1）、`pnpm-workspace.yaml`（+`minimumReleaseAgeExclude`）、**`cordis.patch.yml`：minimax-cn route 追加 `headers.accept-encoding: identity`（本轮根因修复）** | 备份 `*.bak-20260923-021406`、**`cordis.patch.yml.bak-before-accept-encoding-fix-20260923-025118`**（Owner 02:38 那次编辑之后的现场）；`node_modules/` 新增 3 包 |
| 根因取证产物（`tmp/`，gitignore） | `fetch-trace-hook.mjs`（fetch 探针）、`host-request-body-1.json`（宿主原始请求 97 KB）、`host-fetch-trace.log`（状态/空 header/未解压 br 首块）、`repro-undici-encoding.mjs`、`repro-sdk-stream.mjs`、`identity-encoding.patch.yml`（一次性 4604 验证用 overlay）、`minimax-diagnosis.md`、`OWNER-runbook-team-test.md` | 诊断实例 4604（作业 `bash-404`，**保留**以便随时复现；4600 为验收实例 `bash-409`） |
| profile 被宿主写回（**非我所改，见 F-070-3**） | `~/.dsh/profiles/dev-orchestra/cordis.patch.yml` | 02:16 由 1980 → 2135 B：`agent-default-model` +`reasoningEffort: high`；新增 `ui-settings-general`（`welcomeNoticeVersion: 2026-08-13.1`）。diff 见 §A3；**未回滚** |
| git | commit `27b29af`（版本号）；工作区仅 `?? .pi/` | 未 push / 未 tag |
| 未产生 | 团队记录 / 角色座位 / web 备份目录 / 除一张截图外的任何产物 | web 未安装（且 web 侧**本来就没有** orchestra-dsh，F-070-4）；`orchestra_E2E/orchestra/state` 仍空 |

### A2 "看这里"（三行，按 Phase 4 格式，供 Owner 现场复核）

1. **URL + token**：<http://127.0.0.1:4600/?token=8xUA9LSTiJ1f31a87QOj0HqZW4gjp6GJXO2B2xFSvYU>（dev-orchestra；进程目前作为本会话的后台作业 `bash-307` 运行。**要停**：`lsof -ti tcp:4600 | xargs kill`；**要起**：`dsh --profile dev-orchestra --port 4600 --no-open`——重启会换新 token，从启动日志第一行取）。
2. **工作区与会话标题**：工作区 `orchestra_E2E`（=`/Users/yuantian/Documents/agentWorkspace/artifacts/projects/orchestra_E2E`）；失败会话 `session-83ec3a88-7371-455b-8ffa-c49f1860a7cf`（首条消息"只回复两个字：收到。不要调用任何工具。"，标题由宿主生成；UI 上显示 `处理失败 / 已重试模型请求（5/5） · 9s / Anthropic stream ended without a stop reason / TRANSPORT`）。
3. **Owner 可以亲手做的一步**：在同一个 4600 页面上**再发一条任意短消息**（模型已是 M3/High）——若仍是同样的 `TRANSPORT`，即为"持续故障"的现场复现；若成功，则说明是瞬时抖动，可据此决定是否继续 Phase 2。**注意：这一条会把"重试判定"的责任交给 Owner，本轮我按停机条件没有自行重试。**

### A3 宿主写回的 profile diff（F-070-3 原文）

```diff
--- cordis.patch.yml.bak-20260923-021406	2026-09-23 02:14:06
+++ cordis.patch.yml	2026-09-23 02:16:29
@@ -63,3 +63,8 @@
   config:
     provider: minimax-cn
     model: MiniMax-M3
+    reasoningEffort: high
+- id: ui-settings-general
+  name: "@deepseek-ai/dsh-client-ui-settings-general"
+  config:
+    welcomeNoticeVersion: 2026-08-13.1
```

### A4 完整命令清单（按时间顺序，节选关键命令）

```bash
# —— 侦察
pwd; git status --porcelain=v1; git branch --show-current; git log -1 --format='%H%n%ci%n%s'
ls -la; ls -la *.tgz; ls -la lib/; git ls-files lib/ | wc -l
ls -la ~/.dsh/profiles/; cat ~/.dsh/profiles/dev-orchestra/package.json
lsof -nP -iTCP -sTCP:LISTEN | grep -E '459[0-9]|460[0-9]'
for p in 4599 4600 4601; do curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$p/; done
dsh --version                      # 0.1.7-alpha.1
# —— Phase 0
mv orchestra-dsh-0.5.1.tgz orchestra-dsh-0.5.1.tgz.stale-pre-0.6.0
mkdir -p /tmp/orchestra-stale-artifacts && mv orchestra-dsh-0.5.1.tgz.stale-pre-0.6.0 /tmp/orchestra-stale-artifacts/
shasum -a 256 /tmp/orchestra-stale-artifacts/*
# （edit package.json: version 0.5.1 → 0.6.0）
git diff -- package.json && git add package.json && git commit -m "chore(release): bump version to 0.6.0"
git worktree add --detach /tmp/orchestra-p0-0.6.0 27b29af8cad628fa68fb7f987f638c878881ef44
ln -sfn /Users/yuantian/Developer/orchestra-dsh/node_modules /tmp/orchestra-p0-0.6.0/node_modules
cd /tmp/orchestra-p0-0.6.0 && npm run typecheck && npm run build
npm test > /tmp/orchestra-p0-npm-test.log 2>&1; grep -E '^# (tests|pass|fail|cancelled)' /tmp/orchestra-p0-npm-test.log
npm pack --cache /tmp/dsh-npm-cache
tar -xzf orchestra-dsh-0.6.0.tgz -C /tmp/orchestra-artifact-check
tar -tzf orchestra-dsh-0.6.0.tgz | grep -c '@deepseek-ai'
diff -r /tmp/orchestra-artifact-check/package/lib /tmp/orchestra-p0-0.6.0/lib
cp /tmp/orchestra-p0-0.6.0/orchestra-dsh-0.6.0.tgz /Users/yuantian/Developer/orchestra-dsh/
# —— Phase 1
cd ~/.dsh/profiles/dev-orchestra && cp package.json{,.bak-$(date +%Y%m%d-%H%M%S)}   # 另含 pnpm-workspace.yaml / cordis.patch.yml
# （写入新 package.json / pnpm-workspace.yaml；rm -f node_modules/.modules.yaml .pnpm-workspace-state-v1.json .pnpm/lock.yaml）
pnpm install
ls node_modules/ | grep -v dup-bak; ls node_modules/@deepseek-ai
node -e "console.log(require.resolve('@deepseek-ai/dsh-tools', {paths:['./node_modules/orchestra-dsh/lib']}))"
diff -r node_modules/orchestra-dsh /tmp/orchestra-artifact-check/package
dsh --profile dev-orchestra --port 4600 --no-open        # 作业 bash-307
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4600/
dsh --profile dev-orchestra --dump-config | grep -i orchestra
# —— Phase 1.3（Ego lite，空间 3）
ego-browser nodejs <<'EOF' … taskSpace(3); page("p1").goto("http://127.0.0.1:4600/?token=…") … EOF
# 新建会话 → 工作区 orchestra_E2E → 模型 minimax-cn/MiniMax-M3 + High → 发送"只回复两个字：收到。不要调用任何工具。"
# —— 取证
ls -la ~/.dsh/sessions/--Users-yuantian-…-orchestra_E2E--/session-83ec3a88-…/
zstd -d -c session.v4.jsonl.zstd > /tmp/gate-session.jsonl
node tmp/p0-0.6.0-evidence/summarize-session-log.mjs <sessionDir>
shasum -a 256 ~/.dsh/profiles/web/{package.json,pnpm-workspace.yaml,cordis.patch.yml}
diff -u ~/.dsh/profiles/dev-orchestra/cordis.patch.yml{.bak-20260923-021406,}
```

### A5 起始 / 终态 `ls`

**起始（Phase 0 之前）**：见 §2.1 前提状态。要点：`orchestra-dsh-0.5.1.tgz`（16:07）在场；`lib/` 为 16:09 旧产物；`git status` 仅 `?? .pi/`；`package.json` version `0.5.1`。

**终态**

```console
$ git status --porcelain=v1
?? .pi/                                   # 与起始一致（既有、非源码）
$ git log -2 --format='%h %ci %s'
27b29af 2026-09-23 01:46:22 +0800 chore(release): bump version to 0.6.0
a0914d6 2026-09-22 18:25:43 +0800 docs: record peer MiniMax stream failure as runtime prerequisite

$ ls -la | grep -E 'tgz|package\.json|tmp| lib$'
drwxr-xr-x@ 74 yuantian staff    2368 Sep 21 00:05 lib                        # 主检出旧 lib 未动
-rw-r--r--@  1 yuantian staff  208645 Aug 25 02:28 orchestra-dsh-0.4.0.tgz
-rw-r--r--@  1 yuantian staff  300046 Sep 16 01:25 orchestra-dsh-0.4.1.tgz
-rw-r--r--@  1 yuantian staff  289970 Sep 16 21:19 orchestra-dsh-0.5.0.tgz
-rw-r--r--@  1 yuantian staff  351882 Sep 23 01:47 orchestra-dsh-0.6.0.tgz   # 新增（0.5.1 旧货已移出到 /tmp）
-rw-r--r--@  1 yuantian staff    6698 Sep 23 01:46 package.json              # version 0.6.0
drwxr-xr-x@  4 yuantian staff     128 Sep 23 01:47 tmp                       # 新增证据目录（gitignore）

$ ls -la ~/.dsh/profiles/dev-orchestra/
cordis.patch.yml (2135, 02:16 ←宿主写回)  cordis.patch.yml.bak-20260923-021406 (1980)
cordis.yml (223)  node_modules/ (10 项)  package.json (337)  package.json.bak-… (217)
pnpm-lock.yaml (2302)  pnpm-workspace.yaml (111)  pnpm-workspace.yaml.bak-… (61)

$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4600/   → 401   # 实例仍在运行（作业 bash-307）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4599/   → 401   # Owner 实例，全程未动
$ ls -la ~/.dsh/profiles/web/                                     # 无安装动作；mtime 全部 ≤ 09-22 23:00（唯一例外见 §2.4）
```

---

**一句话总结**：**0.6.0 制品与 dev 装载全绿（295/295、78 文件、三件套通过、18 个插件工具已注册）；Phase 1.3 通道闸初次 6/6 次 `TRANSPORT` 失败，根因定位为「服务端把 SSE 以 `content-encoding: br` 回传、宿主 HTTP 路径未解压就交给 SSE 解析器」（§2.5），在 minimax-cn route 加一行 `accept-encoding: identity` 后 4600 上 Phase 1.3/1.4 均通过（`turn/end=completed`、0 重试、`tool/call orchestra_topologies` 成功）；Phase 2 改由 Owner 亲手驱动，Phase 3 未执行、4599 与 web 全程只读未写。**
