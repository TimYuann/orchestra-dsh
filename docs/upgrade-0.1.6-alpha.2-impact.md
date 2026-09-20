# 升级适配报告 · DSH 0.1.5-rc.2 → 0.1.6-alpha.2 对 orchestra-dsh 的影响

| | |
|---|---|
| **区间** | `dsh-v0.1.5-rc.2` → `dsh-v0.1.6-alpha.2` |
| **模式** | **npm 模式**（本机无 deepseek-harness checkout，`DSH_SOURCE_PATH` 未设置） |
| **来源** | npm registry 已发布包 + GitHub compare enrichment |
| **规模** | **1687 commits**（enrichment 列出前 250 条，`truncated: true`）、**4 个 revert** |
| **材料** | `a/` = 0.1.5-rc.2 依赖闭包；`b/` = 0.1.6-alpha.2 依赖闭包；`manifest-diff.txt`、`commits.txt`、`reverts.txt` |
| **审计日期** | 2026-09-20 |

## 范围声明（**重要，勿误读为完整兼容审计**）

按技能尺寸规则，1687 commits 属最大档、本该跑全部六个分面。**本报告的审计范围被限定在 orchestra-dsh 的消费面**，即：

1. 组合与预设（`dsh-agent-presets` / `dsh-permission-presets` / `cordis` / `cordis-plugin-include`）+ 组合引擎 `dsh-app-boot`
2. 会话生命周期与服务面（`dsh-agent` / `dsh-session` / `dsh-api-session-controller` / `dsh-subagent`）
3. 工具面与模型可见面（`dsh-tools` / `dsh-llm` / `dsh-commands` / `dsh-system-prompt`）
4. 审批、权限与沙箱（`dsh-user-approval` / `dsh-permission-presets` / `dsh-sandbox` / `dsh-sandbox-policy` / `dsh-scope` / `dsh-fs`）

**未覆盖**：CLI 命令与 flag 面、SDK JSON-RPC / ACP / hooks 协议面、Web UI 面、Python SDK、SQLite 持久化后端的 schema。这些对本插件**不构成消费面**，但本报告不能用来判断它们是否兼容。

**已知方法学盲区（自有）**：driver 的导出集机械比对只解析了各包 `lib/index.js` 末尾的显式 `export {}` 语句，因此**漏掉了 `export *` 转出的类型与子路径导出**。两处由此被漏报、后由分面 recon 补上并经 driver 复核确认：`RequestImageOffloadPolicy`、`AssistantProvenance`。后续同类审计必须同时比对 `lib/**/*.d.ts`。

---

## Verdict（直接回答比较性问题）

**是的，`to` 相对 `from` 含大量变更（1687 commits），但对 orchestra-dsh 而言：变更多于破坏。** 全部 19 个依赖中，**我们实际 import 的导出符号零移除**；`cordis`、`dsh-fs`、`cordis-plugin-include`、`cordis-plugin-timer` 的 `lib/**` **逐字节相同**；D4 与 D2 的全部判据所依赖的引擎事实**逐字未变**；会话数据格式未变（`SESSION_FORMAT_VERSION` 两树皆为 3），**旧会话文件读取不受影响**。

**4 个 revert 全部落在 Web UI / desktop 侧**，与我们的消费面无关；**没有任何 revert 撤回了我们依赖的行为**。

**必须处理的只有三条**（见 §5 迁移清单）：
1. **19 条 `@deepseek-ai/*` 依赖范围硬失配**（其中 2 条是精确锁）——不改则 typecheck / `npm pack` 解析指向旧树。
2. **`dsh-subagent` 新增进程级容量上限**（`maxActiveSubagents: 8` / `maxDepth: 1`）——这是**唯一真正改变我们运行时行为**的一条，且走的是我们在用的 `startContinuable` 路径。
3. **§7.2 的 `patchReload: "live"` 依据作废**（`PATCH_RELOAD` 在新 `dsh-app-boot` 全 `lib/` 零命中）。

**另有一条不属于"兼容性"但重要性更高的战略发现**：DSH 0.1.6-alpha.2 引入了**可选**的官方 agent-team 能力（`ctx.agentTeams`），与 orchestra-dsh 的核心地盘高度重叠。见 §6。

