import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname } from "node:path"
import { withFileLock } from "../process/file-lock"

/** Serial, atomic snapshots: readers see the previous or next complete document. */
export class JsonStore<T> {
  private writes: Promise<void> = Promise.resolve()
  constructor(
    readonly path: string,
    private readonly validate: (value: unknown) => T,
    private readonly options: { durable?: boolean } = {},
  ) {}

  read(): Promise<T | undefined>
  read(fallback: T): Promise<T>
  async read(fallback?: T): Promise<T | undefined> {
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
      .then(() => this.writeSnapshot(snapshot))
    this.writes = operation
    return operation
  }

  /** Apply a patch to a fresh disk value under a cross-process lock. */
  update(fallback: T, mutate: (current: T) => T): Promise<T> {
    const operation = this.writes
      .catch(() => {})
      .then(() =>
        withFileLock(`${this.path}.lock`, async () => {
          const next = this.validate(mutate(await this.read(fallback)))
          await this.writeSnapshot(JSON.stringify(next, null, 2) + "\n")
          return next
        }),
      )
    this.writes = operation.then(() => {})
    return operation
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    const created = await mkdir(dirname(this.path), {
      recursive: true,
      mode: 0o700,
    })
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      if (this.options.durable) {
        const file = await open(temporary, "wx", 0o600)
        try {
          await file.writeFile(snapshot)
          await file.sync()
        } finally {
          await file.close()
        }
      } else await writeFile(temporary, snapshot, { mode: 0o600, flag: "wx" })
      await rename(temporary, this.path)
      if (this.options.durable) {
        // Persist newly created ancestor entries as well as the final rename.
        const stop = created ? dirname(created) : dirname(this.path)
        let current = dirname(this.path)
        for (;;) {
          const directory = await open(current, "r")
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
          if (current === stop || current === dirname(current)) break
          current = dirname(current)
        }
      }
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  flush(): Promise<void> {
    return this.writes
  }
}
