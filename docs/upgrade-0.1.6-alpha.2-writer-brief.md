---
obsidian-note-type: writer-brief
target: writer（execution plan 的编辑者）
cwd: ~/Developer/orchestra-dsh
updated: 2026-09-20
---

# 版本更新摘要 · DSH 0.1.5-rc.2 → 0.1.6-alpha.2 对 `docs/plan-0.8.0-execution.md` 的影响

> **给 writer 的唯一任务**：把 execution plan 里**引用了已失效引擎事实**的位置改对，并新增一条假设/风险条目。**这是版本适配，不是重新设计。**
>
> **证据全文在** `docs/upgrade-0.1.6-alpha.2-impact.md`（232 行，含边界签名表、逐条证据、未验证清单）。本摘要只列**结论与落点**；任何需要展开的地方去那份报告查。

## 0. 事实底数（勿再论证）

- 区间 `dsh-v0.1.5-rc.2` → `dsh-v0.1.6-alpha.2`，**1687 commits**、**4 个 revert**（全在 Web UI / desktop 侧，与本案无关）。
- 审计模式：**npm 模式**（本机无 harness checkout），材料 = 两棵已发布依赖闭包 + GitHub compare enrichment。原始材料**已清理**（634MB），需要重跑时用 `dsh-upgrade-audit` 技能重新材料化。
- **审计范围＝orchestra-dsh 的消费面**（组合/预设、会话与服务面、工具与模型可见面、审批与沙箱）。**不是**完整的 DSH 外部兼容审计；CLI/协议/Web UI/Python SDK/SQLite schema 未覆盖。
- 结论：**我们 import 的导出符号零移除**；`cordis` / `dsh-fs` / `cordis-plugin-include` / `cordis-plugin-timer` 的 `lib/**` **逐字节相同**；D4 与 D2 的全部判据所依赖的引擎事实**逐字未变**；`SESSION_FORMAT_VERSION` 两树皆 **3**。

---

## A. 必须改的位置（引用了已失效或需修正的事实）

### A-1 §7.2 部署表格 —— `patchReload` 已不存在

- **原文**（§7.2 表格 "重启 dev（4600）" 行）：`patchReload: "live"` 让 patch 文件本身热重载，但**新增根**要重启。
- **升级后事实**：`PATCH_RELOAD` / `patchReload` 在新 `dsh-app-boot` 的**整个 `lib/` 零命中**（旧树有 `lib/index.js` 两处 + `types/index.d.ts` + `types/profile.d.ts` 六处）；新树另增 `types/profile-resolution/`（`service.d.ts` / `resolver.d.ts` / `worker-bootstrap.d.ts`）与 `lib/worker/`。**新行为 = UNKNOWN，需实测后再写。**
- **建议**：删掉 `patchReload` 那一句，改为按新行为描述；未实测前写「待核」而不是猜。
- **适用边界：仅 §7.2 表格的这一格。**
- ⚠️ **同节其余部分不要改**：`composeEntries` **逐字相同**（层序与"恰好一行"仍成立）、`applyEntryPatches` 的**浅替换语义未变** ⇒ **§7.1 的三条写法纪律仍然有效，dev profile 那份 patch 内容不需要改**。

### A-2 §4.8 D2-a 步骤 3 —— 断言 `rejected` 会假失败

- **原文**：期望 `approval/asked` 与 `approval/decided(outcome="rejected")` 成对。
- **升级后事实（旧新一致，非本次改动）**：`decide()` 内 `if (signal?.aborted) return "cancelled";` **位于** `if (effectivePolicy === "never") return "rejected";` **之前** ⇒ **「已中止 + never」返回 `cancelled` 而非 `rejected`**。
- **建议**：该处期望改为 `outcome ∈ {allowed-once, rejected, cancelled, unavailable}`（§4.8 **D2-c 步骤 3 已经是这个写法**，两处统一即可）。
- **适用边界：仅 D2-a 步骤 3 的期望值。**
- ⚠️ **§4.8 开头那三条机制事实不要改**：`dsh-user-approval/lib/index.js` 与全部 `.d.ts` **逐字节相同**；旧文档引的 `:131-146`、`:49-53`、`:134/:141/:178/:179` **行号仍逐行对应**；三条判据（先无条件 append asked 再判策略 / never 早返回 rejected 且 waterfall 不可达 / asked-decided 成对且被回合包住）**逐条成立**。`setApprovalPolicy(session,"never")` 亦未变。

