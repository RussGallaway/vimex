import { mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"

let native:
  | Promise<{
      flock(fd: number, operation: number): number
      errno(): number
    }>
  | undefined

/** Load libc only when a lock is needed; ordinary CLI startup stays FFI-free. */
function locking() {
  return (native ??= (async () => {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("File locking requires macOS or Linux")
    const { dlopen, FFIType, toArrayBuffer } = await import("bun:ffi")
    const errnoName =
      process.platform === "darwin" ? "__error" : "__errno_location"
    const library = dlopen(
      process.platform === "darwin"
        ? "/usr/lib/libSystem.B.dylib"
        : "libc.so.6",
      {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        [errnoName]: { args: [], returns: FFIType.ptr },
      },
    )
    return {
      flock: (fd: number, operation: number) =>
        library.symbols.flock!(fd, operation) as number,
      errno: () => {
        const address = library.symbols[errnoName]!()
        if (!address) throw new Error("Unable to read file-lock error")
        return new Int32Array(toArrayBuffer(address, 0, 4))[0]!
      },
    }
  })())
}

/**
 * Nonblocking OS lock. Closing the descriptor (including process death) releases
 * ownership. The stable lock file must never be unlinked by callers.
 */
export async function acquireFileLock(
  path: string,
): Promise<(() => Promise<void>) | undefined> {
  const api = await locking()
  const created = await mkdir(dirname(path), {
    recursive: true,
    mode: 0o700,
  })
  if (created) {
    // Ownership is acquired before the first checkpoint write; persist the
    // directory entries created here so that write can rely on their existence.
    let current = dirname(path)
    for (;;) {
      const directory = await open(current, "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      if (current === dirname(created) || current === dirname(current)) break
      current = dirname(current)
    }
  }
  const file = await open(path, "a", 0o600)
  if (api.flock(file.fd, 2 | 4) !== 0) {
    const errno = api.errno()
    await file.close()
    if (errno === (process.platform === "darwin" ? 35 : 11)) return undefined
    throw new Error(`Unable to acquire file lock ${path} (errno ${errno})`)
  }
  let released: Promise<void> | undefined
  return () => (released ??= file.close())
}

/** Mutate shared state only inside this callback, after freshly reading disk. */
export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let release = await acquireFileLock(path)
  while (!release) {
    if (Date.now() >= deadline) throw new Error(`Timed out locking ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 15))
    release = await acquireFileLock(path)
  }
  try {
    return await operation()
  } finally {
    await release()
  }
}