---

## §1 Reverts（区间内被撤回的行为）

| # | commit | 内容 | 对我们的影响 |
|---|---|---|---|
| 1 | `81e05ab` | Revert "feat(client): optimize code block previews and source highlighting" | 无（Web 客户端侧） |
| 2 | `a4452b2` | Merge PR #4442 revert-3906 perf/code-block-preview-renders | 无（Web 客户端侧） |
| 3 | `03f93dc` | revert(web): remove raw disclosure reset on record selection | 无（Web 客户端侧） |
| 4 | `d9a55c7` | fix: revert desktop | 无（桌面侧） |

---

## §2 破坏项（按对我们的影响排序）

### A. 真实影响运行时行为 —— 必须处理

#### A-1 `dsh-subagent` 新增进程级容量上限（`ACTIVATION_LIMIT_REACHED`）

**新增**（0.1.5-rc.2 无此机制）：

```js
/** Process-local slots shared through uninterrupted continuable parent links. */
var ActivationPool = class {
  slots = new Set();
  reserve(capacity) {
    if (this.slots.size >= capacity) throw new SubagentError(
      `subagent limit reached (active child limit: ${capacity}); wait for an existing child to finish or complete this work with the current agents`,
      "ACTIVATION_LIMIT_REACHED");
    ...
```

- 默认值：`Config { maxDepth: 1, maxActiveSubagents: 8 }`（用户设置段 `"subagent"` 可覆盖）。
- **我们的调用点**：`src/subagent-node.ts:149` 的 `subagents.startContinuable({...})` —— 即"用持久可续子代理承载 DAG 节点"这条路径。
- **失败形态**：进程内直接调用会拿到 `SubagentError(code="ACTIVATION_LIMIT_REACHED")`；Remote 面（浏览器/API 调用者）被映射为 `RemoteError("subagent/delivery-unavailable", "subagent follow-up is temporarily unavailable")`。
- **Adapt**：① 在 `subagent-node.ts` 的失败路径上**识别 `ACTIVATION_LIMIT_REACHED` 并给出类型化事实**（不要让它变成未类型化异常）；② 评估我们的并发活跃子代理上限是否可能超过 8 —— 若会，需在部署侧 `settings.subagent.maxActiveSubagents` 提高，**本插件无法自行设置**；③ 记录该上限为部署前提，写进 `docs/dsh-native-capabilities.md`。
- **待验证**：`maxDepth: 1` 对我们的拓扑是否有约束（我们的角色会话是 `ctx.agents` 的一等会话，与 subagent 父链的深度计数关系尚未实测）。

#### A-2 依赖范围硬失配（19 条）

**机械实测**（semver 7.8.5）：

```
0.1.6-alpha.2 satisfies ^0.1.5-rc.2 ?  false
0.1.6-alpha.2 satisfies >=0.1.5-rc.2 ? false
```

预发布匹配规则要求范围内存在**同 major.minor.patch 且有预发布后缀**的比较器，故 `^0.1.5-rc.2` 连 `>=` 都不成立。

- 本仓 `node_modules` 仍为 0.1.5-rc.2 ⇒ **typecheck 正对着旧版跑**。
- 其中 **2 条是精确锁**（非 `^`）：`@deepseek-ai/dsh-user-approval: "0.1.5-rc.2"`、`@deepseek-ai/dsh-session-title: "0.1.5-rc.2"`。
- **风险等级已下调**：两个 profile 的 `pnpm-workspace.yaml` 均为 `autoInstallPeers: false`，故未满足的 peer **不会触发自动安装**，不会产生实体副本，不会踩 2026-08-16 那条双实例事故线。本项属于**必须同步的元数据**，而非加载阻断。
- **Adapt**：19 条 peer + 对应 devDependencies 全部改为 `^0.1.6-alpha.2`（2 条精确锁同样改为该范围），然后 `npm install` → `npm run typecheck` → `npm test`。

### B. 明确不适用于我们（已亲验零引用）

