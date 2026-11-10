# 2026-11-10 · A2A-first / DSH 0.2.2 更新

## 范围与部署状态

Owner 本轮决定：适配当前 DSH，强化独立 A2A；Governed Team 保留但退到可选进阶工作流，不扩展交付层。源码包升级为 0.7.0，目标宿主 `>=0.2.2-rc.1 <0.3.0`，开发依赖固定 0.2.2-rc.1。

**本报告不是安装验收**：当前 Desktop profile 未替换、未重启；旧 dev/web profile 也未改。当前 CLI 另为 0.2.1-rc.5，不把它当成 Desktop 0.2.2 的测试替身。浏览器打开当前 GUI 根地址时要求认证，因此未进入其设置面板，不能据此宣称新 Client 已渲染。下一步需要单独确认安装/重启窗口。

## 已修的实际问题

### 1. 长期 busy 接收方的消息排队

旧 `a2a_send/reply` 默认 `followup()`，只有显式 `interrupt:true` 才用 `steer()`。原生 `followup` 是独立下一回合；主 Agent 当前回合长期不结束时，回复不会进入它当前正在做的工作。

现在 raw `a2a_send/reply` 默认 step steering，不取消请求或工具。`interrupt:false` 保留显式独立回合；`wake:false` 总是只 inject/park，即使同时传了 `interrupt:true`。Governed `orchestra_send` 的默认语义刻意保留，本轮不是 Team 行为迁移。

attached Session 无运行中 Agent 时，waking 路径尝试原生 resume，不能只 splice 后宣称已唤醒。如果宿主不能取得 writer，会明确失败。原生 SessionStore.prepare 拒绝已有同 ID Session；本插件不绕过这条保护。两个普通消息同时发给 cold target 时，只共享一次恢复过程，不合并消息或收据。

step steering 不是不可丢失或固定延迟承诺：当前请求/工具要先到步骤边界，取消、拒绝步骤、卸载可能使其延迟或丢弃。原来已经排队的消息不会因重试旧收据而自动提前。

### 2. 创建回执写了 Max，宿主却没有记录

当前 `installModelSelection(agentCtx)` 只安装切换提示钩子，不再接收旧的 selection state 参数。旧插件仍传第二参数，JavaScript 会忽略它；lightweight 的 agentOptions 又遗漏 reasoningEffort，故回执/蓝图中的值不能证明执行或 GUI 的值。

现在三条创建路径用 `agent.model.select()` 写原生 `model/selection`，并在 lightweight agentOptions 中保留显式 effort。LLM 服务在场时先 `resolveCallConfig` 校验 route/effort，拒绝不支持的值，而不是静默忽略。继承优先读取原生 pending/current selection。

Lightweight cold recovery 只在完全没有原生 model selection/request header 时用出生蓝图补足；不会用旧出生值覆盖 GUI 后续修改。历史 request header 也优先保留，不自动猜测用户当时究竟想选什么 effort。Governed role 的固定授权契约不因此放宽。

### 3. 权限显示与实际权限混淆

`permissionPreset`、sandbox 和 approval 是不同事实。成员创建仍钉 `approval:never`，不自动授予 Full access；原 stock preset 若声明 ask，被钉为 never 后，原生 GUI 可能显示 custom。

创建结果现在同时返回 requested preset、effective preset、sandbox、approval 和 effort。后续修改使用原生 GUI；本轮没有新增允许 Agent 随意替他人升权的配置工具。用户对已有 Session 的调整不等于修改它的出生蓝图。

### 4. answered 状态几乎无法由正常 reply 证明

旧状态查询只寻找带 replyTo 的 assistant message，而正常原生 assistant source 没有这个字段。现在也检查精确 `a2a_reply(reply_to=<incoming id>, to=<original sender>)` 及对应成功 tool/result。只有调用、失败结果、错误收件人、描述性 reply marker 均不算 answered。匿名发送方无此精确证据时仍保守返回 claimed/unknown。

同时让 read-only 发件人的幂等 reply 收据使用与 send 相同的 workspace receipt escrow policy，避免消息已投递但收据写入因 sandbox 被拒。

## 当前接口与插件规范适配

