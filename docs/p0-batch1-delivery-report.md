# 批 1 交付报告（S′ + P0）—— 出口闸 G-P0

> **出具人**：driver。**日期**：2026-09-21。**口径来源**：`docs/plan-0.8.0-execution.md` §11（G-P0）+ `docs/plan-0.8.0-protocol.md` §3.1（批 1 = S′ + P0，**发布阻断项**）+ 台账 `docs/review-rounds-ledger.md` §23–§32（本批全部裁定）。
> **一句话**：**发布阻断项（角色身份跨重启）已闭合**；出口闸 9 条判据中 **8 条命中期望码**，**3 项显式延后并各带 landing**（不是漏掉）。

---

## 1. 出口闸逐条（唯一形态 = 台账 §7 的具名脚本表）

| # | 命令 | 期望码 | 实测 | 证据锚点 |
|---|---|---|---|---|
| ① | `node scripts/verify-role-identity.mjs --repo <fixture> --team <team 快照>` | 0 | ✅ **0** | `IDENTITY_OK reviewer … rows=11 tools=11`；记录里 `blueprint.compositionRowIds` **11 条**；**清理后仍可复跑**（会话日志在 `~/.dsh/sessions`，团队快照已留档 `reports/fixture-forensics-2026-09-21/`） |
| ② | 同上 `--self-test` | 1 | ✅ **1** | 检出即 1；**未检出 → 2**（裁定 X：盲校准不得冒充通过） |
| ③ | `node scripts/verify-d2-approval.mjs --session <role dir> --expect-policy never` | 0 | ✅ **0** | `hanging 0 dangling 0`；**且该会话 `approval/asked=1`、`decided=1`（同 id `85a03f50-…`、outcome `rejected`、同属 turn 2）⇒ 成对断言非空转** |
| ④ | 同上 `--self-test` | 1 | ✅ **1** | `dangling_approval: ask-calibration … never decided`；内部干净基线同时印 `APPROVAL_OK … hanging 0 dangling 0`（**仪器非恒红**） |
| ⑤ | `node scripts/verify-role-presets-roster.mjs` | 0（12/12） | ✅ **0** | `presets healthy=12/12 roots=1 agent_presets_rows=1 warnings=0` + **四形态负对照**（非恒真） |
| ⑥ | `node scripts/test-orchestra-archive.mjs` | 0 | ✅ **0**（14 条） | D3 三用例：连调两次都通知 + 第二次 `already_archived`；终态旧队**先通知后清活跃**；marker 后 `orchestra_team` 返回 `team:null` + 归档列表命中 |
| ⑦ | `node scripts/test-tool-schemas.mjs` | 0 | ✅ **0** | E-1 轮完成（真实 handler 调用 + 返回值过 schema） |
| ⑧ | `node scripts/test-orchestra-role-presets.mjs` | 0 | ✅ **0** | E4 两条断言（`danger-full-access` / 非 `workspace-write` ⇒ `invalid_spec`） |
| ⑨ | `node scripts/test-tier0-predicate.mjs` | 0 | ⏸ **延后** | **landing = 批 2 / G-P2**（裁定 AI）：档 0 谓词在 `src/` 零命中，其约束对象（节点记录/摄入/胶囊/租约）全是批 2/3 产物 ⇒ 此刻建脚本必**恒真**（弱数据假绿） |
| — | `node scripts/verify-agent-budget.mjs`（**G-BUDGET**） | 0 | ⏸ **延后** | **landing = P2-2 节点记录 + E2/E3 决策记录落地之后（最迟 G-P2/G-P4）**（裁定 AI）：§9.1 的判据是对真实节点生命周期的测量，没有那些记录测不出来 |
| — | `node scripts/verify-d2-decision.mjs`（计划 §11 判据 ④） | 0 | ⏸ **延后（编号不动）** | **landing = 批 2 / G-P2**（O-5(a)–(d)：内容全属 E2/E3，V1 已令其退出 P0） |

**判定形态**：**①②③④⑤⑥⑦⑧ 命中各自期望码 + ⑨ / G-BUDGET / 计划-④ 三项显式延后（各带 landing）**。

## 2. 本批交付的实现面

- **减法 S′**：**S1a** 三条建会话路径统一到 `buildRoleSession`；**S1b** `prepareRoleBlueprint` 单派发点；**S3** `mountRolePreset` 单入口（四处挂载点改造，名册来源 `path === ""`）；**S4** 停摆兜底换第一手信号（订阅 `agent/turn-stopping` + `approval/asked`/`decided` 悬空表 + **删除 `agent/status` 推断路径**）；**§7-dev 部署**（单跳 override，名册 12/12）；**依赖面迁移** 42 条 → DSH 0.1.6-alpha.2。
- **P0**：**D1** 角色身份持久（记录侧 `compositionRowIds` + **live 侧闭合**：重启后经产品路径唤醒冷角色，10 次工具调用 0 错误，唤醒入口 = A2A inbox splice）；**D2-a** `approval: "never"` 钉到**全部可达建/恢复路径**（+ 记录层 `pinnedApproval` 声明，裁定 AH）；**D2-c** 步骤 1/3（步骤 2 延后，裁定 AA）；**D3** 归档先停后记（cancel → notify → 快照 → marker，幂等）；**D4** 工具闭包守卫；**E1** 权限预分配（与 D2-a 同源）；**E4** 档 0 断言。

