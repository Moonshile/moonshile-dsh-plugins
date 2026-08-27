# dsh-workspace-sort

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-workspace-sort.svg)](https://www.npmjs.com/package/dsh-workspace-sort)

DeepSeek Harness (DSH) plugin bundle: re-sorts the sidebar workspace order by last activity **once per day**; the order stays fully stable for the rest of the day.

## Why

DSH's native workspace order is manual drag order (the durable `workspaceIds` array); the "Last updated" view option only sorts sessions inside a group. If every session event moved the owning workspace to the top, the order would jump around constantly. This plugin instead performs **one full sort per calendar day**: the day's first session event triggers the sort, after which nothing moves until the next day.

## Install

```bash
dsh plugin --profile web add dsh-workspace-sort
```

The package declares `dsh.bundle.patch`, so it installs as an **active profile bundle** — one command, no manual patch editing. Restart `dsh web` after installing (bundle layers mount at boot).

## Behavior

- **Trigger**: the first `session/event` activity of the calendar day (any session of a workspace produces a new event)
- **Ordering key**: last-activity time per workspace accumulated since plugin start, full sort descending; workspaces with no recorded activity keep their relative order (stable sort)
- **Stable within the day**: no re-sort until the next day; manual drag order survives the rest of the day
- **Persistence**: `~/.dsh/workspace-sort-state.json` records the last sorted date (`DSH_HOME` overrides the home directory)
- **Limitations**: after a same-day server restart the first sort may have sparse activity data (accurate from the next day); ungrouped sessions do not participate

## Development

```bash
pnpm install
pnpm test     # node:test pure-function tests, no DSH runtime dependency
```

## Publishing

```bash
cd plugins/dsh-workspace-sort
pnpm publish --access public
```
