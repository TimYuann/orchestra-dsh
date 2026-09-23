# P0 · 修复：12 条角色预设真正进入组合树 + 会话日志读取器 v4 支持

> **作者**：repair session（只按 driver 给定的方案改代码；不改 web/4599、不 bump 版本、不 push）。
> **代码修复 commit**：`eb7a71d5ab26b6a411046a38af17eab384bf3b1b`（`fix(bundle): deliver the 12 role presets via dsh.bundle.patch, not an inert include`），父提交 `de345b0`。
> **报告 commit**：本文件所在的文档提交 —— 用 `git log -1 --format=%H -- docs/p0-report-preset-registration-fix.md` 取（其父提交固定为 `eb7a71d5ab26b6a411046a38af17eab384bf3b1b`；两份 commit 之间只增加本文档）。自引用会让写死在文中的 hash 在 amend 后失效，故此处用命令取值。
> **制品**：`orchestra-dsh-0.6.0.tgz`（**版本保持 0.6.0**）352,142 B / 78 文件 / sha256 `49c1000219f237d2e0c6b200c5a05c019a8aa7881e5da32eb086cbb422a28ce6` / npm shasum `4e1fd147dd81522d13fe9396490f3c30e1c6e917`。构建于干净 detached worktree `/tmp/orchestra-preset-fix-0.6.0`（`git worktree add --detach <commit eb7a71d>`，无旧 `lib/`）。
> **运行期实例**：`dev-orchestra` / **4600**（作业 `bash-700`，PID 4699，token `hPaO9vlB3KnEUEY8yCnl2BOz8B-Fw9Wqezf6AW4hIac`）。`web/4599`（PID 94859）与 `dev-trinity/4601` 全程未碰。
> **停机条件**：三条均未触发（详见 ③）。

---

## ① 结论

| 工作项 | 判定 | 一句话 |
|---|---|---|
| **1 · 预设注册** | **通过** | 改前组合树 orchestra preset 行 **0**（宿主 CLI 与离线组合入口都读到 `patch: id is required for non-insert patches`）；改后 **12**；**三个负例**（模块名写错一行 / entry id 改错一行 / 改前 include 形状）全部让断言失败；`npm pack` 解包后离线仍 **12**；真机 `orchestra_draft` 返回 12/12 角色成功解析。 |
| **2 · 会话日志读取器** | **通过** | `readStoredEvents` 改为按**世代号最大者**选文件（v4 优先、v3 回退，与宿主 `resolveGenerationInDirectory` 同规则）：真实 v4 会话解出 **81 events**、真实 v3 会话解出 **4 events**；同目录同时放 v3+v4 ⇒ 选 **v4**；只留 v3 ⇒ 回退 **v3**；两者都没有 ⇒ **报错并非空**。 |
| **3 · 装进 dev-orchestra + 重启 4600** | **通过** | 干净 worktree：typecheck 0 / build 0 / **295 pass · 0 fail · 0 cancelled** / pack 0；三件套绿；`cordis.patch.yml` 与另两个 profile 文件**哈希前后逐字相同**（`accept-encoding: identity` 在位）；4600 重启后启动日志零插件加载失败；**真机落地验证**：新会话 `session-c67d9332`（v4）调用 `orchestra_draft` 一次 ⇒ `tool/result isError=false`、**12 个角色的 preset 全部解析**、提案表正常产出、`turn/end={"kind":"completed"}`。 |

### 工作项 1 的机制判定（本轮结论的落点）

宿主 0.1.7-alpha.1 的真实语义（**不是文档，是安装盘上的代码**）：

- 补丁引擎 `@deepseek-ai/cordis-plugin-include@1.0.8` 的 `applyEntryPatches` 只解构 `{ id, insert, name, ...overrides }` ⇒ **`include` 根本不是补丁键**：不匹配任何行的补丁被 warn + skip。这解释了改前那句 `patch: id is required for non-insert patches`。
- bundle 的补丁文件是**声明式列表**：`@deepseek-ai/dsh-app-boot@0.1.7-alpha.1` 的 `bundlePatchFiles` / `bundlePatchPaths` / `loadProfileDirectory` 接受 `dsh.bundle.patch` 为 **字符串或文件路径数组**，每个文件作为**独立补丁层**加载。**shipped 的 `@deepseek-ai/dsh-web-app` 就是这么发自己的 4 条 preset 的**：
  ```json
  "dsh": { "bundle": { "patch": ["./cordis.patch.yml", "./presets/standard.patch.yml",
                                  "./presets/ptc.patch.yml", "./presets/minimal.patch.yml",
                                  "./presets/cordis.patch.yml"] } }
  ```
  （`dev-orchestra` 的组合树里 web-app 层实测为 **5 file(s)**。）

⇒ 选定方案：**既非 (a) 也非 (b)，而是宿主自己的声明式机制**——把生成的 preset 文件作为 `dsh.bundle.patch` 的**第二个条目**声明（与 shipped bundle 同形状），并把 `cordis.patch.yml` 里那行无效 `- include:` 删除。理由：不动生成器、不重排 patch 文件、不需要 `cordis:include` 插件行，且行为与官方 bundle 完全同构（`loadProfileDirectory` 的 `patchPaths.flatMap(loadOverlayPatches)` 是同一段代码路径）。

---

## ② 证据

### 2.1 锚点（commit + 符号，不用行号）

