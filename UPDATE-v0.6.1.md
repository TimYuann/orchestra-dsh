# UPDATE v0.6.1 — DSH 0.2.0-rc.2 兼容发布

> npm `orchestra-dsh@0.6.1` · git tag `v0.6.1` · 源码无行为改动（只动依赖面与版本号）。
> 上一个 npm 发布是 **0.5.0**；本版本把 0.5.1 → 0.6.0 的源码工作与 0.2.0-rc.2 兼容修正一并发布。

## 一句话

0.6.0 把 22 个 `@deepseek-ai/*` peer 依赖**精确钉死**在 `0.1.7-alpha.1`，被宿主 0.2.0-rc.2 的 peer 闸门判定不兼容 ⇒ 装不上、也起不来。0.6.1 把 peer 改成范围并补齐 0.2.0-rc.2 新增的宿主 peer；A2A 与 team 代码一行未改。

## 为什么必须改（0.6.0 在 0.2.0-rc.2 上的真实后果）

宿主 `@deepseek-ai/dsh-app-boot` 的兼容性检查**只**看名字匹配 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer，用
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 判定。0.6.0 的 18 个 `dsh-*` peer 全是精确版本，于是：

- **安装被拒**：`dsh plugin add` 预检直接 `rejected(preflight, "nothing was installed")`；Web 插件管理器抛 `incompatible-version`。
- **启动被跳过**：即使手工把 tgz 塞进 profile，`loadProfileDirectory` 也会抛错，整个 bundle 被跳过
  （`dsh: skipping profile bundle "orchestra-dsh"`），**一行补丁都不挂 ⇒ A2A 工具根本不会注册**。
- 唯一放行手段是精确版本豁免（`compatibility.json` / `dsh plugin allow-version`），不该是用户的默认操作。

## 改了什么

**peerDependencies**

| 组 | 0.6.0 | 0.6.1 |
|---|---|---|
| 18 个 `@deepseek-ai/dsh-*` | `0.1.7-alpha.1`（精确） | `>=0.1.7-alpha.1 <0.3.0` |
| `@deepseek-ai/cordis` | `4.0.3` | `^4.0.3` |
| `cordis-plugin-include` | `1.0.8` | `^1.0.8` |
| `cordis-plugin-timer` | `1.1.5` | `^1.1.5` |
| `cordis-plugin-loader` | `1.0.4` | `^1.0.4` |
| `@deepseek-ai/cordis-plugin-group` | —（未声明） | `^1.0.4`（预设里的 `cordis:group` 行需要） |

`>=0.1.7-alpha.1 <0.3.0` 覆盖了实际验证过的区间：`0.1.7-alpha.1` … `0.2.0-rc.2` 全部通过，`0.3.0` 被挡。

**devDependencies**：全部升到 `0.2.0-rc.2`（cordis 家族 `4.0.4` / `1.0.9` / `1.0.5` / `1.1.6`），
并补齐 0.2.0-rc.2 宿主包新引入的运行时 peer，否则本仓 `npm test` 会因 `ERR_MODULE_NOT_FOUND` 挂掉：
`cordis-plugin-group@1.0.4`、`dsh-native-command`、`dsh-attachment`、`dsh-util-time`、`dsh-launch-environment`、`dsh-session-query`、`dsh-credentials`。

**未改动**：`dsh.bundle.patch`、`dsh.client`、patch 行方言、12 条角色预设文件全部保持原样（0.2.0-rc.2 仍然接受这些声明形态）。

### 顺带修掉一个真实缺陷：`a2a_create(execution="session")` 在默认部署上必然失败

真机验证时实测到的、与宿主版本无关的既有缺陷（0.6.0 及更早同样存在）：

```
Error: published permission "custom" does not match blueprint "workspace-write"
```

成因：每个新建会话都被钉上 `approval: never`（D2-a），而这个钉发生在权限预设应用**之后**。宿主
`@deepseek-ai/dsh-permission-presets` 的 `current()` 返回的是从**旋钮状态推导出的有效预设名**，不是被选中的名字——所以凡是"声明 approval 为 `ask`"的预设（stock 表里的 `read-only`、`workspace-write`），被钉之后都会退化成宿主的 "not-a-preset" 状态 `custom`。lightweight 路径的最后校验拿这个**有效名**去比对**被选中的名字**，于是必然抛错；governed 路径有 `effectivePermissionPreset` 这层容纳，lightweight（A2A 的默认 session 后端）没有。

修法（`src/session-blueprint.ts`，只动 lightweight 路径）：