| 项 | 内容 | 我们的引用数 |
|---|---|---|
| `dsh-permission-presets` | `PermissionSelect` 接口删除；`selectFor(state)` → `catalog()`；`permissions` 会话投影 wire **去掉 `options`**（`stateVersion` 仍为 2，**静默收窄**） | `selectFor` = 0；我们用 `permissionService.current/set`、`permissions.resolve`、`defaultPreset` —— **全部仍在、签名未变** |
| `dsh-sandbox` | `SandboxProvider.confine` **同步 → 异步**（自实现/mock provider 必须改） | 2 处命中**均为注释文字**（`src/orchestra.ts:464/700` 的 "confines its path"）⇒ 我们不实现也不调用 `confine` |
| `dsh-sandbox` | `approveEscalation` 新增**等值模式免审批快路径**（旧行为：非严格升权必抛） | 0；我们不依赖"非升权必抛" |
| `dsh-scope` / `dsh-agent` | 事件 **`agent/session-start` 被删除**（无替代；`source` 迁入 `agent/created` payload） | 0 |
| `dsh-llm` | `AssistantProvenance` → `AssistantProviderMetadata`（**硬改名，无别名**） | 0 |
| `dsh-llm` | `RequestImageOffloadPolicy` 删除（→ `LlmImageRequestBudget`） | 0 |
| `dsh-llm` | `offloadRequestImagesWithPolicy` 删除、`offloadedImagePrefixCount` 去导出 | 0 |
| `dsh-tools` | `ctx.codeRuntime` → `ctx.ptcRuntime`；peer `dsh-code-runtime` → `dsh-ptc-runtime`；`CodeSdkLanguage` → `PtcSdkLanguage` | 0 |
| `dsh-sandbox-policy` | `resolveWorkspaceRoot`：**相对路径现在抛错**，且不再 realpath 归一 | 0（`workspaceRoot` 在 `src/` 零命中）；**但部署侧若有相对 `workspaceRoot` 会开始抛错**，值得核一次 |
| `dsh-api-session-controller` | `session/control` 流删除 `queue` 帧与 baseline `queues`；`SessionQueuedItem` 类型删除；`updateQueue` 同步→**异步且会复活冷 Agent** | 0 |
| `dsh-commands` | `CommandDescriptor.definitionId` **新增可选** | 我们在 `src/orchestra.ts:5260` 注册 `/team`。**已裁定：零改动** —— 类型为可选，且运行时 `...(definition.definitionId === void 0 ? {} : {...})` 显式处理缺省 |
| TYPERT | 生成 codec 字段 `schema` → `create`（记忆化零参工厂），22+ 处 | 我们不消费 typert 生成码 |

### C. 语义变更（需知悉，非破坏）

- `agent/created`：`@mode emit` → **`@mode serial`**，payload 增 `source` / `signal` ⇒ **listener 抛错现在会让创建失败并跳过后续 listener**（旧：异步拒绝只 warn）。
- `dsh-subagent` 委派新增 `permissionPreset` 捕获并写 `permission/preset` 事件；结算通知**只取非空 text 块**（不再含 reasoning）。
- `pinInitialPermission`：恢复持久 preset 为 `"auto"` 而该集成不在线时**抛错**。
- `dsh-session`：新增 `ctx.sessions.registerMessageProjection()`；`eventAt` / `snapshotEvents` / `ownEvents` **全部标记 `@deprecated`（禁止新调用）**。

---

## §3 确认未变（这一节与破坏项同等重要）

**逐字节相同（`diff -rq` 差异条目 0）**：`cordis`(4.0.2)、`dsh-fs`、`cordis-plugin-include`(1.0.7)、`cordis-plugin-timer`。
**逐字节相同的关键文件**：`dsh-tools/lib/types/schema.js`、`schema.d.ts`、`json-schema.js`；`dsh-user-approval/lib/index.js` 与全部 `.d.ts`；`dsh-agent-presets` 的 `preset.d.ts` / `authoring` / `metadata` / `display` / `specifier` / `composition-inventory`。

