# Concurrent development

`bun run claim` records cooperative file ownership for agents sharing a checkout. It does not enforce filesystem access or manage tasks. The implementation is one script, `scripts/claim.mjs`, with no added dependencies.

## Quick start

Inspect changes and current owners, then claim your files:

```sh
git status --short
bun run claim list
bun run claim acquire --id agent-nav --owner codex-session-123 \
  --scope packages/interaction/src/commands/registry.ts \
  --scope docs/keys.md
```

Acquisition returns JSON containing a unique `claimId`. Save that token with your task context. Use a descriptive task ID (lowercase letters, digits, hyphens; starts with a letter; maximum 64 characters) and an owner that identifies your session.

```sh
bun run claim verify --id agent-nav --claim-id TOKEN --scope docs/keys.md
bun run claim release --id agent-nav --claim-id TOKEN
bun run claim list --json
```

Replace `TOKEN` with the returned value. All commands exit zero on success and nonzero on failure. `list --json` and successful acquisition produce JSON on stdout; errors go to stderr. `bun run claim --help` lists commands.

## Scope and handoff

- Paths are relative to the checkout root, not the caller's directory. The script finds the root from its own location. From a nested directory, you can invoke it by its absolute path.
- A directory covers all descendants, including files not yet created. Exact, ancestor, and descendant overlaps conflict. All requested scopes succeed together or none are acquired.
- Use exact on-disk spelling. Overlap checks conservatively ignore case on every platform so macOS aliases cannot bypass ownership. Globs, traversal, symlink components, and `.git`/`.vimex` metadata scopes are rejected.
- `--scope .` conflicts with every file claim. Use it for coordinated checkout-wide operations once other writers have handed off.
- To expand scope, acquire another claim with a different ID; retain your existing claim until done. No release/reacquire gap is necessary.
- Readers need no claim. Existing dirty files require ownership investigation even when no claim is recorded. Claims cannot retroactively identify their author.
- Before handoff, report changed files and validation. Release the claim; the recipient acquires a new one. Tokens prevent an old session from accidentally releasing a newer acquisition of the same task ID. They are identity checks, not secrets or authentication.

Each checkout/worktree has its own ignored `.vimex/coordination/claims/` registry. Separate worktrees may edit overlapping paths; their integration conflicts are handled through Git. This local tool does not coordinate separate clones or machines and is intended for a local filesystem.

## Shared Git and validation

File claims do not isolate the shared Git index or produce a stable test snapshot. Use one integration owner for staging and commits, stage explicit paths, and inspect staged changes (including formatter changes from hooks). Avoid whole-repository formatting while another agent is editing. Run final acceptance against a settled checkpoint; focused checks during concurrent work are provisional. Follow the checks required by CONTRIBUTING.md for the actual change.

## Recovery

Claims do not expire automatically. A paused or disconnected agent may still own unfinished changes. Inspect the claim, relevant diff, and owner status before explicitly releasing an abandoned claim:

```sh
bun run claim release --id abandoned-task --force --reason "Owner confirmed stopped; changes handed off"
```

The reason is printed with the former owner; retain that output in the handoff if needed. There is no audit service.

Every registry operation briefly holds `.vimex/coordination/registry.lock/`, created exclusively. A competing command fails with a busy message; retry after the active command completes. Claims are published via temporary-file rename so readers never observe partially written JSON.

If busy persists, inspect `registry.lock/owner.json` (PID, hostname, creation time). Confirm that the owning CLI process has ended and no registry commands are running before manually removing **only that lock directory**. If metadata is missing, establish the same quiescent state first. Never remove a lock based solely on age or remove the claims directory to clear contention. No automatic stale-lock stealing is implemented.

A process killed before publication may leave an ignored `.tmp` file; it grants no ownership. A kill after publication may leave a valid claim even if the caller saw no output: list and inspect before retrying. Malformed JSON/records fail closed; preserve and inspect the damaged record, then repair it only with writers stopped. Filesystem durability across power loss is not guaranteed.

## Tests

```sh
bun test scripts/claim.test.mjs
```

Tests use disposable directories and subprocesses, never the live registry. They are also included by the default `bun test` / `bun run check` suite.
