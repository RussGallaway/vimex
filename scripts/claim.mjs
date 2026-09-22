#!/usr/bin/env node

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import os from "node:os"
import { fileURLToPath } from "node:url"

const repositoryRoot = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
)
const liveRoot = path.join(repositoryRoot, ".vimex/coordination")
const claimsRoot = path.join(liveRoot, "claims")
const registryLock = path.join(liveRoot, "registry.lock")

class ClaimError extends Error {}

function fail(message) {
  throw new ClaimError(message)
}

function usage() {
  console.log(`Usage:
  bun run claim acquire --id ID --owner OWNER --scope PATH [--scope PATH...]
  bun run claim acquire --id ID --owner OWNER --scope .
  bun run claim list [--json]
  bun run claim verify --id ID --claim-id CLAIM_ID [--scope PATH...]
  bun run claim release --id ID --claim-id CLAIM_ID
  bun run claim release --id ID --force --reason TEXT`)
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const allowed = {
    acquire: ["id", "owner", "scope"],
    list: ["json"],
    verify: ["id", "claim-id", "scope"],
    release: ["id", "claim-id", "force", "reason"],
  }
  const options = { scopes: [] }
  const seen = new Set()
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!allowed[command]?.includes(token.slice(2)) || !token.startsWith("--"))
      fail(`unknown option: ${token}`)
    if (token !== "--scope" && seen.has(token))
      fail(`duplicate option: ${token}`)
    seen.add(token)
    if (token === "--json" || token === "--force") {
      options[token.slice(2)] = true
      continue
    }
    const value = rest[index + 1]
    if (
      !token.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      fail(`invalid argument near ${token}`)
    }
    const key = token.slice(2)
    if (key === "scope") options.scopes.push(value)
    else options[key.replaceAll("-", "_")] = value
    index += 1
  }
  return { command, options }
}

function validateId(value, label) {
  if (!value || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    fail(`${label} must match [a-z][a-z0-9-]{0,63}`)
  }
  return value
}

function normalizeScope(value, inspect = true) {
  if (
    !value ||
    value.split("/").includes("..") ||
    path.isAbsolute(value) ||
    /[*?\[\]\\\x00-\x1f]/.test(value)
  ) {
    fail(
      `scope must be a repository-relative path prefix without globs: ${value}`,
    )
  }
  const normalized = path.posix
    .normalize(value.replaceAll("\\", "/"))
    .replace(/^\.\//, "")
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.toLowerCase() === ".git" ||
    normalized.toLowerCase().startsWith(".git/") ||
    normalized.toLowerCase() === ".vimex" ||
    normalized.toLowerCase().startsWith(".vimex/")
  ) {
    fail(`scope escapes the repository or targets reserved metadata: ${value}`)
  }
  const absolute = path.resolve(repositoryRoot, normalized)
  if (
    absolute !== repositoryRoot &&
    !absolute.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    fail(`scope escapes the repository: ${value}`)
  }
  // Existing symlink components would give one file multiple claim names.
  let current = repositoryRoot
  for (const part of inspect ? normalized.split("/") : []) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        fail(`symlink scope is unsupported: ${value}`)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  return normalized === "." ? "." : normalized.replace(/\/$/, "")
}

function overlaps(left, right) {
  left = left.toLowerCase()
  right = right.toLowerCase()
  if (left === "." || right === ".") return true
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  )
}

function ensureStorage() {
  fs.mkdirSync(claimsRoot, { recursive: true })
}

function claimPath(id) {
  return path.join(claimsRoot, `${id}.json`)
}

function readClaims() {
  ensureStorage()
  return fs
    .readdirSync(claimsRoot)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      try {
        const claim = JSON.parse(
          fs.readFileSync(path.join(claimsRoot, name), "utf8"),
        )
        validateId(claim.id, "stored id")
        if (
          name !== `${claim.id}.json` ||
          claim.version !== 1 ||
          typeof claim.claimId !== "string" ||
          !claim.claimId ||
          typeof claim.owner !== "string" ||
          !claim.owner.trim() ||
          !Array.isArray(claim.scopes) ||
          !claim.scopes.length ||
          claim.scopes.some(
            (scope) =>
              typeof scope !== "string" ||
              normalizeScope(scope, false) !== scope,
          )
        )
          fail("invalid record")
        return claim
      } catch (error) {
        fail(`malformed claim ${name}: ${error.message}`)
      }
    })
}

