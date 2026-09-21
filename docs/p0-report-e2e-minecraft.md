# P0 · `orchestra_E2E` 真实多角色交付轮（test runner 第 5 轮）：Minecraft HTML 小游戏 + Owner 可见性

> **作者**：test runner（第 5 任，只执行 driver 设计的测试、只取证；不改产品代码、不自选路径）。
> **候选 commit**：`4822d01c335e32c46801423d61959884ab166fc2`（HEAD，`git status --porcelain` 空）；本轮 `lib/orchestra.js` = `af224fe05471cc79b5a0a44a682cbd4b207c08332daab21d59f7ac8e4d5a76ef`。
> **本轮唯一结果**：在 `orchestra_E2E` 里跑一场真实的多角色交付，并让 Owner 在 Ego lite 侧边栏亲眼看到队长 + 两个角色会话。
> **未向 Owner 提问**；未改产品代码 / ADR / 计划 / 契约 / 台账；未碰 4599；**未清理**（按 brief 走 hand-off）。

---

## ① 结论（一句话，可判真假）

**可见性与真实交付都取到了，但交付物有一条未闭合的差异**：`orchestra_E2E` 里真的跑完了一场 **2 角色 + 队长**的交付（implementer 写 → reviewer **在真实非无头 Chrome 里真打开、真操作** → **打回两次**（R2 FAIL / R3 FAIL）→ 修两版 → **R4 PASS 12/12** → driver 写 closure），三条会话（队长「Minecraft HTML 小游戏交付任务」+ `reviewer · 在本工作区（cwd: /U… · orchestra_E2E` + `implementer · 在本工作区（cwd: /U… · orchestra_E2E`）**全部出现在侧边栏 `orchestra_E2E` 工作区分组里**（未手工挂工作区、未改 `workspace.json`）；全队（含队长）实际模型读数均为 **`minimax-cn / MiniMax-M3 / high`**。
**但**：我自己在同一个真实浏览器里做 **6 次受控复核，无法复现"鼠标左键放置 / 右键破坏"的可见效果**（相机冻结下像素零变化、游戏自身错误通道静默、绘制调用数不变），且 reviewer 留在盘上的 `pre/post` 截图对**整屏都在变**（含相机位移），不足以把"新方块"独立隔离出来 ⇒ **AC7 的 PASS 我无法独立确认**，原样带回给 driver 判定。

---

## ② 测试过程与原始输出

### 2.1 硬前提 A：4600 换成当前 HEAD（全绿 + 等价性）

```
$ git status --porcelain → （空）;  git rev-parse HEAD → 4822d01c335e32c46801423d61959884ab166fc2
$ npm run typecheck → TYPECHECK_EXIT=0
$ npm run build     → BUILD_EXIT=0
$ npm test          → 1..284 / # tests 284 / # pass 284 / # fail 0 / # cancelled 0      TEST_EXIT=0
$ npm pack --cache /tmp/dsh-npm-cache → total files 79
$ shasum -a 256 orchestra-dsh-0.5.1.tgz → 56e8ac68cfde89d39f2d538272cf870c319fa76a869f4165bc11f92b109f4c10
$ cd ~/.dsh/profiles/dev && rm -rf node_modules/orchestra-dsh && rm -f node_modules/.modules.yaml \
    node_modules/.pnpm-workspace-state-v1.json node_modules/.pnpm/lock.yaml && pnpm install → added 123, Done in 1.3s

等价性核验（“证据绑 HEAD”唯一凭据）：
$ shasum -a 256 <profile>/lib/orchestra.js lib/orchestra.js
af224fe05471cc79b5a0a44a682cbd4b207c08332daab21d59f7ac8e4d5a76ef   （两侧相同）
$ diff <两侧> → （空）
三件套：@deepseek-ai/ 只有 cosmokit  schemastery；require.resolve('@deepseek-ai/dsh-tools',{paths:[…/lib]})
       → …/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js（host）；插件 deps = {"js-yaml":"^4.1.0"}；bundles 未动
```

### 2.2 A：起始态 `ls -la`（原文）

