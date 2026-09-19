export function formatDuration(durationMs: number): string {
  const clamped = Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : 0
  if (clamped < 1000) return `${clamped}ms`
  const seconds = Math.floor(clamped / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
}
