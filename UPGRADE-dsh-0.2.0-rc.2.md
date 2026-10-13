# 升级评估：dsh 0.1.5-rc.1 → 0.2.0-rc.2

评估对象：本仓库四个插件（`dsh-last-turn-delete`、`dsh-responses-replay-fix`、`dsh-web-direct`、`dsh-workspace-sort`）
与 `~/.dsh/profiles/web` 这个已部署 profile。

结论先说：**升级不是换个 npm 包那么简单**。0.2 引入了插件与宿主的 peer 版本闸门、Session format v4（消息 source 语法硬拒）、settings 机制重做；三个插件会被闸门直接跳过，其中 `dsh-last-turn-delete` 就算绕过闸门也会在数据面写坏 Session 日志。工作量集中在 `dsh-last-turn-delete` 与 `dsh-responses-replay-fix`。

---

## 1. 版本现状

| 项 | 值 |
|---|---|
| 当前宿主 | `@deepseek-ai/dsh@0.1.5-rc.1`（npm 全局：`~/.nvm/.../lib/node_modules/@deepseek-ai/dsh`） |
| 目标 rc | `0.2.0-rc.2`（`dist-tags.latest` 与 `next` 都指向它；`alpha` = `0.2.1-alpha.2`） |
| 中间版本 | `0.1.5-rc.2/rc.3`、`0.1.6-alpha.*`、`0.1.7-rc.*`、`0.2.0-rc.1`（没有单独的 `rc` dist-tag） |
| 关键依赖变化 | `@deepseek-ai/cordis` `^4.0.2` → `~4.0.4`；`schemastery` `~3.18.2` → `~3.18.4`；CLI 直接依赖里新增 `dsh-hmr`，`dsh-agent-presets` 改名 `dsh-agent-preset-registry` 等 |
| profile | `~/.dsh/profiles/web`：bundles = `dsh-base`、`dsh-web-app`、三个插件；`cordis.patch.yml` 额外 insert `dsh-workspace-sort` |
| 会话数据 | `~/.dsh/sessions` 约 **901 MB**（format v3）；`storages` 18 MB |

---

## 2. 已经实证的破坏性变更

### 2.1 peer 版本闸门（硬拦截，插件直接被跳过）

0.2 的 app-boot 会在加载插件**之前**检查 `peerDependencies` 里所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 声明
（`dsh-app-boot/lib/index.js` → `evaluatePluginCompatibility`，用 `semver.satisfies(runtime, range, {includePrerelease:true})`），
不满足就**跳过整个 bundle**，只在 stderr 留一行警告：

```
dsh: skipping profile bundle "dsh-last-turn-delete": Error: Plugin dsh-last-turn-delete@0.1.1 is
incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-session":"^0.1.2-alpha.5", ...}
... grant the exact-version exemption ... with `dsh plugin allow-version` ...
```

原因：`^0.1.2-alpha.5` 的 caret 语义是 `>=0.1.2-alpha.5 <0.2.0`，**永远不可能**匹配 `0.2.0-rc.2`。

实测（隔离 DSH_HOME + 0.2 CLI 跑 `web --dump-config`）：

| 插件 | 结果 |
|---|---|
| `dsh-last-turn-delete@0.1.1` | ❌ 被闸门跳过（peers: dsh-session / dsh-storage-domain / dsh-typert-protocol） |
| `dsh-web-direct@0.1.0` | ❌ 被闸门跳过（peers: dsh-credentials / dsh-web / dsh-web-fetch-http） |
| `dsh-responses-replay-fix@0.1.1` | ✅ 通过（唯一 peer 是 `@deepseek-ai/schemastery`，不是 `dsh-*`，**不参与检查**） |
| `dsh-workspace-sort@0.1.1` | ✅ 通过（无 peer） |

绕行手段是 `dsh plugin --profile web allow-version <pkg>@<ver> --dsh-version 0.2.0-rc.2 --accept-risk`，
它写进 `profiles/web/compatibility.json`，**按精确版本**生效（每次升 dsh 都要重新授权），只能当临时手段，不应作为长期方案。

### 2.2 Session format v3 → v4：`source.kind === "plugin"` 被硬拒（`dsh-last-turn-delete` 必修）

0.2 的 format 版本是 **4**（新增 `dsh-session-format-v3-to-v4`）。v4 的“原生准入”要求每条 durable 消息的 source
必须带**生产者自有**的 kind：

```js
// dsh-session-format-v3-to-v4:  "format v4 message requires a producer-owned source kind"
function source(message) {
  if (... || value["kind"] === "plugin") throw new SessionFormatError(...);
}
```

实测（直接调 0.2 的 `assertV4RowAdmission`）：

```
admit REFUSED kind=plugin: format v4 message requires a producer-owned source kind
admit ok      kind=plugin:dsh-last-turn-delete
admit ok      kind=dsh-last-turn-delete
```

而本插件的删除标记正好写的是旧语法（`lib/core.js`）：

```js
export function deletionMarkerSource() { return { kind: "plugin", plugin: PKG_NAME }; }
```

后果链：
1. `session.append("user/message", marker, …)` 在**内存 Session** 层只校验“kind 是非空字符串”，所以删除看起来会成功；
2. 但落盘后重新打开该会话时，持久化后端会先跑 `assertV4RowAdmission` / `assertReleasedV4Relationships`
   （`dsh-session-persistence-jsonl/lib/index.js:1072,1093`）→ **整个 Session 打不开**。
   这正是仓库之前踩过一次的坑（`scripts/repair-deletion-marker-source.mjs` 的由来）。

还有第二处**回归**：v3→v4 迁移会把旧标记 `{kind:"plugin", plugin:"dsh-last-turn-delete"}`
改写成 `{kind:"plugin:dsh-last-turn-delete"}` 并且**删掉 `plugin` 字段**；而现在的读取端
`isDeleteMarker()` 要求 `source.kind === "plugin"` 且 `source.plugin === PKG_NAME` —— 迁移后**认不出来**，
表现为升级后“以前删掉的用户消息全部复活”。

**实测影响面**（`node scripts/audit-session-markers.mjs`，只读审计）：

| 指标 | 值 |
|---|---|
| 扫描会话目录 | 624 |
| 当前代（运行时真正会打开的那个文件）带删除标记的会话 | **25** |
| 标记行合计 | **93** |
| 硬拒风险（retired source / v3 文件里出现 `start/end`） | **0** |
| 其中当前代是 `session.v3.jsonl.zstd` | 23（另 2 个是 header 声明 `version: 0` 的旧文件，迁移链会自行转换键名）|

也就是说：数据面是干净的（迁移不会拒绝这些会话），唯一会被破坏的是**语义** —— 这 25 个会话里的 93 处删除
在升级后会“复活”。**先把读取端改好**（同时认 `plugin:<pkg>` 与 `plugin` wrapper 两种形态），这批数据就完全无损。

### 2.3 settings 机制重做：`installSection` 消失（`dsh-responses-replay-fix` 必修）

- 0.1.5：插件用 `ctx.settings.installSection(ctx, NS, Config, defaults, { setSource, onChange })` 注册 settings 段，
  用户在 `~/.dsh/settings.yaml` 里写 `responses-replay-fix: { providers: [...] }`。
- 0.2：**全树已无 `installSection`**。新的模型是“插件的 cordis entry config 即 settings 段”：
  插件导出一个 schemastery `Config`，`apply(ctx, config)` 直接拿到解析值，需要出现在设置页时调用
  `ctx.settings.configure({ auto: false }, fiber)`（见 0.2 的 `dsh-llm-pi-ai`、`dsh-permission-presets`）。
  命名空间 = `ctx.fiber.entry?.options.id ?? NS`。
- `settings.yaml` 本身也被移除：首次用 0.2 启动时会把 `$DSH_HOME/settings.yaml` **改名**为
  `settings.yaml.imported`，再把每个顶层 section 写进 profile 的 `cordis.patch.yml` 对应 entry 的 `config:`
  （`dsh-settings` → `importLegacyDocument()`）。导入不进去的 section 只留警告并保留在 `.imported` 文件里。

