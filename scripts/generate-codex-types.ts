import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"

const versionProcess = Bun.spawn(["codex", "--version"], { stdout: "pipe", stderr: "inherit" })
const versionText = (await new Response(versionProcess.stdout).text()).trim()
const exitCode = await versionProcess.exited
if (exitCode !== 0) throw new Error(`codex --version failed with ${exitCode}`)

const version = versionText.match(/(\d+\.\d+\.\d+)/)?.[1]
if (!version) throw new Error(`Unable to parse Codex version from: ${versionText}`)

const directory = join(import.meta.dir, "..", "packages", "codex-app-server", "src", "generated", `v${version.replaceAll(".", "_")}`)
await rm(directory, { recursive: true, force: true })
await mkdir(directory, { recursive: true })

const generator = Bun.spawn(["codex", "app-server", "generate-ts", "--experimental", "--out", directory], {
  stdout: "inherit",
  stderr: "inherit",
})
const generated = await generator.exited
if (generated !== 0) throw new Error(`schema generation failed with ${generated}`)
console.log(`Generated Codex ${version} bindings in ${directory}`)
