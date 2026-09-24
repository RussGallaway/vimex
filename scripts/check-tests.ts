// Keep the full test inventory while isolating native renderer state and large
// transcript fixtures in separate Bun processes on the release matrix.
const tests = [
  ...new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}").scanSync({
    cwd: import.meta.dir + "/..",
    onlyFiles: true,
  }),
]
  .filter(
    (file) => !file.startsWith("node_modules/") && !file.startsWith("dist/"),
  )
  .sort()

const groups = [
  [
    "core",
    tests.filter(
      (file) =>
        !file.startsWith("packages/transcript/") &&
        !file.startsWith("packages/ui-opentui-react/"),
    ),
  ],
  [
    "transcript",
    tests.filter((file) => file.startsWith("packages/transcript/")),
  ],
  ["ui", tests.filter((file) => file.startsWith("packages/ui-opentui-react/"))],
] as const

for (const [name, files] of groups) {
  if (!files.length) throw new Error(`No ${name} tests found`)
  console.log(`Running ${files.length} ${name} test files`)
  const child = Bun.spawn([process.execPath, "test", ...files], {
    cwd: import.meta.dir + "/..",
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await child.exited
  if (code !== 0) process.exit(code)
}
