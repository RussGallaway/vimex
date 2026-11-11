export const helpText = `Vimex — Codex, operated like Vim

Usage:
  vimex [PATH] [options]         Start in PATH or the current directory
  vimex resume [ID] [options]    Resume ID, or open this directory's session picker
  vimex resume --last [options]  Resume this directory's most recent session
  vimex doctor                  Check installation and dependencies
  vimex upgrade [--version V]   Upgrade Vimex (update is an alias)
  vimex rex install --shell zsh|bash  Enable restart restoration in Rex panes
  vimex rex uninstall --shell zsh|bash  Remove the shell integration
  vimex rex hook zsh|bash       Print the shell integration
  vimex rex import-state       Import legacy views into this inactive Rex pane

Options:
  --cwd PATH       Working directory
  --machine NAME   Run against local or an SSH machine
  --thread ID      Resume a Codex thread (legacy spelling)
  --model NAME     Model for a new thread
  --config PATH    Alternate Vimex JSON configuration
  --demo           Local demonstration without Codex
  -h, --help       Show help
  -V, --version    Show version

Normal: i compose · Ctrl-k/j focus · Ctrl-u/d scroll · v select · :help commands
Insert: Enter send · Shift+Enter newline · Esc Normal
In Vimex: :performance export (:perf export) saves a local performance trace
`