| 层 | 锚点 |
|---|---|
| 本仓（改前） | `de345b0:package.json` → `dsh.bundle.patch` = `"./cordis.patch.yml"`（字符串）；`de345b0:cordis.patch.yml` 末行 `- include: ./presets/orchestra-roles.patch.yml` |
| 本仓（改后） | `eb7a71d:package.json::dsh.bundle.patch` = `["./cordis.patch.yml","./presets/orchestra-roles.patch.yml"]`；`eb7a71d:cordis.patch.yml` 末段注释说明声明位置与 `include` 为何不可用 |
| 本仓（新增判据） | `scripts/verify-role-preset-registration.mjs::{rolePresetRows, registrationFailures, syntheticProfile}` |
| 本仓（读取器） | `scripts/check-session-readable.mjs::{sessionLogPath, hasStoredLog, readStoredEvents}`；`scripts/verify-role-identity.mjs::realSessionIds` |
| 宿主 | `@deepseek-ai/cordis-plugin-include@1.0.8::applyEntryPatches`；`@deepseek-ai/dsh-app-boot@0.1.7-alpha.1::{bundlePatchFiles,bundlePatchPaths,loadProfileDirectory,composeEntries,mountRootInclude}`；`@deepseek-ai/dsh-session-persistence-jsonl::{parseGenerationLogFilename,resolveGenerationInDirectory}`；`@deepseek-ai/dsh-web-app/package.json::dsh.bundle.patch` |

### 2.2 工作项 1 ① 改前/改后对照 + 负例

**可复跑命令**（在仓库根，先 `npm run build`，因为脚本读 `lib/orchestra-role-presets.js`）：

```bash
npm run build
# 改后：仓库源码树 / 已装 profile / 解包 tgz
node scripts/verify-role-preset-registration.mjs --bundle "$PWD"
node scripts/verify-role-preset-registration.mjs --profile dev-orchestra
node scripts/verify-role-preset-registration.mjs --bundle /tmp/orchestra-preset-fix-tarball/package
# 负例（保留在 tmp/preset-registration-verify/，未提交）
node scripts/verify-role-preset-registration.mjs --bundle tmp/preset-registration-verify/neg1-module-typo
node scripts/verify-role-preset-registration.mjs --bundle tmp/preset-registration-verify/neg2-entryid-renamed
node scripts/verify-role-preset-registration.mjs --bundle tmp/preset-registration-verify/neg3-prefix-include-shape
```

**改前（`git show HEAD:package.json` + `git show HEAD:cordis.patch.yml` 的**逐字**拷贝 = `neg3-prefix-include-shape`）**：

```console
$ node scripts/verify-role-preset-registration.mjs --bundle tmp/preset-registration-verify/neg3-prefix-include-shape
# profile=orchestra-preset-compose-l3DNdO bundle_layers=orchestra-dsh(1 file(s))
# patch-warning patch: id is required for non-insert patches
ROLE_PRESET_FAIL composed tree is missing 12 of 12 role presets: orchestra-v04-implementer-v1, …, orchestra-oracle (rows found: 0; …)
ROLE_PRESET_FAIL the patch engine skipped patches while composing: patch: id is required for non-insert patches
# role_preset_rows=0 expected=12 composed_entries=3 warnings=1
EXIT=1
```

**改后（仓库源码树）**：

```console
$ node scripts/verify-role-preset-registration.mjs --bundle "$PWD"
# profile=orchestra-preset-compose-Eg9GZM bundle_layers=orchestra-dsh(2 file(s))
ROLE_PRESET_ROW row=preset-orchestra-v04-implementer-v1 config_id=orchestra-v04-implementer-v1 plugins=10
ROLE_PRESET_ROW row=preset-orchestra-v04-reviewer-v1 config_id=orchestra-v04-reviewer-v1 plugins=8
ROLE_PRESET_ROW row=preset-orchestra-v04-investigator-v1 config_id=orchestra-v04-investigator-v1 plugins=8
ROLE_PRESET_ROW row=preset-orchestra-v04-verifier-v1 config_id=orchestra-v04-verifier-v1 plugins=5
ROLE_PRESET_ROW row=preset-orchestra-v04-architect-v1 config_id=orchestra-v04-architect-v1 plugins=7
ROLE_PRESET_ROW row=preset-orchestra-v04-researcher-v1 config_id=orchestra-v04-researcher-v1 plugins=7
ROLE_PRESET_ROW row=preset-orchestra-v04-hardening-auditor-v1 config_id=orchestra-v04-hardening-auditor-v1 plugins=8
ROLE_PRESET_ROW row=preset-orchestra-v04-planner-v1 config_id=orchestra-v04-planner-v1 plugins=7
ROLE_PRESET_ROW row=preset-orchestra-v04-oracle-v1 config_id=orchestra-v04-oracle-v1 plugins=7
ROLE_PRESET_ROW row=preset-orchestra-implementer config_id=orchestra-implementer plugins=5
ROLE_PRESET_ROW row=preset-orchestra-reviewer config_id=orchestra-reviewer plugins=5
ROLE_PRESET_ROW row=preset-orchestra-oracle config_id=orchestra-oracle plugins=5
# role_preset_rows=12 expected=12 composed_entries=15 warnings=0
EXIT=0
```

**改后（已装 profile；这就是 4600 组合树的内容）**：

```console
$ node scripts/verify-role-preset-registration.mjs --profile dev-orchestra
# profile=dev-orchestra bundle_layers=@deepseek-ai/dsh-base(1 file(s)) @deepseek-ai/dsh-web-app(5 file(s)) orchestra-dsh(2 file(s))
# role_preset_rows=12 expected=12 composed_entries=192 warnings=0
EXIT=0
```

**同一判据改用宿主自己的 CLI 组合入口**（不需要我的脚本）：

