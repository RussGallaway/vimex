import type { ReactNode } from "react"
import { emberTide } from "../theme"

export function OverlayFrame(props: { title: string; width: number; children: ReactNode }) {
  return (
    <box position="absolute" top="15%" left="15%" width="70%" maxWidth={props.width} maxHeight="70%" zIndex={50}
      border borderStyle="single" borderColor={emberTide.blue} backgroundColor={emberTide.backgroundRaised}
      paddingX={2} paddingY={1} title={` ${props.title} `} titleAlignment="left">
      {props.children}
    </box>
  )
}
