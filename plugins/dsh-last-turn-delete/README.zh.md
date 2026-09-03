# dsh-last-turn-delete

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-last-turn-delete.svg)](https://www.npmjs.com/package/dsh-last-turn-delete)

DeepSeek Harness (DSH) 插件 bundle：在会话**最新可删项**上显示一个**垃圾桶按钮**——它可以是**最后一条用户消息**，也可以是**失败的 `/compact` 卡片**。点击后（在小气泡中确认）即**软删除**该项，随后按钮自动移到上一条，直到真正（成功）的 compact 边界或无消息为止。

## 为什么

长时间的 agent 会话会积累你不再希望模型记住的轮次，以及挡在中间的“失败的 /compact”卡片。DSH 的会话日志按设计只追加，没有内置“删除这一轮”的能力；本插件用与 compact 相同的机制在**模型可见 surface** 上删除，不动你的持久化日志。

## “删除”的含义

- **用户消息 + 其整段回复**会被一条替换事件从模型 surface 上遮蔽，之后不再进入任何后续请求的上下文。原始事件仍在磁盘上；该一轮在界面中变暗（软删除，不丢数据）。
- **失败的 `/compact` 卡片**没有成功压缩任何内容，因此**不是 compact 边界**——同样可以删除。删除时把该命令 id 记入一个小的私有侧表（`dsh_last_turn_delete` storage domain），删除链随后继续越过它。**成功的 compact 仍是真正的边界**：它覆盖的内容（已离开模型 surface）不可删除。
- 按钮只在 agent **回复完全结束**后出现（宿主报告 `running`）；回复过程中隐藏。

## 安装

需要 PATH 上有 [pnpm](https://pnpm.io/installation) —— `dsh plugin` 会把 profile 的包操作转发给 pnpm。

```bash
dsh plugin --profile web add dsh-last-turn-delete
```

把 npm 包装进 `web` profile 并作为 bundle 激活（本包声明了 `dsh.bundle.patch`）。**一条命令，无需手动改 patch。** 重启 `dsh web` 后刷新页面。

其他 profile：把 `web` 换成对应名字，例如 `dsh plugin --profile <名字> add dsh-last-turn-delete`。

## 行为

- **按钮**：与待发消息队列同款的 `IconTrashOutline16`，插入到消息操作条中、紧挨复制按钮；它克隆原生操作按钮的类，因此静置/悬停外观与复制按钮完全一致（无自定义颜色）。任意会话（新旧均可）只要在 GUI 中打开即可使用。
- **删除流程**：点垃圾桶 → 弹出小气泡（`确认删除` / `取消`；Esc 或点击其它位置取消）→ 确认 → 宿主软删除，按钮移到上一项。
- **链式前进**：可连续删除；删除链向后穿过“失败的 compact 卡片”与用户消息，直到真正（成功）的 compact 边界或无用户消息。
- **刷新恢复**：已删除的用户消息从日志重新推导，已删除的失败 compact id 记在侧表——变暗状态与按钮位置在刷新后依然正确。
- **安全**：可删尾由宿主的 `tail` Remote 判定（已并入流式、边界与先行删除），且只在 agent 空闲时删除；过期点击会被拒绝并重新锚定到真实尾部。

## 实现原理

```
浏览器（client 半边）
  垃圾桶按钮挂在最新可删行（消息操作条）
    点击 → 内联确认气泡 → 删除
        │  lastTurnDelete/delete        { sessionId, messageId }
        │  lastTurnDelete/deleteCompact { sessionId }
        ▼
宿主（lib/index.js，lastTurnDelete Remote 服务）
  delete            agent.runMaintenance（仅空闲、与 driver 串行）
                    session.surface.nodes → 最后一个 on-surface 用户消息
                    session.append("user/message", marker, {
                      surfaceOp: { op: "replace", start, end },
                      sourceEventSeqs: shadowed
                    }) + ctx.sessions.flush()   ← 该段离开 surface
  deleteCompact     最新失败 /compact 组 → 侧表记录
  tail              最新可删项 + agent running 标志
  deleted           已删除消息 + 已遗忘的 compact id
```

宿主权威结果通过 `lastTurnDelete/tail` 回传：最新可删项（`{kind: "message", messageId}` / `{kind: "compact", commandId}` / `{kind: null}`）外加 `running`。纯选取逻辑在 `lib/core.js`（有单测、不依赖 DSH 运行时）；标记/用户消息载荷使用插件自己的 `source` 身份，因此不会把 compact 检查点误判为删除。按钮与气泡全部使用创建节点上的内联样式——注入的 `<style>` 由宿主模块系统接管、不可依赖。

## 开发

```bash
pnpm install
pnpm test     # node:test 纯函数测试，不依赖 DSH 运行时
```

## 发布

```bash
cd plugins/dsh-last-turn-delete
pnpm publish --access public
```
