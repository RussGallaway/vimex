export default {
  extends: ["@commitlint/config-conventional"],
  // PR titles become squash commits; merge/revert/version exemptions do not apply.
  defaultIgnores: process.env.COMMITLINT_PR_TITLE !== "1",
}
