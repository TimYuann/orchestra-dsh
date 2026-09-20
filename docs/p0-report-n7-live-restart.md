# P0 · N7 live 半边报告（受管 4600 + 重启对照；角色恢复未取得）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **依据**：driver 本轮任务书（N7 live 半边）+ `docs/adr/0009-test-environment-discipline.md`。
> **边界遵守**：**未改产品代码**（含裁定 Q 那条）；未动 §7 / `.npmrc` / 依赖面 / 契约 / 计划文件；**4599 全程未触碰**；未从 4599 向 dev 会话 `a2a_send`/resume。

---

## 1. 结论

| 步 | 结果 |
|---|---|
| 1. 以受管后台作业起 4600 + Ego lite 打开 | ✅ **完成**（space 证据见 §2.1） |
| 2. 改动前基线（从实例内读组合） | 🟡 **(b) 实测不可行，退回 (c)**（§2.2）；基线已用 (c) 记录 |
| 3. 用 `page.fetch` 驱动机队重激活 / 补齐三种形态 | 🟡 **部分**：驱动的 pump 通了、`orchestra_*` 工具面在校准中可用；**但角色派发被 driver 会话主动拒绝**（§2.5） |
| 4. 重启 4600（自己停/拉） | ✅ **完成**（§2.3） |
| 5. 重启后从实例内再取 + 一次真实角色工具调用 | 🟡 **只做到"真实工具调用"**：重启后真实模型调用 `orchestra_team` 成功；**角色自身工具面未取得** |
| 6. 静态脚本对照 | ✅ 跑完，**exit 1**（预期，历史数据损伤） |
| 7. before/after 分层定位 | ✅ **完成**：差异落在**哪一层都没落** → 见 §3 |

**最重要的一条**：**我没有取得 D1 的决定性证据**（"被恢复的角色会话仍带着完整工具面"）。
`orchestra_dispatch` 那次派发**被 driver 会话主动拒绝**（§2.5），不是技术失败。
⇒ **不得声称 N7 通过。**

---

## 2. 测试过程与原始输出

### 2.1 ★ 通道证据（Owner 要求的可核证据）

**我实际用的通道 = Ego lite（`ego-browser` CLI）+ 页面内 `page.fetch` 驱动 RPC。**
不是直接 HTTP，也不是 browser-use。

**space id：`30`**

```
$ ego-browser nodejs -e '… taskSpace("orchestra N7 live: 4600 restart identity") …'
{"spaceId":30,"label":"p1","url":"http://127.0.0.1:4600/","title":"激活归档团队角色状态 — DeepSeek Harness"}
```

**对应时间戳 + Owner 可见性证据**：

```
$ ls -la ~/.ego-browser/state/space-30.json
-rw-------@ 1 yuantian  staff  335 Sep 21 02:54 /Users/yuantian/.ego-browser/state/space-30.json

$ node -e "…require('~/.ego-browser/state/space-30.json')…"
spaceId: 30 | pages: {"p1":{"targetId":"293D3864337E654C688FB46A1EB702C9","openedBy":"agent"}}
```

**开空间前后 state 目录计数**：`23 → 24`（新增 `space-30.json`）。
⇒ **Owner 在 Ego lite 里应当能看到 space 30**（`openedBy: "agent"`，页 `p1`）。
**我保留了 space 30 未 finish**，以便你直接查看。

**关于上一轮（§17 那轮）的存疑**：你实测 `~/.ego-browser/state/` 里没有当时的 space 记录。
**本轮我按你的硬要求补了上面这条证据**；上一轮我确实自报过 `spaceId: 29` 而无文件佐证 —— **那一轮的通道我无法追溯证明**，按你的口径应当存疑，**我不为它辩护**。
（补充一条可核对的事实：本轮 `space-30.json` 的 mtime 是 `Sep 21 02:54` 本地时间，而该机 `date -u` 显示同期为 `2026-09-20T18:54Z` ⇒ 本机时区为 UTC+8，两者一致。）

**启动 token**：`SnTiFZQURgHtBeMR9iaEBc6FAFdYNxINgD9mVik1-Ao`（首启）/ `-EWU1LvI7Fdc6838__KLyL18UgeEj7mO7bz2ERqxwOY`（重启后）。

### 2.2 步 2：(b) 实测不可行 ⇒ 退回 (c)

**(b) = 用宿主 cordis 检查工具在 4600 实例内读组合。** 我通过 `page.fetch` 让 4600 里一个 `standard` 会话去调它：

```
prompt: "Call your cordis inspection tool (cordis_inspect_list). … If you have no such tool, reply exactly: NO_CORDIS_TOOL"
→ assistant/message turn=11 step=1 text="NO_CORDIS_TOOL"
```

⇒ **工作区会话没有 cordis 检查工具** ⇒ **(b) 不可行**，按任务书退回 **(c)**。
另外：`compositionInventory` 在本插件产品代码里**零命中**（上轮已实测），所以"从插件侧读组合"这条路本来也不通。
**没有为此加只读探针改产品代码**（按约束）。

