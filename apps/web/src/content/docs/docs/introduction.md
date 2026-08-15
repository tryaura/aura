---
title: Introduction
description: What Aura does and why a repo with several coding agents needs it.
---

Most repositories now carry configuration for more than one coding agent. Claude Code reads its
files, Codex reads its own, Cursor reads a third set. Each has its own instruction file, its own
MCP server list, and its own idea of which skills are installed. Nothing keeps them in agreement.

Aura reads all of them, normalizes what it finds into a single model, and reports where they have
drifted apart.

## How a scan works

1. **Adapters detect** which agent applications are installed and declare the files they care
   about. They do not read those files themselves.
2. **Core reads** the declared paths and hands the contents back to each adapter's `parse`, which
   is synchronous and has no filesystem access.
3. **Checks inspect** the resulting `WorkspaceModel` — every application's instruction documents,
   MCP servers, and skills together — and emit findings.
4. **Fixes return data**, never actions. A fix produces a `FixPlan` of write, remove, move, and
   symlink operations, so Aura can show you a diff, dry run it, back it up, and undo it.

That separation is what makes a scan previewable. A check cannot run a command, and a fix cannot
make a network request.

## Plugins

Everything above ships as plugins built on [`@tryaura/aura-sdk`](https://github.com/tryaura/aura/tree/main/packages/sdk).
Adapters, checks, snippets, skills, MCP catalog entries, and presets are all contribution slots on
a plugin, and every contribution ID is namespaced under the plugin's own ID.

:::caution[Plugins are not sandboxed]
A plugin runs with the full privileges of the Aura process. `Adapter.detect` and skill sources
receive an `Environment` and can execute commands. Install plugins with the same care you apply to
any other dependency.
:::

The declarative shapes in the SDK exist for previewability, not isolation. See the
[SDK trust model](https://github.com/tryaura/aura/tree/main/packages/sdk#trust-model) for the
guarantees Aura does enforce.

## Next

- [Installation](/docs/installation) — install the CLI and run your first scan.