| 我们依赖的事实 | 结论 |
|---|---|
| **D4**：工具返回值必经 `snapshotToolValue` → `validateJsonSchemaValue(tool.output.schema)` → 抛 `ToolOutputError` | **未变**。`snapshotToolValue` 函数体与唯一调用点（`createSuccessResult` 内）逐字相同；`snapshotJsonValue` 73 字符逐字相同 |
| **D4**：`additionalProperties: false` ⇒ 多余键**报错而非丢弃** | **未变**。`json-schema.js` 整文件 `cmp` 通过 |
| **D4**：`defineTool` 必填字段面无新增 | **未变**（两份拷贝分别 1948/3244 字符逐字相同）。真实 API 为 `{name, description, parameters, output: {schema, render}, execute}`；我们 18 个工具用的正是它 |
| `ToolExecutionInput.agent` | **未变**（仅新增可选 `schema?`） |
| `ctx.systemPrompt.section(...)` | **签名与必填形状未变**（`interpolate` 纯可选；我们 3 处调用文本不含 `{{`） |
| **D2-a / D2-c 全部机制判据** | **逐条仍然成立**：①先无条件 append `approval/asked` 再判策略 ②`effectivePolicy==="never"` ⇒ `decide()` 早返回 `"rejected"`，**waterfall 不可达** ③`asked`/`decided` 成对、宿主写、被回合包住（`hasOpenTurn` 前置 + 包内不变式） |
| `setApprovalPolicy(session, "never")` | **未变**（`APPROVAL_POLICIES=["ask","never"]`；`lib/types/index.d.ts` 字节相同） |
| **S4 落点** `agent/turn-stopping` | **未变**：宿主实测 `@mode serial`，`(payload:{agent,turn,signal}) => Promise<void>|void`，"在边界提交前被 await"，且按 scope 过滤派发 |
| `agent/status`、`agent/inbox/*`、`agent/pre-step`、`agent/request*` | **全部逐字未变**（事件面 13 → 12，唯一增删是 `agent/session-start` 的移除，**无改名**） |
| **S2 落点**：`sessionController` 公开方法集 | **旧 19 == 新 19，零增删**；剔注释后类体**字节相同**；`resolveAgent(sessionId)` 仍在、签名与返回形状不变（失败联合仅新增 `session/writer-held`）；`prompt(request, signal)` 逐字不变；`resume`/`resumeObserved` **仍是 private，仍未进服务面** ⇒ **P0-F3 的更正存活** |
| `ctx.agents` | 15 个声明成员全在，零增删；`create`/`resume`/`get` 逐字不变；`send`/`steer`/`followup`/`inject`/`whenIdle` 为 `Agent` 实例方法，逐字相同 |
| `agent/session-start` | 删除 —— **我们的监听器只有 `agent/status` / `internal/service` / `session/event`，零引用** |
| **会话数据格式** | `SESSION_FORMAT_VERSION` 两树皆 **3**，版本守卫与报错文案未变。新增的投影强校验只针对 `image/offload`（旧树 0 命中）⇒ **旧会话文件读取不受影响** |
| **预设发现** | `PresetRoot` 仍为 `{path, trust}`、`trust: 'system'\|'user'`、仍扫每目录 `agent.cordis.yml`、`PRESET_ID`/`COMPOSITION_FILE`/Config schema **逐字节相同**；`expandHomePath` **逐字符相同** ⇒ **我部署的 12 个目录不会变非法** |
| `mountPreset` / `presets.resolve(id)` / `defaultId` | 签名未变（`mountPreset` 体内仅 `await inactiveRows(tree)`，异步激活失败现在会 reject）；`resolve` 逐字符相同 |
| 档位 → approval 映射 | `workspace-write → ask`、`danger-full-access → never` **未变**（§4.8 第 622 行的机制级成因仍成立） |
| `setSandboxMode` / `SandboxMode` | 取值集合与签名未变（`SANDBOX_MODES` 逐字相同） |

**§7 组合引擎**：`composeEntries` **逐字相同**（层序与"恰好一行"仍成立）；`applyEntryPatches` 的**浅替换逻辑未变**（仅把 `structuredClone` 挪到早退之后、无 patch 时返回浅拷贝）⇒ **§7.1 的三条写法纪律仍成立**，dev 的 patch 仍然正确。

---

## §4 边界签名表

