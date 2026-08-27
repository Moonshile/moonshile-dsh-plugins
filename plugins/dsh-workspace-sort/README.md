# dsh-workspace-sort

DeepSeek Harness (DSH) host plugin: re-sorts the sidebar workspace order by last activity **once per day**; the order stays fully stable for the rest of the day.

## Why

DSH's native workspace order is manual drag order (the durable `workspaceIds` array); the "Last updated" view option only sorts sessions inside a group. If every session event moved the owning workspace to the top, the order would jump around constantly. This plugin instead performs **one full sort per calendar day**: the day's first session event triggers the sort, after which nothing moves until the next day.

## Install

```bash
dsh plugin --profile web add dsh-workspace-sort
```

Add to the profile's `cordis.patch.yml` (new rows must use `insert` semantics):

```yaml
- insert:
    - id: workspace-sort
      name: dsh-workspace-sort
      inject:
        - workspaceRegistry
```

Host-plugin **code** changes require restarting `dsh web` (row-level changes hot-apply).

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
