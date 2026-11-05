import type { CliRenderer, TreeSitterClient } from "@opentui/core"

// An opt-in diagnostic: postpone only fenced-code decoration on newly mounted,
// completed Markdown. Parsing, concealment, layout, and navigation stay native.
export const navigationDetailExperimentEnabled =
  process.env.VIMEX_NAV_DEFER_CODE_DETAIL === "1"

export class NavigationDetailGate {
  readonly diagnostics = {
    motions: 0,
    deferredRequests: 0,
    releasedRequests: 0,
  }
  private timer: ReturnType<typeof setTimeout> | undefined
  private waiters: Array<() => void> = []
  private clients = new WeakMap<TreeSitterClient, TreeSitterClient>()

  constructor(private readonly idleMs = 120) {}

  get active(): boolean {
    return this.timer !== undefined
  }

  motion(): void {
    this.diagnostics.motions++
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.dispose(), this.idleMs)
  }

  whenIdle(): Promise<void> {
    return this.active
      ? new Promise((resolve) => this.waiters.push(resolve))
      : Promise.resolve()
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  client(client: TreeSitterClient): TreeSitterClient {
    const prior = this.clients.get(client)
    if (prior) return prior
    const proxy = new Proxy(client, {
      get: (target, property) => {
        if (property === "highlightOnce")
          return async (content: string, filetype: string) => {
            // Markdown highlighting also performs concealment/source mapping.
            if (filetype !== "markdown" && this.active) {
              this.diagnostics.deferredRequests++
              await this.whenIdle()
              this.diagnostics.releasedRequests++
            }
            return target.highlightOnce(content, filetype)
          }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    this.clients.set(client, proxy)
    return proxy
  }
}

const gates = new WeakMap<CliRenderer, NavigationDetailGate>()
export function navigationDetailGate(
  renderer: CliRenderer,
): NavigationDetailGate {
  let gate = gates.get(renderer)
  if (!gate) {
    gate = new NavigationDetailGate()
    gates.set(renderer, gate)
  }
  return gate
}