实测：隔离 HOME 首次 0.2 启动后，`cordis.patch.yml` 从 1.4 KB 涨到 6 KB，`ui-onboarding` / `agent-default-model` /
`permission` / `llm-pi-ai` / `llm-deepseek` 全部落成 entry config；`settings.yaml` 只剩 `.imported`。

对本插件的影响：`settingsCtx.settings.installSection(...)` 在 0.2 里不存在 → 该回调抛 `TypeError`
（cordis 会记成插件错误），`providers` 名单拿不到、退回默认 `["zhongxin"]`；
“整个插件不生效”还是“只有 settings 失效”（取决于 `ctx.inject(["settings"], …)` 回调是同步还是延后执行）
需要在真机 boot 里确认。无论如何都必须把 settings 注册改成 entry-config 形式，
用户的配置位置也随之从 `settings.yaml` 变成 profile 的 `cordis.patch.yml`。

### 2.4 `patchReload` 字段被 `dsh-hmr` 取代

0.2 全树已无 `patchReload`（连 README 都删了）。新机制是 base bundle 自带 `hmr` entry（`id: hmr`），
launcher 提供 `profileContext` 时默认开启，配置文件热重载由 `dsh-hmr` 负责。
所以 `profiles/web/package.json` 里的 `"patchReload": "live"` 是**过时字段**（实测被静默忽略，不影响启动），
应删掉或改写为显式 `hmr` entry 配置。

### 2.5 会话文件单向迁移、不可回退

- 打开旧会话是只读迁移（不落盘）；一旦**写打开**（继续对话/删除等），会在同目录发布 `session.v4.jsonl.zstd`，
  `session.v3.jsonl.zstd` 保持字节不变但不再是“最高代”。
- 运行时永远选**编号最高**的 generation；0.1.5 的 format catalog 只到 v3，
  **无法读 v4**（README 原文：retained predecessors do not provide automatic fallback or downgrade support）。
- 推论：升级后只要产生过 v4 落盘，回滚到 0.1.5 就再也读不到那些会话（除非手工删/移走 v4 文件）。901 MB 的会话目录是主要风险敞口。

### 2.6 顺手发现的既有 bug（不是升级引入，但建议一起修）

`dsh-last-turn-delete` 冷会话路径用 `ctx.sessionPersistence.inspect(sessionId)`，
但 **0.1.5 和 0.2 都没有这个方法**（持久化 seam 只有 `create/open/stat/list/flush`）。
现在它被 try/catch 吞掉，只是“没有 live agent 时删除失败”；0.2 的正确写法是
`const handle = await ctx.sessionPersistence.open(id, "read"); await handle.read()`。
0.2 的 `dsh-message-feedback` 就是这么写的，可以直接照抄。

### 2.7 安装方式带来的“影子依赖”（建议修，非阻断）

`profiles/web` 里 `dsh-responses-replay-fix`、`dsh-web-direct` 是 **`link:`** 安装（符号链接到仓库源码目录），
所以它们 `import "@deepseek-ai/dsh-web"` 时解析到的是**插件自己 `node_modules` 里的旧副本**
（`0.1.2-rc.1` / `0.1.2-alpha.5`），而不是宿主进程里的 0.2 副本 —— 两套 class/brand 同时存在。
`dsh-last-turn-delete` 用的是 `file:`（pnpm 只拷贝 `files` 白名单，不含 `node_modules`），所以它反而解析到宿主副本。

升级时这个版本差会从 0.1.2→0.1.5 拉大到 0.1.2→0.2.0，风险显著上升。建议：
改用 `file:`（或打包后再装），或把 devDependencies/`node_modules` 重装到 0.2.0-rc.2。

---

## 3. 四个插件分别要改什么

### `dsh-last-turn-delete`（改动最大）

1. `package.json` peers：`^0.1.2-alpha.5` → `^0.2.0-rc.2`（`@deepseek-ai/cordis` 建议同步提到 `^4.0.4`）。版本号 bump。
2. `lib/core.js`
   - `deletionMarkerSource()` → `{ kind: "plugin:dsh-last-turn-delete" }`（与 v3→v4 迁移输出保持一致）。
   - `isDeleteMarker()` 需同时认三种形态：新的 `plugin:<pkg>`、迁移前的 `{kind:"plugin", plugin}`、
     以及更早的 `{kind:"plugin", name, operation:"delete"}`（历史 `scripts/repair-*` 的那批）。
     可选：`source.kind` 以 `plugin:` 开头且后缀等于 `PKG_NAME` 时也接受。
   - 更新注释里引用的 `@deepseek-ai/dsh-llm` `MessageSourceMap` 说法（0.2 里该常量已不存在，规则搬到了 format 校验器）。
3. `lib/core.test.mjs`：断言改为新形态，并补一条“迁移后形态也能识别”的用例。
4. `lib/index.js`：冷会话读取从 `sessionPersistence.inspect` 换到 `open(id,"read")` + `handle.read()`（顺手修 2.6）。
5. 自查清单：`Service.init` / `TypertRemoteService(ctx, name)` / `Remote(name)` 装饰器协议 /
   `defineDomain`+`domainTable`+`storageDomain.open/table/close` / `session.append(type,data,{surfaceOp:{op:"replace",startSeq,endSeq},sourceEventSeqs})` /
   `agent.runMaintenance(job)` / `agent.status` / `session.surface.nodes` / `foldSurface` / `ctx.sessions.flush` —— 这些在 0.2 **全部仍然存在且语义一致**（已逐个核对），只有 source 形态与 `inspect` 两处要动。
6. **社区已经踩过的客户端坑，逐项核对过我们的代码**（来源见 §9）：
   - **`kind: "list"` 的 slot 在 0.2 强制要求 `options.id`**，缺失时 `register()` 抛错 → cordis 回滚**整个插件 fiber**
     （连带已注册成功的 action 按钮一起撤销），现象是「插件已加载、日志无异常、按钮消失」。
     我们只注册一处 `conversation.chat.assistant-actions` 且带 `id: "last-turn-delete"` ✓ —— 不受影响，但这条契约要记住。
   - **图标改名**：0.2 的 primitives 导出 `IconTrashOutlineRegular` / `IconTrashOutlineMedium` / `IconTrashOutline` /
     `IconTrashOutlineArtwork`，**`IconTrashOutline16` 已不存在**。我们的 `mountTrashIcon()` 有
     `typeof Primitives.IconTrashOutline16 === "function"` 判断 + 自绘 SVG 兜底，所以按钮不会消失，
     但会退化成兜底图形（与排队消息的原生按钮视觉不一致）。建议改成**按优先级运行时解析**当前内核导出的图标名。
   - `dsh.client.inject` **只接受动态客户端包**（有 `dsh.client` 字段 + `lib/client.js`）；我们列的
     connection / locale / ui-renderer / ui-conversation 四个都符合 ✓。
   - 载体语义：社区实测「替换载体必须是 **turn-less `user/message`**，且**空 content 会被网关 400
     （`user message must have content`）拒绝**」。我们的标记正是 turn-less `user/message` + 可读中英文提示，合规；
     唯一副作用是模型可能复述这句提示（社区改用单个零宽空格规避，可选优化）。
7. 客户端半边（`lib/client.js`）：`window.__ModuleLoader__.load` 协议、`require("@deepseek-ai/dsh-client-ui-primitives")`、
   `dsh.client.platform/inject` 元数据、slot `conversation.chat.assistant-actions`、
   `ctx.connection.rpc.call("/api", "lastTurnDelete/delete", { args: { request } })`、
   DOM 锚点 `[data-chat-flow]` / `data-chat-flow-key` / `data-chat-flow-kind` / `data-chat-anchor-key`、
   copy 按钮按 aria-label 定位 —— **在 0.2 里都能找到对应实现**，暂不需要改（真机 smoke 再确认）。

### `dsh-responses-replay-fix`

