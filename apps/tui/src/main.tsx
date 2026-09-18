import { parseCliOptions, helpText } from "./cli-options"
import { runApplication } from "./composition-root"

async function main() {
  const options = parseCliOptions(process.argv.slice(2))
  if (options.help) { console.log(helpText); return }
  if (options.version) { console.log("vimex 0.1.0"); return }
  await runApplication(options)
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(errorText)].join("\n")
  return error instanceof Error ? error.message : String(error)
}
main().catch(error => { console.error(errorText(error)); process.exitCode = 1 })