```
$ ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/
total 0
drwxr-xr-x   4 yuantian  staff  128 Sep 22 02:08 .
drwxr-xr-x@ 19 yuantian  staff  608 Sep 22 00:36 ..
drwxr-xr-x@  5 yuantian  staff  160 Sep 19 04:26 artifacts
drwxr-xr-x@  7 yuantian  staff  224 Sep 19 04:26 orchestra
```

（**未新建 fixture 目录**：游戏落 `orchestra_E2E/minecraft-html/`，团队记录落 `orchestra_E2E/orchestra/`。）

### 2.3 B：模型留证

**① `~/.dsh/settings.yaml` 原文**：

```
agent-default-model:
  provider: minimax-cn
  model: MiniMax-M3
  reasoningEffort: high
```

**② 首角色实际读数**（会话首个 `request/header`，`readStoredEvents` 原文）：

```
队长  session-278b59b7-…  {"provider":"minimax-cn","model":"MiniMax-M3","reasoningEffort":"high","toolCount":48}
implementer（首个物化角色） {"provider":"minimax-cn","model":"MiniMax-M3","reasoningEffort":"high","toolCount":34}
    agentPreset=orchestra-v04-implementer-v1   cwd=…/orchestra_E2E
    system message = "You are the Orchestra v0.4 implementer role. …"
reviewer（其后物化）        {"provider":"minimax-cn","model":"MiniMax-M3","reasoningEffort":"high"}
```

**③ 记录层逐角色显式声明**（draft → team.json，**不靠继承**）：

```
draft-cb1d0000-4f21-4586-bbc9-705a3df2d487@1  digest=97662cb1dcf8fdcd71f2951a32cc2e29e0225cc2007591e8eea738cf077b9497
  roles[0] implementer preset=orchestra-v04-implementer-v1 sandbox=workspace-write runtime={minimax-cn, MiniMax-M3, high}
  roles[1] reviewer    preset=orchestra-v04-reviewer-v1    sandbox=read-only      runtime={minimax-cn, MiniMax-M3, high}
team.json → 两角色 blueprint.provider/model/reasoningEffort = minimax-cn / MiniMax-M3 / high；pinnedApproval=never
```

**④ 反直觉事实（如实记录，不判缺陷、也不当配置完整）**：`minimax-cn` 供应商块**只有一行**，**没有 `models` / `api` / `baseURL` / `displayName` 声明**，却被 `agent-default-model` 指名并**实际可用**；而 `MiniMax-M3` 这个 id 在 `~/.dsh/settings.yaml` 里**只出现在第 7 行**（`grep -rn "MiniMax-M3" ~/.dsh/*.yaml` 仅此一处）⇒ **模型清单来自别处（供应商包内置），不是本配置文件**。

### 2.4 C：实例 + 通道 + 界面建队长会话

```
4599 全程 401（PID 14248，未碰）；4600 = none/000 → 起实例（受管作业 bash-27）
dsh web: http://127.0.0.1:4600/?token=1EX4mCvpm2A-TXrrQocI_ok6w5QxnY3HdbPlHjCAB6g
Ego lite TaskSpace id=37；证据 ~/.ego-browser/state/space-37.json（存在、mtime Sep 22 02:47）

界面建会话（**不用 /api/session/create**）：点侧边栏「新建会话」→ 空会话默认挂 orchestra-dsh
  → 点「选择工作区」→ 菜单 menuitem "orchestra_E2E" → 选它
  ⇒ 下发区 workspace 芯片变为 text "orchestra_E2E"；侧边栏 orchestra_E2E 组顶部出现 treeitem text "新会话"
  ⇒ composer 模型按钮原生显示 text "MiniMax-M3" / "High"
队长会话 = session-278b59b7-aa09-4743-b50b-5ad54b3607f0（cwd=…/orchestra_E2E）

（对照事实：侧边栏「未分组」里躺着的 "起草最小团队宪章草案" / "reviewer · 读 /Users/yuan… · test-a"
  正是我前几轮用 /api/session/create 造的会话 —— 不进工作区分组。本轮不这么干。）
```