### A-3 §1 S2 与 §3 —— `ctx.sessionController.resume(...)` 的落点不存在（P0-F3）

- **原文**：冷恢复改调 `ctx.sessionController.resume(sessionId)`（引 `dsh-api-session-controller/lib/index.js:391-407`）。
- **实测（执行期已裁定更正，计划文本尚未改）**：服务面公开入口是 **`resolveAgent(sessionId)`**（宿主内插件可调，**非** Remote）与 **`prompt(request, signal)`**；`resume` / `resumeObserved` 是内部类 `ApiSessionAgentController` 的 `private` 成员，**不在服务面上**。
- **升级后复核**：`SessionController` 公开方法集 **旧 19 == 新 19、零增删**，剔注释后类体**字节相同**；`resolveAgent` 签名与返回形状不变（失败联合仅新增 `session/writer-held`）⇒ **该更正依然有效，不是临时状态**。
- **建议**：S2 落点改写为 `resolveAgent(sessionId)`（冷恢复）+ `prompt(request, signal)`（唤醒）；保留「`sessionController` 缺席时**类型化失败、不静默回退**」的原意，并落实 O-4 的约束——**默认用 `ctx.get("sessionController")` + 调用点类型化错误，不写进 `inject`**（写 `inject` = 硬依赖，服务缺席会让整个 a2a 插件 waiting、`a2a_*` 工具全消失）。
- **适用边界：仅 S2 的落点与配套测试期望。**

### A-4 §0.1 依赖的契约版本

- `0.1.5-rc.2` → **`0.1.6-alpha.2`**。
- 配套事实：`^0.1.5-rc.2` **不覆盖** `0.1.6-alpha.2`（semver 7.8.5 实测，预发布匹配规则，**连 `>=0.1.5-rc.2` 都不满足**）；本仓 19 条 peer + 对应 devDependencies 需同步，其中 `@deepseek-ai/dsh-user-approval` 与 `@deepseek-ai/dsh-session-title` 原为**精确锁**。风险已降级：两个 profile 的 `pnpm-workspace.yaml` 均为 `autoInstallPeers: false` ⇒ 不会触发自动安装、不产生实体副本。

### A-5 §0.2 假设清单 B-1…B-4

这些是对 DSH 能力的假设，需按新版本逐条重述。**不要凭直觉改**——除本摘要 A-1/A-2/A-3 已列出的以外，逐条去 `docs/upgrade-0.1.6-alpha.2-impact.md` §3「确认未变」与 §4「边界签名表」核对；报告未覆盖的条目保持原样并标「待核」。

### A-6 §11 G-P0 的三处计划文本欠账（执行期已裁定，计划尚未同步）

1. **判据 ④**（`verify-d2-decision.mjs` 六用例）：其内容全是 E2/E3/P3-5，而 V1 已令这三项退出 P0 ⇒ 标为「**延后（landing = 批 2 / G-P2）**」，**编号不动**（依据：§10.7 自己的标题「延后项（显式标注，不是漏掉）」）。
2. **§4.8 D2-b 的归属**：该节自己写着「这里的"路由"是**本插件的决策队列**（E2/E3）」⇒ 随判据 ④ 一并移出 P0，**成为批 2 / G-P2 的判据项**。
3. **§11 的具名脚本表与判据不一致**（P0-F1 + driver 新发现）：表里留着已被 V1 移出的 `test-decision-queue.mjs`(E2/E3) 与 `test-design-gate.mjs`(F1′)，**却漏了判据 ⑨ 要求的 `test-tier0-predicate.mjs`**。批 1 的 G-P0 可执行形态 = 判据 ①②③⑤⑥⑦⑧⑨ 各自命中期望码 + ④ 显式延后；完整清单与期望退出码见 `docs/review-rounds-ledger.md` §7。

---

## B. 需要新增的条目

### B-1 新假设 + 新风险：`dsh-subagent` 新增进程级容量上限

