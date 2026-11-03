/** Text glyphs keep machine names usable without a patched icon font. */
export function machineIcon(id: string): string {
  return id === "local" ? "⌂" : "☁︎"
}
