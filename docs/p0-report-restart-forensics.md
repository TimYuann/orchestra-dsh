# P0 · 真实取证轮报告（跨重启取证 —— 只取证、未改一行产品代码）

> **作者**：0.8.0 交付层 Implementer（Session 3）。
> **基线**：`519d8cd`（S3 完成）。**本轮新增只读探针脚本** `scripts/probe-preset-roster.mjs`（可复跑证据），**未改任何产品代码**。
> **红线遵守**：全部操作在 **4600 侧读**；**没有**从 4599 向 dev 会话发过 `a2a_send`／resume；没有创建任何会话。

---

## 1. 结论

| 步 | 结果 |
|---|---|
| **1. 进程内 resolve 探针** | ✅ **12/12 可解析，0 失败，exit 0** ⇒ **假设 (b) 被排除**：§7 的根**在真实组合里被认到了** |
| **2. 建角色会话** | ⬜ **未做（有意）**——见 §2.4 的替代取证 |
| **3. 重启 dev** | ⬜ **未做**（未建会话，重启无从对照；且 dev 实例是你刚起的） |
| **4. 重启后外部核对** | ⬜ **未做**（同因） |
| **5. 定位** | 🟡 **部分完成**：拿到了一个**具体的、可判的成分分解**，但**未跑完决定性那一步** |

**最重要的一条**：本轮**没有**完成跨重启测量。**我不把第 1 步的成功写成"缺陷已修"** —— 它排除的是 (b)，不是 (a)/(c)。

---

## 2. 证据

### 2.1 第 1 步探针（原始输出，`scripts/probe-preset-roster.mjs`）

```
$ node scripts/probe-preset-roster.mjs
harnessBase: file://~/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/
roster size: 16
CONTROL (shipped presets):
   standard     healthy
   minimal      healthy
   ptc          healthy
   cordis       healthy
CATALOG (the 12 orchestra-* presets):
  RESOLVE_OK   orchestra-implementer              trust=system from_catalog=true
  RESOLVE_OK   orchestra-oracle                   trust=system from_catalog=true
  RESOLVE_OK   orchestra-reviewer                 trust=system from_catalog=true
  RESOLVE_OK   orchestra-v04-architect-v1         trust=system from_catalog=true
  RESOLVE_OK   orchestra-v04-hardening-auditor-v1 trust=system from_catalog=true
  RESOLVE_OK   orchestra-v04-implementer-v1       trust=system from_catalog=true
  RESOLVE_OK   orchestra-v04-investigator-v1      trust=system from_catalog=true
  RESOLVE_OK   orchestra-v04-oracle-v1            trust=system from_catalog=true
  RESOLVE_OK   orchestra-v04-planner-v1           trust=system from_catalog=true
  RESOLVE_OK   orchestra-v04-researcher-v1        trust=system from_catalog=true
  RESOLVE_OK   orchestra-v04-reviewer-v1          trust=system from_catalog=true
  RESOLVE_OK   orchestra-v04-verifier-v1          trust=system from_catalog=true
# probe ids=12 ok=12 fail=0
exit=0
```

**它测的是什么**：用宿主自己的 `dsh-app-boot` 读 **dev profile 真实组合**（`@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-trinity, orchestra-dsh`）→ 取出合成后的 `agent-presets` 行 config → 用引擎自己的 `discoverPresets` 按**服务真正扫描的根序**（shipped → 配置根 → 用户根）跑发现。

**根序与合成 config（探针打印）**：
```
composed agent-presets rows: 1
composed config: {"default":"standard","roots":[{"path":"~/.dsh/orchestra/catalog-presets","trust":"system"}]}
roots scanned: shipped(system) → ~/.dsh/orchestra/catalog-presets(system) → ~/.dsh/.agent-presets(user)
```

### 2.2 一次**自我更正**：我第一版探针把 12/12 全判成了 BROKEN

第一版我用**文件系统路径**当 `harnessBase`，结果**每个**预设（含 4 个 shipped）都报
`the composition's plugins cannot be checked: Invalid URL`，12/12 "失败"。

**抓到它的是对照组**：我额外跑了"只扫 shipped 根"——**shipped 也全 BROKEN**，那不可能是产品缺陷，只能是探针错。根因：`harnessBase` 要的是 **目录 URL**（服务从 `ctx.baseUrl` 取，`dsh-app-boot` 用 `pathToFileURL` 生成），我传了裸路径。

改对之后：**shipped 4/4 healthy（对照组通过）**，catalog **12/12 可解析**。

**这条必须留痕**：如果我没跑对照组，本轮会报出一个**假缺陷**（"12 个预设全坏"），而且它会看起来完全可信。

### 2.3 替代取证：读真实的**组合标记**（这一步替代了第 2 步）

建会话需要 `frozenRef`（用户批准），且会写共享会话日志——两者都不该由我做。所以我改为读**已有的真实标记**（只读）：