| API 面 | from (0.1.5-rc.2) | to (0.1.6-alpha.2) | 变了？ |
|---|---|---|---|
| `ctx.sessionController` 公开方法集 | 19 个 | 19 个，同名 | **否** |
| `sessionController.resolveAgent(sessionId)` | `Promise<{agent}\|{error}>` | 同，失败联合 +`session/writer-held` | 否（增） |
| `sessionController.prompt(request, signal)` | 逐字 | 逐字 | **否** |
| `ctx.agents` 声明成员 | 15 | 15 | **否** |
| `agent/turn-stopping` | serial, `{agent,turn,signal}` | 同 | **否** |
| `agent/status` / `agent/inbox/*` | 逐字 | 逐字 | **否** |
| `agent/session-start` | emit | **删除** | **是（移除）** |
| `agent/created` | emit, `{agent}` | **serial, `{agent,source,signal?}`，可失败** | **是** |
| `defineTool` 必填字段 | 4 | 4 | **否** |
| 工具结果校验链 | 逐字 | 逐字 | **否** |
| `ToolExecutionInput.agent?` | 在 | 在（+`schema?`） | 否（增） |
| `ctx.systemPrompt.section()` | 逐字 | 逐字 | **否** |
| `setApprovalPolicy(session,'never')` | 在 | 在，字节相同 | **否** |
| `approval` asked/decided 契约 | 无条件 asked → 判策略 | 同（`lib/index.js` 字节相同） | **否** |
| `PresetRoot{path,trust}` / 扫描 | 逐字 | 逐字 | **否** |
| `expandHomePath` | 逐字 | 逐字 | **否** |
| `composeEntries` 层序 | 逐字 | 逐字 | **否** |
| `applyEntryPatches` 浅替换 | 按键浅替换 | 同 | **否** |
| `PATCH_RELOAD` / `patchReload` | 存在 | **全 lib 零命中** | **是（移除）** |
| `SESSION_FORMAT_VERSION` | 3 | 3 | **否** |
| `ctx.subagents.startContinuable/sendMessage/listChildren/drainContinuableChildren` | 4 个 | 4 个，签名同在 | **否** |
| `dsh-subagent` 容量 | 无上限 | **`maxActiveSubagents:8` / `maxDepth:1`** | **是（新增）** |
| `SandboxProvider.confine` | 同步 | **异步** | **是** |
| `approveEscalation` 等值模式 | 抛错 | **放行** | **是** |
| `permissions` 投影 wire | `{options,currentValue}` | **`{currentValue}`** | **是** |
| `CommandDescriptor.definitionId` | 无 | 可选新增 | 否（增） |
| `@deepseek-ai/*` peer 范围 | `^0.1.5-rc.2` | `0.1.6-alpha.2` | **是（我们必须同步）** |

---

## §5 迁移清单（编号 = 执行顺序）

1. **同步依赖面**：19 条 peerDependencies + 对应 devDependencies → `^0.1.6-alpha.2`（含 2 条精确锁 `dsh-user-approval` / `dsh-session-title`）。**保持 `@deepseek-ai/*` 只进 peer + dev、严禁进 `dependencies`。**
2. `npm install` → `npm run typecheck` → `npm run build` → `npm test`，确认基线仍绿（升级前 254 pass）。
3. **处理 A-1**：在 `src/subagent-node.ts` 的 `startContinuable` 失败路径上识别并类型化 `ACTIVATION_LIMIT_REACHED`；评估并发上限 8 是否够用；把 `maxActiveSubagents`/`maxDepth` 记为部署前提。
4. **改写 §7.2**：`patchReload: "live"` 的依据作废，需按新 `dsh-app-boot` 的实际行为重写该表；dev 的 patch 文件本身**不需要改**（`composeEntries` 与浅替换语义均未变）。
5. **修正 D2-a 的判据措辞**：`decide()` 中 `signal?.aborted` 的早返回**在 `never` 判断之前**，故「已中止 + never」返回 `cancelled` 而非 `rejected`。断言必须是 `outcome ∈ {allowed-once, rejected, cancelled, unavailable}`；**不得断言 never 必为 `rejected`**（否则在预中止信号上假失败）。
6. **重跑 G-PRE**：`node scripts/check-p0-preconditions.mjs`（升级后引擎事实需重新确认）。
7. 记录新事实到 `docs/dsh-native-capabilities.md`：`agent/session-start` 已删除、`agent/created` 转 serial、`ctx.subagents` 新上限、`patchReload` 消失。
8. **§7-dev 的 patch 与 12 个名册目录无需改动**（已证逐字节兼容）；dev 实例重启后仍有效。

