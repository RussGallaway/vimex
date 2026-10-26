import { expect, test } from "bun:test"
import type { VimBindingContext } from "./binding-context"
import { transcriptBindings } from "./transcript-bindings"

for (const mode of ["normal", "visual"] as const) {
  test(`${mode} G uses counted navigation without independently attaching the tail`, () => {
    const motions: string[] = []
    const commands: unknown[] = []
    const scrolls: number[] = []
    const ctx = {
      interaction: { surface: "transcript", mode },
      countedMotion: (motion: string) => motions.push(motion),
      controller: { transcript: (command: unknown) => commands.push(command) },
      scrollRef: { current: { scrollTo: (row: number) => scrolls.push(row) } },
    } as unknown as VimBindingContext
    transcriptBindings(ctx)
      .find((binding) => binding.key === "shift+g")!
      .cmd()
    expect(motions).toEqual(["last"])
    expect(commands).toEqual([])
    expect(scrolls).toEqual([])
  })
}
