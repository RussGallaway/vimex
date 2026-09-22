import { expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import {
  createConversation,
  itemId,
  reduceConversation,
  threadId,
  turnId,
} from "@vimex/conversation"
import {
  blockGraphemeRange,
  createTranscriptFrame,
  initialTranscript,
  syncTranscriptItem,
  type TranscriptItemBlock,
  type TranscriptWindow,
} from "@vimex/transcript"
import { act, createRef, useState } from "react"
import { createEmberTideSyntax } from "../theme"
import {
  sameTranscriptViewportProps,
  TranscriptViewport,
  type TranscriptViewportProps,
} from "./TranscriptViewport"
import {
  measureRenderedTranscript,
  transcriptBlockRenderableId,
} from "./rendered-layout"

test("an unrelated parent update does not reconcile a stable transcript viewport", async () => {
  const thread = threadId("memo"),
    turn = turnId("memo-turn"),
    id = itemId("memo-item")
  const item = {
    id,
    turnId: turn,
    kind: "assistant" as const,
    markdown: "Stable historical row",
    status: "complete" as const,
  }
  let conversation = createConversation(thread)
  conversation = reduceConversation(conversation, {
    type: "item.started",
    threadId: thread,
    item,
  })
  const transcript = syncTranscriptItem(initialTranscript(), item)
  const frame = createTranscriptFrame({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 1,
    conversation,
    transcript,
    mode: "follow",
    canonicalDamage: { kind: "full" },
  })
  const syntax = createEmberTideSyntax()
  const scrollRef = createRef<ScrollBoxRenderable>()
  const viewportProps: TranscriptViewportProps = {
    window: frame.window,
    state: frame.transcript,
    surface: "transcript",
    syntax,
    scrollRef,
  }
  let updateParent!: () => void
  function Harness() {
    const [revision, setRevision] = useState(0)
    updateParent = () => setRevision((value) => value + 1)
    return (
      <box width="100%" height="100%" flexDirection="column">
        <text>{revision}</text>
        <TranscriptViewport {...viewportProps} />
      </box>
    )
  }
  const setup = await testRender(<Harness />, { width: 80, height: 20 })
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const viewport = setup.renderer.root.findDescendantById("transcript")
    await act(async () => {
      updateParent()
      await setup.flush()
      await setup.renderOnce()
    })
    expect(setup.renderer.root.findDescendantById("transcript")).toBe(viewport)
    expect(
      sameTranscriptViewportProps(viewportProps, { ...viewportProps }),
    ).toBe(true)
    expect(
      sameTranscriptViewportProps(viewportProps, {
        ...viewportProps,
        surface: "composer",
      }),
    ).toBe(false)
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

test("window movement mounts only planned blocks while retaining both spacer roots", async () => {
  const thread = threadId("window-mount"),
    turn = turnId("window-mount-turn")
  let conversation = createConversation(thread)
  conversation = reduceConversation(conversation, {
    type: "turn.started",
    threadId: thread,
    turnId: turn,
  })
  let transcript = initialTranscript()
  for (let index = 0; index < 3; index++) {
    const item = {
      id: itemId(`window-item-${index}`),
      turnId: turn,
      kind: "assistant" as const,
      markdown: `row ${index}`,
      status: "complete" as const,
    }
    conversation = reduceConversation(conversation, {
      type: "item.started",
      threadId: thread,
      item,
    })
    transcript = syncTranscriptItem(transcript, item)
  }
  const frame = createTranscriptFrame({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 1,
    conversation,
    transcript,
    mode: "follow",
  })
  const first: TranscriptWindow = Object.freeze({
    activityBatches: [],
    activityBatchByItem: {},
    activityPresentation: {},
    blocks: Object.freeze(frame.blocks.slice(0, 2)),
    topSpacerRows: 0,
    bottomSpacerRows: 1,
    overscanRows: 1,
  })
  const second: TranscriptWindow = Object.freeze({
    activityBatches: [],
    activityBatchByItem: {},
    activityPresentation: {},
    blocks: Object.freeze(frame.blocks.slice(1)),
    topSpacerRows: 1,
    bottomSpacerRows: 0,
    overscanRows: 1,
  })
  const syntax = createEmberTideSyntax()
  const scrollRef = createRef<ScrollBoxRenderable>()
  let move!: () => void
  function Harness() {
    const [window, setWindow] = useState(first)
    move = () => setWindow(second)
    return (
      <TranscriptViewport
        window={window}
        state={frame.transcript}
        surface="transcript"
        syntax={syntax}
        scrollRef={scrollRef}
      />
    )
  }
  const setup = await testRender(<Harness />, { width: 80, height: 20 })
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const top = setup.renderer.root.findDescendantById("transcript-top-spacer")
    const bottom = setup.renderer.root.findDescendantById(
      "transcript-bottom-spacer",
    )
    expect(top).toBeDefined()
    expect(bottom).toBeDefined()
    expect(
      setup.renderer.root.findDescendantById(
        transcriptBlockRenderableId(frame.blocks[0]!),
      ),
    ).toBeDefined()
    expect(
      setup.renderer.root.findDescendantById(
        transcriptBlockRenderableId(frame.blocks[2]!),
      ),
    ).toBeUndefined()

    await act(async () => {
      move()
      await setup.flush()
      await setup.renderOnce()
    })
    expect(
      setup.renderer.root.findDescendantById("transcript-top-spacer"),
    ).toBe(top)
    expect(
      setup.renderer.root.findDescendantById("transcript-bottom-spacer"),
    ).toBe(bottom)
    expect(top?.height).toBe(1)
    expect(bottom?.visible).toBe(false)
    expect(
      setup.renderer.root.findDescendantById(
        transcriptBlockRenderableId(frame.blocks[0]!),
      ),
    ).toBeUndefined()
    expect(
      setup.renderer.root.findDescendantById(
        transcriptBlockRenderableId(frame.blocks[1]!),
      ),
    ).toBeDefined()
    expect(
      setup.renderer.root.findDescendantById(
        transcriptBlockRenderableId(frame.blocks[2]!),
      ),
    ).toBeDefined()
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

test("command fragments render one header, unique descendants, and no sibling or activity gaps", async () => {
  const thread = threadId("fragment-viewport"),
    turn = turnId("fragment-turn"),
    id = itemId("fragment-command")
  const detail = Array.from(
    { length: 180 },
    (_, index) =>
      `${String(index).padStart(4, "0")}: ${"bounded output ".repeat(5)}`,
  ).join("\n")
  const item = {
    id,
    turnId: turn,
    kind: "command" as const,
    title: "One command header",
    executionCommand: "bun test",
    detail,
    status: "complete" as const,
  }
  let conversation = createConversation(thread)
  conversation = reduceConversation(conversation, {
    type: "turn.started",
    threadId: thread,
    turnId: turn,
  })
  conversation = reduceConversation(conversation, {
    type: "item.started",
    threadId: thread,
    item,
  })
  conversation = reduceConversation(conversation, {
    type: "turn.completed",
    threadId: thread,
    turnId: turn,
    outcome: "complete",
    durationMs: 1,
  })
  const transcript = syncTranscriptItem(
    initialTranscript(),
    conversation.items[id]!,
  )
  const frame = createTranscriptFrame({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 3,
    conversation,
    transcript,
    mode: "follow",
  })
  const itemBlocks = frame.blocks.filter((block) => "projection" in block)
  expect(itemBlocks.length).toBeGreaterThan(1)
  const syntax = createEmberTideSyntax()
  const scrollRef = createRef<ScrollBoxRenderable>()
  const setup = await testRender(
    <TranscriptViewport
      window={frame.window}
      state={frame.transcript}
      surface="transcript"
      syntax={syntax}
      scrollRef={scrollRef}
    />,
    { width: 80, height: 400 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    const captured = setup.captureCharFrame()
    expect(captured.match(/One command header/g)).toHaveLength(1)
    for (const block of itemBlocks) {
      const suffix = `:${block.key.blockId}`
      expect(
        setup.renderer.root.findDescendantById(`tool-output:${id}${suffix}`),
      ).toBeDefined()
    }
    expect(
      setup.renderer.root.findDescendantById(
        `decoration:fold:${id}:command:header`,
      ),
    ).toBeDefined()
    expect(
      setup.renderer.root.findDescendantById(
        `decoration:fold:${id}:${itemBlocks[1]!.key.blockId}`,
      ),
    ).toBeUndefined()
    const roots = itemBlocks.map((block) =>
      setup.renderer.root.findDescendantById(
        transcriptBlockRenderableId(block),
      )!,
    )
    const outputs = itemBlocks.map((block) =>
      setup.renderer.root.findDescendantById(
        `tool-output:${id}:${block.key.blockId}`,
      )!,
    )
    for (let index = 1; index < roots.length; index++) {
      expect(roots[index]!.y).toBe(
        roots[index - 1]!.y + roots[index - 1]!.height,
      )
      expect(outputs[index]!.y).toBe(
        outputs[index - 1]!.y + outputs[index - 1]!.height,
      )
    }
    const activity = frame.blocks.find((block) => "turn" in block)!
    const activityRoot = setup.renderer.root.findDescendantById(
      transcriptBlockRenderableId(activity),
    )!
    expect(activityRoot.y).toBe(roots.at(-1)!.y + roots.at(-1)!.height)
    expect(activityRoot.y).toBe(outputs.at(-1)!.y + outputs.at(-1)!.height + 1)
    const scroll = setup.renderer.root.findDescendantById(
      "transcript",
    ) as ScrollBoxRenderable
    const layout = measureRenderedTranscript(setup.renderer, scroll, {
      frame,
      styleRevision: "command-fragment-test",
    })!
    const points = layout.points![id]!
    expect(Object.keys(points)).toHaveLength(
      frame.transcript.projectionById[id]!.source.length + 1,
    )
    for (let index = 1; index < itemBlocks.length; index++) {
      const boundary = itemBlocks[index]!.sourceSpan.from
      expect(points[boundary]?.screenY).toBe(roots[index]!.y)
    }
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

test("Markdown and edit fragments keep unique native children, exact geometry, and one edit header", async () => {
  const thread = threadId("content-fragments"),
    markdownTurn = turnId("markdown-fragment-turn"),
    editTurn = turnId("edit-fragment-turn")
  const markdownId = itemId("fragment-markdown"),
    editId = itemId("fragment-edit")
  const paragraphs = Array.from({ length: 24 }, (_, index) =>
    index === 8
      ? `## Section ${index}\n\n| column | value |\n| --- | ---: |\n| row | ${index} |`
      : index === 16
        ? "```ts\nconst stable = true\n```"
        : `Paragraph ${index}: ${"bounded Markdown content ".repeat(8)}[link](https://vimex.test/${index}).`,
  )
  const markdown = paragraphs.join("\n\n")
  const changes = Array.from({ length: 4 }, (_, index) => ({
    path: `file-${index}.ts`,
    action: "update" as const,
    patch: `diff --git a/file-${index}.ts b/file-${index}.ts\n--- a/file-${index}.ts\n+++ b/file-${index}.ts\n@@ -1 +1 @@\n-old${index}\n+new${index}`,
  }))
  const markdownItem = {
    id: markdownId,
    turnId: markdownTurn,
    kind: "assistant" as const,
    markdown,
    status: "complete" as const,
  }
  const editItem = {
    id: editId,
    turnId: editTurn,
    kind: "edit" as const,
    title: "Four deterministic files",
    patch: changes.map((change) => change.patch).join("\n"),
    changes,
    status: "complete" as const,
  }
  let conversation = createConversation(thread)
  let transcript = initialTranscript()
  for (const [turn, item] of [
    [markdownTurn, markdownItem],
    [editTurn, editItem],
  ] as const) {
    conversation = reduceConversation(conversation, {
      type: "turn.started",
      threadId: thread,
      turnId: turn,
    })
    conversation = reduceConversation(conversation, {
      type: "item.started",
      threadId: thread,
      item,
    })
    conversation = reduceConversation(conversation, {
      type: "turn.completed",
      threadId: thread,
      turnId: turn,
      outcome: "complete",
      durationMs: 1,
    })
    transcript = syncTranscriptItem(transcript, conversation.items[item.id]!)
  }
  const frame = createTranscriptFrame({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 6,
    conversation,
    transcript,
    mode: "follow",
  })
  const markdownBlocks = frame.blocks.filter(
    (block): block is TranscriptItemBlock =>
      "projection" in block && block.key.itemId === markdownId,
  )
  const editBlocks = frame.blocks.filter(
    (block): block is TranscriptItemBlock =>
      "projection" in block && block.key.itemId === editId,
  )
  expect(markdownBlocks.length).toBeGreaterThan(1)
  expect(editBlocks).toHaveLength(changes.length)
  const syntax = createEmberTideSyntax()
  const scrollRef = createRef<ScrollBoxRenderable>()
  const setup = await testRender(
    <TranscriptViewport
      window={frame.window}
      state={frame.transcript}
      surface="transcript"
      syntax={syntax}
      scrollRef={scrollRef}
    />,
    { width: 80, height: 400 },
  )
  try {
    await act(async () => {
      await setup.flush()
      await setup.renderOnce()
    })
    for (const block of markdownBlocks) {
      expect(
        setup.renderer.root.findDescendantById(
          `markdown:${markdownId}:${block.key.blockId}`,
        ),
      ).toBeDefined()
    }
    for (const [index, block] of editBlocks.entries()) {
      if (block.renderItem.kind !== "edit" || !block.renderItem.changes)
        throw new Error("Expected edit fragment")
      for (const localIndex of block.renderItem.changes.keys()) {
        const localSuffix = localIndex === 0 ? "" : `:${localIndex}`
        expect(
          setup.renderer.root.findDescendantById(
            `diff:${editId}:${block.key.blockId}${localSuffix}`,
          ),
        ).toBeDefined()
        expect(
          setup.renderer.root.findDescendantById(
            `decoration:edit-file:${editId}:${block.key.blockId}:${localIndex}`,
          ),
        ).toBeDefined()
      }
      if (index > 0)
        expect(
          setup.renderer.root.findDescendantById(
            `decoration:edit-header:${editId}:${block.key.blockId}`,
          ),
        ).toBeUndefined()
    }
    expect(
      setup.renderer.root.findDescendantById(
        `decoration:edit-header:${editId}:edit:header`,
      ),
    ).toBeDefined()
    expect(
      setup.renderer.root.findDescendantById(
        `decoration:edit-header:${editId}:${editBlocks[1]!.key.blockId}`,
      ),
    ).toBeUndefined()
    const rootsByBlock = new Map(
      [...markdownBlocks, ...editBlocks].map((block) => [
        block,
        setup.renderer.root.findDescendantById(
          transcriptBlockRenderableId(block),
        )!,
      ]),
    )
    for (const blocks of [markdownBlocks, editBlocks])
      for (let index = 1; index < blocks.length; index++) {
        const root = rootsByBlock.get(blocks[index]!)!
        const previous = rootsByBlock.get(blocks[index - 1]!)!
        expect(root.y).toBe(previous.y + previous.height)
      }
    const scroll = setup.renderer.root.findDescendantById(
      "transcript",
    ) as ScrollBoxRenderable
    const layout = measureRenderedTranscript(setup.renderer, scroll, {
      frame,
      styleRevision: "content-fragment-test",
    })!
    for (const blocks of [markdownBlocks, editBlocks]) {
      const id = blocks[0]!.key.itemId
      const points = layout.points![id]!
      expect(Object.keys(points)).toHaveLength(
        frame.transcript.projectionById[id]!.sourceSpans.length + 1,
      )
      for (let index = 1; index < blocks.length; index++) {
        const offset = blockGraphemeRange(blocks[index]!).from
        const root = rootsByBlock.get(blocks[index]!)!
        expect(points[offset]!.screenY).toBeGreaterThanOrEqual(root.y)
        expect(points[offset]!.screenY).toBeLessThan(root.y + root.height)
      }
    }
  } finally {
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
})

test("fragmented Markdown preserves the unsplit native frame and every logical coordinate", async () => {
  const thread = threadId("markdown-parity"),
    turn = turnId("markdown-parity-turn"),
    id = itemId("markdown-parity-item")
  const markdown = Array.from({ length: 18 }, (_, index) =>
    index === 6
      ? "## Stable table\n\n| column | value |\n| --- | ---: |\n| row | six |"
      : index === 12
        ? "```ts\nconst fenced = true\n```"
        : `Paragraph ${index} has **stable emphasis**, \`code\`, and [a link](https://vimex.test/${index}). ${"wrap text ".repeat(20)}`,
  ).join("\n\n")
  const item = {
    id,
    turnId: turn,
    kind: "assistant" as const,
    markdown,
    status: "complete" as const,
  }
  let conversation = createConversation(thread)
  conversation = reduceConversation(conversation, {
    type: "turn.started",
    threadId: thread,
    turnId: turn,
  })
  conversation = reduceConversation(conversation, {
    type: "item.started",
    threadId: thread,
    item,
  })
  const transcript = syncTranscriptItem(
    initialTranscript(),
    conversation.items[id]!,
  )
  const frame = createTranscriptFrame({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 2,
    conversation,
    transcript,
    mode: "follow",
  })
  const fragments = frame.blocks.filter(
    (block): block is TranscriptItemBlock => "projection" in block,
  )
  expect(fragments.length).toBeGreaterThan(1)
  const first = fragments[0]!
  const root: TranscriptItemBlock = Object.freeze({
    ...first,
    key: Object.freeze({ kind: "item", itemId: id, blockId: "root" }),
    renderItem: first.item,
    sourceSpan: Object.freeze({ from: 0, to: first.projection.source.length }),
    fragment: undefined,
    followedByActivity: false,
  })
  const fragmentedWindow: TranscriptWindow = Object.freeze({
    activityBatches: [],
    activityBatchByItem: {},
    activityPresentation: {},
    blocks: Object.freeze(fragments),
    topSpacerRows: 0,
    bottomSpacerRows: 0,
    overscanRows: 0,
  })
  const rootWindow: TranscriptWindow = Object.freeze({
    activityBatches: [],
    activityBatchByItem: {},
    activityPresentation: {},
    blocks: Object.freeze([root]),
    topSpacerRows: 0,
    bottomSpacerRows: 0,
    overscanRows: 0,
  })
  const fragmentedFrame = Object.freeze({
    ...frame,
    blocks: Object.freeze(fragments),
    window: fragmentedWindow,
  })
  const rootFrame = Object.freeze({
    ...frame,
    blocks: Object.freeze([root]),
    window: rootWindow,
  })
  const render = async (
    window: TranscriptWindow,
    layoutFrame: typeof frame,
    styleRevision: string,
  ) => {
    const syntax = createEmberTideSyntax(),
      scrollRef = createRef<ScrollBoxRenderable>()
    const setup = await testRender(
      <TranscriptViewport
        window={window}
        state={transcript}
        surface="transcript"
        syntax={syntax}
        scrollRef={scrollRef}
      />,
      { width: 80, height: 400 },
    )
    try {
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
      const scroll = setup.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      const layout = measureRenderedTranscript(setup.renderer, scroll, {
        frame: layoutFrame,
        styleRevision,
      })!
      return { frame: setup.captureCharFrame(), points: layout.points![id]! }
    } finally {
      await act(async () => setup.renderer.destroy())
      syntax.destroy()
    }
  }
  const fragmentedResult = await render(
    fragmentedWindow,
    fragmentedFrame,
    "markdown-fragment-parity",
  )
  const rootResult = await render(rootWindow, rootFrame, "markdown-root-parity")
  expect(fragmentedResult.frame).toBe(rootResult.frame)
  expect(Object.keys(fragmentedResult.points)).toEqual(
    Object.keys(rootResult.points),
  )
  for (const offset of Object.keys(rootResult.points).map(Number)) {
    expect(fragmentedResult.points[offset]).toMatchObject({
      screenX: rootResult.points[offset]!.screenX,
      screenY: rootResult.points[offset]!.screenY,
    })
  }
})

test("fragmented multi-file edits preserve the unsplit native frame and every logical coordinate", async () => {
  const thread = threadId("edit-parity"),
    turn = turnId("edit-parity-turn"),
    id = itemId("edit-parity-item")
  const changes = Array.from({ length: 6 }, (_, index) => ({
    path: `src/file-${index}.ts`,
    action: "update" as const,
    patch: `diff --git a/src/file-${index}.ts b/src/file-${index}.ts\n--- a/src/file-${index}.ts\n+++ b/src/file-${index}.ts\n@@ -1,2 +1,2 @@\n export const file${index} = {\n-  value: "before",\n+  value: "after",\n }`,
  }))
  const item = {
    id,
    turnId: turn,
    kind: "edit" as const,
    title: "Six files",
    patch: changes.map((change) => change.patch).join("\n"),
    changes,
    status: "complete" as const,
  }
  let conversation = createConversation(thread)
  conversation = reduceConversation(conversation, {
    type: "turn.started",
    threadId: thread,
    turnId: turn,
  })
  conversation = reduceConversation(conversation, {
    type: "item.started",
    threadId: thread,
    item,
  })
  const transcript = syncTranscriptItem(
    initialTranscript(),
    conversation.items[id]!,
  )
  const frame = createTranscriptFrame({
    threadId: thread,
    canonicalGeneration: 0,
    canonicalRevision: 2,
    conversation,
    transcript,
    mode: "follow",
  })
  const fragments = frame.blocks.filter(
    (block): block is TranscriptItemBlock => "projection" in block,
  )
  expect(fragments).toHaveLength(changes.length)
  const first = fragments[0]!
  const root: TranscriptItemBlock = Object.freeze({
    ...first,
    key: Object.freeze({ kind: "item", itemId: id, blockId: "root" }),
    renderItem: first.item,
    sourceSpan: Object.freeze({ from: 0, to: first.projection.source.length }),
    fragment: undefined,
    followedByActivity: false,
  })
  const fragmentedWindow: TranscriptWindow = Object.freeze({
    activityBatches: [],
    activityBatchByItem: {},
    activityPresentation: {},
    blocks: Object.freeze(fragments),
    topSpacerRows: 0,
    bottomSpacerRows: 0,
    overscanRows: 0,
  })
  const rootWindow: TranscriptWindow = Object.freeze({
    activityBatches: [],
    activityBatchByItem: {},
    activityPresentation: {},
    blocks: Object.freeze([root]),
    topSpacerRows: 0,
    bottomSpacerRows: 0,
    overscanRows: 0,
  })
  const fragmentedFrame = Object.freeze({
    ...frame,
    blocks: Object.freeze(fragments),
    window: fragmentedWindow,
  })
  const rootFrame = Object.freeze({
    ...frame,
    blocks: Object.freeze([root]),
    window: rootWindow,
  })
  const render = async (
    window: TranscriptWindow,
    layoutFrame: typeof frame,
    styleRevision: string,
  ) => {
    const syntax = createEmberTideSyntax(),
      scrollRef = createRef<ScrollBoxRenderable>()
    const setup = await testRender(
      <TranscriptViewport
        window={window}
        state={transcript}
        surface="transcript"
        syntax={syntax}
        scrollRef={scrollRef}
      />,
      { width: 80, height: 200 },
    )
    try {
      await act(async () => {
        await setup.flush()
        await setup.renderOnce()
      })
      const scroll = setup.renderer.root.findDescendantById(
        "transcript",
      ) as ScrollBoxRenderable
      const layout = measureRenderedTranscript(setup.renderer, scroll, {
        frame: layoutFrame,
        styleRevision,
      })!
      return { frame: setup.captureCharFrame(), points: layout.points![id]! }
    } finally {
      await act(async () => setup.renderer.destroy())
      syntax.destroy()
    }
  }
  const fragmentedResult = await render(
    fragmentedWindow,
    fragmentedFrame,
    "edit-fragment-parity",
  )
  const rootResult = await render(rootWindow, rootFrame, "edit-root-parity")
  expect(fragmentedResult.frame).toBe(rootResult.frame)
  expect(Object.keys(fragmentedResult.points)).toEqual(
    Object.keys(rootResult.points),
  )
  for (const offset of Object.keys(rootResult.points).map(Number)) {
    expect(fragmentedResult.points[offset]).toMatchObject({
      screenX: rootResult.points[offset]!.screenX,
      screenY: rootResult.points[offset]!.screenY,
    })
  }
})