```console
$ dsh --profile dev-orchestra --dump-config | grep -c "id: preset-orchestra"
12
$ dsh --profile dev-orchestra --dump-config | grep "id: preset-orchestra" | head -13
- id: preset-orchestra-v04-implementer-v1
- id: preset-orchestra-v04-reviewer-v1
- id: preset-orchestra-v04-investigator-v1
- id: preset-orchestra-v04-verifier-v1
- id: preset-orchestra-v04-architect-v1
- id: preset-orchestra-v04-researcher-v1
- id: preset-orchestra-v04-hardening-auditor-v1
- id: preset-orchestra-v04-planner-v1
- id: preset-orchestra-v04-oracle-v1
- id: preset-orchestra-implementer
- id: preset-orchestra-reviewer
- id: preset-orchestra-oracle
$ dsh --profile dev-orchestra --dump-config 2>&1 >/dev/null | grep -viE 'UNDICI|trace-warnings'
（空 —— 没有任何 skipped-patch 警告）

# 对照：同一个 CLI 指向"改前形状"的一次性 profile（DSH_HOME=/tmp/preset-fix-dsh-home）
$ DSH_HOME=/tmp/preset-fix-dsh-home dsh --profile preset-fix-neg --dump-config 2>&1 | grep -c "id: preset-orchestra"
0
$ DSH_HOME=/tmp/preset-fix-dsh-home dsh --profile preset-fix-neg --dump-config 2>&1 >/dev/null | grep -viE 'UNDICI|trace-warnings'
dsh: [orchestra-dsh] patch: id is required for non-insert patches
```

**负例校准（三个，都必须失败）** —— 每个只对**一行**做手术（`diff` 原文见下）：

```console
$ diff <(cat presets/orchestra-roles.patch.yml) <(cat tmp/preset-registration-verify/neg1-module-typo/presets/orchestra-roles.patch.yml)
178c178
<       name: '@deepseek-ai/dsh-agent-preset'
>       name: '@deepseek-ai/dsh-agent-presett'
$ diff <(cat presets/orchestra-roles.patch.yml) <(cat tmp/preset-registration-verify/neg2-entryid-renamed/presets/orchestra-roles.patch.yml)
374c374
<     - id: preset-orchestra-v04-planner-v1
>     - id: preset-orchestra-v04-planner-v1-renamed

$ node scripts/verify-role-preset-registration.mjs --bundle tmp/preset-registration-verify/neg1-module-typo
# role_preset_rows=11 expected=12 composed_entries=15 warnings=0
ROLE_PRESET_FAIL composed tree is missing 1 of 12 role presets: orchestra-v04-verifier-v1 …
EXIT=1
$ node scripts/verify-role-preset-registration.mjs --bundle tmp/preset-registration-verify/neg2-entryid-renamed
# role_preset_rows=12 expected=12 composed_entries=15 warnings=0
ROLE_PRESET_FAIL preset orchestra-v04-planner-v1 is declared by row id "preset-orchestra-v04-planner-v1-renamed"; expected "preset-orchestra-v04-planner-v1"
EXIT=1
$ node scripts/verify-role-preset-registration.mjs --bundle tmp/preset-registration-verify/neg3-prefix-include-shape
# role_preset_rows=0 expected=12 composed_entries=3 warnings=1
ROLE_PRESET_FAIL the patch engine skipped patches while composing: patch: id is required for non-insert patches
EXIT=1
```

> 防恒真说明：期望集合来自**构建后的 catalog**（`lib/orchestra-role-presets.js::ALL_BUILTIN_ROLE_PRESETS`，12 条），不是手写计数；断言同时要求"每条 row 的 entry id === `preset-<config.id>`"与"`config.plugins` 非空"，因此**掉一行、改一行、多一行**都会失败；`warnings` 一起进判据，避免"0 行 0 警告"被读成通过。

### 2.3 工作项 1 ② 打包后仍在

```console
$ cd /tmp/orchestra-preset-fix-0.6.0 && npm pack --cache /tmp/dsh-npm-cache
npm notice name: orchestra-dsh
npm notice version: 0.6.0
npm notice filename: orchestra-dsh-0.6.0.tgz
npm notice package size: 352.1 kB
npm notice unpacked size: 1.7 MB
npm notice shasum: 4e1fd147dd81522d13fe9396490f3c30e1c6e917
npm notice integrity: sha512-Nf1aNpVh46lKV[...]cuPBcoK5w2Z/A==
npm notice total files: 78
PACK_EXIT=0
$ shasum -a 256 orchestra-dsh-0.6.0.tgz
49c1000219f237d2e0c6b200c5a05c019a8aa7881e5da32eb086cbb422a28ce6  orchestra-dsh-0.6.0.tgz

$ tar -tzf orchestra-dsh-0.6.0.tgz | awk -F/ '{print $2}' | sort -u
cordis.patch.yml / cordis.yml / lib / LICENSE / package.json / presets / README.md / skills
$ node -e 'const p=require("/tmp/orchestra-preset-fix-tarball/package/package.json"); …'
{ "version": "0.6.0",
  "dependencies": { "js-yaml": "^4.1.0" },
  "bundle": { "patch": [ "./cordis.patch.yml", "./presets/orchestra-roles.patch.yml" ] } }
$ tar -tzf orchestra-dsh-0.6.0.tgz | grep -c '@deepseek-ai'                      → 0
$ tar -tzf orchestra-dsh-0.6.0.tgz | grep -cE '(^|/)(node_modules|src|scripts)/'  → 0
$ tar -tzf orchestra-dsh-0.6.0.tgz | wc -l                                        → 78
$ grep -c '^- include:' /tmp/orchestra-preset-fix-tarball/package/cordis.patch.yml → 0
$ ls -la /tmp/orchestra-preset-fix-tarball/package/presets/
-rw-r--r--  28649  orchestra-roles.patch.yml
$ shasum -a 256 /tmp/orchestra-preset-fix-tarball/package/presets/orchestra-roles.patch.yml
b9751ac807e588ea249d828276418d6931170437bbc5626c037a42d66a11d8bc   （与仓库内同文件逐字相同）
$ diff -r /tmp/orchestra-preset-fix-0.6.0/lib /tmp/orchestra-preset-fix-tarball/package/lib → IDENTICAL

$ node scripts/verify-role-preset-registration.mjs --bundle /tmp/orchestra-preset-fix-tarball/package
# profile=orchestra-preset-compose-BP5s2T bundle_layers=orchestra-dsh(2 file(s))
… 12 × ROLE_PRESET_ROW …
# role_preset_rows=12 expected=12 composed_entries=15 warnings=0
EXIT=0
```

