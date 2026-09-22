import type { Overlay, Surface } from "../focus/focus-controller"
import type { VimMode } from "./mode"
export interface VimRegister {
  text: string
  shape: "character" | "line"
}
export interface InteractionState {
  mode: VimMode
  surface: Surface
  lastNormalSurface: Surface
  overlay: Overlay
  commandLine: string
  pendingKeys: string
  count: string
  unnamedRegister: VimRegister
}
export type InteractionCommand =
  | { type: "mode.normal" }
  | { type: "mode.insert" }
  | { type: "mode.visual" }
  | { type: "mode.command" }
  | { type: "focus.set"; surface: Surface }
  | { type: "overlay.open"; overlay: Exclude<Overlay, null> }
  | { type: "overlay.close" }
  | { type: "command.change"; value: string }
  | { type: "keys.pending"; value: string }
  | { type: "keys.clear" }
  | { type: "count.change"; value: string }
  | { type: "count.push"; digit: number }
  | { type: "count.clear" }
  | { type: "register.set"; register: VimRegister }
export const initialInteraction = (): InteractionState => ({
  mode: "normal",
  surface: "transcript",
  lastNormalSurface: "transcript",
  overlay: null,
  commandLine: "",
  pendingKeys: "",
  count: "",
  unnamedRegister: { text: "", shape: "character" },
})
export function reduceInteraction(
  state: InteractionState,
  command: InteractionCommand,
): InteractionState {
  switch (command.type) {
    case "mode.normal":
      return {
        ...state,
        mode: "normal",
        surface: state.mode === "insert" ? "composer" : state.surface,
        commandLine: "",
        pendingKeys: "",
        count: "",
      }
    case "mode.insert":
      return {
        ...state,
        mode: "insert",
        surface: "composer",
        lastNormalSurface: state.surface,
        pendingKeys: "",
        count: "",
      }
    case "mode.visual":
      return { ...state, mode: "visual", pendingKeys: "", count: "" }
    case "mode.command":
      return {
        ...state,
        mode: "command",
        commandLine: "",
        pendingKeys: "",
        count: "",
      }
    case "focus.set":
      return {
        ...state,
        mode:
          state.mode === "insert" && command.surface === "transcript"
            ? "normal"
            : state.mode,
        surface: command.surface,
        lastNormalSurface: command.surface,
        pendingKeys: "",
        count: "",
      }
    case "overlay.open":
      return { ...state, overlay: command.overlay }
    case "overlay.close":
      return { ...state, overlay: null }
    case "command.change":
      return { ...state, commandLine: command.value }
    case "keys.pending":
      return { ...state, pendingKeys: command.value }
    case "keys.clear":
      return { ...state, pendingKeys: "" }
    case "count.change":
      return {
        ...state,
        count: /^\d*$/.test(command.value)
          ? command.value.slice(0, 4)
          : state.count,
      }
    case "count.push":
      if (
        !Number.isInteger(command.digit) ||
        command.digit < 0 ||
        command.digit > 9 ||
        (command.digit === 0 && state.count === "")
      )
        return state
      return { ...state, count: `${state.count}${command.digit}`.slice(0, 4) }
    case "count.clear":
      return { ...state, count: "" }
    case "register.set":
      return { ...state, unnamedRegister: command.register }
  }
}
