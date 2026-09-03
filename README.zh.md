# moonshile-dsh-plugins

[English](README.md) | 中文

Moonshile 的 DeepSeek Harness (DSH) 插件集合。每个插件一个独立目录、依赖各自管理，pnpm workspace 统一编排。

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

## 结构

```
plugins/
└── <package-name>/
    ├── package.json   # 独立包：name / main / files / scripts
    ├── lib/           # 实现（host 半边 / client 半边）
    ├── lib/*.test.mjs # node:test 纯函数测试
    └── README.md      # 英文版（中文见 README.zh.md）
```

## 本地开发

```bash
pnpm install     # 根目录安装 workspace
pnpm test        # 运行全部插件测试（pnpm -r test）
```

## 发布

每个插件独立发布到 npm（包名需全局唯一）：

```bash
cd plugins/<package-name>
pnpm publish --access public
```

## 插件

所有插件都是 npm 包，用 `dsh plugin` 一条命令安装（自动激活的 bundle）。每个插件有独立目录和 README。

| 插件 | 说明 | 安装 | 使用方法 |
| --- | --- | --- | --- |
| [dsh-workspace-sort](plugins/dsh-workspace-sort/README.md) | 侧边栏工作区**每日**按最近活动排序一次（当天顺序稳定） | `dsh plugin --profile web add dsh-workspace-sort` | 无需配置——安装后重启 `dsh web`，它每天按会话活动自动排序；上次排序日期存于 `~/.dsh/workspace-sort-state.json`。 |
| [dsh-last-turn-delete](plugins/dsh-last-turn-delete/README.md) | 最新可删项（最后一条用户消息或失败的 `/compact` 卡片）上的垃圾桶按钮（与待发队列同款图标），**软删除该轮对话**使其不再进入模型上下文，随后移到上一项，直到真正 compact 边界或无消息 | `dsh plugin --profile web add dsh-last-turn-delete` | 安装后重启 `dsh web` 并刷新。点垃圾桶（确认气泡）即删除；按钮在回复结束后才出现。被删除的一轮在界面中变暗；持久化日志不会被改写。 |
| [dsh-responses-replay-fix](plugins/dsh-responses-replay-fix/README.md) | 修复严格 Responses 网关（如中信 `www.wxzjai.com`）拒绝历史回放：回放前给消息 id 补 `msg_` 前缀、给 thinking 补明文 `reasoning_text` | `dsh plugin --profile web add dsh-responses-replay-fix` | 无需配置——安装后重启 `dsh web`。默认只作用于 `zhongxin` provider，可在 settings 段 `responses-replay-fix.providers` 配置更多。 |

## 添加插件

1. 新建 `plugins/<包名>/`，配好 `package.json`（name、main、files、license、`dsh.bundle.patch`）和 `lib/`。
2. 以 `lib/*.test.mjs`（node:test）补测试，用 `pnpm test` 验证。
3. 在 [插件](#插件) 表格里加一行。
4. 发布到 npm（`pnpm publish --access public`）；仓库 CI 会在 push 时自动发布未发布的版本。