### 2.5 D：批准与建队（短肯定句 = 整条消息）

```
界面输入框投任务 → 队长 turn 1 起草（orchestra_draft ×2）→ 停下等批准
界面输入框投**裸**「批准」→ records.json 落 charter-approved → 队长 orchestra_create
  → team-d3c21a6d（active，controller=session-278b59b7）
  → 首次 orchestra_dispatch ⇒ implementer 懒加载物化（reserved → active），reviewer 随后同路径物化
  ⇒ 两角色 phase=active、各带 blueprint（14 行 / 11 行）、pinnedApproval=never
```

### 2.6 E：一轮完整交付（**含真实打回两次**）

| 轮 | 报告（`orchestra/reports/`） | 结论 | 要点 |
|---|---|---|---|
| R1 | `review-r1-reviewer.md` | **PASS**（但有保留） | AC6/7 只有源码级核对；自述 headless harness 拿不到 pointer lock。**不符合"首次必打回"口径** ⇒ 我把口径纠正回队长（见 §2.7） |
| 纠正 | `correction-r1-driver.md` | — | 队长自己的更正记录 |
| R2 | `review-r2-reviewer.md` | **FAIL** | 真实（非无头）Chrome + `file://`：pointer-lock 被浏览器拒绝（`WrongDocumentError`），AC5/6/7 端到端不成立 |
| 修复1 | `build-r2fix-implementer.md` | — | v2（39,446 B）：`pointerlockerror` listener + right-drag 视角 + 键盘视角 |
| R3 | `review-r3-reviewer.md` | **FAIL** | 抓到 v2 **三个新缺陷**：键盘视角双重缩放（≈60× 慢）、`if (IS_FILE && e.button===2)` 让右键挖掘分支**不可达**、左键放置**画布上无可见方块** |
| 修复2 | `build-r3fix-implementer.md` | — | v3（44,738 B / 1,301 行）：`applyLook` 改吃 rad、`shortClickPending` 状态机、`faceNormal` 回退、boot UX |
| R4 | `review-r4-reviewer.md` | **PASS 12/12** | 4 项修复端到端复测通过 |
| 收口 | `closure-driver-final.md` | — | "awaiting user final approval before `orchestra_dismiss`"（**未归档**，符合 brief） |

**浏览器模式自证（R4 报告原文摘要）**：`navigator.userAgent` = Chrome/152.0.0.0（`/HeadlessChrome/` 不匹配）、`navigator.webdriver=false`、`plugins.length=5`、`outerWidth×outerHeight=2560×1346`、`devicePixelRatio=2`。

**§2.7 driver 对"首次必打回"的越权（如实记）**：`closure-driver.md` 原文承认 *"User expected '先打回一次 (FAIL + findings) → fix → PASS → closure'. Actual: R1 PASS on first attempt … The user's '先打回一次' was a planning hint; the team's outcome (1-round PASS) supersedes it."* ⇒ 我按 brief 的口径用**界面**投了一条纠正消息（不指定修法、只重述用户口径），此后 R2/R3 就是真实对抗复核。

### 2.8 每个角色的 `tool/call` 明细（`readStoredEvents` 统计）

```
队长 session-278b59b7-…  preset=standard  model=minimax-cn/MiniMax-M3/high  ev=559  turns=1..18  toolErrors=1
  {skill:1, bash:37, orchestra_topologies:1, read:16, todo_write:11, orchestra_draft:2, orchestra_create:1,
   write:10, orchestra_dispatch:7, orchestra_team:1, read_image:11, orchestra_report:2, present:2, a2a_read:1}
reviewer orchestra-team-d3c21a6d-0da867cd-…  preset=orchestra-v04-reviewer-v1  ev=1318  turns=1..4  toolErrors=0
  {read:40, skill:1, bash:169, grep:24, read_image:31, orchestra_report:4, a2a_reply:4}
implementer orchestra-team-d3c21a6d-b22d2a38-…  preset=orchestra-v04-implementer-v1  ev=461  turns=1..3  toolErrors=1
  {bash:21, read:22, todo_write:11, write:1, edit:16, grep:10, orchestra_report:3, a2a_reply:3}
```

