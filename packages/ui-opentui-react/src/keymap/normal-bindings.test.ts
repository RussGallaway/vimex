import { describe, expect, test } from "bun:test"
import { normalBindings } from "./normal-bindings"

function context(openMentionPicker?: (kind: "file" | "grep") => void) {
  return {
    interaction: { surface: "composer", mode: "normal", overlay: null },
    transcript: {},
    composer: { text: "", cursorOffset: 0 },
    controller: {
      dispatchInteraction: () => undefined,
      changeDraft: () => undefined,
    },
    countRef: { current: "" },
    textareaRef: { current: null },
    scrollRef: { current: null },
    toggleComposer: () => undefined,
    enterVisibleTranscript: () => undefined,
    submitComposer: () => undefined,
    countedMotion: () => undefined,
    dispatchMotion: () => undefined,
    positionCursor: () => undefined,
    runComposerKey: () => undefined,
    beginVisual: () => undefined,
    openOverlay: () => undefined,
    scroll: () => undefined,
    openMentionPicker,
  } as never
}

describe("normal picker bindings", () => {
  test("leader space opens the file picker without editing the composer", () => {
    const opened: string[] = []
    const bindings = normalBindings(context((kind) => opened.push(kind)))
    bindings.find((binding) => binding.key === "<leader><leader>")!.cmd()
    expect(opened).toEqual(["file"])
  })

  test("leader slash opens the grep picker without editing the composer", () => {
    const opened: string[] = []
    const bindings = normalBindings(context((kind) => opened.push(kind)))
    bindings.find((binding) => binding.key === "<leader>/")!.cmd()
    expect(opened).toEqual(["grep"])
  })
})
