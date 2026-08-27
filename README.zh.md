# moonshile-dsh-plugins

[English](README.md) | 中文

Moonshile 的 DeepSeek Harness (DSH) 插件集合。每个插件一个独立目录、依赖各自管理，pnpm workspace 统一编排。

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

## 插件列表

| 插件 | 说明 | 安装 |
| --- | --- | --- |
| [dsh-workspace-sort](plugins/dsh-workspace-sort/README.md) | 侧边栏工作区**每日**按最近活动排序一次（当天稳定） | `dsh plugin --profile web add dsh-workspace-sort` + patch `insert` 行 |
