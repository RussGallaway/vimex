/** Count only lines inside unified hunks; file headers are metadata. */
export function diffSummary(
  patch: string,
): { added: number; removed: number } | undefined {
  let added = 0,
    removed = 0,
    oldRemaining = 0,
    newRemaining = 0,
    sawHunk = false
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) {
      oldRemaining = Number(hunk[2] ?? 1)
      newRemaining = Number(hunk[4] ?? 1)
      sawHunk = true
      continue
    }
    if (line.startsWith("+") && newRemaining > 0) {
      added++
      newRemaining--
    } else if (line.startsWith("-") && oldRemaining > 0) {
      removed++
      oldRemaining--
    } else if (line.startsWith(" ")) {
      oldRemaining = Math.max(0, oldRemaining - 1)
      newRemaining = Math.max(0, newRemaining - 1)
    }
  }
  return sawHunk ? { added, removed } : undefined
}

/** Native parser names, not filename extensions. Unknown languages stay plain. */
export function diffFiletype(path: string): string {
  const extension = path.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase()
  if (["ts", "mts", "cts"].includes(extension ?? "")) return "typescript"
  if (["tsx", "mtsx", "ctsx"].includes(extension ?? ""))
    return "typescriptreact"
  if (["js", "mjs", "cjs"].includes(extension ?? "")) return "javascript"
  if (extension === "jsx") return "javascriptreact"
  if (["md", "markdown"].includes(extension ?? "")) return "markdown"
  if (["zig", "zon"].includes(extension ?? "")) return "zig"
  if (["py", "pyw"].includes(extension ?? "")) return "python"
  if (["sh", "bash"].includes(extension ?? "")) return "bash"
  if (extension === "json") return "json"
  return "text"
}