### 2.4 工作项 2 —— 会话日志读取器（v4 优先 / v3 回退 / 都没有则报错）

**全仓扫描**：`grep -rn "session\.v3\|session\.v4" scripts/ src/` 命中 3 处（`src/` 0 处）：

| 命中位置（符号） | 处置 | 为什么 |
|---|---|---|
| `scripts/check-session-readable.mjs::readStoredEvents` | **改** | 硬编码 `session.v3.jsonl.zstd` ⇒ 对 0.1.7 写的 v4 会话直接 `no session.v3.jsonl.zstd`。改为 `sessionLogPath()`：正则 `^session\.v(\d+)\.jsonl\.zstd$` 收集所有世代、取**最大世代**（宿主 `resolveGenerationInDirectory` 同规则：`sort(desc)[0]`），找不到则 `throw`（"报错而不是返回空"，沿用既有纪律）。 |
| `scripts/verify-role-identity.mjs::realSessionIds` | **改** | 发现逻辑用 `existsSync(store/id/"session.v3.jsonl.zstd")` 过滤 ⇒ 当前宿主写的会话**全部不可见**（会让该脚本的负例校准找不到真实对照样本）。改用 `hasStoredLog()`（新导出，与读取器同一规则）。同文件 `slugForCwd` 的文档注释同步改成 `session.v<N>`。 |
| `scripts/verify-d2-approval.mjs::writeSyntheticLog` | **不改（有意）** | 它是**自造夹具**：`syntheticHeader()` 写的 header 就是 `version: 3`，文件名与 header 同代际才对；文件名仍能被新读取器选中（该目录只有这一个世代）。回归实测见下（`APPROVAL_OK`）。 |

**判据（原始输出）**

```console
# 真实 v4 会话（本轮之前的存量；目录里只有 v4）
$ ls -la ~/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_E2E--/session-83ec3a88-7371-455b-8ffa-c49f1860a7cf/
-rw-r--r--@ 1 yuantian staff      0 Sep 23 02:16 session.lock
-rw-------@ 1 yuantian staff  51278 Sep 23 02:28 session.v4.jsonl.zstd
$ node scripts/check-session-readable.mjs <该目录>
READABLE  session-83ec3a88-7371-455b-8ffa-c49f1860a7cf
          …/session.v4.jsonl.zstd
          81 event(s)

# 真实 v3 会话
$ node scripts/check-session-readable.mjs ~/.dsh/sessions/--Users-yuantian-Developer-orchestra-dsh--/session-59652cbf-7039-4297-94d9-834e84e8d95d
READABLE  session-59652cbf-7039-4297-94d9-834e84e8d95d
          …/session.v3.jsonl.zstd
          4 event(s)

# 同一目录里同时放 v3 + v4 ⇒ 必须选 v4（世代号大者）
$ ls -la tmp/preset-registration-verify/both-generations/
-rw-------  409   session.v3.jsonl.zstd
-rw-------  51278 session.v4.jsonl.zstd
$ node scripts/check-session-readable.mjs tmp/preset-registration-verify/both-generations
READABLE  session-83ec3a88-7371-455b-8ffa-c49f1860a7cf
          tmp/preset-registration-verify/both-generations/session.v4.jsonl.zstd
          81 event(s)

# 把 v4 删掉 ⇒ 回退 v3
$ node scripts/check-session-readable.mjs tmp/preset-registration-verify/only-v3
READABLE  session-59652cbf-7039-4297-94d9-834e84e8d95d
          tmp/preset-registration-verify/only-v3/session.v3.jsonl.zstd
          4 event(s)

# 两者都没有（空目录）⇒ 必须报错并非空
$ ls -la tmp/preset-registration-verify/no-log-session-dir
（空目录，0 条目）
$ node scripts/check-session-readable.mjs tmp/preset-registration-verify/no-log-session-dir
ERROR  /Users/yuantian/Developer/orchestra-dsh/tmp/preset-registration-verify/no-log-session-dir
          no session.v<N>.jsonl.zstd under …/no-log-session-dir (looked for session.v*.jsonl.zstd)
1 log(s) would be refused
EXIT=1

# 既有防恒真校准仍然分得清"检测到"与"没检测"
$ node scripts/check-session-readable.mjs --self-test
known event types: 59
detects a planted orchestra/blueprint event: yes
reports a clean log as clean: yes
EXIT=0

# 受该读取器服务的另一个脚本未回归
$ node scripts/verify-d2-approval.mjs --self-test
APPROVAL_OK    /tmp/verify-d2-approval-FWgBzD/session-calibration-paired hanging 0 dangling 0
          dangling_approval: ask-calibration for tool bash was asked at seq 5 in turn 1 and never decided
# self-test dangling=detected
EXIT=1        ← 该脚本的既有语义：检出注入缺陷即为预期结果
```

