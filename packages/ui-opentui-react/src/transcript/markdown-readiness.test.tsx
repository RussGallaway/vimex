import { expect, test } from "bun:test"
import {
  CodeRenderable,
  SyntaxStyle,
  getTreeSitterClient,
  type Renderable,
} from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { createMarkdownReadiness } from "./markdown-readiness"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(content = "Before [link](https://vimex.test) after.") {
  const gate = deferred()
  const native = getTreeSitterClient()
  const client = new Proxy(native, {
    get(target, key) {
      if (key === "highlightOnce")
        return async (...args: Parameters<typeof native.highlightOnce>) => {
          await gate.promise
          return target.highlightOnce(...args)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  const syntax = SyntaxStyle.create()
  const setup = await testRender(
    <markdown
      id="required"
      content={content}
      streaming={false}
      internalBlockMode="top-level"
      syntaxStyle={syntax}
      treeSitterClient={client}
      conceal
    />,
    { width: 80, height: 6 },
  )
  await act(async () => {
    await setup.flush()
    await setup.renderOnce()
  })
  const root = setup.renderer.root.findDescendantById("required") as Renderable
  const descendants = (node: Renderable): Renderable[] => [
    node,
    ...node.getChildren().flatMap((child) => descendants(child as Renderable)),
  ]
  const leaf = descendants(root).find(
    (node) => node instanceof CodeRenderable,
  ) as CodeRenderable
  let notifications = 0
  const readiness = createMarkdownReadiness(() => {
    notifications++
    setup.renderer.requestRender()
  })
  const paint = async () => {
    await act(async () => {
      await setup.renderOnce()
    })
  }
  return {
    setup,
    descendants,
    root,
    leaf,
    readiness,
    gate,
    paint,
    notifications: () => notifications,
    close: async () => {
      readiness.dispose()
      gate.resolve()
      await act(async () => {
        await setup.renderer.destroy()
      })
      syntax.destroy()
    },
  }
}

test("readiness observes actual native render without issuing a synthetic paint", async () => {
  const f = await fixture()
  const original = f.leaf.render
  let renders = 0
  f.leaf.render = function (buffer, elapsed) {
    renders++
    return original.call(this, buffer, elapsed)
  }
  const delegated = f.leaf.render
  const hitGrid = () =>
    Array.from({ length: 6 }, (_, y) =>
      Array.from({ length: 80 }, (_, x) => f.setup.renderer.hitTest(x, y)),
    )
  const beforeHits = hitGrid()
  try {
    expect(f.readiness.check([f.root], "style")).toBe(false)
    expect(renders).toBe(0)
    expect(hitGrid()).toEqual(beforeHits)
    await f.paint()
    expect(renders).toBe(1)
    expect(hitGrid()).toEqual(beforeHits)
    expect(f.readiness.check([f.root], "style")).toBe(false)
    expect(f.setup.captureCharFrame().trim()).toBe("")
    f.gate.resolve()
    await f.leaf.highlightingDone
    // A worker completion alone is not a paint certificate.
    expect(f.readiness.check([f.root], "style")).toBe(false)
    await f.paint()
    expect(f.readiness.check([f.root], "style")).toBe(true)
    expect(f.setup.captureCharFrame()).toContain("Before link")
    f.readiness.dispose()
    expect(f.leaf.render).toBe(delegated)
  } finally {
    await f.close()
  }
})

test("superseded native identities and detached leaves cannot certify pending work", async () => {
  const f = await fixture()
  try {
    expect(f.readiness.check([f.root], "old-style")).toBe(false)
    await f.paint()
    const oldJob = f.leaf.highlightingDone
    f.leaf.content = "Replacement [label](https://vimex.test/new)."
    expect(f.readiness.check([f.root], "new-style")).toBe(false)
    f.gate.resolve()
    await oldJob
    expect(f.readiness.check([f.root], "new-style")).toBe(false)
    await f.paint()
    await f.leaf.highlightingDone
    await f.paint()
    expect(f.readiness.check([f.root], "new-style")).toBe(true)
    expect(f.setup.captureCharFrame()).toContain("Replacement label")
    // Removing a required root releases it immediately, not after its old job.
    expect(f.readiness.check([], "new-style")).toBe(true)
  } finally {
    await f.close()
  }
})

test("destroying a required leaf unblocks independently of its worker promise", async () => {
  const f = await fixture()
  try {
    const original = f.leaf.render
    expect(f.readiness.check([f.root], "style")).toBe(false)
    await f.paint()
    f.leaf.destroy()
    expect(f.leaf.render).toBe(original)
    expect(f.readiness.check([f.root], "style")).toBe(true)
    const notifications = f.notifications()
    f.readiness.dispose()
    f.gate.resolve()
    await Promise.resolve()
    expect(f.notifications()).toBe(notifications)
  } finally {
    await f.close()
  }
})

test("a visible portion of an oversized Markdown root does not await offscreen leaves", async () => {
  const f = await fixture(
    Array.from(
      { length: 80 },
      (_, index) => `Paragraph ${index} [link](https://vimex.test/${index}).`,
    ).join("\n\n"),
  )
  const viewport = { y: 0, height: 6 }
  try {
    expect(f.root.height).toBeGreaterThan(viewport.height)
    expect(f.readiness.check([f.root], "style", viewport)).toBe(false)
    await f.paint()
    f.gate.resolve()
    await Promise.all(
      f
        .descendants(f.root)
        .filter(
          (node): node is CodeRenderable =>
            node instanceof CodeRenderable &&
            node.y < viewport.height &&
            node.y + node.height > 0,
        )
        .map((leaf) => leaf.highlightingDone),
    )
    await f.paint()
    expect(f.readiness.check([f.root], "style", viewport)).toBe(true)
    // Offscreen siblings have no certificate from this observer. They must not
    // prevent navigation in the visible corridor; entering them requires paint.
    expect(f.readiness.check([f.root], "style")).toBe(false)
    expect(f.readiness.check([f.root], "style", viewport)).toBe(true)
    expect(f.setup.captureCharFrame()).toContain("Paragraph 0 link")
  } finally {
    await f.close()
  }
})
