import { addDefaultParsers, type FiletypeParserOptions } from "@opentui/core"
import { fileURLToPath } from "node:url"
import { realpathSync } from "node:fs"
import { dirname, join } from "node:path"

declare const VIMEX_COMPILED: boolean

function asset(language: "python" | "bash" | "json", name: string): string {
  if (typeof VIMEX_COMPILED !== "undefined" && VIMEX_COMPILED) {
    return join(dirname(realpathSync(process.execPath)), "assets", "parsers", language, name)
  }
  return fileURLToPath(new URL(`../../assets/parsers/${language}/${name}`, import.meta.url))
}

/** Renderer-owned, pinned parsers that are available without a network connection. */
export const vimexSyntaxParsers: readonly FiletypeParserOptions[] = [
  {
    filetype: "python",
    aliases: ["py", "python3"],
    wasm: asset("python", "tree-sitter-python.wasm"),
    queries: { highlights: [asset("python", "highlights.scm")] },
  },
  {
    filetype: "bash",
    aliases: ["sh", "shell", "shellscript"],
    wasm: asset("bash", "tree-sitter-bash.wasm"),
    queries: { highlights: [asset("bash", "highlights.scm")] },
  },
  {
    filetype: "json",
    wasm: asset("json", "tree-sitter-json.wasm"),
    queries: { highlights: [asset("json", "highlights.scm")] },
  },
]

let registered = false

/** Call once at the composition root, before constructing the OpenTUI renderer. */
export function registerSyntaxParsers(): void {
  if (registered) return
  registered = true
  addDefaultParsers([...vimexSyntaxParsers])
}
