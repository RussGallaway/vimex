---
name: vimex-release
description: Prepare, publish, or troubleshoot a Vimex version release using the repository's tag-driven GitHub Actions workflow and monorepo Homebrew formula. Use for release requests, not ordinary feature development.
---

# Vimex release

Coordinate releases for `RussGallaway/vimex`. Keep release policy and implementation in their existing sources; do not duplicate them in this skill.

## Sources of truth

Read these files before preparing or publishing a release. Links are relative to this skill; shell commands run from the repository root.

- [Release procedure and version policy](../../../docs/releasing.md): release gates, SemVer, publication, and recovery.
- [Homebrew distribution](../../../docs/homebrew.md): explicit-URL monorepo tap, formula ownership, and upgrades.
- [Release workflow](../../../.github/workflows/release.yml): actual tag trigger, build matrix, checks, publication, and formula update.

Inspect the root `package.json` and relevant `scripts/release/` implementations for the current version and commands. If docs and automation disagree, report the discrepancy before proceeding with publication.

## Prepare

Treat “prepare a release” as local preparation. It does not authorize pushing commits or tags, creating a GitHub release, or publishing packages. An explicit request to publish authorizes that release; do not repeatedly ask for the same authorization.

Inspect the branch, worktree, remote, existing release tags, and changes since the preceding release. Work on main unless the user directs otherwise. Preserve unrelated changes and never include them in a release commit implicitly.

Use the requested version, or propose a SemVer version based on the changes and documented policy. Update the root version and any metadata required by the current packaging scripts. Summarize release notes, including breaking changes and compatibility limits. Regenerate the manual only if its source changed.

Run the documented release gates and relevant packaging checks. Distinguish local native checks from remote matrix results and fixture tests from a real installation or upgrade. Do not invent successful validation for platforms or published assets that do not yet exist.

Finish preparation with the proposed version, included changes, check results, outstanding gates, and the intended release commit. Commit only the scoped release changes when authorized. Do not create a release tag until its exact commit is settled.

## Publish and verify

When publication is authorized and the release gates are satisfied, follow the release procedure. Verify that the intended release commit is present on `origin/main`, then verify that the exact `vVERSION` tag matches the root package version and that commit. Push only the intended branch and tag; do not push all local tags.

The tag triggers publication. Monitor that workflow rather than manually duplicating its release uploads or formula changes. Check that the release contains the expected platform archives, manifest, checksums, installer, and provenance. For stable releases, review the generated formula pull request after its checks pass, merge it through the protected branch, and verify that the formula on main references the published version and hashes. Prereleases must leave the stable formula unchanged.

Report the release URL, workflow result, formula status, and any remaining installation validation. Do not describe publication as complete if the workflow or formula update failed.

## Recovery

Follow the retry and branch-protection procedure in `docs/releasing.md`. Preserve published tags and assets. Never repair a release by force-moving a published tag, replacing published archives, bypassing branch protection, or inventing checksums.

Identify the failing step before retrying. Reuse the published manifest for formula recovery, and avoid regressing a newer stable formula. If a retry fails for the same reason, stop repeating it and report the blocker with a concrete recovery option.
