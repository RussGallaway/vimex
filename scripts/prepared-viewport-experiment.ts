/** Opt-in, credential-free native viewport. Not wired into production Vimex. */
import { appendFileSync } from "node:fs"
import {
  createCliRenderer,
  CliRenderEvents,
  TextRenderable,
  CodeRenderable,
  SyntaxStyle,
} from "@opentui/core"
import { PreparedViewportExperiment } from "../packages/ui-opentui-react/src/transcript/prepared/prepared-viewport-experiment"
import { registerSyntaxParsers } from "../packages/ui-opentui-react/src/syntax/register-parsers"

const width = 80
const height = 18
const delay = Number(process.env.VIMEX_PREPARED_DETAIL_DELAY_MS ?? 400)
const blocking = Number(process.env.VIMEX_PREPARED_BLOCK_MS ?? 0)
if (
  !Number.isFinite(delay) ||
  delay < 0 ||
  delay > 5000 ||
  !Number.isFinite(blocking) ||
  blocking < 0 ||
  blocking > 200
)
  throw new Error("Invalid experiment delay")
const logPath = process.env.VIMEX_PREPARED_TRACE
const started = performance.now()
const trace = (kind: string, value: object = {}) => {
  if (logPath)
    appendFileSync(
      logPath,
      JSON.stringify({ kind, atMs: performance.now() - started, ...value }) +
        "\n",
    )
}
const blocks = Array.from({ length: 256 }, (_, block) => ({
  id: `block-${block}`,
  kind: "code" as const,
  text: Array.from(
    { length: 12 },
    (_, row) =>
      `value_${String(block).padStart(3, "0")}_${String(row).padStart(2, "0")} = ${block * 12 + row}  # prepared viewport`,
  ).join("\n"),
}))
const experiment = new PreparedViewportExperiment({
  blocks,
  width,
  height,
  startBlock: 120,
})
registerSyntaxParsers()
const renderer = await createCliRenderer({
  screenMode: "alternate-screen",
  exitOnCtrlC: false,
  exitSignals: [],
  targetFps: 60,
})
const syntax = SyntaxStyle.fromStyles({
  keyword: { fg: "#ff8888" },
  string: { fg: "#88ff88" },
  number: { fg: "#88ccff" },
  comment: { fg: "#999999" },
})
const cheap = new TextRenderable(renderer, {
  id: "prepared-cheap",
  position: "absolute",
  left: 0,
  top: 0,
  width,
  height,
  wrapMode: "none",
  content: "Preparing initial viewport...",
})
const help = new TextRenderable(renderer, {
  id: "prepared-help",
  position: "absolute",
  left: 0,
  top: 18,
  width,
  height: 1,
  content: "EXPERIMENT Ctrl-U/D move | v select | y copy to trace | q quit",
})
const status = new TextRenderable(renderer, {
  id: "prepared-status",
  position: "absolute",
  left: 0,
  top: 19,
  width,
  height: 1,
  content: "PV starting",
})
renderer.root.add(cheap)
renderer.root.add(help)
renderer.root.add(status)
let rich: CodeRenderable | undefined
let detailTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let content = ""
let detail = "waiting"
let lastStatus = ""
let closed = false
let lastFrame = experiment.frame()
function redraw() {
  const frame = experiment.frame()
  lastFrame = frame
  const nextContent = frame.rows.join("\n")
  if (frame.rows.length && nextContent !== content) {
    content = nextContent
    generation++
    const token = generation
    if (detailTimer) clearTimeout(detailTimer)
    rich?.destroy()
    rich = undefined
    cheap.visible = true
    cheap.content = content
    detail = "waiting"
    detailTimer = setTimeout(async () => {
      if (closed || token !== generation) return
      const detailStart = performance.now()
      while (performance.now() - detailStart < blocking) {
        /* deliberate negative control */
      }
      const candidate = new CodeRenderable(renderer, {
        id: `detail-${token}`,
        position: "absolute",
        left: 0,
        top: 0,
        width,
        height,
        wrapMode: "none",
        content,
        filetype: "python",
        syntaxStyle: syntax,
        conceal: false,
        drawUnstyledText: true,
      })
      candidate.visible = false
      renderer.root.add(candidate)
      rich = candidate
      await candidate.highlightingDone
      if (closed || token !== generation) {
        if (!candidate.isDestroyed) candidate.destroy()
        return
      }
      candidate.visible = true
      cheap.visible = false
      detail = "rich"
      trace("detail", {
        generation: token,
        durationMs: performance.now() - detailStart,
      })
      redraw()
    }, delay)
  }
  const top = frame.top
  const nextStatus = `PV a=${frame.accepted} r=${frame.resolved} p=${frame.pending} top=${top?.blockIndex ?? -1}:${top?.row ?? -1} ${detail} ${frame.status}`
  if (nextStatus !== lastStatus) {
    lastStatus = nextStatus
    status.content = nextStatus
    renderer.requestRender()
  }
  if (frame.cursor)
    renderer.setCursorPosition(frame.cursor.x, frame.cursor.y, true)
}
renderer.on(CliRenderEvents.FRAME, () =>
  trace("frame", {
    ...lastFrame,
    rows: undefined,
    state: undefined,
    detail,
    cache: experiment.cacheStats,
  }),
)
const tick = setInterval(() => {
  if (closed) return
  const start = performance.now()
  const work = experiment.prepare()
  const preparationMs = performance.now() - start
  experiment.advance()
  if (work.jobs)
    trace("prepare", {
      ...work,
      durationMs: preparationMs,
      advanceMs: performance.now() - start - preparationMs,
    })
  redraw()
}, 4)
function close() {
  if (closed) return
  closed = true
  clearInterval(tick)
  if (detailTimer) clearTimeout(detailTimer)
  trace("final", { frame: lastFrame, cache: experiment.cacheStats })
  renderer.destroy()
  syntax.destroy()
  process.exit(0)
}
renderer.keyInput.on("keypress", (key) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) return close()
  if (key.ctrl && (key.name === "u" || key.name === "d")) {
    const delta = (key.name === "u" ? -1 : 1) * Math.floor(height / 2)
    const accepted = experiment.enqueue(delta)
    trace("key", { delta, accepted })
    experiment.advance()
    redraw()
  } else if (key.name === "v") experiment.beginSelection()
  else if (key.name === "y")
    trace("copy", {
      text: experiment.copy(),
      selection: experiment.state.selection,
    })
})
process.on("SIGTERM", close)
renderer.start()
redraw()
