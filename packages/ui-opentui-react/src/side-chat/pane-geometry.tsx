import { useTerminalDimensions } from "@opentui/react"
import { createContext, useContext } from "react"

export interface PaneGeometry {
  width: number
  height: number
  x: number
  y: number
}
export const PaneGeometryContext = createContext<PaneGeometry | undefined>(
  undefined,
)
/** Components size themselves to their pane, including when it is maximized. */
export function usePaneGeometry(): PaneGeometry {
  const terminal = useTerminalDimensions()
  return useContext(PaneGeometryContext) ?? { ...terminal, x: 0, y: 0 }
}
