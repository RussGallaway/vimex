import {
  type LocalState,
  type WorkbenchLifecycleSnapshot,
} from "@vimex/workbench"
import type { PaneCheckpoint, VimexConfig } from "@vimex/platform-node"

/** Apply only this client's changes to a freshly read shared legacy snapshot. */
export function mergeLocalChanges(
  latest: LocalState,
  before: LocalState,
  after: LocalState,
): LocalState {
  const patchMap = <T>(
    current: Readonly<Record<string, T>> = {},
    previous: Readonly<Record<string, T>> = {},
    next: Readonly<Record<string, T>> = {},
  ): Record<string, T> => {
    const result = { ...current }
    for (const key of new Set([
      ...Object.keys(previous),
      ...Object.keys(next),
    ])) {
      if (JSON.stringify(previous[key]) === JSON.stringify(next[key])) continue
      if (Object.hasOwn(next, key)) result[key] = next[key]!
      else delete result[key]
    }
    return result
  }
  const patchSet = (
    current: readonly string[] = [],
    previous: readonly string[] = [],
    next: readonly string[] = [],
  ) => {
    const values = new Set(current)
    for (const id of previous) if (!next.includes(id)) values.delete(id)
    for (const id of next) if (!previous.includes(id)) values.add(id)
    return [...values]
  }
  return {
    version: 1,
    threads: patchMap(latest.threads, before.threads, after.threads),
    sideChats: patchMap(latest.sideChats, before.sideChats, after.sideChats),
    favoriteThreadIds: patchSet(
      latest.favoriteThreadIds,
      before.favoriteThreadIds,
      after.favoriteThreadIds,
    ),
    retiredSideThreadIds: patchSet(
      latest.retiredSideThreadIds,
      before.retiredSideThreadIds,
      after.retiredSideThreadIds,
    ),
  }
}

/** New panes may inherit navigation, but never another pane's unsent work. */
export function navigationSeed(state: LocalState): LocalState {
  return {
    ...state,
    threads: Object.fromEntries(
      Object.entries(state.threads).map(([id, view]) => [
        id,
        {
          ...view,
          draft: "",
          images: undefined,
          mentions: undefined,
          cursorOffset: 0,
          outbox: [],
        },
      ]),
    ),
  }
}

/** Only committed machine transitions may replace the durable resume target. */
export function observePaneTarget(
  checkpoint: PaneCheckpoint,
  snapshot: WorkbenchLifecycleSnapshot,
  sshHost?: string,
): PaneCheckpoint {
  if (!snapshot.resumeTarget) return checkpoint
  const target = {
    ...snapshot.resumeTarget,
    localCwd: checkpoint.target.localCwd,
    ...(checkpoint.target.config ? { config: checkpoint.target.config } : {}),
    ...(sshHost ? { sshHost } : {}),
  }
  return JSON.stringify(target) === JSON.stringify(checkpoint.target)
    ? checkpoint
    : { ...checkpoint, target }
}

/** Merge shared settings by the keys this client actually changed. */
export function mergeConfigPatch(
  latest: VimexConfig,
  before: VimexConfig,
  patch: Partial<VimexConfig>,
): VimexConfig {
  const result = { ...latest, ...patch }
  if (patch.machines) {
    result.machines = { ...latest.machines }
    for (const id of new Set([
      ...Object.keys(before.machines),
      ...Object.keys(patch.machines),
    ])) {
      if (
        JSON.stringify(before.machines[id]) ===
        JSON.stringify(patch.machines[id])
      )
        continue
      if (Object.hasOwn(patch.machines, id))
        result.machines[id] = patch.machines[id]!
      else delete result.machines[id]
    }
  }
  if (patch.favoriteMachines) {
    const favorites = new Set(latest.favoriteMachines)
    for (const id of before.favoriteMachines)
      if (!patch.favoriteMachines.includes(id)) favorites.delete(id)
    for (const id of patch.favoriteMachines)
      if (!before.favoriteMachines.includes(id)) favorites.add(id)
    result.favoriteMachines = [...favorites]
  }
  return result
}
