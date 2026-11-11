import { realpath } from "node:fs/promises"
import { delimiter, isAbsolute, join, resolve } from "node:path"

/** Retain an installation's stable symlink across upgrades, without switching builds. */
export async function rexLauncher(options: {
  compiled: boolean
  executable: string
  entry: string
  invoked?: string
  path?: string
}): Promise<string[]> {
  if (!options.compiled) return [options.executable, options.entry]
  const actual = await realpath(options.executable)
  const candidates: string[] = []
  if (
    options.invoked &&
    isAbsolute(options.invoked) &&
    resolve(options.invoked) !== resolve(options.executable)
  )
    candidates.push(options.invoked)
  for (const directory of (options.path ?? "").split(delimiter).filter(Boolean))
    for (const name of ["vimex", "vimex-dev"])
      candidates.push(join(directory, name))
  for (const candidate of candidates) {
    const resolved = await realpath(candidate).catch(() => undefined)
    if (resolved === actual) return [resolve(candidate)]
  }
  return [options.executable]
}
