# Backup and recovery

In normal Codex or Claude Code use, the host agent runs routine recovery, diagnostic, rebuild, and eligible synchronization commands for the owner. Command snippets in this document are manual troubleshooting/reference equivalents; they are not steps the owner must type during the managed workflow. A new or changed synchronization destination still requires explicit owner confirmation.

## Backup

The Git repository is the durable backup unit. Back up all tracked files, especially `sources/`, `wiki/`, and tracked `.brain` files. Managed operations always commit locally. A host may synchronize only to an owner-confirmed `brain sync` target and only when the core proves the push is a safe managed fast-forward; it never pushes an arbitrary remote, force-pushes, pulls, or rebases.

For manual troubleshooting, `.brain/cache/` can be deleted and reconstructed with:

```bash
pnpm brain rebuild
```

Do not treat `.brain/runtime/` as canonical knowledge. Before removing it, have the host inspect status and ensure `recovery.required` is false and no query or mutation is active.

## Interrupted mutation

The core journals multi-file writes and saves a canonical snapshot before applying them. On startup or before a domain query, the host runs recovery and diagnostics in the required order. Manual troubleshooting/reference equivalents are:

```bash
pnpm brain status
pnpm brain recover
pnpm brain doctor
pnpm brain audit
```

Recovery restores a pre-commit transaction or recognizes an already completed commit. Validation and commit failures restore canonical files and leave unrelated work untouched. Never manually delete a live transaction journal to bypass recovery.

## Immutable-source violation

If status, scan, or query begin reports changed/deleted registered bytes, the host agent guides and performs the recoverable workflow:

1. Restore the original file at its registered path.
2. Add the revised bytes at a new path.
3. Have the host scan the sources and inspect the result.
4. After the source IDs are known, have the host supersede the old ID with the new ID.

Both versions remain available for historical citations.

Manual troubleshooting/reference equivalents for steps 3 and 4 are:

```bash
pnpm brain source scan --json
pnpm brain source supersede <old-id> <new-id>
```

## Restore on another machine

The host agent installs dependencies and rebuilds disposable state after the repository is cloned. For manual troubleshooting/reference, the equivalent sequence is:

```bash
pnpm install --frozen-lockfile
pnpm brain recover
pnpm brain rebuild
pnpm brain doctor
```

## Pending remote synchronization

If an operation or final query reports `⚠ Sync pending — …`, the knowledge is already safely committed in the local repository. Do not rewrite history or retry with force. The host agent first inspects synchronization state and may retry only the already confirmed destination. Manual troubleshooting/reference equivalents are:

```bash
pnpm brain sync status
pnpm brain sync
```

`brain sync` retries only the confirmed remote/branch and only eligible managed commits. If status is `manual-sync-required`, the host reports the named Git condition for deliberate resolution—for example, restoring the confirmed remote URL, returning to the configured branch, or using a human-reviewed normal integration for a remote branch that advanced. The host may run `brain sync configure --confirm` for a changed remote or branch only after the owner explicitly approves that exact destination. Until synchronization succeeds, retain the exact visible warning in any answer based on the locally committed knowledge.

## Rebuilding local retrieval

Delete neither canonical pages nor registered sources to repair a cache. The host agent recreates the lexical index from canonical data when needed. The manual troubleshooting/reference equivalent is:

```bash
pnpm brain rebuild
```

The next semantic reconciliation rebuilds the semantic index if it is stale; initial setup verifies the pinned model artifact before it can complete. If the model cache is missing on an offline machine, restore network access or a verified cache and resume the interrupted setup; do not mark setup complete without the required audit and healthy graph.
