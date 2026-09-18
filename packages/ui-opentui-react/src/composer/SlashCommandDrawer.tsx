import { CommandCompletionDrawer } from "./CommandCompletionDrawer"

export function SlashCommandDrawer(props: { choices: readonly string[]; selected: number }) {
  return <CommandCompletionDrawer {...props} prefix="/" id="slash-command-drawer" />
}