1. peers 里的 `schemastery` 提到 `~3.18.4`（不影响闸门，但保持一致）。
2. 把 `settings.installSection(...)` 换成 entry-config：
   - 导出 `Config = z.object({ providers: z.array(z.string()).default(["zhongxin"]) })`；
   - `apply(ctx, config)` 直接用 `config.providers`（或在 `ctx.on("app-boot/config-reload")` 后重读），
     去掉 `setSource/onChange` 那套；
   - 需要出现在设置页时用 `ctx.settings.configure({ auto: false }, ctx.fiber)`；
   - 文档/README 里的配置示例从 `settings.yaml` 改为 profile `cordis.patch.yml` 的
     `- id: responses-replay-fix` + `config: { providers: [...] }`。
3. `wrapAdapterStream`（`ctx.llm.adapters` 上挂 own `streamWithSnapshot`）在 0.2 仍然成立：
   `llm.adapters` 仍是 `Map<provider, {adapter}>`，`llm/adapters-updated` 事件仍在，`streamWithSnapshot` 仍是 pi-ai 的动态下发点。**核心修复逻辑不用动。**

### `dsh-web-direct`

1. peers（`^0.1.2-rc.1` → `^0.2.0-rc.2`）+ bump 版本；把实现依赖改成宿主解析（去掉 `link:` 的旧副本，见 2.7）。
2. 代码 API 在 0.2 全都在：`WebError`、`HttpFetchProvider(limits, resolveAddresses)`、
   `credentialRef`、`ctx.web.registerFetchProvider/registerSearchProvider`、
   `ctx.web.fetchProviderId/searchProviderId`、seam 配置键 `fetchProvider`/`searchProvider`。
   实测把 profile patch 的 `fetchProvider: http-direct` 喂给 0.2，composed config 正确生效。
3. 唯一需要在真机确认的是你本机 fake-ip/VPN 场景（本机 DNS 行为与版本无关）。

### `dsh-workspace-sort`

1. 无 `dsh-*` peer → **不会被闸门拦**；`workspaceRegistry.list()/insertBefore()`、`session/event` 事件、
   `~/.dsh/workspace-sort-state.json` 在 0.2 都保持原样。
2. 只需 bump 版本（可选），并在真机上确认“每日重排”仍然触发。

---

## 4. 建议的升级步骤

0. **备份**（会话是单向迁移，必须做）
   - 先跑一次只读审计，确认影响面：`node scripts/audit-session-markers.mjs`（本机结果：25 会话 / 93 标记 / 0 硬拒风险）
   - `cp ~/.dsh/settings.yaml ~/.dsh/settings.yaml.bak`
   - `cp -R ~/.dsh/profiles ~/.dsh/profiles.bak`
   - 会话目录：至少 `cp -R ~/.dsh/sessions ~/.dsh/sessions.bak`（约 900 MB，空间不够就只备份最近常用的 project 目录），
     或接受“升级后不可回退”。
1. **先改插件代码再升级宿主**（顺序很重要：改完并本地测过，再换 CLI）
   - 按第 3 节改 `dsh-last-turn-delete`、`dsh-responses-replay-fix`、`dsh-web-direct` 的 peers/代码，
     commit + push（CI 会按新版本号发布）。
2. **隔离 dry-run**（不动真实 `~/.dsh`）
   ```bash
   mkdir -p /tmp/dsh-probe && cd /tmp/dsh-probe
   npm i @deepseek-ai/dsh@0.2.0-rc.2            # 只在该目录装，不碰全局
   rm -rf /tmp/dsh-home-020 && mkdir -p /tmp/dsh-home-020/sessions /tmp/dsh-home-020/storages
   cp -R ~/.dsh/profiles /tmp/dsh-home-020/profiles
   cp ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml /tmp/dsh-home-020/
   # 修好 link: 插件在副本里的相对符号链接（或直接改 package.json 用绝对路径）
   DSH_HOME=/tmp/dsh-home-020 node node_modules/@deepseek-ai/dsh/lib/bin.js web --dump-config
   # stderr 里应不再出现 "skipping profile bundle"
   DSH_HOME=/tmp/dsh-home-020 node node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3099
   ```
3. **升级全局 CLI** 并刷新 profile
   ```bash
   npm i -g @deepseek-ai/dsh@0.2.0-rc.2
   dsh --version
   dsh plugin --profile web install      # 等价于在 profile 目录跑 pnpm install
   dsh web --dump-config | grep -E "fetchProvider|last-turn-delete|workspace-sort"
   ```
4. **首次启动后立刻检查**
   - `~/.dsh/settings.yaml` 是否已被改名成 `settings.yaml.imported`；
     `~/.dsh/profiles/web/cordis.patch.yml` 是否长出了各个 entry 的 `config:`；
   - 日志里有没有 `settings: section ... was not imported`；
   - 打开一个**旧会话**，确认没被“以前的删除标记”搞复活，也没有 format 报错；
   - 侧边栏删除按钮：删一条用户消息 → 重开该会话，确认消息仍处于已删除状态（这一步就是 v4 source 回归的验收）。
5. **回滚边界**：回滚到 0.1.5 前必须把该会话目录下的 `session.v4.jsonl.zstd` 移走，
   否则 0.1.5 会因为选中了最高代（v4）而拒绝打开。

---

## 5. 建议顺带补的工程化改进

1. **CI 版本矩阵 / 集成冒烟**：现在的 `pnpm test` 只测 `lib/core.js` 的纯函数（本次基线全绿：16/27/… 条），
   完全覆盖不到 peer 闸门、Session format、settings 这些真正会断的地方。
   建议加一个脚本：用隔离 `DSH_HOME` + 目标 dsh 版本跑 `web --dump-config`，
   断言 stderr 无 `skipping profile bundle`，作为发布前 gate。
2. **声明支持范围**：在每个插件 README 里写清支持的 dsh 版本（0.2.x），并在 `peerDependencies` 用
   `^0.2.0-rc.2`（dsh 官方推荐本地开发用 `workspace:^`，发布时 pnpm 会重写成具体范围）。
3. **别用 `link:` 装到 profile**：`file:`/打包安装能避免插件自带旧 `node_modules` 影子宿主依赖。
4. **删除过时的 `patchReload`**，改由 0.2 的 `hmr` entry 承担。
5. **发布**：改完版本号后走现有 `.github/workflows/publish.yml`（检测到 npm 上不存在的版本才发布）。

---

## 6. 还没验证、需要真机确认的点

- `dsh-responses-replay-fix` 在 0.2 boot 时 `installSection` 缺失导致的失败范围：是仅 settings 段失效、
  还是整个 `apply` 中断（`streamWithSnapshot` 包装没装上）。本次隔离启动的 stdout/stderr 里没有相关行，
  要么被日志级别过滤、要么回调延后执行，需要一次带日志的 boot 才能定论。
- `Remote(name)` 手工装饰器模拟（`markRemoteMethod`）在 0.2 的 `addMarkerInitializer` 下是否仍然成立
  —— 协议签名一致，但只在真实 cordis fiber 里才能确认（建议写一条 boot smoke 断言 `lastTurnDelete.tail` 可调用）。
- 客户端半边的视觉/DOM 耦合：copy 按钮的 aria-label 文案、原生 action 按钮 class 是否变化（0.2 里仍有 `copy*` 标识，但没逐一核对文案）。
- `dsh-web-direct` 在真机 fake-ip 环境下的实际连通性。
- `dsh 0.2.0-rc.2` 之后还会有 rc.3/正式版：peer 范围用 `^0.2.0-rc.2` 可以覆盖 0.2.x，但每个新 minor 都要重走一次本评估的“闸门 + format”检查。

---

## 7. 必要性复核：0.2 里这三个插件还需要吗？

结论：**三个都还需要**（两个是能力缺口，一个是本机环境缺口）。逐条给证据。

### 7.1 `dsh-last-turn-delete` —— 需要保留（0.2 没有原生等价物）

0.2 新增了不少东西，但**没有**"把最后一条用户消息从模型上下文里去掉"的能力：

- 全量扫描 0.2 里所有会产生 surface 替换（`op: "replace"`）的位置：只有 `dsh-agent-loop`（运行时上下文的
  system 消息重写）、`dsh-compaction-basic` / `dsh-compaction-tool-result-pruner`（压缩）、
  `dsh-session-log-deepseek`（线格式编码）、以及 format 迁移包自身。**没有任何一处替换 `user/message` 区间**。
