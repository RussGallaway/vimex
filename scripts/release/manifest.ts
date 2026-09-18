import { createHash } from "node:crypto"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseRelease } from "@vimex/distribution"

const directory = resolve(process.argv[2] ?? "dist")
const { version } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"))
const artifacts = []
for (const file of (await readdir(directory)).filter(name => /^vimex-v.*-(darwin|linux)-(arm64|x64)\.json$/.test(name)).sort()) {
  const fragment = parseRelease(JSON.parse(await readFile(join(directory, file), "utf8")))
  if (fragment.version !== version) throw new Error(`Mismatched artifact version: ${file}`)
  for (const artifact of fragment.artifacts) {
    const expected = `vimex-v${version}-${artifact.platform}-${artifact.arch}.tar.gz`
    if (artifact.name !== expected) throw new Error(`Unexpected artifact filename: ${artifact.name}`)
    const sha = createHash("sha256").update(await readFile(join(directory, artifact.name))).digest("hex")
    if (sha !== artifact.sha256) throw new Error(`Checksum mismatch: ${artifact.name}`)
    artifacts.push(artifact)
  }
}
const release = parseRelease({ version, artifacts })
if (release.artifacts.length !== 4) throw new Error("Publishing requires all four native platform artifacts")
await writeFile(join(directory, "vimex-release.json"), JSON.stringify(release, null, 2) + "\n")
await writeFile(join(directory, "SHA256SUMS"), release.artifacts.map(artifact => `${artifact.sha256}  ${artifact.name}\n`).join(""))
