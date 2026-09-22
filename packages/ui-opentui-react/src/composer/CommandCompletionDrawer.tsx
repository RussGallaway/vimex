import { usePaneGeometry } from "../side-chat/pane-geometry"
import {
  commandDescriptions,
  commandDescriptors,
  parseCommand,
} from "@vimex/interaction"
import { emberTide } from "../theme"

export function CommandCompletionDrawer(props: {
  choices: readonly string[]
  selected: number
  prefix: ":" | "/"
  id: string
  hint?: string
}) {
  const rows = Math.max(1, Math.min(6, usePaneGeometry().height - 11))
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
      height={Math.max(1, visible.length) + 2}
      backgroundColor={emberTide.backgroundPanel}
      border={["left"]}
      borderColor={emberTide.blueBright}
      paddingX={1}
    >
      <text height={1} fg={emberTide.blueBright}>
        Commands
      </text>
      {visible.length ? (
        visible.map((choice, index) => {
          const command = parseCommand(choice)
          const selected = start + index === props.selected
          return (
            <box
              key={choice}
              id={`${props.id}-choice:${start + index}`}
              height={1}
              flexDirection="row"
              gap={2}
              backgroundColor={
                selected ? emberTide.selection : emberTide.backgroundPanel
              }
            >
              <text
                width="35%"
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
                {command.kind === "command"
                  ? command.argument ||
                    commandDescriptors[command.name].arguments !== "none"
                    ? `Usage: ${props.prefix}${commandDescriptors[command.name].usage}`
                    : commandDescriptions[command.name]
                  : ""}
              </text>
            </box>
          )
        })
      ) : (
        <text height={1} fg={emberTide.textMuted}>
          No matching commands
        </text>
      )}

      <text height={1} fg={emberTide.textMuted} wrapMode="none" truncate>
        {props.hint ?? "↑/↓ choose · tab complete · enter run"}
      </text>
    </box>
  )
}