- **事实**：`ActivationPool.reserve(capacity)` 在 `slots.size >= capacity` 时抛 `SubagentError(code="ACTIVATION_LIMIT_REACHED")`，文案 `` `subagent limit reached (active child limit: ${capacity}); …` ``。默认 `Config { maxDepth: 1, maxActiveSubagents: 8 }`，可由部署的 `settings` 段 `"subagent"` 覆盖。**0.1.5-rc.2 没有这个机制。**
- **我方命中面**：`src/subagent-node.ts:149` 的 `subagents.startContinuable(...)`（另有 `sendMessage` / `listChildren` / `drainContinuableChildren`；**四者的存在与签名均未变**——计数与类型面均已逐一核对）。
- **建议**：写入 §0.2 作为新假设条目，并在 §8 风险表加一行。
- **适用边界（R-creep，必须照写）**：**仅适用于"由 subagent child 承载的节点"**；可见会话承载的节点不受影响。**不得**普遍化为"所有节点都有并发上限"，**不得**因此新增任何机制（本项没有 `fault_ref`，属"知道即可"）。

---

## C. 已核、**不要改**（负面清单，防止过度修改）

- **D4 全部判据**：`snapshotToolValue` 函数体与唯一调用点（`createSuccessResult` 内）**逐字相同**；`json-schema.js` 整文件 `cmp` 通过（`additionalProperties: false` ⇒ 多余键**报错而非丢弃**，语义未变）；`defineTool` 两份拷贝分别 1948 / 3244 字符**逐字相同**。
- **`defineTool` 的真实字段名**：`{ name, description, parameters, output: { schema, render }, execute }`。`inputSchema` / `outputSchema` / `handler` **不是** DSH 的字段名（`outputSchema` 在本仓只是本地变量名）。若计划里把它们当字段名写，那是错的；但本仓 `src/orchestra.ts` / `src/a2a.ts` 用的是正确形态，**代码无需改**。
- **S4 落点**：`agent/turn-stopping` 名称、payload、`@mode serial`、以及在边界提交前被 await 的语义**全部未变**（运行中宿主实测）。
- **`agent/status` 与 `agent/inbox/*`**：逐字未变。事件面 13 → 12，**唯一增删是 `agent/session-start` 被移除**（本仓零引用）。
- **审批与沙箱**：`setApprovalPolicy`、`SandboxMode` 取值集合、档位→approval 映射（`workspace-write → ask`、`danger-full-access → never`）**均未变**。
- **§7 的组合与预设**：`PresetRoot{path, trust}`、`trust:'system'` 合法、每目录扫 `agent.cordis.yml`、`PRESET_ID` / `COMPOSITION_FILE` / Config schema、`expandHomePath`、`mountPreset`、`presets.resolve(id)`、`defaultId` **全部未变** ⇒ **已部署的 12 个名册目录不会变非法，dev 的 patch 有效**。
- **会话数据**：`SESSION_FORMAT_VERSION` 两树皆 3；新增的投影强校验只针对 `image/offload`（旧树 0 命中）⇒ **旧会话文件读取不受影响**。
- **导出符号**：19 个依赖中，我们 import 的符号**零移除**。仅 `dsh-llm` 有移除（`offloadRequestImagesWithPolicy`、`offloadedImagePrefixCount`、类型 `RequestImageOffloadPolicy`）与硬改名（`AssistantProvenance` → `AssistantProviderMetadata`，无别名）——**本仓全部零引用**。
- **`commands.register`**：`CommandDescriptor.definitionId` 是**可选**（运行时 `...(definition.definitionId === void 0 ? {} : {...})` 显式处理缺省）⇒ 本仓 `src/orchestra.ts` 的 `/team` 注册**零改动**。
- **4 个 revert**：全在 Web UI / desktop 侧，无一条撤回我们依赖的行为。

---

## D. 给 writer 的纪律（与计划自身一致）

1. **不引入任何新机制**。本次只做两件事：改 A 组那些"引用了失效事实"的位置、加 B-1 一条假设/风险。
2. **每条改动写明适用边界**（R-creep：不得把一个实例的义务推广成普遍义务）。
3. **锚点用 commit + 文件**，行号只作辅助（前几轮已实测行号会漂）。
4. **A-6 与 A-3 是执行期已经裁定生效的欠账**，本次一并补进计划文本；**除此之外不要改口径**。
5. 凡**未在证据中验证**的说法，写「待核」，不要写成现状（计划 §10.6 已有这条约束）。
6. 改完请在 `docs/review-rounds-ledger.md` 记一行（轮次 + 问题 id + 落定位置 + commit）。