**一个如实登记的读数**：另一个更老的 v3 会话（`session-b589a3b2-720a-4c20-ae1d-705119542813`）**解码成功（24 events，路径为 v3）**，但被**宿主自己的** `validateStoredEvents` 拒绝：

```
REFUSED   session-b589a3b2-720a-4c20-ae1d-705119542813
          …/session.v3.jsonl.zstd
          24 event(s)
          stored session "…" failed validation: Error: session event at seq 7 message must have system-prompt source
```

这是**该旧日志内容**与当前宿主校验规则的差异（与该文件名的世代选择无关：同一目录只有 v3，也正是回退路径生效的证明）；换一个 v3 日志（`session-59652cbf`）即 READABLE。

### 2.5 工作项 3 · 干净 worktree 门 + 制品

```console
$ git worktree add --detach /tmp/orchestra-preset-fix-0.6.0 eb7a71d5ab26b6a411046a38af17eab384bf3b1b
HEAD is now at eb7a71d fix(bundle): deliver the 12 role presets via dsh.bundle.patch, not an inert include
$ ls -d /tmp/orchestra-preset-fix-0.6.0/lib
ls: /tmp/orchestra-preset-fix-0.6.0/lib: No such file or directory      # 无旧 lib/
$ ln -sfn /Users/yuantian/Developer/orchestra-dsh/node_modules /tmp/orchestra-preset-fix-0.6.0/node_modules

$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.client.json
TYPECHECK_EXIT=0
$ npm run build
ℹ [orchestra-dsh/client] lib/client.js 12.24 kB │ gzip: 3.83 kB
✔ [orchestra-dsh/client] Build complete in 33ms
BUILD_EXIT=0                      # lib/ 69 文件
$ npm test
# tests 295 / # pass 295 / # fail 0 / # cancelled 0 / # skipped 0
NPM_TEST_EXIT=0
$ npm pack --cache /tmp/dsh-npm-cache      → PACK_EXIT=0（读数见 2.3）
```

### 2.6 工作项 3 · 装进 dev-orchestra（只加不改）+ 三件套

**profile 配置三个文件前后逐字相同**（`cordis.patch.yml` 里 `accept-encoding: identity` 在位）：

```console
$ cd ~/.dsh/profiles/dev-orchestra && shasum -a 256 package.json cordis.patch.yml pnpm-workspace.yaml
b1b16a0c711c077cf12e162e727b22cf8a5d5245909792c5302480f781831c97  package.json
099e24185eed68dc254e15d8099068fe6738b8e69f3aa7ea44a24cbf7644e744  cordis.patch.yml
4769af759c67c3d0a37b5db3a8c180c6d9fe507ed1a3f66a814e0f4b5331ebd3  pnpm-workspace.yaml
（备份：package.json / cordis.patch.yml / pnpm-workspace.yaml → *.bak-before-preset-fix-20260923-221308）
$ rm -f node_modules/.modules.yaml node_modules/.pnpm-workspace-state-v1.json node_modules/.pnpm/lock.yaml && pnpm install
Progress: resolved 3, reused 2, downloaded 1, added 3, done
Done in 599ms using pnpm v11.24.0
$ shasum -a 256 package.json cordis.patch.yml pnpm-workspace.yaml      # AFTER
b1b16a0c711c077cf12e162e727b22cf8a5d5245909792c5302480f781831c97  package.json
099e24185eed68dc254e15d8099068fe6738b8e69f3aa7ea44a24cbf7644e744  cordis.patch.yml
4769af759c67c3d0a37b5db3a8c180c6d9fe507ed1a3f66a814e0f4b5331ebd3  pnpm-workspace.yaml
PROFILE CONFIG UNCHANGED (identical hashes)
$ grep -n "accept-encoding: identity" cordis.patch.yml
44:          accept-encoding: identity
```

**三件套**：

```console
$ ls node_modules/ | grep -v dup-bak
argparse
js-yaml
orchestra-dsh
$ ls -la node_modules/@deepseek-ai
ls: node_modules/@deepseek-ai: No such file or directory            # 连目录都没有
$ node -e "console.log(require.resolve('@deepseek-ai/dsh-tools', {paths:['./node_modules/orchestra-dsh/lib']}))"
/Users/yuantian/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js
$ node -e "console.log(require.resolve('@deepseek-ai/cordis', {paths:['./node_modules/orchestra-dsh/lib']}))"
/Users/yuantian/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js
$ node -e "const p=require('./node_modules/orchestra-dsh/package.json'); …"
version 0.6.0 | dependencies {"js-yaml":"^4.1.0"} | peers 22 | dsh.bundle {"patch":["./cordis.patch.yml","./presets/orchestra-roles.patch.yml"]}
$ diff -r node_modules/orchestra-dsh /tmp/orchestra-preset-fix-tarball/package → IDENTICAL
```

**一件如实说明**：`require.resolve("@deepseek-ai/dsh-agent-preset")` **从插件 lib 视角仍然 MODULE_NOT_FOUND**——这**不是缺陷**：`dsh-agent-preset` 不在本插件 peers 里，它是**宿主自己的插件包**，由 Loader 用宿主基线解析（`mountRootInclude` 的 `HostResolvedRootInclude.import` → `loader.internal.import(specifier, bareModuleBaseUrl)`）：

