export type PublicationState = "missing" | "draft" | "published"
export type PublicationAction = "create" | "resume" | "reuse"

export function publicationAction(state: PublicationState): PublicationAction {
  if (state === "missing") return "create"
  if (state === "draft") return "resume"
  if (state === "published") return "reuse"
  throw new Error(`Unknown publication state: ${state}`)
}

export type FormulaAction = "deploy" | "skip-prerelease" | "skip-superseded"

export function formulaAction(
  tag: string,
  latestStableTag: string,
): FormulaAction {
  if (tag.includes("-")) return "skip-prerelease"
  return tag === latestStableTag ? "deploy" : "skip-superseded"
}

if (import.meta.main) {
  const [command, ...arguments_] = process.argv.slice(2)
  if (command === "publication" && arguments_.length === 1) {
    console.log(publicationAction(arguments_[0] as PublicationState))
  } else if (command === "formula" && arguments_.length === 2) {
    console.log(formulaAction(arguments_[0]!, arguments_[1]!))
  } else {
    throw new Error(
      "Usage: policy.ts publication STATE | formula TAG LATEST_STABLE_TAG",
    )
  }
}
