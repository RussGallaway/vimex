import { posix, resolve } from "node:path"
import type {
  MachineNavigation,
  MachineRuntime,
  LocalState,
} from "@vimex/workbench"
import { parseConfig, type VimexConfig } from "@vimex/platform-node"

export interface MachineTarget {
  id: string
  sshHost?: string
  executable: string
  mode: "daemon" | "stdio"
}
export interface MachineNavigationOptions {
  config: VimexConfig
  saveMachines?(
    machines: VimexConfig["machines"],
    favoriteMachines: string[],
  ): Promise<void>
  initialMachine: string
  localCwd: string
  remoteCwd?: string
  createRuntime(
    target: MachineTarget,
    cwd: string,
  ): Omit<MachineRuntime, "machine" | "cwd">
  resolveRemoteDirectory(host: string, cwd?: string): Promise<string>
  loadState(id: string): Promise<LocalState>
}

/** Configuration and path policy; concrete adapters are supplied by composition. */
export function createMachineNavigation(options: MachineNavigationOptions) {
  let configuredMachines = { ...options.config.machines }
  let favorites = new Set(options.config.favoriteMachines)
  let mutations = Promise.resolve()
  const mutate = (change: () => Promise<void>) => {
    const operation = mutations.catch(() => {}).then(change)
    mutations = operation
    return operation
  }
  const known = new Set(["local", ...Object.keys(options.config.machines)])
  known.add(options.initialMachine)
  const targets = new Map<string, MachineTarget>()
  const configured = (id: string) =>
    Object.hasOwn(configuredMachines, id) ? configuredMachines[id] : undefined
  function target(id: string): MachineTarget {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
      throw new Error("Invalid machine name")
    const machineConfig = configured(id)
    const result: MachineTarget =
      id === "local"
        ? {
            id,
            executable: options.config.codexExecutable,
            mode:
              options.config.localTransport === "auto"
                ? options.config.codexExecutable === "codex"
                  ? "daemon"
                  : "stdio"
                : options.config.localTransport,
          }
        : {
            id,
            sshHost: machineConfig?.sshHost ?? id,
            executable: machineConfig?.codexExecutable ?? "codex",
            mode: "daemon",
          }
    targets.set(id, result)
    return result
  }
  const info = (id: string) => {
    const label = configured(id)?.label
    return {
      id,
      ...(label ? { label } : {}),
      ...(favorites.has(id) ? { favorite: true } : {}),
    }
  }
  async function save(
    next: VimexConfig["machines"],
    nextFavorites = favorites,
  ) {
    const favoriteMachines = [...nextFavorites]
    parseConfig({ ...options.config, machines: next, favoriteMachines })
    await options.saveMachines!(next, favoriteMachines)
    configuredMachines = next
    favorites = nextFavorites
  }
  function requireRemote(id: string) {
    if (id === "local") throw new Error("The local machine cannot be changed")
    if (!known.has(id)) throw new Error(`Unknown machine: ${id}`)
  }
  const navigation: MachineNavigation = {
    current: info(options.initialMachine),
    list: () => [...known].map(info),
    ...(options.saveMachines
      ? {
          add: (input: { id: string; sshHost: string }) =>
            mutate(async () => {
              if (["add", "rename", "remove", "favorite"].includes(input.id))
                throw new Error(`Reserved machine name: ${input.id}`)
              if (input.id === "local" || configured(input.id))
                throw new Error(`Machine already exists: ${input.id}`)
              if (known.has(input.id) && input.sshHost !== input.id)
                throw new Error(
                  `Remove connection ${input.id} before assigning a different SSH host`,
                )
              await save({
                ...configuredMachines,
                [input.id]: { sshHost: input.sshHost },
              })
              known.add(input.id)
            }),
          rename: (id: string, label: string) =>
            mutate(async () => {
              requireRemote(id)
              await save({
                ...configuredMachines,
                [id]: {
                  ...(configured(id) ?? { sshHost: id }),
                  label: label.trim(),
                },
              })
              if (navigation.current.id === id) navigation.current = info(id)
            }),
          setFavorite: (id: string, value: boolean) =>
            mutate(async () => {
              if (!known.has(id)) throw new Error(`Unknown machine: ${id}`)
              const nextFavorites = new Set(favorites)
              if (value) nextFavorites.add(id)
              else nextFavorites.delete(id)
              const next = { ...configuredMachines }
              if (id !== "local" && !configured(id) && value)
                next[id] = { sshHost: id }
              await save(next, nextFavorites)
              if (navigation.current.id === id) navigation.current = info(id)
            }),
          remove: (id: string) =>
            mutate(async () => {
              requireRemote(id)
              const next = { ...configuredMachines }
              delete next[id]
              const nextFavorites = new Set(favorites)
              nextFavorites.delete(id)
              await save(next, nextFavorites)
              known.delete(id)
              targets.delete(id)
            }),
        }
      : {}),
    async open(id) {
      const selected = target(id)
      const machineConfig = configured(id)
      const cwd = selected.sshHost
        ? await options.resolveRemoteDirectory(
            selected.sshHost,
            (id === options.initialMachine ? options.remoteCwd : undefined) ??
              machineConfig?.cwd,
          )
        : options.localCwd
      const localState = await options.loadState(id)
      const ports = options.createRuntime(selected, cwd)
      known.add(id)
      return {
        ...ports,
        machine: info(id),
        cwd,
        localState,
        resolveDirectory: selected.sshHost
          ? (base, path) => {
              if (path.startsWith("~"))
                throw new Error(
                  "Use an absolute remote path when changing directories",
                )
              return posix.resolve(base, path)
            }
          : resolve,
      }
    },
  }
  return { navigation, target, targets }
}
