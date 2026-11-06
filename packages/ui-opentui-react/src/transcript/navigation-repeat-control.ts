import type { KeyEvent } from "@opentui/core"

export type NavigationRepeatKey = "u" | "d"
export type NavigationRepeatInput = {
  key: NavigationRepeatKey
  repeated: boolean
}

export function navigationRepeatControlEnabled(): boolean {
  return process.env.VIMEX_NAV_REPEAT_CONTROL === "1"
}

/** Only protocol-confirmed repeats are replaceable; legacy presses stay exact. */
export function navigationRepeatInput(
  event: KeyEvent | undefined,
): NavigationRepeatInput | undefined {
  if (
    !navigationRepeatControlEnabled() ||
    event?.source !== "kitty" ||
    event.eventType === "release" ||
    !event.ctrl ||
    (event.name !== "u" && event.name !== "d")
  )
    return undefined
  return {
    key: event.name,
    repeated: event.repeated === true || event.eventType === "repeat",
  }
}

/** Preserve a started motion's remainder so its coherent cursor target settles. */
export function discardPendingRepeats<
  T extends { sequence?: number; repeatKey?: NavigationRepeatKey },
>(
  queue: readonly T[],
  activeSequence: number | undefined,
  key?: NavigationRepeatKey,
): T[] {
  return queue.filter(
    (intent) =>
      !intent.repeatKey ||
      (intent.sequence !== undefined && intent.sequence === activeSequence) ||
      (key !== undefined && intent.repeatKey !== key),
  )
}
