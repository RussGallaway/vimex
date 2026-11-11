import {
  mkdir,
  lstat,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
  unlink,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { withFileLock } from "../process/file-lock"

export type RexShell = "zsh" | "bash"
const start = "# >>> vimex rex restore >>>"
const end = "# <<< vimex rex restore <<<"

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Runs synchronously in the restored shell, without replacing it or typing into it. */
export function createRexShellHook(
  shell: RexShell,
  command: readonly string[],
): string {
  if (shell !== "zsh" && shell !== "bash") throw new Error("Unsupported shell")
  if (!command.length || command.some((arg) => !arg || /[\r\n\0]/.test(arg)))
    throw new Error("Invalid Vimex launcher")
  return `${start}
case $- in
  *i*)
    if [ -t 0 ] && [ -t 1 ] && [ -n "\${REX_SERVER:-}" ] && [ -n "\${REX_SESSION:-}" ] && [ -n "\${REX_BLOCK:-}" ] && [ "\${VIMEX_REX_CHECKED:-}" != "$REX_SERVER|$REX_SESSION|$REX_BLOCK" ]; then
      export VIMEX_REX_CHECKED="$REX_SERVER|$REX_SESSION|$REX_BLOCK"
      ${command.map(quote).join(" ")} rex resume-pane || :
    fi
    ;;
esac
${end}`
}

function removeHook(text: string): string {
  const first = text.indexOf(start)
  const last = text.indexOf(end)
  if (first === -1 && last === -1) return text
  if (
    first === -1 ||
    last < first ||
    text.indexOf(start, first + start.length) !== -1 ||
    text.indexOf(end, last + end.length) !== -1
  )
    throw new Error(
      "Vimex shell integration markers are incomplete or duplicated; preserve the file and repair the marked block before retrying",
    )
  const after = last + end.length
  return (
    text.slice(0, first) + text.slice(after + (text[after] === "\n" ? 1 : 0))
  )
}

export async function configureRexShellHook(options: {
  shell: RexShell
  command: readonly string[]
  remove?: boolean
  home?: string
  zdotdir?: string
}): Promise<string[]> {
  const home = options.home ?? homedir()
  const paths =
    options.shell === "zsh"
      ? [
          join(
            resolve(home, options.zdotdir ?? process.env.ZDOTDIR ?? home),
            ".zshrc",
          ),
        ]
      : [join(home, ".bashrc"), await bashLoginFile(home)]
  const hook = createRexShellHook(options.shell, options.command)
  for (const path of paths) {
    if (options.remove) {
      const before = await readFile(path, "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
        throw error
      })
      // Do not create lock files or directories for an integration that was
      // never installed. Re-read inside the lock when there is work to remove.
      if (removeHook(before) === before) continue
    }
    await mkdir(dirname(path), { recursive: true })
    // Follow a user's existing symlink; atomically replacing it would break their dotfile setup.
    const destination = await realpath(path).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const entry = await lstat(path).catch((missing) => {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT")
            return undefined
          throw missing
        })
        if (entry?.isSymbolicLink())
          throw new Error(
            `Refusing to replace dangling shell configuration symlink: ${path}`,
          )
        return path
      }
      throw error
    })
    await withFileLock(`${destination}.vimex-lock`, async () => {
      const before = await readFile(destination, "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
        throw error
      })
      const clean = removeHook(before)
      const after = options.remove
        ? clean
        : clean + (clean && !clean.endsWith("\n") ? "\n" : "") + hook + "\n"
      if (after === before) return
      const mode = await stat(destination)
        .then((value) => value.mode & 0o777)
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0o600
          throw error
        })
      const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`
      try {
        await writeFile(temporary, after, { mode, flag: "wx" })
        await rename(temporary, destination)
      } finally {
        await unlink(temporary).catch(() => {})
      }
    })
  }
  return paths
}

async function bashLoginFile(home: string): Promise<string> {
  for (const name of [".bash_profile", ".bash_login", ".profile"]) {
    const path = join(home, name)
    try {
      await stat(path)
      return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return join(home, ".bash_profile")
}