- 斜杠命令清单里没有 undo / rewind / delete：0.2 注册命令的只有 `compact`、`goal`、`feedback`、
  `plan-mode`、`file-upload`、`session-log-export`、`permission-presets`。
- 客户端：`conversation.chat.assistant-actions` 槽位在 0.2 只有 `dsh-client-ui-chat`、
  `dsh-client-ui-message-feedback`、`dsh-cordis-client-runner` 三个注册者；对 `delete*` 的全包扫描命中的
  全是编辑器文本操作（`deleteContentBackward` 之类）和"删除排队消息 / 删除定时任务"，没有"删除这条消息及其回复"。
- 新增的 `orderBy`/`user-questions`/`agent-team`/`auto-review` 等能力与"软删除用户回合"无关。

一个重要的**边界澄清**：历史删除的*效果*并不依赖这个插件——标记行 + 原生 surface fold 就在生效。
插件提供的是「按钮 + 继续删除后续回合」的能力。所以：

- 想省事、不再删新回合 → 可以直接不装它；已删除的回合在迁移后仍然保持"不在上下文里"（见 7.4 的注意事项）。
- 想继续用 → 必须按 §3 修 source 形态与读取端。

### 7.2 `dsh-web-direct` —— 在这台机器上仍然需要（0.2 没有修 DNS 问题）

- 本机实测（本次评估时）：`api.deepseek.com` 与 `www.baidu.com` 都被解析到 `198.19.x.x`
  （fake-ip 保留段），`/etc/resolv.conf` 指向 VPN 的 `10.251.1.1`。问题依然存在。
- 0.2 的 stock fetch provider（`dsh-web-fetch-http`）**仍然**用 `node:dns/promises.lookup`
  （getaddrinfo 通道 → 拿到 198.19.x）并做公网地址校验，错误串 `resolves to a non-public IP address` /
  `WEB_BLOCKED_URL` 原样保留。
- 0.2 只注册两个 stock provider（`dsh-web-fetch-http` 的 `http`、`dsh-web-search-deepseek` 的
  `deepseek-official`）；新增的只是 **选择方式**：`DSH_WEB_FETCH_PROVIDER` / `DSH_WEB_SEARCH_PROVIDER`
  环境变量，以及 `dsh-http-proxy` 的 `proxyRouteFor(url)` 逐请求代理路由。**没有** stock 的"直连真实 DNS"provider。
- 所以插件（或等价物）在这台机器上依然必需。它也是三个插件里唯一与 dsh 版本无关、纯环境适配的一个：
  升级只需改 peer 范围。

### 7.3 `dsh-workspace-sort` —— 需要保留（0.2 只重排组内会话，不重排工作区）

0.2 客户端新增了视图选项 `orderBy: "manual"`（手动排序）/ `orderBy: "updated"`（最近更新），
默认 `updated`。但看实现：

```js
// dsh-client-ui-workspace: 组内会话按最近活动排序
const baseOrder = orderBy === "updated"
  ? orderByRecency(memberIds, list.byId)
  : reconcileManualOrder(memberIds, sessionOrderByAccount[workspace.workspaceId], ...);
// 工作区（分组）本身的顺序仍来自 list 的顺序，即宿主 workspaceRegistry 的持久 workspaceIds
const orderedWorkspaces = workspaces.map((workspace) => ({ ...workspace, sessionIds: pinCurrentBlank(baseOrder, ...) }));
```

也就是说 `最近更新` 只作用于**每个工作区内部的会话列表**；工作区之间的顺序仍然是宿主侧手动的持久数组
（`dsh-workspace` 的 domain `version: 2`，0.1.5 与 0.2 一致）。插件"每日按活动重排工作区"的语义
在 0.2 里依然没有原生替代。

### 7.4 如果决定不保留某个插件的后果

| 插件 | 不保留的后果 |
|---|---|
| `dsh-last-turn-delete` | 失去删除按钮；历史上 25 个会话的 93 处删除**在迁移后仍然生效**（标记行是合法的 `plugin:<pkg>` producer kind，原生 fold 照常把那段区间挡在模型上下文外）。但 §3 的读取端修复不做了的话，"再删下一条"时的定位会指向已删除的回合 —— 所以要么修好再用，要么彻底不装。 |
| `dsh-web-direct` | 本机 `web_fetch` 会被 SSRF 校验直接拒（`WEB_BLOCKED_URL`），`web_search` 连接不稳定；除非改本机 DNS 或换成走代理。 |
| `dsh-workspace-sort` | 侧边栏工作区回到手动拖拽顺序（组内会话排序仍由原生 `最近更新` 负责）。 |

---

## 8. 保留 session 的平滑升级手册

前提：`~/.dsh/sessions` 是 **v3**、目标是 **v4**，迁移是**惰性**且**单向**的：

- `list()` / `stat()` 只翻译头部，不读事件行、不触发迁移 → **浏览/看列表是安全的**。
- 只有**写打开**（继续对话、删除、压缩等）才会在同目录发布 `session.v<N+1>.jsonl.zstd`；源文件字节不变。
- 运行时永远选编号最高的那个文件；回滚到 0.1.5 前必须把 v4 后继移走。

### 步骤 0（**必须最先做**）：把读取端改好再升级

`dsh-last-turn-delete/lib/core.js` 的 `isDeleteMarker()` 要同时认三种形态：`plugin:<pkg>`、`plugin` wrapper、
以及更老的 `{kind:"plugin", name, operation}`。这 25 个会话的 93 处删除是否"复活"完全取决于这一步。

### 步骤 1：只读审计，确认影响面

```bash
node scripts/audit-session-markers.mjs                    # 人读报告
node scripts/audit-session-markers.mjs --json             # 机器可读
node scripts/audit-session-markers.mjs --fail-on-risk     # 有硬拒风险时退出码 1
```

本机结果：624 个会话目录，25 个当前代含标记（93 行），硬拒风险 0。
硬拒风险 = `{kind:"plugin", name, operation}` 这种"发明出来的 source"，或者 v3 声明文件里出现 `start/end`
键 —— 两者都会让整份 Session 打不开，需要**升级前**修（前者用仓库里既有的 `scripts/repair-deletion-marker-source.mjs`）。

### 步骤 2：备份（三档，按可接受的风险选）

| 档 | 命令 | 覆盖的回滚场景 |
|---|---|---|
| A（最省） | `cp -R ~/.dsh/profiles ~/.dsh/profiles.bak; cp ~/.dsh/settings.yaml{,.bak}; cp -R ~/.dsh/storages ~/.dsh/storages.bak`（约 18 MB） | 配置层面的回滚；会话靠"删 v4 后继" |
| B（推荐） | A + `rsync -a --delete ~/.dsh/sessions/ ~/.dsh-sessions-bak/`（约 900 MB，先确认磁盘余量） | 任意时刻可整体回滚到升级前 |
| C | 整个 `~/.dsh` 快照（含 credentials） | 最彻底，占用最大 |

注意 `~/.dsh/storages` 里已有 `dsh_last_turn_delete.json`（failed `/compact` 的忘记列表）和 `workspace.json`
（工作区顺序）—— 这两份是插件语义的补充状态，别只备份 sessions。

### 步骤 3：用真实会话做隔离 dry-run（不动生产）

```bash
# 0.2 CLI 装到临时目录，不碰全局
mkdir -p /tmp/dsh-probe && cd /tmp/dsh-probe && npm i @deepseek-ai/dsh@0.2.0-rc.2

# 隔离 home：拷配置 + 挑 2~3 个带标记的会话进去
rm -rf /tmp/dsh-home-020 && mkdir -p /tmp/dsh-home-020/sessions
cp -R ~/.dsh/profiles /tmp/dsh-home-020/profiles
cp ~/.dsh/settings.yaml ~/.dsh/.credentials.yaml /tmp/dsh-home-020/
rsync -a ~/.dsh/storages/ /tmp/dsh-home-020/storages/
rsync -a ~/.dsh/sessions/--Users-duankaiqiang-code-gakku-study-content--/ \
         /tmp/dsh-home-020/sessions/--Users-duankaiqiang-code-gakku-study-content--/

# 1) 组合层检查：stderr 里不应再有 "skipping profile bundle"
DSH_HOME=/tmp/dsh-home-020 node /tmp/dsh-probe/node_modules/@deepseek-ai/dsh/lib/bin.js web --dump-config
# 2) 真机冒烟：打开其中一个会话、发一条消息（触发写打开）
DSH_HOME=/tmp/dsh-home-020 node /tmp/dsh-probe/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3099
```

