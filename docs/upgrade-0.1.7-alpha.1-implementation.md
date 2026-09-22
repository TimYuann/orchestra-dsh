# DSH 0.1.7-alpha.1 迁移验证记录

> **2026-09-22收尾源码：`2f08a05`。机械验证通过；浏览器/真实会话/跨重启/正式Web安装未完成。**
> 下一轮唯一接续入口：[详细handoff](handoff-2026-09-22-upgrade.md)。包版本保持 **0.5.1**，未发布/推送/tag。

## 已落源码

- 原生preset声明注册取代旧roots/file mount；完整声明由typed catalog生成，包含persona、工具、skills、planning和compaction；V4消息源与client API适配。
- driver指引支持直接做/native child/独立Session/Team，不强制所有工作先画图；完整preset-authoring playbook可被发现并从包内加载。
- 模型按显式节点配置优先，否则继承driver实际当前request路由/推理；旧tier机制删除，governed reservation冻结展示路由。
- mission/lane输入、返回与团队投影具有真实结构化schema；支持复用成员、责任人/职责/完成条件，不把零新增座位说成零新增lane。
- 子代理persona/filter经持久化读回保留；接管已物化child使用新身份并留history；后续消息用native continuation。
- Session的expected工具要求与观测readiness分开；完整governed setup/commit用于新建、冷恢复与替换；live先核验，不补写权限掩盖问题。公开AgentRegistry.resume不是SessionController的私有helper。
- same-birth marker允许幂等重试、不同birth拒绝；marker不代表发布成功。归档激活不继承旧dismissalAttempt，成功恢复清除failed状态。
- 正式dismiss及/team归档严格停止/等待；drain失败不宣告归档。快照CAS重试遇晚到报告保留旧快照并创建明确superseding快照。

源码提交链与各阶段曾发现的真实缺口见handoff§2；早期子报告的“完成”不作为当前验证依据。

## 最终独立机械证据

Sol high在**全新隔离快照**中执行，无profile安装/宿主启动：

- base `c58a59c3f262bfff29a02d8e387e0e524009a596`。
- patch `/tmp/orchestra-web-ready-handoff-candidate.patch`，SHA-256 `f866e1a2d49f917b0858a390875a0eedc0a5548be9203e1faf5e50c33423ce47`，与2f08a05的staged diff逐字一致。
- `npm run typecheck`：exit0。
- `npm test`（含build）：**295 pass / 0 fail / 0 cancelled / 0 skipped**。
- 模型路由探针：**5/5**；真实注册工具/schema/lane探针：**9/9**。这些额外探针尚在临时目录，不冒称已全部纳入维护套件。
- `npm pack --cache /tmp/dsh-npm-cache`：exit0；78文件，351.9kB packed；runtime dependencies仅js-yaml，22 peers；无src/scripts/probes/node_modules。

最终候选：`/tmp/orchestra-web-ready-017-final.f1Wcab/orchestra-dsh-0.5.1.tgz`。
SHA-256：`a9745496d7b2a2f5758d2b7af43b116d5ee42197519c0217958b56aef689f178`。

完整报告：`/Users/yuantian/.pi/agent/sessions/--Users-yuantian-Developer-orchestra-dsh--/subagent-artifacts/outputs/8139acf1-cb0e-432c-8cdd-2e58fe70ad5b/validation/web-ready-017.md`。
日志：`/tmp/orchestra-web-ready-017-final-{typecheck,test,probes,pack}.log`。

## 失败记录与fixture边界

- f54383c的3处TS错误已修，不再是当前阻断。
- candidate1又暴露native AgentOptions被Record错误收窄，主agent已修。
- 更完整的运行期守卫使13个旧fixture不符合真实host形状。主agent审阅并整合5个测试文件的夹具修正（ctx/preset/权限/工具/创建参数位置）；没有削弱产品校验。**raw候选282/295不被记成通过**。
- 额外探针随后发现governed child继承模型未落team状态，主agent补冻结；最终已包含fixture和源码修正，295/295不是在隐藏的测试变体上凑出的数字。

## 仍需真实运行验收

Owner要求此处收尾，因此**没有**安装dev依赖、启动4600、打开浏览器、发真实M3请求、重启或安装正式web。

`dev-orchestra:4600`只做了profile-local设置迁移：4 provider配置/4现有credential引用，默认`minimax-cn/MiniMax-M3`。原全局legacy设置已被第一个0.1.7 profile消费，新profile/未来web不会自动继承；逐entry核effective config/credential状态。凭据复制有授权，但原文不得输出或入仓库。

下一轮：从干净提交重新pack（含最新README）→ 安装dev-orchestra → 单个fresh Sol high做browser/完整host/M3角色/child/strict stop/跨重启 → Owner确认正式web安装窗口。正式web4599、旧dev、dev-trinity4601和历史会话保持不动。

**结论：机械候选PASS，完整Web安装资格仍未完成。**
