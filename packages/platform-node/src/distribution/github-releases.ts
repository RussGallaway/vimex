import { normalizeVersion, parseRelease, type Release } from "@vimex/distribution"
const repository = "RussGallaway/vimex"
export interface ReleaseHttp { fetch: typeof fetch }
/** Fixed upstream; release filenames never supply an arbitrary download origin. */
export class GithubReleases {
  constructor(private readonly http: ReleaseHttp = { fetch }) {}
  private async json(url: string): Promise<unknown> {
    const response = await this.http.fetch(url, { signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json" } })
    if (!response.ok) throw new Error(`Release request failed (${response.status}): ${url}`)
    return response.json()
  }
  async get(requestedVersion?: string): Promise<Release> {
    let version = requestedVersion && normalizeVersion(requestedVersion)
    if (!version) {
      const latest = await this.json(`https://api.github.com/repos/${repository}/releases/latest`) as { tag_name?: unknown }
      if (!latest || typeof latest.tag_name !== "string") throw new Error("GitHub returned no release version")
      version = normalizeVersion(latest.tag_name)
    }
    const release = parseRelease(await this.json(`https://github.com/${repository}/releases/download/v${version}/vimex-release.json`))
    if (release.version !== version) throw new Error("Release manifest version does not match its tag")
    return release
  }
  async download(version: string, name: string): Promise<Uint8Array> {
    normalizeVersion(version)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar\.gz$/.test(name)) throw new Error("Invalid artifact filename")
    const response = await this.http.fetch(`https://github.com/${repository}/releases/download/v${version}/${name}`, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Artifact download failed (${response.status})`)
    return new Uint8Array(await response.arrayBuffer())
  }
}
