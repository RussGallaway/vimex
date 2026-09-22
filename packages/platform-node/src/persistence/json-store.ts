import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** Serial, atomic snapshots: readers see the previous or next complete document. */
export class JsonStore<T> {
  private writes: Promise<void> = Promise.resolve()
  constructor(
    readonly path: string,
    private readonly validate: (value: unknown) => T,
  ) {}

  async read(fallback: T): Promise<T> {
    try {
      return this.validate(JSON.parse(await readFile(this.path, "utf8")))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback
      throw new Error(
        `Unable to load ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  write(value: T): Promise<void> {
    const snapshot = JSON.stringify(this.validate(value), null, 2) + "\n"
    const operation = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`
        try {
          await writeFile(temporary, snapshot, { mode: 0o600, flag: "wx" })
          await rename(temporary, this.path)
        } finally {
          await unlink(temporary).catch(() => {})
        }
      })
    this.writes = operation
    return operation
  }

  flush(): Promise<void> {
    return this.writes
  }
}