1. 校验按**旋钮事实**而非**推导名**：接受宿主推导出的 `custom`，但仅在「会话沙箱 == 预设声明的沙箱」且「approval == 钉住的 `never`」同时成立时接受——这正是恢复路径本来就在断言的那对事实；任何真实漂移仍然响亮失败。
2. 把预设声明的沙箱**显式写进会话**：宿主只有在"与生效值不同"时才写旋钮事件，声明值恰好等于部署默认时不留任何事件，会让上面的校验把"没写"读成"没声明"。

新增 4 条单测（先红后绿，去掉修复后 3 条失败），全套 **299/299**。真机复验（同一隔离 headless profile）：
`a2a_create(execution="session")` → `session-b2c6f7b4-…`，完整 `create → send → read` 往返见下。

## 验证证据（本机 macOS，2026-09-30）

**构建与单测（宿主依赖 = 0.2.0-rc.2）**

- `npm run typecheck` → exit 0（host + client 两套）
- `npm test` → **299 / 299 pass，0 fail，0 cancelled**（295 条既有 + 4 条本次新增的权限校验回归；新增用例先红后绿）
- `npm pack` → 81 files；`@deepseek-ai/*` **零泄漏进 `dependencies`**（CI 同款闸门通过）

**宿主契约比对（0.2.0-rc.2 npm 包 + Desktop app 内 `app.asar` 双源交叉核对）**

- 插件用到的 11 个运行时导入符号全部存在；插件 `inject` 的 6 个服务与 `ctx.get` 的 15 个服务名全部仍由宿主提供
- `agent/turn-stopping`（serial）、`session/event`、`internal/service` 三个事件仍在发射
- `SESSION_FORMAT_VERSION` 两版均为 **4**，且插件未硬编码该常量
- cordis 家族 4 个包 0.1.7→0.2.0 的运行时 JS **逐字节相同**（版本范围扩大不引入行为风险）

**真机（隔离 profile，未触碰 `web`/4599、`dev`、`dev-orchestra`、`dev-trinity`）**

| 靶场 | 配置 | 结果 |
|---|---|---|
| `a2a020h`（headless） | `dsh-base + dsh-headless + orchestra-dsh@0.6.1` + 本地补丁挂 preset registry | bundle 三行全部进组合树、无 skipped bundle；**两条真实 A2A 往返**：subagent 后端（`a2a_create → a2a_read` 取回 `A2A-PONG`）与 **session 后端**（`a2a_create → a2a_send → a2a_read`，`RESULT session-5f209754-344f-4e47-b2ec-ecd0cf6099bc A2A-SESSION-PONG`） |
| `a2a020`（web，端口 4602） | `dsh-base + dsh-web-app + orchestra-dsh@0.6.1` | 启动零 plugin 加载失败、12 条角色预设行全部激活；浏览器实测 `orchestra-dsh/client.js` 进入 `window.__DSH_BOOT__` 模块图、设置面板与插件清单正常渲染；**GUI 内 session 后端 A2A 往返成功**：`RESULT session-a79dbc0d-0576-4cc9-9f85-4e287f63b23b A2A-WEB-OK`（21 秒） |

> 修复前同一套 GUI 流程的实测输出是 `Error: published permission "custom" does not match blueprint "workspace-write"` —— 上面这条 `A2A-WEB-OK` 就是该缺陷被修掉的对照证据。

`a2a020h` 上 12 条预设行显示 `pending (waiting for service: agentPresets)` 属预期：`dsh-base + dsh-headless` 不含
`dsh-agent-preset-registry`（它由 `dsh-web-app` 的补丁层挂载），headless 场景下 `a2a_create` 走 `subagent` 后端即可。

## 安装

```bash
cd ~/.dsh/profiles/<your-profile>
npm install --legacy-peer-deps orchestra-dsh     # npm ≥7 需 --legacy-peer-deps：peer 由宿主提供
# 或在 profile 的 package.json 里加 "orchestra-dsh": "^0.6.1" 后 pnpm install
```

profile 的 `dsh.profile.bundles` 需要包含 `orchestra-dsh`。注意本仓硬规则：`@deepseek-ai/*` **只允许出现在 peerDependencies**，
profile 的 `node_modules` 里出现 `@deepseek-ai` 实体副本会导致宿主双实例加载、所有工具调用崩溃。

## 边界（本版本不声明的事）

- 本轮只验收 **A2A 面**；team / 交付层（0.8.0 计划）本轮不要求、未验证。
- 未验证：进程重启后角色会话身份是否完整、`a2a_create(execution="session")` 在 headless profile（该 profile 无 preset registry）、Windows 路径。
- 0.6.0 的既有边界不变：图循环/闸门仍是声明；交付层 v2 仍是草案。
