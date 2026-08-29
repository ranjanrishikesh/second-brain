# Backup and recovery

## Backup

The Git repository is the durable backup unit. Back up all tracked files, especially `sources/`, `wiki/`, and tracked `.brain` files. Managed operations always commit locally. A host may synchronize only to an owner-confirmed `brain sync` target and only when the core proves the push is a safe managed fast-forward; it never pushes an arbitrary remote, force-pushes, pulls, or rebases.

`.brain/cache/` can be deleted and reconstructed with:

```bash
pnpm brain rebuild
```

Do not treat `.brain/runtime/` as canonical knowledge. Before removing it, run `pnpm brain status` and ensure `recovery.required` is false and no query/mutation is active.

## Interrupted mutation

The core journals multi-file writes and saves a canonical snapshot before applying them. On startup or before a domain query:

```bash
pnpm brain status
pnpm brain recover
pnpm brain doctor
pnpm brain audit
```

Recovery restores a pre-commit transaction or recognizes an already completed commit. Validation and commit failures restore canonical files and leave unrelated work untouched. Never manually delete a live transaction journal to bypass recovery.

## Immutable-source violation

If status, scan, or query begin reports changed/deleted registered bytes:

1. Restore the original file at its registered path.
2. Add the revised bytes at a new path.
3. Run `pnpm brain source scan --json`.
4. Run `pnpm brain source supersede <old-id> <new-id>`.

Both versions remain available for historical citations.

## Restore on another machine

Clone the repository, install dependencies, and rebuild disposable state:

```bash
pnpm install --frozen-lockfile
pnpm brain recover
pnpm brain rebuild
pnpm brain doctor
```

## Pending remote synchronization

If an operation or final query reports `⚠ Sync pending — …`, the knowledge is already safely committed in the local repository. Do not rewrite history or retry with force. Inspect the state first:

```bash
pnpm brain sync status
pnpm brain sync
```

`brain sync` retries only the confirmed remote/branch and only eligible managed commits. If status is `manual-sync-required`, resolve the named Git condition deliberately—for example, restore the confirmed remote URL, return to the configured branch, or use a human-reviewed normal integration for a remote branch that advanced. Re-run `brain sync configure --confirm` only after the owner approves a changed remote/branch. Until synchronization succeeds, retain the exact visible warning in any answer based on the locally committed knowledge.

## Rebuilding local retrieval

Delete neither canonical pages nor registered sources to repair a cache. Recreate the lexical index from canonical data with:

```bash
pnpm brain rebuild
```

The next semantic reconciliation rebuilds the semantic index if it is stale; initial setup verifies the pinned model artifact before it can complete. If the model cache is missing on an offline machine, restore network access or a verified cache and resume the interrupted setup; do not mark setup complete without the required audit and healthy graph.
