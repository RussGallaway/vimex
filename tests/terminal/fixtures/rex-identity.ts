#!/usr/bin/env bun
// Credential-free Rex stand-in. Only the exact test endpoint is ever accepted.
const args = process.argv.slice(2)
if (!process.env.REX_SERVER?.startsWith("unix:///vimex-fixture/"))
  process.exit(2)
if (args.includes("whoami")) {
  console.log(
    JSON.stringify({
      endpoint: process.env.REX_SERVER,
      session_id: process.env.REX_SESSION,
      block_id: process.env.REX_BLOCK,
    }),
  )
} else if (args.includes("process")) {
  console.log(JSON.stringify({ child: { pid: process.ppid } }))
} else process.exit(2)