```console
$ node -e "console.log(require.resolve('@deepseek-ai/dsh-agent-preset', {paths:['/Users/yuantian/.nvm/.../dsh/node_modules']}))"
/Users/yuantian/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset/lib/index.js
```

上一轮 §2.6 把这条 MODULE_NOT_FOUND 读成"源模块缺失导致 preset 解析失败"——**本轮的受控实验证明该归因不成立**：真正的原因是补丁形状（include 不是补丁键），与 `dependencies` 无关；`dependencies` 仍只有 `js-yaml`，未改（**没有**按上一轮 driver 建议把 `@deepseek-ai/dsh-agent-preset` 移进 dependencies——那会踩本仓防崩硬规则 1）。

### 2.7 工作项 3 · 重启 4600 + 启动日志

```console
$ lsof -nP -iTCP:4600 -sTCP:LISTEN
node 81500 … TCP 127.0.0.1:4600 (LISTEN)           # 旧实例
$ kill 81500 ; lsof -nP -iTCP:4600 -sTCP:LISTEN → （空）
$ dsh --profile dev-orchestra --port 4600 --no-open        # 受管后台作业 bash-700
dsh web: http://127.0.0.1:4600/?token=hPaO9vlB3KnEUEY8yCnl2BOz8B-Fw9Wqezf6AW4hIac
（stderr 只有 UNDICI-EHPA 实验性警告；无 "Failed to load plugins"、无 loader entry 失败、无 skipped-patch 警告）
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4600/                                    → 401
$ curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:4600/?token=hPaO9vlB3KnEUEY8yCnl2BOz8B-Fw9Wqezf6AW4hIac" → 303
$ curl -sL … -o /tmp/preset-fix-boot.html -w '%{http_code}' …                                      → 200
$ grep -o 'orchestra-dsh/client.js' /tmp/preset-fix-boot.html | head -2
orchestra-dsh/client.js
orchestra-dsh/client.js
$ lsof -nP -iTCP -sTCP:LISTEN | grep -E '4599|4600|4601'
node 4699 … TCP 127.0.0.1:4600 (LISTEN)     # 新实例
node 94859 … TCP 127.0.0.1:4599 (LISTEN)    # Owner 实例，PID 未变，全程未碰
（4601 未监听；本轮未碰）
```

### 2.8 工作项 3 · 真机落地验证（4600 上的新会话 + `orchestra_draft` 一次）

**步骤**：ego-browser 打开 `http://127.0.0.1:4600/?token=…`（空间 id `9`，页面 `p1`）→ 新建会话（工作区 `orchestra_E2E` = `/Users/yuantian/Documents/agentWorkspace/artifacts/projects/orchestra_E2E`）→ 发一条**只调用一次 `orchestra_draft`** 的指令，参数里给的是**离线先验过**的 12 角色 inlineTopology（`tmp/preset-registration-verify/twelve-role-inline-topology.json`，用 `lib/orchestra-topology.js::validateTopology` 预检 **problems: 0**）。

**旁证一：界面里的 preset 选择器（= 宿主 `agentPresets` 实时名册）** 现在列出 12 条 orchestra 预设（此前只有 shipped 4 条）：

```
标准模式 / PTC 模式 / 极简模式 / 创造模式
Orchestra Implementer · Orchestra Oracle · Orchestra Reviewer
Orchestra v0.4 Architect · Orchestra v0.4 Hardening Auditor · Orchestra v0.4 Implementer
Orchestra v0.4 Investigator · Orchestra v0.4 Oracle · Orchestra v0.4 Planner
Orchestra v0.4 Researcher · Orchestra v0.4 Reviewer · Orchestra v0.4 Verifier
```

**旁证二：会话日志（新会话，v4）** —— `session-c67d9332-b1e7-47cf-abf0-deb92a6ef42a`：

```console
$ ls -la ~/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_E2E--/session-c67d9332-b1e7-47cf-abf0-deb92a6ef42a/
-rw-r--r--@ 1 yuantian staff 0 Sep 23 22:15 session.lock
-rw-------@ 1 yuantian staff 47849 Sep 23 22:16 session.v4.jsonl.zstd
$ node scripts/check-session-readable.mjs <该目录>
READABLE  session-c67d9332-b1e7-47cf-abf0-deb92a6ef42a
          26 event(s)
$ node -e '…readStoredEvents(tool/result 原文)…'
header: {"id":"session-c67d9332…","version":4,"cwd":"…/orchestra_E2E","agentPreset":"standard"}
events: 26
request/header seq=12 {"provider":"minimax-cn","model":"MiniMax-M3","reasoningEffort":"high"}
tool/call seq=18 orchestra_draft
tool/result seq=19 isError=false
turn/end seq=25 {"kind":"completed"}
```

**`orchestra_draft` 工具返回原文（逐字，来自 v4 会话日志的 `tool/result` payload）**：