dry-run 里要确认的三件事：

1. 原 `session.v3.jsonl.zstd` 旁出现了 `session.v4.jsonl.zstd`，且 v3 文件**字节未变**；
2. v4 文件里原来的标记行已变成 `{"kind":"plugin:dsh-last-turn-delete"}`（`plugin` 字段被删）；
3. **改好的**插件在这个会话里仍然把已删除回合显示为"已删除"（按钮不回退到被删掉的那条）。

### 步骤 4：正式升级

```bash
npm i -g @deepseek-ai/dsh@0.2.0-rc.2
dsh --version
dsh plugin --profile web install          # = 在 profile 目录跑 pnpm install
dsh web --dump-config | grep -E "fetchProvider|last-turn-delete|workspace-sort"
```

首次启动后立刻核对：

- `~/.dsh/settings.yaml` 是否变成 `settings.yaml.imported`，且各 section 落进
  `~/.dsh/profiles/web/cordis.patch.yml` 的 entry `config:`；
- 启动日志里没有 `settings: section ... was not imported`；
- 打开一个老会话（只读浏览即可）确认没有 format 报错；
- **验收用例**：在刚才 dry-run 用过的那个会话里，确认已删除的回合没有复活；再删一条新回合 → 发消息 →
  重开会话，确认仍是已删除状态。

### 步骤 5：回滚边界（写清楚，别踩）

- 升级后**没再写过**的会话：直接 `find ~/.dsh/sessions -name 'session.v4.jsonl.zstd' -delete`，
  再把 `patchReload`/`settings.yaml`/`profiles` 恢复成备份，即可回到 0.1.5 可读状态。
- 升级后**写过**的会话：新内容只存在于 v4 文件里，删掉就丢内容。要么不删、留在 0.2 里继续用，
  要么用 0.2 的导出能力（`session-log-export`）先导出再用 0.1.5 的结果重建。
- 因此：**不要**在升级当天起手就把所有老会话都用一遍；先拿 1~2 个会话验证，剩下的用到再迁移。

### 步骤 6：迁移是渐进的，不要"全量预热"

不需要（也不建议）在升级前把所有会话跑一遍迁移：迁移在写打开时按需发生，没碰过的会话永远是干净的 v3，
这也让"部分回滚"始终可行。真正要提前做完的只有两件：**改好读取端** + **跑一遍审计确认没有硬拒风险**。

---

## 9. 社区现成方案盘点（2026-10 检索）