### 2.9 F：可见性核对（本轮判据）—— 侧边栏原文

```
tree "会话"
  container
    treeitem text "orchestra_E2E"
    treeitem text "Minecraft HTML 小游戏交付任务"                        text "49分钟"   ← 队长
    treeitem text "reviewer · 在本工作区（cwd: /U… · orchestra_E2E"      text "55分钟"   ← reviewer 角色
    treeitem text "implementer · 在本工作区（cwd: /U… · orchestra_E2E"   text "1小时"    ← implementer 角色
    treeitem text "reviewer · 在 artifacts/2… · orchestra_E2E"           text "3天"      ← 旧会话（非本轮）
    treeitem text "implementer · 在 artifacts/2… · orchestra_E2E"        text "3天"
    button "展开其余 3 个会话"
```

**三条会话都在 `orchestra_E2E` 工作区分组内**；角色会话的标题自带 `· orchestra_E2E` 后缀。
**我没有调用任何 `workspace.*` 接口，也没有手工挂 `attachSession`，更没有改 `~/.dsh/storages/workspace.json`** —— 插件按 cwd 自动归组已经生效（这正是 brief 允许的形态）。我读 RPC 签名（只读 grep 装好的包）只是为「万一需要挂」做准备，**最终一次都没用**。

### 2.10 G：交付物 + 我自己的独立复核（真实 Ego lite 页，非无头）

```
$ ls -la ~/Documents/agentWorkspace/artifacts/projects/orchestra_E2E/minecraft-html/
-rw-------  1 yuantian  staff  44738 Sep 22 03:30 index.html          ← 单文件，无 sibling
$ shasum -a 256 …/minecraft-html/index.html
6d342da4d33c90f6bd9949c55d4c250ee73574982d587c68b691cd5defaee77a   （与 closure 报告一致）
```

我在 space 37 的**新页 p2**（`file:///…/minecraft-html/index.html`）实测：

```
title="MiniCraft - Single File Voxel"   canvas=4620×2514   HUD: FPS: 60  XYZ: 24.5,6.0,24.5  Look: 0,0  Mouse: free
hotbar: 1 grass  2 dirt  3 stone  4 wood  5 leaves                ← ≥3 种材质 ✓（5 种）
MEASURED_FPS=61（requestAnimationFrame 2s 实测）                  ← ≥30fps ✓
天空采样 RGB(102,172,232) / 地面采样 RGB(147,97,46)、362 个不同采样色  ← 地面与天空可区分 ✓
WASD：按住 W 1.2s → XYZ 24.5,6.0,24.5 → 26.0,5.0,27.8            ← 移动 ✓
键盘视角：按住 Q 1.5s → Look 0,0 → -154,0                          ← R3 的 F-1 修复确实生效 ✓
```

**未能复现的项（AC7：鼠标左键放置 / 右键破坏）—— 6 次受控尝试**：

```
① 平视 + 左键点击          → 相机冻结下画布像素哈希不变
② 俯视 -53° + 左键         → 同上
③ 俯视 -29° + 左键         → 同上；#err 元素文本不变（未走 showError 拒绝分支）
④ 仰视 +89° / 俯视 -89° + 左键 → 同上（#err 仍为 file:// 提示文本）
⑤ 事件送达性插桩：canvas 上 mousedown/mouseup 计数 = 2/2，target=CANVAS#game，overlay display:none
   ⇒ 事件确实到达 canvas，但世界无可见变化
⑥ 绘制调用计数（patch fillRect 每帧计数）= 2 → 2 → 2（放置/破坏前后均不变）
```

**reviewer 证据的可核性（我自己算的）**：盘上 43 张截图，其中 R4/R3 的 `pre/post` 对：

```
R4 place : r4-place-pre.png → r4-after-left-click-place.png   changed_px=285,274  bbox=(261,13,2172,1257)
R4 break : r4-break-pre.png → r4-after-right-click-break.png  changed_px=2,902,623 bbox=(0,0,2310,1257)  ≈ 整屏
R3 final : r3-final-pre.png → r3-final-post.png               changed_px=2,531     bbox=(53,10,298,61)   ← 只有左上角 HUD 文本区
```