```
| 角色 | backend | preset | sandbox | permission | model | reasoningEffort | compositionTools | orchestraTools |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| v04-implementer | session | orchestra-v04-implementer-v1 | workspace-write | workspace-write | minimax-cn/MiniMax-M3 | high | tool-bash, tool-fs, tool-fs-search | orchestra_report |
| v04-reviewer | session | orchestra-v04-reviewer-v1 | read-only | custom | minimax-cn/MiniMax-M3 | high | tool-bash, tool-fs, tool-fs-search | orchestra_report |
| v04-investigator | session | orchestra-v04-investigator-v1 | read-only | custom | minimax-cn/MiniMax-M3 | high | tool-bash, tool-fs, tool-fs-search | orchestra_report |
| v04-verifier | session | orchestra-v04-verifier-v1 | read-only | custom | minimax-cn/MiniMax-M3 | high | tool-bash, tool-fs-search | orchestra_report |
| v04-architect | session | orchestra-v04-architect-v1 | read-only | custom | minimax-cn/MiniMax-M3 | high | tool-fs, tool-fs-search | orchestra_report |
| v04-researcher | session | orchestra-v04-researcher-v1 | read-only | custom | minimax-cn/MiniMax-M3 | high | tool-fs, tool-fs-search | orchestra_report |
| v04-hardening-auditor | session | orchestra-v04-hardening-auditor-v1 | read-only | custom | minimax-cn/MiniMax-M3 | high | tool-bash, tool-fs, tool-fs-search | orchestra_report |
| v04-planner | session | orchestra-v04-planner-v1 | read-only | custom | minimax-cn/MiniMax-M3 | high | tool-fs, tool-fs-search | orchestra_report |
| v04-oracle | session | orchestra-v04-oracle-v1 | read-only | custom | minimax-cn/MiniMax-M3 | high | tool-fs, tool-fs-search | orchestra_report |
| legacy-implementer | session | orchestra-implementer | workspace-write | workspace-write | minimax-cn/MiniMax-M3 | high | tool-bash, tool-fs, tool-fs-search | orchestra_report |
| legacy-reviewer | session | orchestra-reviewer | read-only | custom | minimax-cn/MiniMax-M3 | high | tool-bash, tool-fs, tool-fs-search | orchestra_report |
| legacy-oracle | session | orchestra-oracle | read-only | custom | minimax-cn/MiniMax-M3 | high | tool-bash, tool-fs, tool-fs-search | orchestra_report |
charter draft draft-6a5ead65-6953-4a3e-9c54-dc08d562ac29@1 (pending) digest=691752a9042dfe6bbb1a5fd904f5560ce8d923f303c7c602e455af57c516aa28
```

**逐条对照判据**：
- **所有角色的 preset 都能解析**：12/12 行都带 `preset` 值（`orchestra-v04-*` 9 条 + legacy 3 条），**没有** `could not be resolved`；`isError=false`。角色行里的 `compositionTools` / `sandbox` 与 catalog 里 `RolePresetSpec` 的声明逐条一致（例如 `v04-verifier` = `tool-bash, tool-fs-search`、`v04-architect` = `tool-fs, tool-fs-search`）⇒ 不只是 `resolve()` 成功，`compositionInventory()` 也读到了真实插件行（若某条 preset `broken`，`resolveRolePresetFile` 会抛 `composition_invalid`）。
- **提案表正常产出**：表 + `charter draft …@1 (pending) digest=…` 摘要行齐全；落盘产物 `orchestra/charter/records.json`（136,472 B，写在 E2E 工作区，**不在仓库内**）。
- 本轮**只调用一次**工具，`turn/end` 为 `completed`（对比上一轮：`orchestra_draft` 5 次全败）。

---

## ③ 未做 · 未验证

**未做（本轮范围外/被边界禁止）**

1. **B2（web 的 `accept-encoding`）未修**：按"配置项、dev-orchestra 已有"处理，`~/.dsh/profiles/web/cordis.patch.yml` 一字未动。
2. **web 安装 / 4599 重启 / 4601 全部未做**：4599 PID 94859 与轮次开始时一致；`web` profile 仍是回滚后的安装前状态；未装 web、未起 4605。
3. **未 push / 未 tag / 未 publish / 未 bump 版本**（仍 0.6.0）。
4. **未实现交付层**、未重排 driver 指引、未改 persona 文案、未删任何产品守卫。
5. **未做完整交付测试**（建队 → `orchestra_create` → 懒加载物化 → 派活 → 打回 → 收束 → A2A → 重启后角色身份）：按任务要求留给 Owner 手测。
6. **`/team` 斜杠命令入口本身未重跑**：本轮走的是 `orchestra_draft` 直接调用（任务允许二选一）；`/team` 的交互式 onboarding 未复测。
7. **未把新判据接进 `npm test`**：见下一跳建议第 1 条。

**未验证（本轮无法确认的读法）**

- **12 条 preset 的"激活不 broken"只到 `orchestra_draft` 这一层**：`role_blueprint_preview` 证明每条 preset 能解析且能读出插件行；但**每条 preset 真正 mount 出一个角色会话**（首次派活物化、persona/工具/premission 落地）没做——那是 Owner 手测的建队路径。
- **`preset` 的 `compositionInventory()` 只以"未报 `composition_invalid`"间接验证**，未逐条打印 inventory（draft 成功即蕴含未 broken）。
- **旧 v3 会话被宿主校验拒绝**（`session-b589a3b2`）的成因未深挖：本轮只确认"解码正常、拒绝来自宿主 `validateStoredEvents`、换一个 v3 日志即通过"，未判定该旧日志内容与当前规则的差异是否属预期。
- **`web-app` 层 5 个补丁文件与我们的 2 个文件在同一 profile 里的层序**只按 `loadProfileDirectory` 的 bundle 顺序推断，未做"谁覆盖谁"的专项实验（本插件的 preset 行 id 与 shipped 4 条不冲突，实测无覆盖警告）。
- 未对 `dsh --dump-config` 的**完整输出**做断言（只断言 `preset-orchestra-*` 行数与警告为空）。

---

## ④ 下一跳建议

