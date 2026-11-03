import { usePaneGeometry } from "../side-chat/pane-geometry"
import { commandDescriptors, parseCommand } from "@vimex/interaction"
import { emberTide } from "../theme"

function wrappedRows(line: string, width: number): number {
  let rows = 1
  let used = 0
  for (const word of line.split(/\s+/)) {
    if (used && used + 1 + word.length > width) {
      rows++
      used = 0
    }
    const length = used + (used ? 1 : 0) + word.length
    rows += Math.max(0, Math.ceil(length / width) - 1)
    used = length ? ((length - 1) % width) + 1 : 0
  }
  return rows
}

function choiceHelp(choice: string) {
  const command = parseCommand(choice)
  if (command.kind !== "command") return undefined
  const descriptor = commandDescriptors[command.name]
  const action =
    descriptor.actions?.[command.argument.trim().split(/\s+/)[0] ?? ""]
  if (action) return action
  return {
    description: descriptor.description,
    usage: command.name === "machine" ? "machine [name]" : descriptor.usage,
  }
}

export function CommandCompletionDrawer(props: {
  choices: readonly string[]
  selected: number
  prefix: ":" | "/"
  id: string
  hint?: string
}) {
  const geometry = usePaneGeometry()
  const help = choiceHelp(props.choices[props.selected] ?? "")
  const detail = help
    ? `${help.description}\nUsage: ${props.prefix}${help.usage}`
    : ""
  const detailRows = help
    ? Math.min(
        5,
        detail
          .split("\n")
          .reduce(
            (rows, line) =>
              rows + wrappedRows(line, Math.max(1, geometry.width - 5)),
            0,
          ),
      )
    : 0
  const rows = Math.max(1, Math.min(6, geometry.height - 11 - detailRows))
  const start = Math.max(0, props.selected - rows + 1)
  const visible = props.choices.slice(start, start + rows)
  return (
    <box
      id={props.id}
      position="absolute"
      bottom="100%"
      left={0}
      right={0}
      zIndex={30}
      height={Math.max(1, visible.length) + 2 + detailRows}
      backgroundColor={emberTide.overlayBackground ?? emberTide.backgroundPanel}
      border={["left"]}
      borderColor={emberTide.blueBright}
      paddingX={1}
    >
      <text
        height={1}
        fg={emberTide.blueBright}
        bg={emberTide.overlayBackground ?? emberTide.backgroundPanel}
      >
        Commands
      </text>
      {visible.length ? (
        visible.map((choice, index) => {
          const help = choiceHelp(choice)
          const selected = start + index === props.selected
          return (
            <box
              key={choice}
              id={`${props.id}-choice:${start + index}`}
              height={1}
              flexDirection="row"
              gap={2}
              backgroundColor={
                selected
                  ? emberTide.selection
                  : (emberTide.overlayBackground ?? emberTide.backgroundPanel)
              }
            >
              <text
                width="40%"
                flexShrink={0}
                wrapMode="none"
                truncate
                fg={selected ? emberTide.selectionText : emberTide.text}
              >
                {props.prefix}
                {choice}
              </text>
              <text
                flexGrow={1}
                minWidth={0}
                wrapMode="none"
                truncate
                fg={selected ? emberTide.selectionText : emberTide.textMuted}
              >
                {help?.description ?? ""}
              </text>
            </box>
          )
        })
      ) : (
        <text height={1} fg={emberTide.textMuted}>
          No matching commands
        </text>
      )}

      {help && (
        <text height={detailRows} fg={emberTide.text} wrapMode="word">
          {detail}
        </text>
      )}
      <text
        height={1}
        fg={emberTide.textMuted}
        bg={emberTide.overlayBackground ?? emberTide.backgroundPanel}
        wrapMode="none"
        truncate
      >
        {props.hint ?? "↑/↓ choose · tab complete · enter run"}
      </text>
    </box>
  )
}
