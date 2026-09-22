#!/usr/bin/env bun
import { parseCommand } from "./parse-command"
import { runCommand } from "./run-command"
import { createCommandPorts } from "./composition-root"
function errorText(error: unknown): string {
  if (error instanceof AggregateError)
    return [error.message, ...error.errors.map(errorText)].join("\n")
  return error instanceof Error ? error.message : String(error)
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await runCommand(
      parseCommand(args),
      createCommandPorts(),
    )
  } catch (error) {
    console.error(errorText(error))
    process.exitCode = 1
  }
}
if (import.meta.main) await main()
