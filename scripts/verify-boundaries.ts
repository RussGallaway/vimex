import { readFile, readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const pure = new Set(["conversation", "transcript", "composer", "interaction", "approvals", "workbench", "distribution"])
const allowedDependencies: Record<string, readonly string[]> = {
  distribution: [], conversation: [], composer: [], interaction: [],
  transcript: ["conversation"], approvals: ["conversation"],
  workbench: ["conversation", "transcript", "composer", "interaction", "approvals"],
  "codex-app-server": ["conversation", "approvals", "workbench"],
  "platform-node": ["conversation", "transcript", "composer", "interaction", "approvals", "workbench", "distribution"],
  "ui-opentui-react": ["conversation", "transcript", "composer", "interaction", "approvals", "workbench"],
  herdr: ["conversation", "workbench"],
  testkit: ["conversation", "transcript", "composer", "interaction", "approvals", "workbench"],
}
const problems: string[] = []
async function visit(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "generated", ".git"].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await visit(path); continue }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) continue
    const name = relative(root, path)
    const packageName = name.split("/")[1]
    const source = await readFile(path, "utf8")
    if (name.startsWith("packages/ui-opentui-react/src/components/")) problems.push(`${name}: UI files require feature ownership rather than a generic components directory`)
    if (pure.has(packageName!) && entry.name === "index.ts" && /export\s+(?:async\s+)?(?:function|class|const|interface)\s/.test(source)) problems.push(`${name}: public entry point contains implementation; use domain/application modules`)

    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
      const target = match[1]!
      const violation = (reason: string) => problems.push(`${name}: ${reason}: ${target}`)
      const dependency = /^@vimex\/([^/]+)/.exec(target)?.[1]
      const allowed = allowedDependencies[packageName!]
      if (dependency && allowed && dependency !== packageName && !allowed.includes(dependency)) violation("dependency reverses the allowed context graph")
      if (pure.has(packageName!) && /^(?:react(?:\/|$)|zustand(?:\/|$)|@opentui\/|node:|bun(?:$|:)|@vimex\/(?:codex-app-server|platform-node|herdr|ui-opentui-react))/.test(target)) violation("pure domain imports a runtime adapter")
      if (target === "@vimex/testkit" || target.startsWith("@vimex/testkit/")) violation("production source imports testkit")
      if (packageName === "ui-opentui-react" && /^@vimex\/(?:codex-app-server|platform-node|herdr)$/.test(target)) violation("UI selects a concrete external adapter")
      if (name.includes("/domain/") && target.startsWith(".") && resolve(directory, target).includes("/application/")) violation("domain depends on application layer")
      if (name.includes("/domain/") && /(?:^|\/)index$/.test(target)) violation("domain imports package barrel, obscuring layer direction")
      if (target.includes("generated/") && packageName !== "codex-app-server") violation("Codex wire types escape the adapter")
      if (/^@vimex\/[^/]+\//.test(target)) violation("cross-package deep import")
      if (target.startsWith(".") && (name.startsWith("packages/") || name.startsWith("plugins/"))) {
        const targetPath = resolve(directory, target)
        const packageRoot = join(root, name.split("/")[0]!, packageName!)
        if (!targetPath.startsWith(packageRoot + "/")) violation("relative import escapes package")
      }
    }
  }
}
for (const folder of ["apps", "packages", "plugins"]) await visit(join(root, folder))
if (problems.length) {
  console.error(problems.join("\n"))
  process.exitCode = 1
} else console.log("Dependency boundaries verified")