结论：**社区不仅提供了等价插件，而且已经有人把 0.2 的坑踩完了**；升级技能（skill）也有，但**没有覆盖
0.1.5-rc.1 → 0.2.0-rc.2 这条走廊**。来源：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（1400+ 行，含 Skills 分类）、[dshbase.com](https://dshbase.com/zh/plugins/awesome-DSH-plugin/)、GitHub 搜索。

### 9.1 回合/消息删除（对应 `dsh-last-turn-delete`）

| 项目 | 状态 | 对我们有用的信息 |
|---|---|---|
| [DDDMUC/dsh-delete-turn](https://github.com/DDDMUC/dsh-delete-turn) | npm `0.1.11`，**明确实测过 0.1.6-alpha.2 / 0.1.7-alpha.2 / 0.2.0-rc.1**，v3+v4 双格式 | 逐条给出了 0.2 的四个真实故障与修法；`peerDependencies` 为空 → 天然绕过早闸门；`plugins` 里 **62 个测试**含真实校验器契约测试；载体用 **turn-less `user/message` + 零宽空格** |
| [TiJun-Prime/dsh-turn-delete](https://github.com/TiJun-Prime/dsh-turn-delete) | README 记录到 **0.2.5** 版本，逐版写清 0.2 的坑 | 0.2.1 peer 闸门、0.2.3 list slot 要 `id`、0.2.4 图标改名、**0.2.5 v4 按角色校验 source**（system/message 必须是 `{kind:"system-prompt"}`，`plugin:<name>` 只能过行准入、过不了回放）|
| [hanshenmesen/dsh-turn-delete](https://github.com/hanshenmesen/dsh-turn-delete) | ★109，npm `0.1.0` | 原版；npm 包 peer 写死 `>=0.1.0-rc.6 <0.2.0-0` → **过不了 0.2 闸门** |
| [DDDMUC/dsh-as-aistudio](https://github.com/DDDMUC/dsh-as-aistudio) | 组合式 | edit-turn / rerun-turn / delete-turn / markdown-bubble 可单独或组合安装 |
| [23swccp/dsh-undo](https://github.com/23swccp/dsh-undo)、[Anionex/dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind)、[domitor-syh/dsh-rollback](https://github.com/domitor-syh/dsh-rollback) | 更重的方案 | 除上下文外还回滚工作区文件（Shadow Git / Change Ledger / 每轮检查点）——如果以后想要"撤销 + 文件回滚"，可以直接用 |

**注意**：`DDDMUC/dsh-delete-turn` 的 README 里有一条我们**没覆盖到**的设计约束 —— 载体只能是
**turn-less `user/message`**；如果为了放一条"对模型隐身的空 `system/message`"而开一个合成 turn，
agent loop 的轮号计数会与日志撞车（冷读 `turn/start does not open the expected turn`），
**并且任何按轮号隐藏的客户端会把被复用的那个真实回合整轮吞掉**（他们真机复现过"消息被吃掉"）。
我们是 turn-less `user/message`，天然避开；但也解释了为什么不要往这条路上加"合成回合"。

### 9.2 web_fetch / web_search 绕过 fake-ip（对应 `dsh-web-direct`）

| 项目 | 做法 | 与我们插件的差别 |
|---|---|---|
| [ArakawaHenri/dsh-plugin-web-fetch-fake-ip](https://github.com/ArakawaHenri/dsh-plugin-web-fetch-fake-ip) | 注册一个"放行指定 fake-IP CIDR（默认 `198.18.0.0/15`）"的 fetch provider，其它目标仍走公网校验，或整体关掉校验 | **只解决 web_fetch**，且我们的机器是 **`198.19.x`**（不属于默认段，需要配置 CIDR）；我们的插件还额外修 `web_search` 的直连与 IP 钉扎 |
| [1499501762/dsh-web-fetch-proxy](https://github.com/1499501762/dsh-web-fetch-proxy) | 让内置 `web_fetch` 走本地代理，绕开 TUN fake-ip 触发 SSRF 校验 | 引入本地代理依赖 |
| [CREAIT-nl/dsh-plugins#web-fetch](https://github.com/CREAIT-nl/dsh-plugins/tree/main/web-fetch) | 自研 guarded local fetch provider（逐跳校验 + 尺寸上限 + content-type 白名单） | 不解决 fake-ip，属于加固 |
| 大量 search provider 插件（[DDDMUC/dsh-free-search](https://github.com/DDDMUC/dsh-free-search)、[240xu/dsh-websearch](https://github.com/240xu/dsh-websearch)、[anweat/dsh-web-search-pro](https://github.com/anweat/dsh-web-search-pro) 等） | 把 `web_search` 换成不依赖 `api.deepseek.com` 的引擎 | 可以**替代 web-search 半边**，但 fake-ip 仍会污染这些引擎的 DNS 解析 |

### 9.3 工作区排序（对应 `dsh-workspace-sort`）

- [karottc/dsh-plugin-workspace-sorted](https://github.com/karottc/dsh-plugin-workspace-sorted)：host 插件按"最近使用"排序工作区，
  README 里给出了与我们**完全一致**的判断（侧边栏的"手动排序 / 最近更新"只作用于会话，工作区分组顺序永远是 Host 注册表的持久顺序）。
- [LostAbaddon/dsh-workspace-sort](https://github.com/LostAbaddon/dsh-workspace-sort)：按最新会话排序工作区，并可配置每个工作区显示的会话数。
- 我们自己的包也在列表里（`Moonshile/moonshile-dsh-plugins`）。

### 9.4 session 迁移 / 修复 / 备份（插件，不是 skill）

| 项目 | 用途 |
|---|---|
| [EIGHTfs/dsh-session-migrate](https://github.com/EIGHTfs/dsh-session-migrate) | 跨版本会话迁移：扫旧存储（v0 明文 / `.zstd` / `.zip` 导出），重新钉 header 的 cwd 到目标工作区，丢进新 home 让持久层在打开时升级；带设置页与 `check/fix/import` CLI |
| [EIGHTfs/dsh-session-conductor](https://github.com/EIGHTfs/dsh-session-conductor) | 会话管理 + **修复损坏日志**（seq 缺口 / EIO / 双格式） |
| [Coprexist/dsh-session-recovery](https://github.com/Coprexist/dsh-session-recovery) | 从磁盘裸恢复被删/损坏的 session 与 `memory.db`，Web UI 里的 `/session-repair` |
| [xiaoshenming/dsh-session-surgeon](https://github.com/xiaoshenming/dsh-session-surgeon) | 修复"打不开的会话"，带 dry-run |
| [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup) | 一条命令备份/恢复 DSH 用户数据（sha256 校验、加固恢复）——可直接用作 §8 步骤 2 的备份实现 |
| [BakaCirno233/dsh-session-delete](https://github.com/BakaCirno233/dsh-session-delete)、[cyh3436332528/dsh-plugin-session-purge](https://github.com/cyh3436332528/dsh-plugin-session-purge) | 会话级彻底删除（含 projection cache / 工作区记账 / 子会话） |

### 9.5 升级流程 / session 迁移的 **Skill** —— 有，但走廊没覆盖 0.2

| Skill | 覆盖范围 | 与我们的关系 |
|---|---|---|
| [ybl2020/dsh-upgrade](https://github.com/ybl2020/dsh-upgrade) | 升级流程技能：**升级前评估 → 用户审核放行 → 强制备份 → 升级 → 证据式验证**，含回滚手册、第三方插件**与技能**双维度评估、npm 11 静默跳过原生模块、`dsh web` token/401、`--dump-config` 不是只读命令 | 流程骨架与 §8 高度重合，**可以借鉴/直接用**；但它基于 `0.1.2-rc.1 → 0.1.5-rc.1`，其中"**dsh 不强制校验 peer 依赖**"的前提在 0.2 已经不成立（0.2 有硬闸门）|
| [Fabian-698/dsh-update-guide](https://github.com/Fabian-698/dsh-update-guide) | 0.1.2 → 0.1.5：**v0→V3 会话迁移修复**、UNKNOWN_MODEL 批量修、会话日志+配置双验证门 | 唯一明确带"session 迁移修复"的 skill，但同样是 0.1.x 走廊 |
| [PerryLink/dsh-plugin-upgrade](https://github.com/PerryLink/dsh-plugin-upgrade) | **插件作者**视角：走廊卡（`0.1.3-alpha.1→0.1.5-rc.1`、`0.1.5-rc.2→0.1.6-alpha.2`）+ 零依赖 seam 扫描器（bundle skill + npx CLI） | 方法论可借；走廊卡需要有人补 `0.1.5-rc.2 → 0.2.0-rc.2` 这张 |
| [william-jin-cmu/dsh-plugin-upgrade](https://github.com/william-jin-cmu/dsh-plugin-upgrade)、[gezi-wen/dsh-repair](https://github.com/gezi-wen/dsh-repair)、[oldzhang82/dsh-conservative-upgrade](https://github.com/oldzhang82/dsh-conservative-upgrade) | 插件跨版本升级 skill / 装坏了怎么修 / "保守升级"策略（别 fork 插件、审 peer、等作者兼容版） | 可作对照阅读 |

技能安装位置：`~/.agents/skills/<name>/` 或 `~/.dsh/skills/<name>/`（本机目前只有 `~/.dsh/plugins/`，还没有 skills 目录）。

### 9.6 取舍建议

1. **`dsh-last-turn-delete`：先"抄结论"，再决定要不要换。**
   社区两个 0.2 版本（`DDDMUC/dsh-delete-turn`、`TiJun-Prime/dsh-turn-delete`）已经把 peer 闸门、slot `id`、
   图标改名、v4 source 角色校验、turn-less 载体全部踩通并写进 README。我们要么按 §3 自己修（工作量不大），
   要么直接切到 `dsh-delete-turn`（能力更强：单条用户消息 / 单个工具步骤 / 整轮，且它把 hidden 台账建在日志上，
   没有 `inspect` 这类冷会话问题）。**不建议**继续用 npm 上的 `hanshenmesen/dsh-turn-delete`（过不了 0.2 闸门）。
2. **`dsh-web-direct`：保留。** 社区的等价物都只覆盖 web_fetch 半边，且默认 CIDR 不含本机的 `198.19.x`；
   我们的插件同时修 search 与 fetch，是更完整的方案。可以考虑把"allow list CIDR"做成配置项以便复用社区思路。
3. **`dsh-workspace-sort`：保留或换 `karottc/dsh-plugin-workspace-sorted`。** 语义一致，
   社区版本额外有"可配置每工作区会话数"，但它是 GitHub 安装（未上 npm）。
4. **升级技能：现在没有能直接用的 0.2 走廊技能。** 最低成本是把 §8 落成一个 `SKILL.md`
   （本仓库 `scripts/audit-session-markers.mjs` 就是它的第一步），走廊卡命名参照 `PerryLink` 的
   `0.1.5-rc.1 → 0.2.0-rc.2`。
5. **社区 README 的结论仍要复核**：例如 TiJun 的 README 称 `>=0.1.5-rc.2 <0.3.0` 在 0.2 闸门下判定为 false，
   但用 dsh 自己调的 node-semver（`includePrerelease: true`）实测是 **true** —— 大概率是版本/参数差异，
   发布前请按你的目标 dsh 构建实测一遍。

### 9.7 peer 范围实测表（dsh 的 `evaluatePluginCompatibility` 用 `includePrerelease: true`）

| range | 0.1.5-rc.1（现在） | 0.1.5-rc.2 | 0.2.0-rc.1 | 0.2.0-rc.2 | 0.2.1-alpha.2 |
|---|---|---|---|---|---|
| `^0.1.2-alpha.5`（现状） | ✅ | ✅ | ❌ | ❌ | ❌ |
| `^0.1.5-rc.2` | ❌ | ✅ | ❌ | ❌ | ❌ |
| `^0.2.0-rc.2` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `^0.1.5-rc.1 \|\| ^0.2.0-rc.2` | ✅ | ✅ | ❌ | ✅ | ✅ |
| `^0.1.5-rc.2 \|\| ^0.2.0-rc.1` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `>=0.1.5-rc.1 <0.3.0` | ✅ | ✅ | ✅ | ✅ | ✅ |

**建议**：想"一份包同时服务升级前后"用 `^0.1.5-rc.1 || ^0.2.0-rc.2`（或更宽的 `>=0.1.5-rc.1 <0.3.0`）；
只服务 0.2 就用 `^0.2.0-rc.2`。注意 `^0.2.0-rc.2` **不匹配 `0.2.0-rc.1`**，若还有人跑 rc.1 需并写上它。

---

## 10. 只考虑 session：v3→v4 迁移的实弹预演

问题：**不修插件、只让 session 平滑升级，需要做什么？** 结论先说：**166 个顶层会话 100% 自动迁移，
需要动手的只有 5 个 subagent 子会话**（另有 61 个子会话是"今天就打不开"，与升级无关）。

### 方法

`scripts/session-migration-dry-run.mjs` —— **只读**预演：对每个会话复刻 0.2 持久化的真实流程
（收集子会话事实 → `createSessionFormatCatalogWithChildren(facts).createRestore(header, {recoverable, transformed})`
→ 逐行 `decodeRow` → `finish`），不写任何文件、不加锁、不发布后继。对同一份 `~/.dsh/sessions`
分别用 **0.1.5** 与 **0.2.0-rc.2** 的 catalog 各跑一遍，然后 diff。

```bash
# 只读预演（目标版本）
node scripts/session-migration-dry-run.mjs --dsh /tmp/dsh-probe/node_modules/@deepseek-ai/dsh --json-out /tmp/dryrun-020.json
# 基线（当前版本）
node scripts/session-migration-dry-run.mjs --dsh "$(npm root -g)/@deepseek-ai/dsh" --json-out /tmp/dryrun-015.json
```

语料：`~/.dsh/sessions`，**624 个会话**（当前代文件合计约 639 MB，其中 166 个顶层、458 个 subagent）。

### 结果

| | 0.1.5（今天） | 0.2.0-rc.2 | 归属 |
|---|---|---|---|
| 迁移通过 | 563 | **558** | — |
| 失败 | 61 | **66** | 全部是 `origin: "subagent"` 的子会话 |

diff 出来的三类：

1. **558 个两边都通过** —— 升级后打开/继续对话都会在写打开时自动发布 v4 后继。
2. **61 个两边都失败** —— 全是 v0 文件（`session.jsonl.zstd`，目录里没有更新的代），
   60 个报 `subagent/descriptor … uses unsupported descriptor version 2`、1 个报 `turn/start 2 does not close the prior turn`。
   这条 `version !== 3` 的规则**在 0.1.5 的 v0→v1 codec 里一模一样** → 它们**今天就已经打不开**，升级既不修好也不变坏。
   建议单独归档（见下方"处置"）。
3. **5 个只有 0.2 失败** —— **真正的升级回归**（全是 v3 文件、全是 subagent 子会话）：

| 会话 | 父会话 | 迁移 |
|---|---|---|
| `competition-by-branch/6a978f80…` | `691b11ce…` | ❌ 父 ✅ |
| `competition-by-branch/c2c02166…` | `691b11ce…` | ❌ 父 ✅ |
| `competition-by-branch/c65745be…` | `c2c02166…` | ❌ 父也是子会话 |
| `journal/075d5a7e…` | `5b22d91b…` | ❌ 父 ✅ |
| `journal/63a39976…` | `5b22d91b…` | ❌ 父 ✅ |

**顶层（用户可见的）会话 0 失败。**

### 那 5 个为什么坏，能不能自动修

它们的 turn 括号在**中间**没闭合（v3 容忍、v4 要求严格配对）：

```
S1  E1(interrupted)  S2  S3  E3(completed)      ← turn 2 从未闭合
S1  E1(interrupted)  S2  S3  S4  E4(completed)  ← turn 2 从未闭合
S1  S2  E2(completed)                           ← turn 1 从未闭合
```

v3→v4 确实带了"闭合有证据的中断回合"的修复，但条件很窄（README 原文）：只有当下一个 `turn/start`
**紧跟一个非空 `agent/inbox/spliced`（target 为 `next-turn`）** 时，才会在它前面插入
`turn/end {reason: interrupted}`；"Open tails remain open. Other turn-order violations, unresolved tools,
and active compactions still fail target validation."

- 这 5 个都不满足该证据条件；
- 内置的崩溃修复 `interruptedTurnClosers()` 实测对这 5 个返回**空数组** —— 它只补**尾部**未闭合的回合。

### 处置（按推荐顺序）

1. **不管**：父会话照常打开，只有点开这些子会话时才看到 format-refusal 报错；父的 catalog 会把它们记成
   "描述符不可用"的子项（告警，不影响父会话）。原始 v3 文件永远只读保留，内容不丢。
2. **升级前移出 sessions 根**（例如 `mv` 到 `sessions-archive/`）：子会话从"打不开"变成"缺失"，
   父会话依旧正常，界面上不再有红字。
3. **升级前用 0.1.5 打开并导出内容存档**（它们今天是可读的）。
4. 真要修就得写转换器：在违规的 `turn/start` 前插入 `turn/end`，并把其后所有 `seq` 引用（`sourceEventSeqs`、
   surfaceOp 区间）按同一套坐标重映射 —— 和 v3→v4 stage 内部的做法一致，成本不低，只有 5 个会话，**不建议**。
5. 下策：把日志截断到最后合法前缀（丢弃后面轮次的内容）。

对上面 61 个"早已损坏"的子会话也一样：1/2/3 都适用，它们本来就不影响父会话。

### session 之外的存储状态：不需要处理

- `~/.dsh/storages` 的域版本两版一致：`workspace` = 2、`session_projcache` = 7、`message_feedback` = 0；
  `session_projcache` 只是投影缓存，丢了会自动重建。
- 惰性迁移：浏览/列列表**只读头部**，不触发迁移；只有写打开才发布 v4 后继 →
  磁盘占用最多翻倍（639 MB → ~1.3 GB），且首次打开大会话（本机最大 76 MB 压缩日志）会有一次完整
  解码 + 重编码的延迟。
- 回滚：对升级后**没写过**的会话，删掉 `session.v4.jsonl.zstd` 就回到 0.1.5 可读状态。

### 结论

**只考虑 session，升级是平滑的**：166 个顶层会话 100% 自动迁移，无需任何预处理；
需要动手的只有 5 个子会话（外加 61 个早就坏了的子会话，可以先归档）。
真正的不确定性仍然在插件侧（§1–§3），与 session 数据本身无关。

---

## 11. 插件实弹验证：把最小改动打上去，在 0.2 里真跑一遍

做法：把四个插件复制到 `/tmp/pluginfix`（**不动本仓库**），只打"最小改动"，再装进隔离 profile
用 0.2.0-rc.2 启动，逐个验证宿主半边、浏览器半边、数据面。改动总量：

```
plugins/dsh-last-turn-delete/lib/core.js            2 行（marker source 形态 + 读取端兼容）
plugins/dsh-last-turn-delete/lib/core.test.mjs      2 行（断言跟随）
plugins/dsh-last-turn-delete/package.json           peers 4 行
plugins/dsh-web-direct/package.json                 peers 3 行
plugins/dsh-responses-replay-fix/lib/index.js       settings 注册块 → 读 entry config（-8/+5 行）
plugins/dsh-responses-replay-fix/package.json       schemastery peer 1 行
plugins/dsh-workspace-sort                          无改动
```

### 结果

| 插件 | 不改动直接升 | 最小改动后 | 验证方式与结果 |
|---|---|---|---|
| `dsh-workspace-sort` | ✅ 正常 | 无需改动 | 隔离 profile 启动**无** `did not activate`；0.2 里 `workspaceRegistry.list()/insertBefore()`、`session/event` 都在 |
| `dsh-web-direct` | ❌ 被 peer 闸门跳过 | peer 范围 | 启动无告警；**headless A/B 实测**：不装插件 → `web_fetch https://example.com` 返回 `URL hostname "example.com" resolves to a non-public IP address`；装上后同一提示 → `Fetched https://example.com/ (HTTP 200)` |
| `dsh-last-turn-delete` | ❌ 闸门跳过 **且** 数据面会写坏日志 | peer + marker source + 读取端 | 启动无告警；`POST /api/lastTurnDelete/tail` 返回**业务响应**（证明 Typert Remote 在 0.2 网关下可调用）；浏览器半边出现在 `__DSH_BOOT__.entries` 且 `/plugins/??dsh-last-turn-delete/client.js` 200；数据面：把标记事件追加到"真实 v3 会话迁移出的 v4 日志"→ **严格冷读通过**；旧形态 → **连编码都过不去** |
| `dsh-responses-replay-fix` | ⚠️ 能装，但 settings 段**静默失效** | settings → entry config | 0.2 全树无 `installSection`（`SettingsForms.prototype` 只有 `configure/describe/update/...`），调用发生在 deferred inject 回调里 → **启动不报错**，只落在 fiber 错误日志；修复后 boot 干净，同一 boot 内**真实 LLM 回合成功**（说明 adapter 包装没有破坏 llm 路径）|

数据面的关键证据（`/tmp/v4-roundtrip.mjs`，只读）：

```
源会话: session-09b88014-… | 声明版本: 3 | 行数: 1455
迁移后: 版本 4 | 事件 1458
新形态 source = {"kind":"plugin:dsh-last-turn-delete"}
  [plugin:dsh-last-turn-delete] 严格冷读: ✅ 通过（事件 1459）
  [plugin wrapper（旧形态）]     ❌ 连编码都过不去 — format v4 message requires a producer-owned source kind
读取端: 新形态/迁移后形态/迁移前形态/更老的 name+operation 形态 → isDeleteMarker 全为 true
```

### 复现命令

```bash
# 1) 拷贝 + 只打最小改动（peer 范围、marker source、settings→entry config）
# 2) 隔离 home：把 profile 的四个插件依赖指向改动后的目录
# 3) 组合层检查：stderr 必须干净（没有 "skipping profile bundle"）
DSH_HOME=/tmp/dsh-home-021 node /tmp/dsh-probe-020/node_modules/@deepseek-ai/dsh/lib/bin.js web --dump-config
# 4) 启动 + 三个探针
DSH_HOME=/tmp/dsh-home-021 node /tmp/dsh-probe-020/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3098 --no-open
curl -sL -c cj -b cj "http://127.0.0.1:3098/?token=$TOKEN" -o index.html    # __DSH_BOOT__.entries 里应有 dsh-last-turn-delete
curl -s -b cj "http://127.0.0.1:3098/plugins/??dsh-last-turn-delete/client.js&rev=$REV" | head -3
curl -s -b cj -X POST http://127.0.0.1:3098/api/lastTurnDelete/tail -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"r1","method":"lastTurnDelete/tail","payload":{"args":{"request":{"sessionId":"nonexistent"}}}}'
# 5) 真实 agent A/B（headless profile + 我们三个插件）
node …/bin.js --profile plugcheck --json "Call the web_fetch tool on https://example.com once and report exactly what it returned."
```

### 顺带踩到的部署坑（与 §2.7 呼应）

- 用 `link:` 装插件时，插件目录**必须能解析到宿主包**：我第一版 scratch 目录没有 `node_modules`，
  0.2 启动直接报 `last-turn-delete (dsh-last-turn-delete): failed to import`。
  生产里 `file:` 安装只拷 `files` 白名单（无 `node_modules`）→ 向上解析到 profile 的宿主 farm ✓；
  而 `link:` 指向仓库源码时会命中仓库内的旧副本。**结论：别用 `link:` 装到 profile，或者让插件目录的
  `node_modules` 指向宿主安装。**

### 还剩的未知（只有真机点一下才能确认）

1. 浏览器里删除按钮的实际交互：slot 契约（`kind: "list"` 需 `id`，我们只有一处非 list 注册且带 id ✓）
   与图标 —— `IconTrashOutline16` 在 0.2 已不存在，会走自绘 SVG 兜底（按钮不会消失，但视觉与原生不同）。
2. `responses-replay-fix` 的包装"真的生效"需要一次 zhongxin 请求才能看到（补 `msg_` 前缀、补 `reasoning_text`）。
3. 冷会话删除在 0.2 仍不可用：实测报错原文 `this.ctx.sessionPersistence.inspect is not a function`
   （这是既有 bug，不是升级引入；改成 `open(id, "read")` + `handle.read()` 即可）。

### 一句话结论

**四个插件在 0.2 里"能平滑升级"，但不是零改动**：`workspace-sort` 零改动；`web-direct` 只需改 peer 范围；
`last-turn-delete` 改 peer + marker source（2 行）+ 读取端兼容（1 行）；`responses-replay-fix` 的 settings
注册块要改写成 entry config。改动总量约 30 行，其中一半是 package.json。

---

## 12. 落地记录：仓库已改完，回归已重跑（2026-10-13）

§11 的"最小改动"已经正式落到本仓库（不是 /tmp 副本）。改动清单：

| 文件 | 改动 |
|---|---|
| `plugins/dsh-last-turn-delete/lib/core.js` | marker source 改为 `plugin:dsh-last-turn-delete`；`isDeleteMarker` 认三种形态（新形态 / 迁移前 wrapper / 更老的 name+operation） |
| `plugins/dsh-last-turn-delete/lib/index.js` | 冷会话读取从 `sessionPersistence.inspect`（两个版本都不存在）换成 `open(id, "read")` + `handle.read()` + `handle.close()`，读打开同时让 DSH 在内存里迁移历史代 |
| `plugins/dsh-last-turn-delete/lib/core.test.mjs` | 断言跟随新形态；新增"迁移后/pre-v4 wrapper 都要认"的用例（17 通过） |
| `plugins/dsh-last-turn-delete/package.json` | version `0.1.2`；peers → `^0.1.5-rc.1 \|\| ^0.2.0-rc.2`（cordis `^4.0.4`） |
| `plugins/dsh-web-direct/package.json` | version `0.1.1`；peers → 双线范围（代码零改动） |
| `plugins/dsh-responses-replay-fix/lib/index.js` | `settings.installSection` 注册块 → 读 `apply(ctx, entryConfig)` 的 entry config；删掉死的 `SETTINGS_NAMESPACE` |
| `plugins/dsh-responses-replay-fix/package.json` | version `0.1.2`；schemastery peer `^3.18.4` |
| 三个插件的 README / README.zh / README.i18n.yaml | 配置位置从 settings.yaml 改为 profile `cordis.patch.yml` 的 entry config；补"兼容性"段；i18n 哈希已重录 |
| `pnpm-lock.yaml` | pnpm 自动重解析 dev 依赖到 0.2.0-rc.2 / cordis 4.0.4（`pnpm install --frozen-lockfile` 通过，CI 不受影响） |
| `dsh-workspace-sort` | **零改动**（无 `dsh-*` peer，API 与 0.2 一致，不需要新版本） |

### 改完后的回归证据（全部重跑）

```bash
pnpm test                       # 4 个包全绿：3 / 17 / 9 / 27
pnpm install --frozen-lockfile  # exit 0（CI 的安装步骤）
```

1. **组合层**：隔离 profile + 0.2.0-rc.2 `web --dump-config` → stderr 为空（不再有 `skipping profile bundle`）。
2. **启动**：`dsh web` 启动日志无 `did not activate` / `failed to import`。
3. **宿主 Remote 真的能用**（0.2 网关，真实会话、无 live agent）：
   ```json
   POST /api/lastTurnDelete/tail
   {"ok":true,"value":{"ok":true,"value":{"kind":"message","messageId":"ecef79a7-...","running":false}}}
   POST /api/lastTurnDelete/deleted
   {"ok":true,"value":{"ok":true,"value":{"items":[{"messageId":"abb3c7da-...","seq":1399}],"compactCommandIds":[]}}}
   ```
   —— 顺带证明了 §2.6 那个 `inspect` bug 已修好（修复前同一条请求返回
   `"cause":"this.ctx.sessionPersistence.inspect is not a function"`），而且**读取端认出了真实 v3 日志里的旧形态标记**。
4. **浏览器半边**：`__DSH_BOOT__.entries` 里有 `dsh-last-turn-delete`，`/plugins/??dsh-last-turn-delete/client.js&rev=…` 返回 200。
5. **数据面**（`scripts/plugin-v4-roundtrip-check.mjs`，用仓库里的插件代码）：新形态 → 严格冷读 ✅；旧形态 → 编码阶段即被拒 ❌；读取端四种形态全认。
6. **真实 agent A/B**（headless profile + 三个插件）：`web_fetch https://example.com` → `Fetched https://example.com/ (HTTP 200)`
   （不装插件时同一请求失败：`resolves to a non-public IP address`）。

### 还没做、留给下一步的

1. **发布**：push 后 CI 会发布 `dsh-last-turn-delete@0.1.2`、`dsh-web-direct@0.1.1`、`dsh-responses-replay-fix@0.1.2`（`dsh-workspace-sort` 无新版本）。
2. **升级宿主**：`npm i -g @deepseek-ai/dsh@0.2.0-rc.2` → `dsh plugin --profile web install`；
   升级前按 §10 处理那 5 个 subagent 会话（可选），并按 §8 备份。
3. **真机点一下**：删除按钮的浏览器交互（图标会走自绘兜底）、`responses-replay-fix` 对 zhongxin 的实际规整效果。
