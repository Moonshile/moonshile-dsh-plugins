# moonshile-dsh-plugins

English | [中文](README.zh.md)

Moonshile's DeepSeek Harness (DSH) plugin collection. Each plugin lives in its own directory as an independent npm package, dependencies managed per package, orchestrated by a pnpm workspace.

## Layout

```
plugins/
└── <package-name>/
    ├── package.json   # standalone package: name / main / files / scripts
    ├── lib/           # implementation (host half / client half)
    ├── lib/*.test.mjs # node:test pure-function tests
    └── README.md      # English (中文见 README.zh.md)
```

## Local development

```bash
pnpm install     # install the workspace from the repo root
pnpm test        # run every plugin's tests (pnpm -r test)
```

## Publishing

Each plugin is published to npm independently (package names must be globally unique on the registry):

```bash
cd plugins/<package-name>
pnpm publish --access public
```

## Plugins

Every plugin is an npm package installed with `dsh plugin` — one command, auto-activating bundle. Each plugin has its own directory and README.

| Plugin | What it does | Install | Usage |
| --- | --- | --- | --- |
| [dsh-workspace-sort](plugins/dsh-workspace-sort/README.md) | Re-sorts sidebar workspaces by last activity **once per day**; order stays stable the rest of the day | `dsh plugin --profile web add dsh-workspace-sort` | None needed — install, restart `dsh web`; it runs daily, sorting by session activity. Last-sort date is persisted at `~/.dsh/workspace-sort-state.json`. |
