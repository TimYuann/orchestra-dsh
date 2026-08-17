# E2E 完整任务文本（headless 模式）

用法：`cd <测试目录> && dsh --profile dev-headless "<下方任务文本>"`

## 任务文本

这是 orchestra-dsh 插件的完整 E2E 测试。工作目录是当前目录。请严格按顺序执行，每步用一句话记录结果：

1. 用 write 工具在当前目录创建 hello.ts（Node 脚本，输出 "hello orchestra"）。
2. 调用 orchestra_topologies，确认返回中有 duo 模板（source: bundled）。
3. 调用 orchestra_create（topology=duo）创建团队，记录 reviewer 的 sessionId。
4. 用 a2a_send 给 reviewer 发 review_request：范围=当前目录的 hello.ts，目标=用 read 工具确认文件存在且内容正确，然后做代码风格评审；要求 reviewer 用 orchestra_report 把报告写入 orchestra/reports/ 并回复报告路径。
5. 用 a2a_read 轮询 reviewer 会话（最多 6 次，每次间隔约 15 秒），直到看到报告路径或确定失败。不要无限等待。
6. 调用 orchestra_team，确认 reviewer 的 rounds >= 1 且 lastReport 非空（验证 bookkeeping 记账）。
7. 调用 orchestra_dismiss 结案，确认返回归档路径。
8. 再次调用 orchestra_create（topology=duo），应成功（验证已结案放行）。

最后输出摘要：每步 通过/失败 + 关键值（duo 模板、reviewer sessionId、报告路径、归档路径、rounds/lastReport）。
