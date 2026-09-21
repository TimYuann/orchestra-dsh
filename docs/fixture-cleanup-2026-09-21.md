# fixture 清理记录（2026-09-21，Owner 裁定后执行）

> **Owner 的口径（2026-09-21）**：`artifacts/projects/orchestra_E2E` 是他建的**测试文件夹**——按测试文件夹的规矩用：**每轮跑完，只要结果拿到了，就在文件级把 team 清掉**（哪怕直接 `rm team.json`），这就是"善后"。终态 = 「**没有使用过 orchestra**」或「**用过 orchestra、但上一个团队要么完整 archive、要么完整交付掉**」。卡住的 team 直接在文件级清掉，**不需要注册工作区**。需要同时跑两三支队伍时，在该文件夹下建子目录（`test-a` / `test-b` / `test-c`；`n7`/`n8` 这类命名也可，前提是"测试顺利 + 善后得当"）。

## 清理前的状态（driver 实测）

| 路径 | 状态 |
|---|---|
| `orchestra_E2E/orchestra/state/team.json` | **active** 团队 `team-f01da153`（6 角色）——就是"没被处理"的那一支；含 §17/§18 归因过的受损数据（幽灵 sessionId + 被写坏的 sessionHistory） |
| `orchestra_N7/` | driver 造的一次性 fixture（第 10 轮 N7 live 取证用） |
| `orchestra_N7b/` | driver 造的一次性 fixture（第 14 轮 D1 live 半取证用） |
| `orchestra_serial/` | Sep 19 的**空目录**，全仓零引用，非本项目产物 ⇒ **未动** |

## 留档（先留档、后删除）

副本落在**仓库内** `reports/fixture-forensics-2026-09-21/`（该目录被 `.gitignore` 忽略，属本地过程记录），逐文件 sha256 见同目录 `MANIFEST.md`。关键三份（也即被删的三处 team 状态）：

```
5b8efdf9fcf5179a8ac6a55c8e8086bf1aebf5190ba2fa4b646a30a7abe2749a  e2e-team.json        (team-f01da153, active, 受损数据)
cad1b5a7e64d34789c0fd7fbbdd9b06f8f7dd604eb31b10301782789d6f4199f  n7-team.json         (team-33be3b56)
dc66b9b5ed951c1a4765c0e212f542c9247ed23709812d147eb6f9c5cfe4ca17  n7b-team.json        (team-e310ff28, dismissed)
```

另留档：E2E 的 **7 份历史 archive 快照**、N7 的 `charter/records.json`、N7b 的 2 份 archive 快照 + `closure.md` + **那份形状非法的手写 marker**（第 14 轮 R-6 的实验残留，留作反例）。

## 清理后的状态（driver 实测）

```
~/Documents/agentWorkspace/artifacts/projects/
├── orchestra_E2E/                  ← 测试文件夹，已无 active team
│   ├── artifacts/{2048,snake,wordle}   （真实交付产物，保留）
│   └── orchestra/{archive,charter,reports,tasks}（交付记录，保留；state/ 已空）
└── orchestra_serial/               （历史空目录，未动）
```

`orchestra_N7/`、`orchestra_N7b/` **已整目录删除**；`orchestra_E2E/orchestra/state/team.json` **已删除**（`state/` 现为空 ⇒ 插件视角 = 该目录没有团队）。

**未删**（按 Owner 口径属"完整交付掉"的合法终态，且是真实交付物）：`artifacts/` 里三个游戏、`orchestra/reports|tasks|archive|charter`。若要连这些也清成"从未用过 orchestra"，说一声即可。

## 会话日志（另说）

上列 fixture 的会话日志仍在 `~/.dsh/sessions/<slug>/` 下（插件与宿主的地盘，与工作区文件无关）。它们是 §17/§18/§23/§27 各条证据的原始载体，**本轮未动**；如需一并清理再单独处理。

## 由此确立的三条纪律（写进每轮 brief）

1. **落点**：测试一律在 `artifacts/projects/orchestra_E2E/`（或其下的 `test-a|test-b|test-c` 子目录）里做；**不再在它的兄弟位置造新目录**。
2. **善后**：每轮 brief 必带「环境与善后」一节 —— 开跑前贴一次 `ls`（起始态），收尾时**文件级清理**并再贴一次 `ls`（终态）；**终态证据缺失 = 该轮不予接受**（材料不全）。
3. **可见性不是目标**：不注册工作区、不挂 `attachSession`、不做"看这里三行"那套（driver 上一轮提的方案**已撤回**）；报告只对**证据**负责。
