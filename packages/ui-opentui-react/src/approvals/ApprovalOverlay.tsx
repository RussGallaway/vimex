import type { Approval } from "@vimex/approvals"
import { OverlayFrame } from "../app/OverlayFrame"
import { emberTide } from "../theme"

export function ApprovalOverlay(props: {
  approval?: Approval
  selected: number
  source?: string
}) {
  return (
    <OverlayFrame title="Approval required" width={88}>
      {props.approval ? (
        <>
          {props.source ? (
            <text fg={emberTide.textMuted}>From {props.source}</text>
          ) : null}
          <text fg={emberTide.amber}>
            <b>{props.approval.title}</b>
          </text>
          <box
            marginTop={1}
            paddingX={1}
            paddingY={1}
            backgroundColor={emberTide.backgroundPanel}
          >
            <text fg={emberTide.textSoft}>{props.approval.detail}</text>
          </box>
          {props.approval.error ? (
            <text marginTop={1} fg={emberTide.red}>
              failed: {props.approval.error} · choose again to retry
            </text>
          ) : null}
          <box marginTop={1}>
            {props.approval.choices.map((choice, index) => (
              <text
                key={choice.id}
                fg={
                  index === props.selected
                    ? emberTide.selectionText
                    : emberTide.textMuted
                }
                bg={index === props.selected ? emberTide.selection : undefined}
              >
                {index === props.selected ? "› " : "  "}
                {index + 1}. {choice.label}
              </text>
            ))}
          </box>
          <text marginTop={1} fg={emberTide.textMuted}>
            j/k choose · enter confirm · 1–9 direct · esc close
          </text>
        </>
      ) : (
        <text fg={emberTide.textMuted}>No pending approvals</text>
      )}
    </OverlayFrame>
  )
}
