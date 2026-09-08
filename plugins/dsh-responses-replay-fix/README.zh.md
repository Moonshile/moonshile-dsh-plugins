# dsh-responses-replay-fix

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-responses-replay-fix.svg)](https://www.npmjs.com/package/dsh-responses-replay-fix)

DeepSeek Harness (DSH) host 插件：修复**严格 OpenAI-Responses 兼容网关**拒绝历史回放（HTTP 400）的问题——这类网关"出站不规范、入站却按 OpenAI 官方规则严格校验"（已确认：**中信**网关 `www.wxzjai.com`，以及任何行为相似的代理）。

## 症状

在这类网关上继续会话时，请求报错：

1. `Invalid 'id': message id must be a string starting with 'msg_', got '<uuid>'`

   网关之前返回的 assistant message item id 是裸 UUID。DSH 把它存进回放状态，下一轮原样回发；网关入站校验要求必须以 `msg_` 开头 → 400。

2. `The reasoning_text in the thinking mode must be passed back to the API.`

   网关返回的 reasoning item `content` 为 `null`（只有带明文推理的 `summary`）。DSH 把整个 item 原样持久化并回放，输入里的 reasoning item 因此没有明文 `reasoning_text`；thinking 模式下网关拒绝。

官方 OpenAI、`morph` 等规范网关不会遇到，因为它们的出站本身符合规则（或入站校验宽松）——这正是为什么只有这个严格网关报错。

## 插件做什么

每次向目标 provider 发 LLM 请求前，对回放的 assistant 消息（`source.replayState.blocks`）做规整：

- **消息 id**（`textSignature`）：不以 `msg_` 开头的补 `msg_` 前缀（保持 ≤64 字符）；
- **reasoning item**（`thinkingSignature`）：content 缺明文 `reasoning_text` 时，用 item 自身的 `summary` 文本补上（已是 `msg_`/`rs_` 前缀的 id 原样保留）。

只改动"确实需要修"的消息——规范消息零修改直接放行，非目标 provider 完全不碰。磁盘上的历史不被改写，规整只在请求路径上于内存中完成。

## 安装

需要 PATH 上有 [pnpm](https://pnpm.io/installation)——`dsh plugin` 会把 profile 的包操作转发给 pnpm。

```bash
dsh plugin --profile web add dsh-responses-replay-fix
```

一条命令，无需手动改 patch。重启 `dsh web` 并刷新页面。

其他 profile：把 `web` 换成 profile 名，例如 `dsh plugin --profile <name> add dsh-responses-replay-fix`。

## 目标 provider

默认只作用于 **`zhongxin`** provider 路由。生效名单通过 DSH **settings 段** `responses-replay-fix` 配置（settings.yaml 顶层键，与 provider 配置同一处编辑）：

```yaml
responses-replay-fix:
  providers:
    - zhongxin
    - b-ai
```

- **未配置** → `["zhongxin"]`（默认）。
- **显式 `providers: []`** → 不修复任何 provider（等于关闭插件效果）。
- **给定列表** → 只规整这些 provider 路由（`b-ai` 是另一个已知会返回裸 UUID 消息 id 的路由）。
- settings 改动对后续请求即时生效——无需重启。

## 工作原理

```
dsh web host (lib/index.js)
  apply(ctx)
    注册 settings 段 "responses-replay-fix"（providers 名单）
    读 ctx.llm.adapters → 逐个包装 adapter 实例的 streamWithSnapshot
      options.messages (durable assistant 消息)
        ├─ textSignature.id  →  缺 msg_ 前缀则补
        └─ thinkingSignature →  无明文 reasoning_text 时补
                                content: [{ type: "reasoning_text", text: <summary> }]
      yield* original(options, snapshot)   ← 网关收到合规回放
```

包装目标是 `ctx.llm` 服务上注册的每个 adapter **实例**（在实例上挂 own `streamWithSnapshot` 遮蔽原型方法），而不是模块 class 的 prototype。所有调用路径（`stream()` 与 `prepareCall` 返回的 stream 闭包）都经 `this.streamWithSnapshot` 动态下发，包装实例即可覆盖整个 provider。

为什么包装实例而不是 class：profile bundle 插件经自己的 `node_modules` 链解析 `@deepseek-ai/dsh-llm-pi-ai`（开发期是 pnpm `link:`，发布后走 registry）。Node 的 ESM 缓存按**模块 URL** 去重——symlink 路径与宿主 bundle 的路径是两个不同模块实例，也就是两个不同 class。patch 插件所见副本的 prototype 不会作用到宿主实际实例化的那个 class。从 `ctx.llm`（宿主进程内的单例服务）取 adapter，无论模块怎么解析，拿到的都是请求真正经过的那个实例。`llm/adapters-updated` 事件触发时会重扫（provider 变更 / HMR 重注册也会被包装）；`PATCHED` 标记保证每个实例只包装一次。

目标 provider 名单每次请求从 settings 段读取（经 `source()`），所以改 settings 无需重启即时生效。纯规整逻辑在 `lib/core.js`（有单测，不依赖 DSH 运行时）。

## 开发

```bash
pnpm test          # 运行 lib/core.test.mjs
```
