/** Compile alongside the release binary to verify packaged worker/native/WASM assets. */
import { configurePackagedAssets } from "../../apps/cli/src/runtime-assets"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

configurePackagedAssets()
const { TreeSitterClient } = await import("@opentui/core")
const { vimexSyntaxParsers } =
  await import("../../packages/ui-opentui-react/src/syntax/register-parsers")
const directory = await mkdtemp(join(tmpdir(), "vimex-bundled-syntax-"))
const client = new TreeSitterClient({ dataPath: directory })
try {
  await client.initialize()
  for (const parser of vimexSyntaxParsers) client.addFiletypeParser(parser)
  for (const [filetype, source, group] of [
    ["python", "def greet():\n    return 'hi'", "keyword"],
    ["bash", "if true; then echo hi; fi", "keyword"],
    ["json", '{"hello":42}', "number"],
    ["typescript", "const answer: number = 42", "keyword"],
  ] as const) {
    const result = await client.highlightOnce(source, filetype)
    if (
      result.error ||
      result.warning ||
      !result.highlights?.some(([, , capture]) => capture.startsWith(group))
    ) {
      throw new Error(
        `Packaged ${filetype} highlighting failed: ${JSON.stringify(result)}`,
      )
    }
  }
  console.log("Packaged syntax: Python, Bash, JSON, TypeScript passed")
} finally {
  await client.destroy()
  await rm(directory, { recursive: true, force: true })
}
