import { expect, test } from "bun:test"
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostOperation } from "./host"

test("host operations reject an already aborted signal before launching", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled before startup")
  controller.abort(reason)
  await expect(
    hostOperation({}, { action: "resolve", path: "/" }, controller.signal),
  ).rejects.toBe(reason)
})

test("directory cancellation terminates a pending SSH process and clears startup timers", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-host-abort-"))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const executable = join(root, "ssh")
    await writeFile(
      executable,
      '#!/bin/sh\nprintf "%s" "$$" > "$VIMEX_TEST_SSH_PID"\nexec /bin/sleep 60\n',
    )
    await chmod(executable, 0o700)
    const pidFile = join(root, "ssh.pid")
    const code = `
      import { existsSync, readFileSync } from "node:fs";
      import { resolveMachineDirectory } from ${JSON.stringify(import.meta.dir + "/host.ts")};
      const controller = new AbortController();
      const result = resolveMachineDirectory("fixture", "/project", controller.signal).then(
        () => ({ aborted: false }), error => ({ aborted: error.name === "AbortError" })
      );
      const deadline = Date.now() + 2000;
      while (!existsSync(process.env.VIMEX_TEST_SSH_PID)) {
        if (Date.now() > deadline) throw new Error("SSH fixture did not start");
        await Bun.sleep(5);
      }
      const pid = Number(readFileSync(process.env.VIMEX_TEST_SSH_PID, "utf8"));
      controller.abort();
      const outcome = await result;
      let alive = true;
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0) } catch { alive = false; break }
        await Bun.sleep(5);
      }
      console.log(JSON.stringify({ ...outcome, alive }));
    `
    const launched = Bun.spawn([process.execPath, "-e", code], {
      env: {
        ...process.env,
        PATH: root + ":" + process.env.PATH,
        VIMEX_TEST_SSH_PID: pidFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    child = launched
    const finished = await Promise.race([
      launched.exited.then(() => true),
      Bun.sleep(4_000).then(() => false),
    ])
    expect(finished).toBe(true)
    expect(await new Response(launched.stderr).text()).toBe("")
    expect(launched.exitCode).toBe(0)
    expect(JSON.parse(await new Response(launched.stdout).text())).toEqual({
      aborted: true,
      alive: false,
    })
  } finally {
    child?.kill()
    await child?.exited
    await rm(root, { recursive: true, force: true })
  }
})

test("successful host requests clean up their abort listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "vimex-host-success-"))
  try {
    const controller = new AbortController()
    const canonical = await realpath(root)
    expect(
      await hostOperation(
        {},
        { action: "resolve", path: root },
        controller.signal,
      ),
    ).toEqual({ path: canonical })
    controller.abort()
    expect(await hostOperation({}, { action: "resolve", path: root })).toEqual({
      path: canonical,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
