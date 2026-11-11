import { expect, test } from "bun:test"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configureRexShellHook, createRexShellHook } from "./shell-hook"

test("shell installation is repeatable, preserves dotfiles and symlinks, and removes only its marked block", async () => {
  const home = await mkdtemp(join(tmpdir(), "vimex-hook-"))
  try {
    const actual = join(home, "actual-zshrc")
    await writeFile(actual, "# keep my settings\nexport SOMETHING=yes\n")
    await symlink(actual, join(home, ".zshrc"))
    const options = {
      home,
      zdotdir: home,
      shell: "zsh" as const,
      command: ["/a path/vimex"],
    }
    await configureRexShellHook(options)
    const installed = await readFile(actual, "utf8")
    await configureRexShellHook(options)
    expect(await readFile(actual, "utf8")).toBe(installed)
    expect(installed).toStartWith("# keep my settings\nexport SOMETHING=yes\n")
    await configureRexShellHook({ ...options, remove: true })
    expect(await readFile(actual, "utf8")).toBe(
      "# keep my settings\nexport SOMETHING=yes\n",
    )
    await configureRexShellHook({ ...options, remove: true })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("bash installation respects the existing login startup file and refuses malformed markers", async () => {
  const home = await mkdtemp(join(tmpdir(), "vimex-bash-hook-"))
  try {
    await writeFile(join(home, ".profile"), "# existing login configuration\n")
    const paths = await configureRexShellHook({
      home,
      shell: "bash",
      command: ["vimex"],
    })
    expect(paths).toEqual([join(home, ".bashrc"), join(home, ".profile")])
    expect(await Bun.file(join(home, ".bash_profile")).exists()).toBe(false)
    const malformed = "# >>> vimex rex restore >>>\n# user edit\n"
    await writeFile(join(home, ".bashrc"), malformed)
    await expect(
      configureRexShellHook({ home, shell: "bash", command: ["vimex"] }),
    ).rejects.toThrow("markers")
    expect(await readFile(join(home, ".bashrc"), "utf8")).toBe(malformed)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("interactive shell hook survives restore failures under errexit, launches once, suppresses nested shells, and quotes the executable", async () => {
  const home = await mkdtemp(join(tmpdir(), "vimex-hook-pty-"))
  try {
    const command = join(home, "launch 'with spaces'.sh")
    const calls = join(home, "calls")
    const hook = join(home, "hook")
    await writeFile(
      command,
      '#!/bin/sh\nprintf "%s\\n" "$2 $3" >> "$1"\nprintf "restore unavailable\\n" >&2\nexit 23\n',
    )
    await writeFile(
      hook,
      createRexShellHook("bash", ["/bin/sh", command, calls]),
    )
    const child = Bun.spawn(
      [
        "python3",
        "-c",
        `import os,pty,subprocess,sys
m,s=pty.openpty()
env=dict(os.environ,REX_SERVER='unix:///test',REX_SESSION='session:one',REX_BLOCK='block:one')
env.pop('VIMEX_REX_CHECKED',None)
script='''set -e; source "$1"; source "$1"; bash --noprofile --norc -i -c 'set -e; source "$1"' ignored "$1"; REX_BLOCK=block:two; source "$1"'''
r=subprocess.run(['bash','--noprofile','--norc','-i','-c',script,'ignored',sys.argv[1]],stdin=s,stdout=s,stderr=s,env=env,timeout=10)
os.close(s);os.close(m)
sys.exit(r.returncode)
`,
        hook,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await child.exited).toBe(0)
    expect(await readFile(calls, "utf8")).toBe(
      "rex resume-pane\nrex resume-pane\n",
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("uninstall without an installed hook creates no directories, config files or locks", async () => {
  const home = await mkdtemp(join(tmpdir(), "vimex-no-hook-"))
  try {
    await configureRexShellHook({
      home,
      shell: "zsh",
      zdotdir: join(home, "absent"),
      command: ["vimex"],
      remove: true,
    })
    await configureRexShellHook({
      home,
      shell: "bash",
      command: ["vimex"],
      remove: true,
    })
    expect(await readdir(home)).toEqual([])
    await writeFile(join(home, ".zshrc"), "# user configuration\n")
    await configureRexShellHook({
      home,
      shell: "zsh",
      zdotdir: home,
      command: ["vimex"],
      remove: true,
    })
    expect(await readdir(home)).toEqual([".zshrc"])
    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe(
      "# user configuration\n",
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("noninteractive shells and interactive nonterminals do not invoke restoration", async () => {
  const hook = createRexShellHook("bash", ["/bin/sh", "-c", "exit 91"])
  for (const flags of [["-c"], ["--noprofile", "--norc", "-i", "-c"]]) {
    const child = Bun.spawn(["bash", ...flags, hook], {
      env: {
        ...process.env,
        REX_SERVER: "server",
        REX_SESSION: "s",
        REX_BLOCK: "b",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
  }
})
