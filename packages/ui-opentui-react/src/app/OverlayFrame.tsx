import type { ReactNode } from "react"
import { emberTide } from "../theme"

export function OverlayFrame(props: { title: string; width: number; children: ReactNode }) {
  return (
    <box id="overlay-frame" width="85%" maxWidth={props.width} maxHeight="85%" zIndex={50}
      border borderStyle="single" borderColor={emberTide.blue} backgroundColor={emberTide.backgroundRaised}
      paddingX={2} paddingY={1} title={` ${props.title} `} titleAlignment="left">
      {props.children}
    </box>
  )
}
