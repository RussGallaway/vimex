import {
  CodeRenderable,
  MarkdownRenderable,
  type Renderable,
} from "@opentui/core"

interface Observation {
  readonly leaf: CodeRenderable
  readonly root: Renderable
  readonly original: CodeRenderable["render"]
  readonly wrapper: CodeRenderable["render"]
  readonly destroyed: () => void
  identity: readonly unknown[]
  ready: boolean
  waiting?: Promise<void>
}
const owners = new WeakMap<CodeRenderable, object>()

/** Observe real native paint only. Never start a highlight through a scratch
 * render: Code.render also writes to the live hit grid and clears dirty state. */
export function createMarkdownReadiness(changed: (root: Renderable) => void) {
  const owner = {}
  const observations = new Map<CodeRenderable, Observation>()
  let revision: unknown
  let disposed = false
  const identity = (leaf: CodeRenderable) => [
    revision,
    leaf.content,
    leaf.filetype,
    leaf.syntaxStyle,
    leaf.conceal,
    leaf.streaming,
    leaf.treeSitterClient,
    leaf.onHighlight,
    leaf.onChunks,
    leaf.baseHighlight,
  ]
  const same = (a: readonly unknown[], b: readonly unknown[]) =>
    a.length === b.length && a.every((value, index) => value === b[index])
  const detach = (observation: Observation) => {
    const { leaf } = observation
    if (leaf.render === observation.wrapper) leaf.render = observation.original
    leaf.off("destroyed", observation.destroyed)
    observations.delete(leaf)
    if (owners.get(leaf) === owner) owners.delete(leaf)
  }
  const observe = (leaf: CodeRenderable, root: Renderable) => {
    let observation = observations.get(leaf)
    if (observation) return observation
    if (owners.has(leaf))
      throw new Error("Markdown readiness already owns this leaf")
    const original = leaf.render
    const wrapper: CodeRenderable["render"] = function (
      this: CodeRenderable,
      buffer,
      deltaTime,
    ) {
      const result = original.call(this, buffer, deltaTime)
      if (this !== leaf || disposed || leaf.isDestroyed || !leaf.visible)
        return result
      const current = observations.get(leaf)
      if (!current) return result
      const next = identity(leaf)
      if (!same(current.identity, next)) {
        current.identity = next
        current.ready = false
      }
      if (!leaf.isHighlighting) {
        if (!current.ready) {
          current.ready = true
          changed(root)
        }
      } else {
        current.ready = false
        const pending = leaf.highlightingDone
        if (current.waiting !== pending) {
          current.waiting = pending
          const generation = current.identity
          const completed = () => {
            if (
              disposed ||
              leaf.isDestroyed ||
              observations.get(leaf) !== current ||
              current.identity !== generation ||
              !same(generation, identity(leaf))
            )
              return
            // Completion requests a genuine paint; only that paint certifies
            // the transformed buffer, including a possible highlight rerun.
            changed(root)
          }
          void pending.then(completed, completed)
        }
      }
      return result
    }
    const destroyed = () => {
      const current = observations.get(leaf)
      if (current) detach(current)
      if (!disposed) changed(root)
    }
    observation = {
      leaf,
      root,
      original,
      wrapper,
      destroyed,
      identity: identity(leaf),
      ready: false,
    }
    observations.set(leaf, observation)
    owners.set(leaf, owner)
    leaf.render = wrapper
    leaf.on("destroyed", destroyed)
    return observation
  }
  return {
    check(
      roots: readonly Renderable[],
      styleRevision: unknown,
      viewport?: Readonly<{ y: number; height: number }>,
    ): boolean {
      revision = styleRevision
      let ready = true
      const visit = (node: Renderable, root: Renderable, markdown: boolean) => {
        if (node.isDestroyed || !node.visible) return
        markdown ||= node instanceof MarkdownRenderable
        if (
          markdown &&
          node instanceof CodeRenderable &&
          node.filetype === "markdown" &&
          (!viewport ||
            (node.y < viewport.y + viewport.height &&
              node.y + node.height > viewport.y))
        ) {
          const observation = observe(node, root)
          const next = identity(node)
          if (!same(observation.identity, next)) {
            observation.identity = next
            observation.ready = false
          }
          if (!observation.ready || node.isHighlighting) ready = false
        }
        for (const child of node.getChildren())
          visit(child as Renderable, root, markdown)
      }
      for (const root of roots) visit(root, root, false)
      return ready
    },
    dispose() {
      disposed = true
      for (const observation of observations.values()) detach(observation)
    },
  }
}