function withRegistryLock(callback) {
  ensureStorage()
  try {
    fs.mkdirSync(registryLock)
  } catch (error) {
    if (error.code === "EEXIST")
      fail(
        `claim registry is busy; retry. If persistent, inspect ${registryLock}/owner.json and follow docs/coordination.md recovery instructions`,
      )
    throw error
  }
  try {
    fs.writeFileSync(
      path.join(registryLock, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      }),
    )
    return callback()
  } finally {
    fs.rmSync(registryLock, { recursive: true, force: true })
  }
}

function writeClaim(claim) {
  const destination = claimPath(claim.id)
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(claim, null, 2)}\n`, {
    flag: "wx",
  })
  fs.renameSync(temporary, destination)
}

function acquire(options) {
  const id = validateId(options.id, "id")
  const owner = options.owner?.trim()
  if (!owner) fail("owner is required")
  const scopes = [
    ...new Set(options.scopes.map((scope) => normalizeScope(scope))),
  ].sort()
  if (!scopes.length) fail("acquire requires at least one --scope")

  const claim = withRegistryLock(() => {
    const claims = readClaims()
    if (claims.some((existing) => existing.id === id))
      fail(`claim id already exists: ${id}`)
    for (const existing of claims) {
      const conflict = scopes.find((scope) =>
        existing.scopes.some((candidate) => overlaps(scope, candidate)),
      )
      if (conflict)
        fail(
          `scope ${conflict} overlaps claim ${existing.id} owned by ${existing.owner}`,
        )
    }

    const created = {
      version: 1,
      id,
      claimId: crypto.randomUUID(),
      owner,
      scopes,
      repositoryRoot,
      acquiredAt: new Date().toISOString(),
    }
    writeClaim(created)
    return created
  })
  console.log(JSON.stringify(claim, null, 2))
}

function list(options) {
  const claims = withRegistryLock(readClaims)
  if (options.json) {
    console.log(JSON.stringify(claims, null, 2))
    return
  }
  if (claims.length === 0) {
    console.log("No live claims.")
    return
  }
  for (const claim of claims) {
    const target = claim.scopes.join(", ")
    console.log(`${claim.id}\t${claim.owner}\t${target}\t${claim.claimId}`)
  }
}

function verify(options) {
  const id = validateId(options.id, "id")
  const claims = withRegistryLock(readClaims)
  const claim = claims.find((candidate) => candidate.id === id)
  if (!claim) fail(`claim not found: ${id}`)
  if (options.claim_id !== claim.claimId)
    fail(`claim identity mismatch for ${id}`)
  if (options.scopes.length > 0) {
    const requested = options.scopes.map((scope) => normalizeScope(scope))
    const outside = requested.find(
      (scope) =>
        !claim.scopes.some(
          (owned) =>
            owned === "." || scope === owned || scope.startsWith(`${owned}/`),
        ),
    )
    if (outside) fail(`scope ${outside} is outside claim ${id}`)
  }
  console.log(`verified ${id} (${claim.claimId})`)
}

function release(options) {
  const id = validateId(options.id, "id")
  withRegistryLock(() => {
    const destination = claimPath(id)
    if (!fs.existsSync(destination)) fail(`claim not found: ${id}`)
    const claim = readClaims().find((candidate) => candidate.id === id)
    if (!options.force && options.claim_id !== claim.claimId) {
      fail(`release requires the matching --claim-id for ${id}`)
    }
    if (options.force && !options.reason?.trim())
      fail("forced release requires --reason")
    fs.unlinkSync(destination)
    console.log(
      options.force
        ? `force-released ${id} owned by ${claim.owner}: ${options.reason}`
        : `released ${id}`,
    )
  })
}

try {
  const { command, options } = parseArgs(process.argv.slice(2))
  if (!command || command === "help" || command === "--help") {
    usage()
  } else if (command === "acquire") {
    acquire(options)
  } else if (command === "list") {
    list(options)
  } else if (command === "verify") {
    verify(options)
  } else if (command === "release") {
    release(options)
  } else {
    usage()
    fail(`unknown command: ${command}`)
  }
} catch (error) {
  if (error instanceof ClaimError) {
    console.error(`claim: ${error.message}`)
    process.exitCode = 1
  } else {
    throw error
  }
}
