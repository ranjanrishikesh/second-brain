# Backup and recovery

## Backup

The Git repository is the durable backup unit. Push or mirror it using your normal private-remote policy; the agent never pushes automatically. Back up all tracked files, especially `sources/`, `wiki/`, and tracked `.brain` files.

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

For hosted use, recreate the OpenClaw runtime volume rather than restoring it as canonical data. The repository mount retains the actual brain.
