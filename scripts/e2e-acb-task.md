# ACB 综合 E2E 任务文本（headless 模式）

## 任务文本

这是 orchestra-dsh 插件 A/C/B 功能的综合 E2E 测试。工作目录是当前目录。请严格按顺序执行，每步一句话记录结果：

1. 调用 orchestra_topologies，原样列出返回（应包含 duo 和 trio 两个模板，均 bundled）。
2. 调用 orchestra_create（topology=trio）创建团队，记录 implementer 和 reviewer 的 sessionId。
3. 用 orchestra_spawn 再补一个角色：templateId=trio、roleId=implementer、roleName=implementer2（验证从模板补角色）。
4. 用 write 工具创建 calculator.ts（Node 脚本：导出 add 和 multiply 函数）。
5. 用 a2a_send 给 implementer2 派活：审查 calculator.ts 并运行验证（node calculator.ts 测试），然后用 orchestra_report 写交付说明到 orchestra/reports/。
6. 用 a2a_read 轮询 implementer2 会话（最多 6 次，每次间隔约 15 秒），直到看到报告路径。
7. 调用 orchestra_team，确认：a) implementer2 的 rounds >= 1 且 lastReport 非空；b) 至少一个角色有 lastActivityAt 和 lastActivity 字段（验证进度观察）。
8. 调用 orchestra_dismiss 结案，确认返回归档路径。

最后输出摘要：每步 通过/失败 + 关键值（模板清单、三个角色 sessionId、报告路径、归档路径、rounds/lastReport、lastActivity 示例）。