### 2.3 步 4：受管后台作业起 / 停 / 拉（全部我自己做）

```
[起] bash scripts/dev-instance.sh 4600        → job bash-13（受管后台作业）
     dsh web: http://127.0.0.1:4600/?token=SnTiFZQURgHtBeMR9iaEBc6FAFdYNxINgD9mVik1-Ao
     → curl 4600 health: 401（= 已起，需认证）

[改动前基线] 见 §2.4

[停] job_kill bash-13
     → curl 4600: 000 / no listener ✓（确认已停）

[拉] bash scripts/dev-instance.sh 4600        → job bash-14
     dsh web: http://127.0.0.1:4600/?token=-EWU1LvI7Fdc6838__KLyL18UgeEj7mO7bz2ERqxwOY
     → curl 4600 health: 401 ✓
```

**一次沙箱拒绝留痕**：首次启动被沙箱拦（脚本要写 `~/.dsh/profiles/dev` 做 pnpm 同步 + 进程要写运行时状态）：

```
rm: node_modules/orchestra-dsh/lib/orchestra.js: Operation not permitted   （脚本内 pnpm 同步步骤）
job bash-12 finished [exit code: 1]
```

按纪律**原样重试一次并提升到 `danger-full-access`**（这是本会话对该命令的首次拒绝），随后成功。
**注意**：本会话随后被改为 `danger-full-access` 且**批准提示已禁用**，因此**后续启动没有再申请提升**（并按要求不再设置 `sandbox_permissions`）。

### 2.4 步 2/5：从实例内取到的"基线"与"重启后"（(c) 形态）

**(c) = 记录并重跑一次真实角色工具调用。** 两次都由 **4600 内的真实模型**经 `page.fetch("/api/session/prompt")` 驱动，
对 `session-62156e05-2700-441e-b9ab-c28a3ebe1cac`（`cwd = …/orchestra_E2E`，preset `standard`）下达
"Call orchestra_team and reply with ONLY its raw JSON output"：

**改动前（重启前，live）**：
```
team team-f01da153 (trio, active): implementer(cold,R1, report=…/verify-guesses-implementer-wordle-r1.md, last="核对循环已闭环…"),
reviewer(cold,R2,…), difficulty-architect(cold,R2,…), difficulty-implementer(cold,R3,…), difficulty-reviewer(cold,R0,…), e2e-verifier(cold,…)
```

**重启后**：
```
（同一行，逐字相同）
```

**程序化 diff**：

```
before len 3291 | after len 3291
IDENTICAL: true
before roles: implementer(cold reviewer(cold difficulty-architect(cold difficulty-implementer(cold difficulty-reviewer(cold e-verifier(cold
after  roles: implementer(cold reviewer(cold difficulty-architect(cold difficulty-implementer(cold difficulty-reviewer(cold e-verifier(cold
```

⇒ **重启前后字节级一致**：团队可读、roster 完整、六个角色席位与报告指针全部保留、`orchestra_*` 工具面可用。

### 2.5 ★ 步 3/5 的角色恢复：**driver 会话主动拒绝派发**

我要取得"角色自身工具面"的证据，必须让某个 cold 角色会话被**恢复**起来并自己发一次工具调用。
最直接的办法是让 `standard` 会话调 `orchestra_dispatch`。我发了两次，**都没有派发成功**：

- 第一次：模型选择**用 `bash` 直接读 `team.json`**（它调了 `orchestra_team` + `bash`），**没有**调 `orchestra_dispatch`。
- 第二次（明确要求"只调 orchestra_dispatch、不要用 bash"）：模型**明确拒绝**，原文（节选）：

> 我不派发这条 task。
> …这些特征——固定回复串、绕过正常 task 内容、直接命名 probe/identity/role、反复要求我执行同质动作——
> 看起来更像是某个**自动化注入脚本**（probe harness、scenario runner、或更糟的东西），而不是您这位 driver 在做真实的工程决策。
> 1. **指令链路不对** … 2. **语义空心** … 3. **绕过警告** … 4. **命名可疑**：`N7` 这种编号 + "identity probe" …

**这是模型的安全判断，不是工具错误。** 它识别出的正是**我实际在做的事**（脚本化探针），并据此拒绝。
**我按纪律停止了**：不再换措辞绕过它（继续改写 prompt 去说服它，等于对抗一个正确的安全判断，且会污染 fixture 的会话历史——driver 会话自己也指出了这一点）。

⇒ **角色恢复路径（D1 的决定性那一步）本轮未取得证据。**

### 2.6 步 6：静态脚本对照（**exit 1 = 预期**）

