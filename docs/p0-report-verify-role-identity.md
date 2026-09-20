# P0 · G-P0 ① 报告（`verify-role-identity.mjs` = N7 判据）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **依据**：driver 裁定 I（用既存 fixture 自测，非 A/B 二选一）+ 计划 §4.7 步 3–6。
> **fixture**：`~/Documents/agentWorkspace/orchestra-e2e/orchestra/state/team.json`（`team-a594dc8e`，2 个 `phase: active` 角色）。
> **本轮只新增这一个脚本**；产品代码、§7、`.npmrc`、依赖面、契约、计划文件**均未动**。

---

## 1. 结论

**G-P0 ① 已建成并双向验证。** 正常模式 exit **0**；`--self-test` 检出并 exit **1**。

| 计划 §4.7 步 | 状态 |
|---|---|
| 步 2 从磁盘解 header + events（复用 `check-session-readable.mjs` 的 zstd 形状 + "解不出即报错"纪律） | ✅ 直接 `import { readStoredEvents }`，无第二份解码器 |
| 步 3 用**宿主自己的**投影/类型定义（不自造第二份解析器） | ✅ 用宿主 `agentPresetProjectionDefinition` 的 `init`/`apply` 做折叠；用宿主 `validateStoredEvents` 判可读 |
| 步 4 `--self-test`：换成**真实但非角色**的会话 id ⇒ 必须 `NOT_A_ROLE_SESSION` 且非 0 | ✅ exit 1 |
| 步 5 历史 id 也跑一遍 2–4 | ✅ 已实现（fixture 无 history，见 §4） |
| 步 6 自测对象用该 fixture | ✅ |

**G-S**：`npm run typecheck` **0**；`npm test` → **266 pass / 0 fail**（本脚本不进 `npm test`，它是 G-P0 闸脚本，按各自期望码单独判）。

---

## 2. 证据（`npm run build` 之后单跑，原始输出）

### 2.1 正常模式 —— 期望 0

```
$ node scripts/verify-role-identity.mjs --repo ~/Documents/agentWorkspace/orchestra-e2e \
    --team ~/Documents/agentWorkspace/orchestra-e2e/orchestra/state/team.json
IDENTITY_OK    implementer orchestra-team-a594dc8e-862d3f28-3d01-422d-adad-2d5fd84521cd preset=orchestra-implementer rows=5 tools=5 (no recorded composition to cross-check)
IDENTITY_OK    reviewer orchestra-team-a594dc8e-27f738a6-24c7-4970-a23b-dd2058dc862e preset=orchestra-reviewer rows=5 tools=5 (no recorded composition to cross-check)
# roles 2 ok 2 missing 0
exit=0
```

`rows=5 tools=5` 是**真实值**（见 §3 的自我更正）。

### 2.2 `--self-test` —— 期望 1

```
$ node scripts/verify-role-identity.mjs --repo … --team … --self-test
# self-test: role "implementer" sessionId orchestra-team-a594dc8e-862d… -> session-4d58eaa0-fa10-4c07-a96b-34c1eda45f2f (a real, non-role session)
IDENTITY_MISSING implementer session-4d58eaa0-fa10-4c07-a96b-34c1eda45f2f preset=standard rows=32 tools=32
          NOT_A_ROLE_SESSION: the session log names preset standard, the role records orchestra-implementer
IDENTITY_OK    reviewer orchestra-team-a594dc8e-27f738a6-24c7-4970-a23b-dd2058dc862e preset=orchestra-reviewer rows=5 tools=5
# roles 2 ok 1 missing 1
# self-test detected=yes
exit=1
```

### 2.3 另外三条检出路径（防止"只会说 OK"）

| 探针 | 注入 | 原始输出 | exit |
|---|---|---|---|
| **A** | 角色的 `blueprint.agentPreset` 改成**另一个合法预设** | `NOT_A_ROLE_SESSION: the session log names preset orchestra-implementer, the role records orchestra-v04-implementer-v1` | 1 |
| **B** | 改成**名册里不存在的预设** | `NOT_A_ROLE_SESSION: … the role records orchestra-does-not-exist` | 1 |
| **C** | `DSH_ORCHESTRA_CATALOG_ROOT` 指向空目录（**模拟 §7 未应用**） | `preset orchestra-implementer is NOT resolvable through the roster`（两个角色都报） | 1 |

A/B 用**临时 team.json 副本**注入，C 用环境变量注入 —— **都没有改产品代码，也没有发明 fixture**。

### 2.4 前置缺失 —— 期望 2

```
$ node scripts/verify-role-identity.mjs
usage: node scripts/verify-role-identity.mjs --repo <abs> --team <abs> [--self-test]                      exit=2
$ … --team /tmp/nope.json
verify-role-identity: team file not found: /tmp/nope.json                                                exit=2
$ … --team /tmp/badteam.json      (内容 '{bad')
verify-role-identity: team file is not readable JSON: Expected property name or '}' …                    exit=2
```