## 3. 本批修掉的真实缺陷（都已复现/变异确认）

1. **幽灵 sessionId**：物化失败分支把当前会话 id 记成"被替换的"，并反复写进 `sessionHistory`（§18/§19）。
2. **判据脚本的"假绿"三处**：`--self-test` 未检出返回 0（自检恒真）· cross-check 读不存在的字段 + 对象过不了 `Array.isArray` · 只比条数不比内容（"11 条全错"能骗过它）。现为 **集合比对 + 未检出 exit 2 + 缺字段即报 `absent`**（裁定 X / Z）。
3. **裁定 Q 的留痕从未落盘**：breadcrumb 写在了 **role** 对象上而 `noticeFailures` 是 **Team 级**字段 ⇒ `normalizeTeam` 下次 read 即丢；旧断言循环在空数组上（**空转**）。本轮移到 Team 级 + 补非空转用例（§31 对 §19 的更正）。
4. **首波 provisioning 在产品里不可达**（`provisionGovernedPlans` 零产品调用点）⇒ 三个早期 fixture 的角色会话**都没走过 governed setup**，这解释了 marker 缺失与 `approval` 长期为 `ask`（§27 更正 F-N7-2/3）。

## 4. 未做 · 未验证（诚实栏，缺此栏即材料不全）

- **⑨ / G-BUDGET / 计划-④**：延后（见 §1，各带 landing）。
- **D2-c 步骤 2**（节点记录 `approvalFacts[]`）：延后（裁定 AA，节点记录是 P2-2 产物）。
- **§4.8 D2-a 步骤 5**（把一条路径改回 `ask` 跑反例）：**未做**（裁定 AJ：需临时改产品码，属 repair；其目的由 ④ 自检 + 真实历史 `ask` 负对照承担，两条均已复现）。**逐字兑现需 Owner 决定**。
- **S4 的 steer 真机实证**：**未取得**（本轮未触发 steer；单测已证 `steer` 每回合恰好一次）。
- **R-5 / F-D1-5**（activate 替换分支按文件挂载 roster 预设）：**未做**，候选，landing = 批 2。
- **S2（原生投递/冷恢复）· S5 · S6**：贯穿项，非阻断，**未做**。
- **两条开放问题**：① R-6 阳性对照下"marker 挂载成功但角色未改用该预设"（裁定 AL）；② 通知文案不再带 archive id（裁定 AK，结构必然）。
- **`orchestra_E2E` 的旧 active team 已被文件级删除**（Owner 裁定 AF），其"① 在旧受损数据上诚实 exit 1"的载体不再存在，判定由留档快照 + 台账承载。

## 5. 可直接复跑的验证入口

```bash
# 闸门（detached worktree 内，先 npm run build）
npm run typecheck && npm run build && npm test          # 期望 0 / 0 / 284 pass 0 fail
node scripts/verify-d2-approval.mjs --self-test          # 期望 exit 1 + dangling_approval
node scripts/verify-d2-approval.mjs \
  --session ~/.dsh/sessions/--Users-yuantian-Documents-agentWorkspace-artifacts-projects-orchestra_E2E-test-a--/orchestra-team-b14140b8-f952d90d-1cd1-44fa-8aa5-672df98ffd0e \
  --expect-policy never                                  # 期望 exit 0 + hanging 0 dangling 0（该会话 asked=1，非空转）
node scripts/verify-role-identity.mjs \
  --repo /Users/yuantian/Documents/agentWorkspace/artifacts/projects/orchestra_N7b \
  --team reports/fixture-forensics-2026-09-21/team-team-e310ff28-1789992613601-9763e236-3bca-410d-ba9c-c314c8e9b009.json
                                                          # 期望 exit 0 + IDENTITY_OK … rows=11（fixture 已清理仍可复跑）
node scripts/test-orchestra-archive.mjs && node scripts/test-tool-schemas.mjs && node scripts/test-orchestra-role-presets.mjs
```

## 6. 建议的下一跳（driver 意见，Owner 决定）

1. **批 2 起步（P1 证据层 → P2 交付层）**：按 `docs/plan-0.8.0-protocol.md` §3.1 的批次表，出口闸是 **G-P1 + G-P2**（N1–N5 + 端到端 `human_interventions=0` + merge-cas 崩溃幂等）。⑨ 与 G-BUDGET 在批 2 内自然落地（landing 已写明）。
2. **可选的收尾项**（不阻塞批 2）：§4.8 步骤 5 的逐字兑现（一轮一次性 repair）· R-5 归因（并 R-6 阳性对照那条开放问题一起）。
3. **不建议**现在做 S2/S5/S6：它们不挤占任何批的出口闸，留到批 2/3 顺路。
