# dsh-workspace-sort

[English](README.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-workspace-sort.svg)](https://www.npmjs.com/package/dsh-workspace-sort)

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

入选列表：[0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) · [awesome-deepseekharness/awesome-deepseek-harness](https://github.com/awesome-deepseekharness/awesome-deepseek-harness)

DeepSeek Harness (DSH) 插件 bundle：侧边栏工作区顺序**每天**按最近活动刷新一次，当天其余时间完全稳定。

## 为什么

DSH 原生工作区顺序是手动拖拽（持久化的 `workspaceIds` 数组），"Last updated" 视图选项只作用于组内会话排序。如果每次会话活动都把工作区置顶，顺序会频繁跳动、干扰使用。本插件改为**每天一次全量排序**：日历日内第一次会话活动触发排序，之后当天不再变动。

## 安装

需要 PATH 上有 [pnpm](https://pnpm.io/installation) —— `dsh plugin` 会把 profile 的包操作转发给 pnpm。

```bash
dsh plugin --profile web add dsh-workspace-sort
```

把 npm 包 [`dsh-workspace-sort`](https://www.npmjs.com/package/dsh-workspace-sort) 装进 `web` profile 并作为 bundle 激活（本包声明了 `dsh.bundle.patch`）。**一条命令，无需手动改 patch。** 安装后重启 `dsh web` 以挂载 bundle 层。

其他 profile：把 `web` 换成对应名字，例如 `dsh plugin --profile <名字> add dsh-workspace-sort`。

## 行为

- **排序触发**：日历日的第一次 `session/event` 活动（任何工作区名下会话产生新事件）
- **排序依据**：自插件启动以来累计的各工作区最近活动时间，按降序全量重排；未记录活动的工作区保持原相对顺序（稳定排序）
- **当天稳定**：同一天内不再重排，手动拖拽的顺序当天有效
- **持久化**：`~/.dsh/workspace-sort-state.json` 记录上次排序日期（`DSH_HOME` 可覆盖家目录）
- **限制**：服务器当天重启后首次排序的活动样本可能不足，次日起准确；ungrouped 会话不参与

## 开发

```bash
pnpm install
pnpm test     # node:test（纯函数测试，无 DSH 运行时依赖）
```

## 发布

```bash
cd plugins/dsh-workspace-sort
pnpm publish --access public
```
