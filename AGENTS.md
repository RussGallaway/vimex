# Working in Vimex

Read [CONTRIBUTING.md](CONTRIBUTING.md) for package boundaries and validation. The [v1 documents](work/projects/v1/README.md) remain the product and architecture authority.

## Concurrent edits

- Inspect `git status` and `bun run claim list` before editing. Preserve existing changes; unclaimed dirty files may belong to an agent that started before this workflow.
- Acquire the narrowest complete set of file or directory scopes, including tests and generated outputs: `bun run claim acquire --id TASK --owner AGENT --scope PATH`. Repeat `--scope` for additional paths. Save the returned `claimId`.
- A conflict means choose independent work or arrange a handoff. Never bypass a claim, automatically expire one, or force-release it merely because its owner is quiet.
- Verify your token and scopes when resuming work. Acquire an additional claim before expanding your edit scope. Release claims after completion or abandonment using the matching token.
- Claims coordinate edits; they do not authorize unrelated work or prevent filesystem writes. Read-only research and review need no claim.
- Coordinate shared-index operations with one integration owner. Stage explicit paths and inspect the staged diff. Broad formatting, regeneration, and branch changes require checkout-wide coordination (`--scope .`); claims do not grant permission to discard changes.

See [coordination](docs/coordination.md) for examples and recovery. No delegation or extra agents are required by this workflow.
