# Rex integration

Vimex automatically reports its focused conversation to Rex when both
`REX_SESSION` and `REX_BLOCK` are present and standard output is a TTY. No Rex
CLI, hooks, or separate plugin installation is required. Other terminals keep
their existing behavior.

The integration uses Rex's [Program Status Protocol (OSC 7501)](https://www.superlogical.com/rex/docs/build/program-status)
with `app=vimex`. It reports:

- `working` while the focused conversation is running.
- `blocked` with `kind=permission` for an unresolved approval, or `kind=question`
  when an answer is required.
- `idle` when ready for input, including after cancellation.
- `done` or `error` after a completed or failed turn, respectively, only when
  Vimex observed that same turn running. Opening an old conversation does not
  announce its historical result as newly completed work.

The terminal title follows the focused conversation as `Vimex · TITLE`.
Background conversations are not aggregated into the pane's reported status.
Normal shutdown clears Vimex's status report.

Rex controls how these reports appear in tabs and its Activity view. See
Settings > Notifications > Program Activity if indicators are hidden. Settings >
Terminal > Titles > Prefer generated titles can override the supplied title.
The integration does not guarantee OS process naming or a custom Vimex icon.

Actual Rex UI behavior has not yet been certified; protocol tests alone do not
establish that every installed Rex version presents these indicators identically.