```
$ ls ~/Documents/agentWorkspace/orchestra/blueprints/
orchestra-team-4b21c7ee-5ff33ff5-da92-481d-8e6b-46118e87b3de.json
orchestra-team-4b21c7ee-88d613d1-12d2-4720-8826-755cfbb323f8.json

$ 标记内容（两个都同形）
preset=orchestra-implementer | source=file | approval=ask | role=implementer
preset=orchestra-reviewer    | source=file | approval=ask | role=reviewer
presetPath=~/.dsh/orchestra/catalog-presets/<id>/agent.cordis.yml
permissionPreset=workspace-write | sandbox=workspace-write
```

**这是一份 v0.5.0 时代的档案**（`docs/adr/0002` 说自定义事件已迁到文件存储；只有 2 个标记、都在 `agentWorkspace`，与 `STATE.md` 里 Pixel Craft 那次交付对得上）。它给出两个**具体的、可判的**事实：

1. **`presetSource: "file"`** —— 旧代码把**名册里的预设**记成了文件来源，`presetPath` 指向 catalog。
   ⇒ **这正是 S3 改掉的东西**：现在同一个预设会按 **id** 挂载并记 `source: "dsh"`。**S3 是否真的改变了新记录，我本轮没有验证**（需要建新会话）。
2. **`approval: "ask"`** —— 而 `src/session-blueprint.ts:902` 对受治理会话调 **`setApprovalPolicy(session, "never")`**。
   ⇒ **标记里记的 `approval` 是「预设声明的值」，不是「会话实际钉住的值」**（`permissionSpec.approval`，且部署把 `workspace-write` 的 approval 配成 `ask`）。

**第 2 点是新发现，且它正是"回合悬挂"那类缺陷的温床**：一条记录说 `ask`、而会话被钉成 `never`。**冷恢复重建会话时若不重新钉 `never`，它就会回到记录所声明的 `ask`** —— 那正是 D2-a 要判的东西，也正是 §4.8 机制事实那一节在讲的。

**但我必须划清边界**：这是**从一条旧档案 + 代码读出来的机制推论**，**不是**重启实测。**我不把它写成"已定位缺陷"。**

### 2.4 为什么没做第 2–4 步（可判定的阻断点）

要跑完第 2–4 步，需要**在 dev 实例上建一个受治理角色会话**。三条独立障碍：

1. **`orchestra_create` 必须带 `frozenRef`**，它只能来自 `/team approve` —— **用户命令**，模型侧无等价工具（这是"自然语言不算批准"的设计意图，`STATE.md` 已记为结构性事实）。⇒ **建会话需要你本人点一次批准。**
2. **红线**：会话日志在共享的 `~/.dsh/sessions`，我不能从 4599 侧操作 dev 的会话。从 4600 侧建、再自己重启再核对，**需要 4600 的可交互通道**，而我只能对它发 HTTP；那条 RPC 通道我没有认证过（见 §3）。
3. **重启 dev 会打断你刚起的实例**；且重启后核对需要**再派一次活**才有对照，而"派活"又回到障碍 1。

---

## 3. 未做 / 未验证（如实）

| 项 | 状态 |
|---|---|
| **第 2 步：建角色会话** | ⬜ 未做（需用户批准 `frozenReq`；见 §2.4 障碍 1） |
| **第 3 步：重启 dev** | ⬜ 未做 |
| **第 4 步：重启后外部核对** | ⬜ 未做 |
| **S3 是否真的把新记录从 `source: file` 改成 `source: dsh`** | ⬜ **未验证**（需建新会话；旧标记只能证明 0.5.0 的行为） |
| **`approval: ask` 记录 vs `never` 会话 的实际影响** | ⬜ **未验证**（是机制推论，非实测） |
| **(a)/(c) 是否成立** | ⬜ **均未判**。第 1 步只排除了 **(b)**。 |
| **4600 的 RPC 通道** | ⚠️ 探到 `/api/*` 存在但**需 cookie 认证**（我已换到 cookie：`/?token=…` → 303 + `set-cookie: dsh-auth-…`），但**没找到具体路由名**（`/api/health` 是 404）。**未继续**——不值得为它烧预算，且它是 4600 侧通道，不是产品面。 |
| **产品代码** | ✅ **一行未改**（本轮只新增 `scripts/probe-preset-roster.mjs`） |
| **§7 / `.npmrc` / 依赖面 / 契约 / 计划文件 / S4 / D2 / G-BUDGET / 其余批 1 脚本** | ✅ 均未动 |

---

## 4. 下一跳

**决定性那一步只需要你做一件事**：在 4600 上，用 `/team approve` 批准一个最小宪章，然后让 driver 侧派一次活把角色会话建起来。之后我可以（在 4600 侧）：
① 记下 `compositionInventory` 与 header 的 `agentPreset` 投影；
② 你重启 dev；
③ 我再取同一组证据 + 一次真实角色工具调用。

**若你不希望为此开一个团队**，替代路径是**零批准**的：我已经证明 `discoverPresets` 在真实组合下 12/12 可解析 —— 那么**把 (a) 单独测掉**只需要证明"按 id 挂载能成功"（`presets.mount(agentCtx, id)`），而这**不需要团队**，只需要一个 agent setup 窗口。我可以在下一轮把它做成一个**离线探针**（不建会话、不写会话日志、不碰 4600），代价是它证的是"挂载能成功"而不是"重启后会话真恢复了组合"。**请择一。**