---

## 3. 过程中的两处自我更正（必须留痕）

1. **首版 `rows=0 tools=0` 是空转输出。** 我最初读 `role.blueprint.compositionRowIds`（fixture 里没有这个字段）⇒ 恒为 0。那样打印出来的行**看起来在报数、其实没有信息**。
   修法：改为经**宿主的 `readComposition`** 读预设文件正文，再交给**插件自己的 `parseRolePresetComposition`** 解析。现在 `rows=5 tools=5` 是真实行数。**没有自造第三份 YAML 解析器。**
2. **`--self-test` 首版挑错了替身。** 它挑到一个**目录存在但没有日志**的会话，于是停在"missing"，报的是"找不到日志"而不是 `NOT_A_ROLE_SESSION`。那只能证明"缺会话会被报缺"，**证明不了"真实但非角色的会话会被拒"** —— 而后者才是校准的目的。
   修法：`realSessionIds()` 只挑**确实有 `session.v3.jsonl.zstd`** 的会话；并把预设不一致的原因码显式写成 `NOT_A_ROLE_SESSION`。

---

## 4. 未做 / 未验证（如实）

| 项 | 状态 |
|---|---|
| **重激活路径的 `sessionHistory` 分支** | ⚠️ **已实现但未在真实数据上跑到**：fixture 的 `team-a594dc8e` 两个角色 `sessionHistory` 都是空数组，所以那条分支本轮**没有执行过**。**我不声称它已验证。** |
| **`rows`/`tools` 与"插件记录里写的预期组合"的逐项比对** | ⚠️ **部分**：本 fixture 的 `blueprint` **没有** `compositionRowIds`/`orchestraTools` 字段（v0.5.0 时代写的），所以行上打印 `(no recorded composition to cross-check)`。**这不是通过，是"没有可比对的东西"** —— 我把它显式打印出来，而不是让它看起来像一致。逐项比对的分支已实现（数量不符即失败），但**未在真实数据上跑到**。 |
| **计划 §4.7 步 4 的"`header.agentPreset` 起 + `agent-preset/selected` 事件推进"** | ✅ 已用宿主投影实现；本次 fixture 的日志里没有 selection 事件，所以折叠结果等于 header 值。**"事件推进"这一半未在真实数据上跑到。** |
| **计划 §4.7 步 4 的"工具名集"比对** | ⚠️ 我读的是**预设组合文件里声明的** 行/工具数，**不是**恢复实例实际挂载的工具面。真正的"实际挂载"要用 `agentPresets.compositionInventory()`，而它需要一个**活着的代理上下文**——本脚本是**纯读盘**，拿不到它。**这是本脚本的证据上限，必须写清。** |
| **步 1（建三个角色）/ 步 2 的重启 / 步 4 的"一次真实角色工具调用校准"** | ⬜ **未做**。按裁定 I，本轮只做**静态读盘**那部分。⇒ **"重启后角色身份完整"这条发布阻断项，仍未在 live 实例上验过。** 本脚本证明的是"记录与名册现在是一致的"。 |
| **`DIS-…` 环境变量覆盖** | 新增两个（`DSH_ORCHESTRA_CATALOG_ROOT` / `DSH_PLUGIN_DIR` / `DSH_HOST_PACKAGES`），用途是**注入故障以验证检出能力**，默认值即真实部署。 |
| **§7 / `.npmrc` / 依赖面 / 契约 / 计划文件 / S4 / D2 / G-BUDGET / 其余批 1 脚本** | ✅ 均未动 |

---

## 5. 下一跳

**批 1 的 G-P0 现状**：①（本脚本，正常 0 ✅ / 校准 1 ✅）、⑦ `test-tool-schemas.mjs` ✅、⑧ `test-orchestra-role-presets.mjs` ✅、G-P0 ⑤ `verify-role-presets-roster.mjs` ✅ ⇒ **已绿 4 条**。
**未建**：③④ `verify-d2-approval.mjs`(+`--self-test`)、⑥ `test-orchestra-archive.mjs` 扩展、⑨ `test-tier0-predicate.mjs`、G-BUDGET `verify-agent-budget.mjs`。

**建议下一轮**：**⑥ D3**（`test-orchestra-archive.mjs` 扩展 + 归档先停后记）或 **⑨ `test-tier0-predicate.mjs`**。
若你更看重**把本脚本的证据上限补上**（即 `compositionInventory` 那一层），那就需要一次 live 会话 —— 那是裁定 I 明确拆出去的部分，需要 Owner 批准，**不由我提议**。