- 原生 child 改用 `startActivation(..., delivery:"parent")`；停止改用 `drainChildren`。无 local inbox receipt 的 backend 明确拒绝，完成 Promise 的 rejection 被观察。
- 当前 native activation 没有旧 persona/toolFilter 字段。A2A 工具不再宣传它们；legacy 请求、以及含这些字段的新 topology 在发布/批准前明确失败。不能静默丢掉工具边界。保留旧数据字段用于读取与诊断；需要人格或独立工具面的角色用声明式 Session preset。
- 补齐 root / a2a / orchestra 三个展示入口的中英文 meta 和原绘 SVG icon，声明 exports 与 files。
- Client 使用当前 locale 服务和 `--dsw-alias-*` token；模块工厂、slot inject 门控保留。移除构建白名单中旧 Client 内部包/运行时豁免。
- 设置页以 A2A 为首屏，Team 放折叠的进阶区；只在该区展开时轮询 Team 数据。未新增 Team 页框架或改写存储。
- 详细 Team 协议移至可发现的 `orchestra-teams` skill；不再把普通“协作/委派”自动解释成建队，也不再全局禁止主 Agent 自己实现。Team 常驻段源码由 3240 降至 332 字符（该数字不是 tokenizer 读数；部署后的完整首轮 token 对比仍未做）。批准、归档与角色约束未删除。

## 验证证据

最终源码检查：

- `npm run typecheck`：exit 0，包含 Host 与 Client。
- `DSH_HOME=<repo>/tmp/test-home-022 npm test`：**347 tests / 347 pass / 0 fail / 0 cancelled**，包含保留的 Team 回归。
- 新增真实 DSH AgentLoop 对照：native Agent、Inbox、Session、projection、driver、tool executor 都来自 0.2.2。只模拟远端模型输出，以可控暂停保持 busy；默认 A2A 在**同一回合下一步骤**收到，显式 queue 在**第二回合**收到，没有 cancel；native model selection 和实际 request header 都包含 Max。
- 单测覆盖 wake=false、attached waking、cold selection preservation、cold concurrent sends、精确 answered 正/负控制、read-only reply escrow、unsupported effort fail-fast。
- `npm audit --omit=dev`：**0 production vulnerabilities**。完整开发依赖安装仍报告 20 条 high advisories；没有擅自运行 audit fix 或修改宿主依赖。
- pack：**93 files**，只含允许发布的文件，不含 node_modules；runtime dependencies 仅 js-yaml。三组 en/zh locale 导出可解析；icon 是有效且小于 256 KiB 的 SVG；client factory 和 Team skill 都在实际 tgz。
- `git diff --check`：通过。

制品：`orchestra-dsh-0.7.0.tgz`，SHA-256 **672ce67d912d58d297210e606e17087ccf0821ddefbed5dd5d7a8b55a1871277**。后续若源码变化，必须重新测试/打包并更新此身份，不能复用旧制品的结论。

## 独立探查与模型事实

Owner 截图确认模型为 **commandcode / deepseek/deepseek-v4.1-flash**，不是旧文档的 command provider。最初两个错误 route 的只读 Session 没有成功产出，已停止，不能算完成的 reviewer。

随后正确 route 的只读 A2A Session `session-1aab2ca3-0040-466f-bd42-dc73c18bef32` 完成限定复核并通过 A2A 回复。它检查的是进行中工作树，不是最终固定制品；最终 gate 仍由主 Agent 重跑。该 Session 是由当前未更新的旧插件创建，虽然请求 Max，其原生 modelSelection cache **没有 reasoningEffort**，正好复现本轮问题；不能称它已用 Max 执行。新实现的 Max 原生事件/请求链已由真实 AgentLoop 验证，**真实 commandcode + Max + GUI / 跨进程重启仍待新制品部署后验证**。

## 待运行期验收

1. 获准窗口内通过原生 plugin manager 安装候选包，读 activation 结果；替换模块若需重启，由用户确认并执行窗口。
2. 新会话创建 commandcode / deepseek/deepseek-v4.1-flash、Max、read-only peer，核 GUI、原生 selection/request header 和实际 sandbox；不要只看回执。
3. 两个独立 Session 在主 Agent busy 时往返，检查 step/turn 次序，保留显式 queue 和 wake=false 负控制。
4. GUI 改 effort/model/权限后，跨进程重启再派活，确认用户的新选择仍然保留。
5. 真浏览器检查 A2A 首屏、Team 折叠区、中英文与明暗主题、插件列表标题/图标。安装、slot 注册与单测均不能替代此项。

未发布 npm、未 push、未改用户原有 live-run 文档或 `.pi/` 内容。