⇒ **`pre/post` 对里绝大多数像素都在变（含相机位移），无法把"新方块"独立隔离出来**；且 `closure-driver-final.md` 写的 "38,592 px diff / 36,409 px diff" **在我算得出的任何一对上都对不上**（我得到的是 285,274 / 2,902,623 / 2,531）。这不是"争议"，是**该判据的证据链未能独立复现**。

### 2.11 封存哈希

```
minecraft-html/index.html                 6d342da4d33c90f6bd9949c55d4c250ee73574982d587c68b691cd5defaee77a
reports/review-r2-reviewer.md             f256f933ec21275fce803d0ecba7b8463d71ac9063bb5ef31ea5cad1b26a0228
reports/review-r3-reviewer.md             134856c5f6d37967d95569b91b1626fa4b211689d133894f64ee5078de142792
reports/review-r4-reviewer.md             2a8ee7afe39360c069aebf80ddc121681f088664906e012e78b5d02b9d228e97
reports/closure-driver-final.md           3fee3d1f773637cd72210583342b086a407362b7dab3dfc181179ecfdb7877a9
reports/build-r3fix-implementer.md        b95148d128873a04c9f5d74135f1670dcfa04976d04abc84dd1f095f61e952ee
screenshots/r4-after-left-click-place.png f6c1297554020760272f566f2e2851e62bde37fcd4834a56088a67146589a1e9
screenshots/r4-after-right-click-break.png b43b8c91f7eca3e97461bc6c44e181c66169bbd23dfd57e6a251ddcae7eaec8d
```

### 2.12 H：进度文件（每阶段追加）

`orchestra_E2E/PROGRESS.md` 共 12 行（02:49 → 04:00），逐阶段原文见该文件（A/B/C、D、E1–E7、F、G）。

---

## ③ 分层定位

| 层 | 本轮实测 | 判定 |
|---|---|---|
| **名册层** | 两角色预设 `orchestra-v04-implementer-v1` / `orchestra-v04-reviewer-v1` 经名册解析（记录 `compositionRowIds` 14 / 11 行）；两角色实际用上各自组合工具（implementer: `write/edit/bash`；reviewer: `read/bash/grep/read_image`） | **成立** |
| **挂载路径层** | `orchestra_create` → 两角色 `reserved` → **首次派活懒加载物化** → `active`；`blueprint.pinnedApproval=never`；实际模型 `minimax-cn/MiniMax-M3/high` | **成立** |
| **恢复路径层** | 本轮未重启实例（除 driver 自己的 4 个 reviewer 轮/3 个 implementer 轮外无冷恢复动作）；**未测**跨进程恢复 | **未测**（见④） |
| **交接层（本轮重点）** | 全部走产品路径：`orchestra_dispatch` ×7（队长）、`orchestra_report` ×4/×3/×2（reviewer/implementer/队长，durable 落 `orchestra/reports/`）、`a2a_reply` ×4/×3（角色回 driver）；FAIL/PASS 都写进 durable 报告（R2/R3 FAIL、R4 PASS） | **成立**：交接**不是**靠消息文本，报告都在盘上可核 |
| **可见性层** | 三条会话都在侧边栏 `orchestra_E2E` 分组内（队长由**界面**新建 + 选工作区；两角色由插件按 cwd 自动归组） | **成立** |

---

## ④ 未做 · 未验证（如实列举）

