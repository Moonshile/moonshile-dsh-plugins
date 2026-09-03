# dsh-last-turn-delete

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-last-turn-delete.svg)](https://www.npmjs.com/package/dsh-last-turn-delete)

DeepSeek Harness (DSH) plugin bundle: a **trash-can button** on the newest deletable item of a conversation — the **last user message**, or a **failed `/compact` card**. A click (confirmed in a small bubble) **soft-deletes** it, then the button walks back to the previous item until a real compact boundary or nothing is left.

## Why

Long agentic sessions pile up turns you no longer want the model to remember — and failed `/compact` cards that sit in the way. DSH's session log is append-only by design, so there is no built-in "remove this turn"; this plugin deletes on the model-visible **surface** using the same mechanism compaction uses, leaving your durable log untouched.

## What "delete" means

- **User message + its whole reply tail** are shadowed from the model surface by one replacement event — they stop entering the context of every later request. Original events stay on disk; the turn is dimmed in place ("soft delete", nothing is lost).
- **Failed `/compact` cards** never compacted anything, so they are **not** compact boundaries — they can be deleted too. Deleting one records the command id in a small private sidecar (the `dsh_last_turn_delete` storage domain) and the chain simply continues past it. **Successful compactions remain real boundaries**: everything they covered (already off the model surface) is not deletable.
- The button only appears once the agent has **finished replying** (the host reports `running`); it is hidden mid-stream.

## Install

Requires [pnpm](https://pnpm.io/installation) on your PATH — `dsh plugin` forwards profile package operations to pnpm.

```bash
dsh plugin --profile web add dsh-last-turn-delete
```

Installs the npm package into the `web` profile and activates it as a bundle (the package declares `dsh.bundle.patch`). **One command, no manual patch editing.** Restart `dsh web`, then refresh the page.

Other profiles: replace `web` with the profile name, e.g. `dsh plugin --profile <name> add dsh-last-turn-delete`.

## Behavior

- **Button**: the same `IconTrashOutline16` the pending-message queue uses, inserted into the message action strip right next to the copy button; it clones the native action button's class, so its resting/hover look matches the copy button exactly (no custom colors). Works in every conversation — old or new — while the session is open in the GUI.
- **Delete flow**: click the trash can → a small confirm bubble (`确认删除` / `取消`; Esc or clicking elsewhere cancels) → confirm → the host soft-deletes and the button moves to the previous item.
- **Walk-back**: repeat; the chain walks backward through failed-compact cards and user turns until a real (successful) compact boundary or no user message remains.
- **Persistence**: deleted user messages are re-derived from the log on reload; deleted failed-compact ids stay in the sidecar — dimmed state and button placement survive page refreshes.
- **Safety**: the host decides the deletable tail via the `tail` Remote (which folds in streaming, boundaries and prior deletions) and only deletes while the agent is idle; a stale click is rejected and the UI re-anchors on the real tail.

## How it works

```
browser (client half)
  trash button on the newest deletable row (message action strip)
    click → inline confirm bubble → delete
        │  lastTurnDelete/delete        { sessionId, messageId }
        │  lastTurnDelete/deleteCompact { sessionId }
        ▼
host (lib/index.js, lastTurnDelete Remote service)
  delete            agent.runMaintenance (idle-only, serialized with the driver)
                    session.surface.nodes → last on-surface user message
                    session.append("user/message", marker, {
                      surfaceOp: { op: "replace", start, end },
                      sourceEventSeqs: shadowed
                    }) + ctx.sessions.flush()   ← the span leaves the surface
  deleteCompact     newest failed /compact group → sidecar record
  tail              newest deletable item + agent running flag
  deleted           previously deleted messages + forgotten compact ids
```

Host-authoritative answers travel back over `lastTurnDelete/tail`: the newest deletable item (`{kind: "message", messageId}` / `{kind: "compact", commandId}` / `{kind: null}`) plus `running`. Pure selection logic lives in `lib/core.js` (unit-tested, no DSH runtime dependency); the marker/user-message payloads use the plugin's own `source` identity so compaction checkpoints are never mistaken for deletions. All button/popover styling is inline on created nodes — injected `<style>` blocks are managed by the host module system and cannot be relied on.

## Development

```bash
pnpm install
pnpm test     # node:test pure-function tests, no DSH runtime dependency
```

## Publishing

```bash
cd plugins/dsh-last-turn-delete
pnpm publish --access public
```
