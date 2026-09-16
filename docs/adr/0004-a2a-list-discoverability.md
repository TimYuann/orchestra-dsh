# ADR-0004 · a2a_list 发现性

- 状态：Accepted
- 日期：2026-09-15
- 来源：用户口述（2026-09-15），基于旧版本的实际使用体验

## 背景

用户原话：

> 现在的问题在于整个 DSH 里有大量 session 存在。最早的时候我说过一件事，就是区分 CWD，
> 优先显示当前同 CWD 的 session，然后包括状态是否被归档，包括上一次激活的时间。
> …… old version 用下来，感觉 A to A list agent 在使用它的时候，找到它需要找的那个 agent
> 不是特别方便。这个问题要看怎么优化会更好。

现状（`src/a2a.ts:604-724`）输出 `sessionId / title / cwd / status / live / archived? /
category? / current_cwd_team?`，排序 rank = `[同 cwd, live, archived, 数组下标]`。

**已做到**：同 cwd 优先（`sameCwd`）、live 优先、归档可折叠（`includeArchived`）、
团队归属标注（`current_cwd_team`）。

**缺口（逐条对应用户要求）**：

1. **上一次激活时间：完全没有**。输出里没有任何时间戳；`recency` 用的是
   `ctx.agents.list()` 与 `query.listSessions()` 的**数组下标**，不是真实时间。
2. **归档状态有了，但默认被折叠**，且与平台归档语义是否一致未核实（见 ADR-0003）。
3. **冷会话静默截断**：`records.filter(...).slice(0, 200)` —— 超过 200 条时直接丢，
   既不报错也不标注。这与项目铁律"上限超限必须报错，不得静默截断"（P13）冲突。
4. **没有"按团队/角色找"的入口**：会话命名已有三段式
   （`roleId · mission 缩写 · cwd-slug`），但列表没有按 team/role 分组或过滤的能力。

## 决定

1. **发现性是产品能力，不是展示细节**：目标从"把会话列出来"升级为"让 driver 用最少的
   往返找到目标会话"。
2. 必须补齐的字段：**上次激活时间**（真实时间戳，不是下标）、更明确的归档标注。
3. 排序必须建立在**真实时间**上，不能依赖宿主数组的返回顺序（那是实现细节，不是契约）。
4. **禁止静默截断**：语料超过上限时报错或显式标注"已截断 N 条"，不静默丢。
5. 默认视图保持"当前 cwd 优先"，但要让**团队/角色**成为可用的定位维度。

## 后果

- 排序键的最终形状（同 cwd → 团队归属 → 真实激活时间 → …）以实现与实测为准，
  但**必须由真实时间驱动**这一条不可让。
- 字段一旦加入输出 schema，就受 `additionalProperties:false` 约束：
  必须同步更新 schema、render、以及 `scripts/test-tool-schemas.mjs` 那一类守卫
  （2026-09-12 已因 schema 与投影不同步导致**整个工具调用失败**一次）。
- 时间戳来源要核实：`sessionQuery.listSessions()` 返回的 record 是否带 header 时间；
  若不带，需要另找权威来源，不得用"读的时候的 now"冒充。

## 核实结果（2026-09-15）：**"上一次激活时间"平台没有暴露**

用创造模式直接查了宿主 `sessionQuery` 服务的**精确契约**，答案是确定的：

```
export interface SessionRecord {
    header: SessionHeader;   // 只有 createdAt
    live: boolean;
    persisted: boolean;
}
```

- `listSessions()` 返回 `SessionRecord[]`（文档原话：*deterministic newest-first
  cloned session records*），**记录里没有任何时间戳**，只有 header 的 `createdAt`。
- 所以能拿到的是**创建时间**，不是**上次激活时间**。
- 真正等价于"上次活动"的数据在事件里（`SessionEventRecord.time`），但读取接口
  `listEvents(sessionId)` 是**一次一个会话**。为列表里 30–100 个会话各读一次日志，
  代价远超这个工具该付的。
- 平台有一个 `api-session/activity(sessionId, updatedAt)` **事件**（"一个用户发出的
  持久消息推进了会话列表活动"），但它是给前端推送用的，**不是可查询的字段**；
  插件若靠监听它自己维护一张表，得到的只是"本进程启动之后"的活动，不是持久的。

**因此本 ADR 第 2 条按事实收窄**：

1. **不假装**。不拿 `createdAt` 冒充"上次激活"，也不用标题的 `updatedAt` 当代理
   （标题是首轮生成后基本不再变，它反映的不是最近活动）。
2. 列表里给出**真实的 `createdAt`**，并且**标明它是创建时间**。
3. **排序维持平台给的 newest-first 顺序**。"用数组下标"这件事本身不是错的 ——
   `listSessions` 的契约明说它是 newest-first，只是它**不带时间戳**，
   所以拿不到"距现在多久"。
4. 若将来确实需要真正的"上次活动"，正确做法是**显式付费**（独立的、按需的
   "读这些会话的最后一个事件"路径），而不是让默认列表变慢。

## 未决

无。