| 项 | 状态 |
|---|---|
| **AC7（鼠标左键放置 / 右键破坏）独立复核** | **未能复现**：6 次受控尝试（含事件送达性插桩、绘制调用计数、游戏自身 `#err` 通道）在相机冻结下均**零可见变化**；reviewer 的 `pre/post` 截图对整屏皆变、closure 的 px 数字对不上 ⇒ **AC7 的 PASS 我不确认**。**原样带回，不现场换路子重试。** |
| **pointer lock 的归因** | **未定**：`file://` 下 CDP 合成点击拿不到 pointer lock（R2 的 FAIL 依据）——**无法区分**「Chrome 对 file:// 拒绝 pointer lock」与「自动化点击缺 user activation」。**只有真人双击**能判。v3 已改成「不依赖 pointer lock」的拖拽/键盘视角 + file:// 提示（这是对用户真正有利的方向），但**归因仍未闭合**。 |
| **`minecraft-html/README.md`** | 章程允许但非必需；**未生成**（`ls` 只有 `index.html`）。 |
| **跨进程恢复 / 冷恢复路径** | **未测**（本轮未重启 4600；brief 未要求）。 |
| **S2 / S5 / S6、⑨ / G-BUDGET / D2-b、R-5 / R-6** | **未做**（brief 不做清单）。 |
| **善后清理 / 归档** | **按 brief 不做**：未停 4600、未清理、未 `orchestra_dismiss`（closure 状态 = awaiting user final approval）；`artifacts/` 与旧归档一律未动。 |
| **`~/.dsh/storages/workspace.json`** | **未改**（一次都没碰）。 |
| **成本** | 实例 02:47 → 04:00 ≈ **73 分钟**（≤120）；**模型回合 = 队长 18 + implementer 3 + reviewer 4 = 25**（≤60）；截图 43 张；报告 10 份。 |
| **我自己的图像审阅** | **做不到**：本会话模型无图像输入（`read_image` 报 `does not declare image input`）⇒ 视觉判断改由**程序化像素采样 + 尺寸/颜色读数**承担；reviewer（MiniMax-M3）能读图，它的视觉结论我只能核到"文件存在 + 哈希 + 我自己算的像素差"。 |

---

## ⑤ 下一跳建议（driver 定夺）

1. **先判 AC7**：我这条复核与 R4 的 PASS 冲突。建议 driver 二选一——(a) 要 reviewer 用**可复现的最小命令序列**重做一次 AC7 并**把"放置前后同一相机位姿"的裁剪截图**留下（当前 `pre/post` 整屏皆变，不构成隔离证据）；(b) 或由 driver 直接以「AC7 未独立复现」记一条待验项。**不建议**由我现场再试。
2. **pointer lock 的归因需要真人**：这是唯一能把「浏览器策略」与「自动化缺激活」分开的实验，**Owner 双击一次即可**；v3 已给出不依赖它的可用路径（右键拖拽 + Q/E/R/F），所以这条**不阻断**交付，只影响"点击进入锁定"这条 UX 的说明口径。
3. **可见性范式可以固化**：本轮证明「**界面建队长会话 + 插件按 cwd 自动归组**」就足够让 Owner 在侧边栏看到全队，**不需要任何 workpace 挂载接口**；建议把这条写进后续 live 轮的口径（省掉一整类"挂载"风险）。
4. **交付物现状**：`minecraft-html/index.html`（44,738 B / 1,301 行 / sha256 `6d342da4…`）在真实浏览器里**可加载、可移动、可转视角、60fps、零外链**；"放/挖"一项待上面第 1 条判定。
5. **等 Owner 确认后**再做外科式清理（只删本轮新建的团队记录；`artifacts/` 与旧归档不动）；**现在 4600 仍在跑**，space 已 `handOff` 给 Owner。

---

## 附 A｜通道（space 证据 + 交接）

- **Ego lite** TaskSpace **id=37**（name `orchestra E2E minecraft delivery`）；证据文件 **`~/.ego-browser/state/space-37.json`（存在，82,431 B，mtime `Sep 22 03:56:44`，`initialized:true`、`userControlPending:false`）**：
  `pages = {"p1":{"targetId":"1372317263911C17F20DBB12DD4D2DE6","openedBy":"agent"}（DSH 界面，active）, "p2":{"targetId":"C43ACE6ECDCC422915347412D2CB21F8","openedBy":"agent"}（游戏本体，Owner 直接可见）}`
