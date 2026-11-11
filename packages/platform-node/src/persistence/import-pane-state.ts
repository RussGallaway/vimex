import { constants } from "node:fs"
import { chmod, copyFile, mkdir, open, unlink } from "node:fs/promises"
import { extname, join } from "node:path"
import {
  emptyLocalState,
  parseLocalState,
  type SavedThreadView,
} from "@vimex/workbench"
import { stateDirectory } from "../config"
import { JsonStore } from "./json-store"
import { PaneStateStore, type PaneIdentity } from "./pane-state"

function unsent(view: SavedThreadView) {
  return {
    draft: view.draft,
    images: view.images ?? [],
    mentions: view.mentions ?? [],
    outbox: view.outbox,
  }
}

function hasWork(view: SavedThreadView): boolean {
  return Boolean(
    view.draft ||
    view.images?.length ||
    view.mentions?.length ||
    view.outbox.length,
  )
}

/** Explicit, selected-machine migration. Originals and submission statuses stay intact. */
export async function importPaneState(
  identity: PaneIdentity,
  root = stateDirectory(),
): Promise<{ machine: string; threads: number; images: number }> {
  const store = new PaneStateStore(identity, root)
  const release = await store.acquire()
  if (!release)
    throw new Error(
      "Vimex is running in this pane. Quit it before importing state.",
    )
  const created: string[] = []
  try {
    const checkpoint = await store.read()
    if (!checkpoint)
      throw new Error(
        "Open Vimex in this Rex pane once, then quit it before importing state.",
      )
    const machine = checkpoint.target.machine
    const source = join(
      root,
      machine === "local" ? "views.json" : `views-${machine}.json`,
    )
    const legacy = await new JsonStore(source, parseLocalState).read()
    if (!legacy) throw new Error(`No legacy view state found for ${machine}.`)
    const current = checkpoint.machines[machine] ?? emptyLocalState()
    const retired = new Set([
      ...(legacy.retiredSideThreadIds ?? []),
      ...(current.retiredSideThreadIds ?? []),
    ])
    const imports = Object.entries(legacy.threads).filter(
      ([id]) => !retired.has(id),
    )
    for (const [id, old] of imports) {
      const existing = current.threads[id]
      if (
        existing &&
        hasWork(existing) &&
        JSON.stringify(unsent(existing)) !== JSON.stringify(unsent(old))
      )
        throw new Error(
          `Thread ${id} already has different unsent work in this pane; nothing was imported.`,
        )
    }
    const directory = join(store.directory, "images")
    const copied = new Map<string, string>()
    const cloneImages = async (images: SavedThreadView["images"]) => {
      if (!images) return undefined
      const result: NonNullable<SavedThreadView["images"]>[number][] = []
      for (const image of images) {
        let path = copied.get(image.path)
        if (!path) {
          const extension = extname(image.path)
          path = join(
            directory,
            `${crypto.randomUUID()}${/^\.[a-zA-Z0-9]{1,10}$/.test(extension) ? extension : ".image"}`,
          )
          copied.set(image.path, path)
          await mkdir(directory, { recursive: true, mode: 0o700 })
          await copyFile(image.path, path, constants.COPYFILE_EXCL)
          created.push(path)
          await chmod(path, 0o600)
          const file = await open(path, "r")
          try {
            await file.sync()
          } finally {
            await file.close()
          }
        }
        result.push({ ...image, path })
      }
      return result
    }
    const threads = { ...current.threads }
    for (const [id, view] of imports) {
      // Identical existing work already owns its images; preserve it exactly.
      if (current.threads[id] && hasWork(current.threads[id]!)) continue
      const images = await cloneImages(view.images)
      const outbox: SavedThreadView["outbox"][number][] = []
      for (const message of view.outbox)
        outbox.push({ ...message, images: await cloneImages(message.images) })
      threads[id] = {
        ...view,
        images,
        outbox,
      }
    }
    if (created.length) {
      for (const path of [directory, store.directory]) {
        const handle = await open(path, "r")
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    }
    await store.write({
      ...checkpoint,
      machines: {
        ...checkpoint.machines,
        [machine]: {
          version: 1,
          threads,
          favoriteThreadIds: [
            ...new Set([
              ...(legacy.favoriteThreadIds ?? []),
              ...(current.favoriteThreadIds ?? []),
            ]),
          ],
          retiredSideThreadIds: [...retired],
          sideChats: { ...legacy.sideChats, ...current.sideChats },
        },
      },
    })
    return { machine, threads: imports.length, images: created.length }
  } catch (error) {
    // A failed directory fsync can follow a successful atomic rename. Never
    // delete copies referenced by the now-visible checkpoint in that case.
    const visible = await store.read().catch(() => undefined)
    const referenced = new Set<string>()
    for (const state of Object.values(visible?.machines ?? {}))
      for (const view of Object.values(state.threads)) {
        for (const image of view.images ?? []) referenced.add(image.path)
        for (const message of view.outbox)
          for (const image of message.images ?? []) referenced.add(image.path)
      }
    await Promise.all(
      created
        .filter((path) => !referenced.has(path))
        .map((path) => unlink(path).catch(() => {})),
    )
    throw error
  } finally {
    await release()
  }
}
