# dsh-responses-replay-fix

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-responses-replay-fix.svg)](https://www.npmjs.com/package/dsh-responses-replay-fix)

DeepSeek Harness (DSH) host plugin: fixes **history replay** being rejected with HTTP 400 by strict OpenAI-Responses-compatible gateways — the ones that return non-conformant **output** yet validate **input** against OpenAI's exact rules (observed with the **Zhongxin / CITIC** gateway at `www.wxzjai.com`, and any similarly-behaved proxy).

## Symptoms

When continuing a conversation on such a gateway, requests fail with:

1. `Invalid 'id': message id must be a string starting with 'msg_', got '<uuid>'`

   The gateway's earlier responses carried a bare UUID as the assistant message item id. DSH stored that id in the replay state and echoed it back verbatim on the next request; the gateway's input validation then rejects it because it does not start with `msg_`.

2. `The reasoning_text in the thinking mode must be passed back to the API.`

   The gateway returns reasoning items whose `content` is `null` (only a `summary` with the plaintext thinking). DSH persisted the whole item and replays it as-is, so the input reasoning item has no plaintext `reasoning_text`; in thinking mode the gateway refuses.

Official OpenAI, `morph` and other conformant gateways never hit these because their own output already follows the rules (or their input validation is lenient) — that is why the errors appear only on the strict gateway.

## What this plugin does

Before every LLM request to a target provider, it normalizes the replayed assistant messages (`source.replayState.blocks`):

- **message ids** (`textSignature`) that do not start with `msg_` get a `msg_` prefix (kept ≤ 64 chars);
- **reasoning items** (`thinkingSignature`) whose content lacks plaintext `reasoning_text` get one, built from the item's own `summary` text (`msg_`/`rs_` prefixed ids are preserved as-is).

Only messages that actually need a change are touched — conformant messages pass through with zero modification, and non-target providers are untouched entirely. Nothing on disk is rewritten; normalization happens in-memory on the request path.

## Install

Requires [pnpm](https://pnpm.io/installation) on your PATH — `dsh plugin` forwards profile package operations to pnpm.

```bash
dsh plugin --profile web add dsh-responses-replay-fix
```

One command, no manual patch editing. Restart `dsh web`, then refresh the page.

Other profiles: replace `web` with the profile name, e.g. `dsh plugin --profile <name> add dsh-responses-replay-fix`.

## Provider targeting

By default the fix applies only to the **`zhongxin`** provider route. The active provider list is configured through DSH's **settings** section `responses-replay-fix` (a top-level key in `settings.yaml`, editable from the same place you configure providers):

```yaml
responses-replay-fix:
  providers:
    - zhongxin
    - b-ai
```

- **Unset** → `["zhongxin"]` (the default).
- **Explicit `providers: []`** → no provider is fixed (the plugin is effectively off).
- **A list** → only those provider routes are normalized (`b-ai` is the other route known to emit bare-UUID message ids).
- Settings changes apply to subsequent requests immediately — no restart needed.

## How it works

```
dsh web host (lib/index.js)
  apply(ctx)
    registers settings section "responses-replay-fix" (providers list)
    reads ctx.llm.adapters → wraps each adapter instance's streamWithSnapshot
      options.messages (durable assistant messages)
        ├─ textSignature.id  →  msg_ prefix if missing
        └─ thinkingSignature →  content: [{ type: "reasoning_text", text: <summary> }]
                               if no plaintext reasoning_text is present
      yield* original(options, snapshot)   ← gateway receives conformant replay
```

The wrap target is each adapter **instance** registered on the `ctx.llm` service (own `streamWithSnapshot` property shadowing the prototype method), not the module's class prototype. Every call path (`stream()` and the `prepareCall` stream closure) dispatches through `this.streamWithSnapshot`, so wrapping the instance covers the whole provider.

Why the instance and not the class: a profile bundle plugin resolves `@deepseek-ai/dsh-llm-pi-ai` through its own `node_modules` chain (a pnpm `link:` during development, the registry after publishing), which Node's ESM cache keys by module URL — a symlinked path and the host bundle's path are **two different module instances and therefore two different classes**. Patching the prototype of the copy the plugin sees would not touch the class the host actually instantiates. Taking the adapter from `ctx.llm` (the host's singleton service) always yields the real instance the requests flow through, regardless of how the module was resolved. Re-scanning happens on `llm/adapters-updated`, so provider changes / HMR re-registrations get wrapped too; a `PATCHED` symbol keeps each instance wrapped exactly once.

The target-provider list is read from the settings section on every request (via `source()`), so a settings change applies without a restart. Pure normalization logic lives in `lib/core.js` (unit-tested, no DSH runtime dependency).

## Development

```bash
pnpm test          # runs lib/core.test.mjs
```