---

## §6 Agent Teams 的定位（**已被 Owner 校正；勿误读为范围问题或竞争面**）

0.1.6-alpha.2 的 agent-team 能力（`ctx.agentTeams`）是**可选的载体（substrate）之一**，与"可见 session""subagent child"同族 —— 由 **driver 在运行时按需选择的一种手段**。它**不构成范围问题，也不改变 0.8.0 的任何设计**。本仓在 0.5.5.0 时期即已知悉该能力（当时需命令行开启）并评估过其代价。

**已知边界（本仓早已记录，非新发现）**：`SpawnTeammateRequest` 只有 `{name, description, prompt, context:'fresh'|'fork', provider, signal}` —— **没有 preset 字段**；team member/child 加入父的 LIVE preset，**无法挂载自己的组合**。这正是 `src/subagent-node.ts` 文件头已经写明的同一条边界：

> "a child joins its parent's LIVE Agent Preset rather than mounting its own composition; its approval policy is pinned to `never` at the delegation boundary… Per-child variation is limited to persona, tool filter, and the model route."

⇒ **team member 结构上不能承载"受治理的角色"**；而 D1/N7 要证的恰恰是角色身份（preset + 工具 + 权限）跨重启完整 —— 那必须是一等会话。

**它默认关闭**：`DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]`；两个 agent-team 包在 `OPTIONAL_BUNDLES`（注释：由插件管理器提供、默认关闭）。

**它对 0.8.0 计划的影响：无。** 我们搭的是 **host 层**（候选身份 / 证据 / 租约 / 合并门 / 对账 / 决策队列）——**与节点由哪种载体承载正交**。"用可见会话还是用 subagent/team member" 是 driver 的手段选择，不是 host 的设计问题。

**本条与我们的真实关系只有一处，且方向与本报告初稿相反**：升级给**其中一种载体**（subagent child）新增了进程级上限（见 §A-1）—— 这是 driver **选择载体时的一个可判定输入**：subagent 承载的节点现在有并发天花板，可见会话承载的节点没有。


**宿主权威契约快照（2026-09-20 实测，仅备查）**：

```
agentTeams  ←  可选：ctx.get("agentTeams")（需判 undefined）
               硬依赖：inject: ["agentTeams"]
```

方法面：`membership` / `listMembers` / `tryMembership` / `spawnTeammate` / `sendMessage` / `createTask` / `getTask` / `listTasks` / `updateTask` / `waitForChange` / `interrupt`，外加 Remote 面 `remoteView` / `remoteCreateTask` / `remoteUpdateTask`。`TeamTaskView` 带 `blockedBy[]` / `ready` / `writeScopes[]` / `revision`，且写面**只是 advisory、无强制**。以上是**手段层的能力清单**，供 driver 选载体时参考，**不作为 0.8.0 计划的输入**。


---

## §7 未验证与边界（诚实清单）

- **UNKNOWN：部署侧 `dsh-base/cordis.patch.yml` 的 permission/sandbox/approval 覆盖值**。该文件只存在于新树，旧树无 `dsh-base` ⇒ "旧版宿主表内容"无法比对。**包默认值已证未变**，部署覆盖值未核。
- **UNKNOWN：`pluginPackages` 是否在 dev profile 挂载**。它决定预设行按 profile 包清单还是按磁盘走查判定 —— 这是 12 个目录唯一可能"由合法变 broken"的路径。
- **UNKNOWN：`dsh-bash-sandbox` / `dsh-pwsh-sandbox` 的失败分类 before→after**（旧树无这两族包）。
- **UNKNOWN：`maxDepth: 1` 与本插件拓扑的交互**（未实测）。
- **本报告不含**：CLI/flag 面、协议面、Web UI 面、Python SDK、SQLite schema（见范围声明）。
- **环境快照（审计时）**：宿主 = 0.1.6-alpha.2；web profile 纯净（`@deepseek-ai/` 空）；dev profile 含 `dsh-trinity` + `orchestra-dsh`（v0.5.1 旧构建，Sep 19）；4600 未监听、4599 运行中。
