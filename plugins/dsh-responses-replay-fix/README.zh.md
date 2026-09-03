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
    包装 PiAiAdapter.prototype.streamWithSnapshot
      options.messages (durable assistant 消息)
        ├─ textSignature.id  →  缺 msg_ 前缀则补
        └─ thinkingSignature →  无明文 reasoning_text 时补
                                content: [{ type: "reasoning_text", text: <summary> }]
      yield* original(options, snapshot)   ← 网关收到合规回放
```

包装点选 `streamWithSnapshot`：所有调用路径（`stream()` 与 `prepareCall` 返回的 stream 闭包）都经过它，一处补丁即覆盖整个 provider。目标 provider 名单每次请求从 settings 段读取（经 `source()`），所以改 settings 无需重启即时生效。纯规整逻辑在 `lib/core.js`（有单测，不依赖 DSH 运行时）。

## 开发

```bash
pnpm test          # 运行 lib/core.test.mjs
```