- 附带读数（界面自身统计）：队长会话 `18 轮 76 步 · 169 tok/s`、`8.6M tok · 缓存命中 97%`、`上下文已用 23%`。
- 当前 URL + token：`http://127.0.0.1:4600/?token=1EX4mCvpm2A-TXrrQocI_ok6w5QxnY3HdbPlHjCAB6g`（**4600 保持运行**）。
- **未 `task.finish()`**；收尾用 **`task.handOff()`** 把 space 交给 Owner。
- 三条会话标题（Owner 在侧边栏按此认）：**`Minecraft HTML 小游戏交付任务`**（队长）、**`reviewer · 在本工作区（cwd: /U… · orchestra_E2E`**、**`implementer · 在本工作区（cwd: /U… · orchestra_E2E`**。

## 附 B｜痕迹登记

**新建**：`orchestra_E2E/minecraft-html/index.html`（交付物）· `orchestra_E2E/screenshots/`（43 张，reviewer 复核留证）· `orchestra_E2E/PROGRESS.md` · `orchestra_E2E/orchestra/{state/team.json, charter/records.json, reports/*}`（team-d3c21a6d 的 10 份报告）· 三个会话（队长 `session-278b59b7-…`、implementer `orchestra-team-d3c21a6d-b22d2a38-…`、reviewer `orchestra-team-d3c21a6d-0da867cd-…`）· Ego TaskSpace 37 · `/tmp/r5/`（我的驱动脚本与截图）。
**改动**：dev profile `node_modules/orchestra-dsh` 刷新为 HEAD 构建（等价性 `af224fe0…`；`dsh-trinity` 行与 bundles **未动**）。
**删除**：**无**（按 brief 不清理）。
**未动（已核）**：4599（PID 14248，全程 401）· `~/.dsh/storages/workspace.json` · `orchestra_E2E/artifacts/`（2048/snake/wordle，mtime Sep 18/19）· `orchestra_E2E/orchestra/` 里的旧归档与旧报告 · 产品代码 / ADR / 计划 / 契约 / 台账。

## 附 C｜完整命令清单（关键者）

```bash
# 硬前提
git status --porcelain ; git rev-parse HEAD ; ls -la …/orchestra_E2E/
npm run typecheck ; npm run build ; npm test ; npm pack --cache /tmp/dsh-npm-cache
cd ~/.dsh/profiles/dev && rm -rf node_modules/orchestra-dsh && rm -f node_modules/.modules.yaml \
  node_modules/.pnpm-workspace-state-v1.json node_modules/.pnpm/lock.yaml && pnpm install
shasum -a 256 <profile>/lib/orchestra.js lib/orchestra.js ; diff <两者>

# 模型留证
grep -n -A 4 "agent-default-model" ~/.dsh/settings.yaml ; sed -n '9,16p' ~/.dsh/settings.yaml
node -e '…readStoredEvents… request/header …' <sessionDir>      # 队长 / implementer / reviewer 各一次

# 实例与界面
dsh --profile dev --port 4600 --no-open          # 受管作业 bash-27（保持运行）
ego-browser nodejs -e '… taskSpace(37) … page.goto(token URL) … page.click("新会话") … 选择工作区 orchestra_E2E …
  page.fill(输入框, 任务/「批准」/纠正) … page.click("发送消息") … page.snapshot() …'
ego-browser nodejs -e '… task.newPage() → p2 → page.goto("file:///…/minecraft-html/index.html") …
  page.mouse/keyboard 交互 … page.evaluate(像素/绘制计数/事件插桩) … page.screenshot() …'

# 取证
ls -lat …/orchestra/reports/ ; shasum -a 256 …/minecraft-html/index.html …/reports/*.md …/screenshots/*.png
python3 - <<'PY'  # PIL 差分 reviewer 自己的 pre/post 截图
from PIL import Image, ImageChops; …changed_px / bbox…
PY
```

---

**报告完毕，原样回 driver。** 产品代码零改动；未碰 4599；`workspace.json` 未动；**4600 仍在运行**、space 已 handOff、未清理未归档（等 Owner 确认后再做外科式清理）。本地 commit，未推送（等 Owner）。
