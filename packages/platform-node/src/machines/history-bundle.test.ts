import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureHistoryBundle, stageHistoryBundle } from "./history-bundle"
const record = (type: string, payload: unknown) =>
  JSON.stringify({ type, payload }) + "\n"
const rollout = (id: string, base?: unknown) =>
  record("session_meta", {
    id,
    history_mode: "paginated",
    ...(base ? { history_base: base } : {}),
  }) +
  record("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "preserve exact context" }],
  })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vimex-history-bundle-"))
  const source = { cwd: root }
  const parent = rollout("parent")
  const child = rollout("child", {
    thread_id: "parent",
    end_ordinal_exclusive: 2,
    end_byte_offset: Buffer.byteLength(parent),
  })
  await writeFile(join(root, "parent"), parent)
  await writeFile(join(root, "child"), child)
  const capture = () =>
    captureHistoryBundle(source, "child", async (id) => join(root, id))
  return {
    root,
    source,
    parent,
    child,
    capture,
    close: () => rm(root, { recursive: true, force: true }),
  }
}
test("bounded ancestry import preserves native bytes, order, and retained dependencies", async () => {
  const f = await fixture()
  try {
    const b = await f.capture()
    expect(b.files.map((f) => f.id)).toEqual(["parent", "child"])
    const staged = await stageHistoryBundle(
      b,
      f.source,
      join(f.root, "home"),
      async () => undefined,
    )
    expect(await readFile(staged.paths.get("child")!, "utf8")).toBe(f.child)
    await staged.verify()
    await b.verifySourceUnchanged()
    await writeFile(
      join(f.root, "parent"),
      f.parent + record("event_msg", { type: "changed" }),
    )
    await expect(b.verifySourceUnchanged()).rejects.toThrow("changed")
    await staged.cleanup()
    await expect(readFile(staged.paths.get("child")!)).rejects.toThrow()
  } finally {
    await f.close()
  }
})
test("matching longer ancestor prefixes reuse IDs, divergent collisions never overwrite", async () => {
  const f = await fixture()
  try {
    const b = await f.capture()
    const existing = join(f.root, "existing")
    await writeFile(existing, f.parent + record("event_msg", { type: "later" }))
    const staged = await stageHistoryBundle(
      b,
      f.source,
      join(f.root, "home"),
      async (id) => (id === "parent" ? existing : undefined),
    )
    expect(staged.paths.get("parent")).toBe(existing)
    await staged.cleanup()
    expect(await readFile(existing, "utf8")).toContain('"later"')
    await writeFile(existing, rollout("different"))
    await expect(
      stageHistoryBundle(b, f.source, join(f.root, "other-home"), async (id) =>
        id === "parent" ? existing : undefined,
      ),
    ).rejects.toThrow("different history")
    expect(await readFile(existing, "utf8")).toBe(rollout("different"))
  } finally {
    await f.close()
  }
})
test("bad cutoffs, cycles and unavailable child dependencies fail before import", async () => {
  const f = await fixture()
  try {
    await writeFile(
      join(f.root, "child"),
      rollout("child", {
        thread_id: "parent",
        end_ordinal_exclusive: 2,
        end_byte_offset: 4,
      }),
    )
    await expect(f.capture()).rejects.toThrow("cutoff")
    await writeFile(
      join(f.root, "child"),
      rollout("child", {
        thread_id: "child",
        end_ordinal_exclusive: 2,
        end_byte_offset: 4,
      }),
    )
    await expect(f.capture()).rejects.toThrow("cycle")
    await writeFile(
      join(f.root, "child"),
      rollout("child") +
        record("response_item", { type: "function_call", name: "spawn_agent" }),
    )
    await expect(f.capture()).rejects.toThrow("subagent history")
  } finally {
    await f.close()
  }
})
test("exclusive staging refuses collisions and rollback retains changed imports", async () => {
  const f = await fixture()
  try {
    const b = await f.capture()
    const home = join(f.root, "home")
    const staged = await stageHistoryBundle(
      b,
      f.source,
      home,
      async () => undefined,
    )
    await expect(
      stageHistoryBundle(b, f.source, home, async () => undefined),
    ).rejects.toThrow()
    const child = staged.paths.get("child")!
    await writeFile(child, f.child + record("event_msg", { type: "new" }))
    await expect(staged.cleanup()).rejects.toThrow("retained")
    expect(await readFile(child, "utf8")).toContain('"new"')
  } finally {
    await f.close()
  }
})

test("repeated ancestor references validate every cutoff instead of trusting the first", async () => {
  const f = await fixture()
  try {
    await writeFile(
      join(f.root, "child"),
      f.child +
        record("session_meta", {
          id: "child",
          history_mode: "paginated",
          history_base: {
            thread_id: "parent",
            end_ordinal_exclusive: 999,
            end_byte_offset: Buffer.byteLength(f.parent),
          },
        }),
    )
    await expect(f.capture()).rejects.toThrow("repeated cutoff")
  } finally {
    await f.close()
  }
})

test("nested fork cutoffs use logical inherited ordinals and preserve all ancestor bytes", async () => {
  const f = await fixture()
  try {
    const grandchild = rollout("grandchild", {
      thread_id: "child",
      end_ordinal_exclusive: 4,
      end_byte_offset: Buffer.byteLength(f.child),
    })
    await writeFile(join(f.root, "grandchild"), grandchild)
    const bundle = await captureHistoryBundle(
      f.source,
      "grandchild",
      async (id) => join(f.root, id),
    )
    expect(bundle.files.map((file) => file.id)).toEqual([
      "parent",
      "child",
      "grandchild",
    ])
    expect(bundle.files[1]!.requiredOrdinal).toBe(4)
  } finally {
    await f.close()
  }
})