1. **把本轮的两条判据接进维护套件**（本轮**故意没做**：`npm test` 的 295 基线是本轮冻结口径，加测试会让计数变成 296+）。具体：把 `scripts/verify-role-preset-registration.mjs` 以 `--bundle <repo>` 形式加进 `npm test` 的脚本清单，并在 `scripts/test-role-preset-roster.mjs` 里加一条"`dsh.bundle.patch` 必须列出 `./presets/orchestra-roles.patch.yml`"的断言——**这正是本轮缺陷的形态（声明与投递不一致），值得有守卫**。
2. **Owner 手测路径**：在 4600 上开新会话 → `/team`（走交互式 onboarding）→ 批准 → `orchestra_create` → 首次派活，验证"每条 preset 真能 mount 出角色会话"（本轮只到草案层）。URL：`http://127.0.0.1:4600/?token=hPaO9vlB3KnEUEY8yCnl2BOz8B-Fw9Wqezf6AW4hIac`。
3. **跨重启角色身份**（`AGENTS.md` 的必备项）仍未取得：建队成功后重启 4600 再派活即可验证；本轮重启只验证了"组合生效"。
4. **文档同步**：`docs/p0-report-0.6.0-web-acceptance.md` §2.6 / ⑤ 的两条建议已被本轮取代——`- include:` 方案（Option (b) `cordis-plugin-include` 入口行）**未被采用且不必要**；建议在该报告加一行"已由 `eb7a71d` 以 `dsh.bundle.patch` 列表修复"，避免后续 session 再走 include 那条路。
5. **web 放行后**：0.6.0 的 tgz 已更新（新 sha256 `49c10002…`），Phase 3 若重做，应使用**本制品**而不是 §附录 A1 里记的 `8250b6ea…`（旧制品已备份到 `/tmp/orchestra-preset-fix-backup/`）。

---

## ⑤ 文件级改动清单

**代码/配置（commit `eb7a71d`）**

| 文件 | 改动（符号） | 为什么 |
|---|---|---|
| `package.json` | `dsh.bundle.patch` 从字符串改为数组 `["./cordis.patch.yml", "./presets/orchestra-roles.patch.yml"]` | 宿主 `bundlePatchPaths` 的声明式投递；与 shipped `@deepseek-ai/dsh-web-app` 同形状。**未动** `dependencies`（仍只有 js-yaml）、`peerDependencies`、版本号。 |
| `cordis.patch.yml` | 删除末尾 `- include: ./presets/orchestra-roles.patch.yml`；新增一段注释说明声明位置与 `include` 为何不是补丁键 | `include` 不是补丁键，会被 warn+skip（改前实测 0 行）。 |
| `scripts/verify-role-preset-registration.mjs` | **新增**：`rolePresetRows` / `registrationFailures` / `syntheticProfile` / `main`（`--profile` 与 `--bundle` 两种模式） | 本轮判据本体：用宿主自己的 `loadProfileDirectory` + `composeEntries` 组合真实层，断言 12 条 preset 行；可用于源码树、已装 profile、解包 tgz 与任意负例目录。 |
| `scripts/check-session-readable.mjs` | `sessionLogPath`（新增导出）、`hasStoredLog`（新增导出）、`readStoredEvents` 改为按最大世代选文件 | F-070-2：0.1.7 写 v4，硬编码 v3 让读取器对**新会话**必然假失败。 |
| `scripts/verify-role-identity.mjs` | `realSessionIds` 改用 `hasStoredLog`；`slugForCwd` 文档注释更新 | 同一处"只认 v3"的发现逻辑会让真实 v4 会话不可见。 |

**有意不改**

| 文件 | 原因 |
|---|---|
| `scripts/verify-d2-approval.mjs::writeSyntheticLog` | 自造夹具，header `version: 3` 与文件名 `session.v3.jsonl.zstd` 同代际；新读取器仍能选中它（回归自测通过）。 |
| `scripts/build-role-presets.mjs` | 生成目标（`presets/orchestra-roles.patch.yml`）不变——方案不需要它改生成目标。 |
| `src/**` | 本轮无产品逻辑缺陷；12 条 preset 的解析路径本就正确，缺的是投递。 |

**证据/运行时痕迹（不入 git）**

| 路径 | 说明 |
|---|---|
| `tmp/preset-fix-evidence/01..07-*.txt` | 改前/改后/负例/解包 tgz/会话读取器/真机工具返回的原始输出 |
| `tmp/preset-registration-verify/{neg1,neg2,neg3,only-v3,both-generations,no-log-session-dir,twelve-role-inline-topology.json}` | 负例与控制组（`tmp/` 已 gitignore） |
| `/tmp/orchestra-preset-fix-0.6.0` | 干净 detached worktree（构建源） |
| `/tmp/orchestra-preset-fix-tarball/package` | 本制品解包副本 |
| `/tmp/orchestra-preset-fix-backup/orchestra-dsh-0.6.0.tgz.pre-preset-fix` | 被替换的旧制品（sha256 `8250b6ea…`，与上一轮记录一致） |
| `~/.dsh/profiles/dev-orchestra/*.bak-before-preset-fix-20260923-221308` | profile 三文件备份（内容与现状逐字相同） |
| `~/.dsh/sessions/…/session-c67d9332-b1e7-47cf-abf0-deb92a6ef42a/` | 本轮真机新会话（v4，26 events）——**保留勿删** |
| `~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/orchestra/charter/records.json` | 本轮 `orchestra_draft` 的落盘草案（136 KB） |
| 运行中实例 | `bash-700` = `dsh --profile dev-orchestra --port 4600 --no-open`（PID 4699）；停：`lsof -ti tcp:4600 \| xargs kill` |