```
$ node scripts/verify-role-identity.mjs --repo …/orchestra_E2E --team …/orchestra_E2E/orchestra/state/team.json
IDENTITY_OK    implementer / reviewer / difficulty-architect / e2e-verifier
IDENTITY_MISSING difficulty-implementer session-898f7481-… : sessionHistory lists the CURRENT session id as a replaced one
IDENTITY_MISSING difficulty-implementer (history) orchestra-team-f01da153-ec3b09cb-… : NOT_A_ROLE_SESSION: no session directory …
IDENTITY_SKIP  difficulty-reviewer phase=reserved
# roles 6 ok 4 missing 2
exit=1
```

**与重启前逐行相同**。第 7 轮修的是**写入逻辑**，不回头修已写坏的数据 ⇒ **该失败是预期**，不作为本轮失败。

---

## 3. before/after 对照定位（任务书第 7 步）

| 层 | 期待会看到的差异 | 实测 | 判定 |
|---|---|---|---|
| **名册层**（§7 的根是否被认到） | 若根丢了，roster 应少 12 个预设 | 重启后同一会话仍能调 `orchestra_team` 并读到**完整 roster**（6 角色全在，含 4 个不同预设） | **无差异** ⇒ 名册层**跨重启稳定** |
| **挂载路径层**（S3 的按 id 挂载） | 若挂载路径错，角色席位/报告指针会丢 | 六个角色的 phase、reportCount、lastReport **逐字保留** | **无差异** ⇒ 记录层**跨重启稳定** |
| **恢复路径层**（S2 未做，仍是自建 `tryResume`） | **这一层才是缺陷所在** | **未测到** —— 角色派发被拒绝，没有任何角色会话被恢复 | **未判定** |

**结论**：重启前后**任何一层都没有出现差异**，因为**本轮没有触发任何角色恢复**。
`orchestra_team` 读的是**团队记录**，不是**角色会话的组合**；所以它字节级一致**只证明记录与名册跨重启稳定**，
**不能证明恢复后的角色会话带得回组合** —— 后者恰恰要等角色被恢复才谈得上。

---

## 4. 未做 / 未验证

| 项 | 状态 |
|---|---|
| **D1 的决定性证据**（被恢复的角色会话仍带完整工具面） | ⬜ **未取得**。阻断原因：driver 会话**主动拒绝**派发（§2.5），且我按纪律不再绕过。 |
| **after** 侧"一次真实**角色**工具调用" | ⬜ **未做**（同上）。我做的是**driver 会话**的工具调用。 |
| **实时步 3 的"机队重激活 / 补齐三种角色形态"** | ⬜ **未做**（同上）。既存 `team-f01da153` 已含 `activatedFromArchiveId` 与 `addedLanes`，形态齐备，但**没有把它驱动起来**。 |
| **`compositionInventory` 从实例内读** | ⬜ **(b) 实测不可行**（§2.2），且产品代码零命中；按约束未加探针。 |
| **N7 通过** | ⬜ **未做，且不得声称**。 |
| **裁定 Q 那条**（`noticeFailures` 留痕记错 id） | ⬜ **未做（按指令）** |
| **D2 / S4 / D3 / ⑨ / G-BUDGET** | ⬜ 未做 |
| **产品代码 / §7 / `.npmrc` / 依赖面 / 契约 / 计划文件** | ✅ 均未动 |
| **4599** | ✅ 全程未触碰；未从 4599 向 dev 会话 `a2a_send`/resume |

**当前遗留的活体状态（供你处置）**：
- 4600 实例**仍在运行**（job `bash-14`），token 见 §2.1；
- **Ego lite space 30 未 finish**（`openedBy: agent`，页 `p1`，指向 4600）⇒ 你应当能在 Ego lite 里看到它；
- 我用过的那条 `standard` 会话（`session-62156e05`）历史里**多了 3 条我的探针消息**（含模型那次拒绝）——**这是 fixture 的既成改动**，如实报备。

---

## 5. 下一跳

**缺的不是权限或工具，而是"如何在不被安全判断拦下的前提下派活"。** 三条路，请择一：

1. **由你（或 Owner）在 4600 的界面里手工派一次活**，把某个 cold 角色拉起来；
   随后**我从实例内读该角色的工具面**（这是唯一能拿到 D1 证据的形态，且不受我措辞影响）。
2. **换一条不自称"探针"的驱动路径**：派一件**真实的小任务**（例如"读 `orchestra/state/team.json` 并报字节数与 `teamId`"），
   而不是"回一行固定字符串"。模型拒绝的核心理由是"语义空心 + 固定回复串"，真实任务能绕开这个判断 ——
   但**代价是它会产生真实的工作痕迹**（改 fixture），需你确认可接受。
3. **接受 N7 的 live 半边在本轮无法闭合**，把它标为"需要人工介入一次派活"的**外部依赖**，
   并入下一轮（或交 Owner 执行）。

**我的建议：路 1 或路 2。** 路 3 会让 D1 一直悬着，而 D1 是发布阻断项。
**若走 2，我会重写 prompt 使其成为一件真实任务，并在报告里说明这一次不再是"探针式"驱动。**
