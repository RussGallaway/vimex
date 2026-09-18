# Markdown and themes

Vimex uses native OpenTUI Markdown with top-level block reconciliation and grid tables. Exact source text remains in the transcript domain for navigation and copying; syntax styling is presentation-only.

## Reference review

Reviewed OpenCode commit `5a8335857b0ebec44ef6aa1d52b339cf25c329ca`: [session rendering](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/tui/src/routes/session/index.tsx), [syntax styles](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/tui/src/theme/index.ts), and [parser registration](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/tui/src/parsers-config.ts). Vimex retains completed-versus-streaming status rather than copying an always-streaming configuration.

Expanded native scopes cover headings, emphasis, links, quotes, lists, inline code, functions, properties, types, constants, and punctuation. The pinned native style API has no strikethrough attribute; deleted text uses a muted foreground. Inline and fenced raw scopes share native behavior, so styles avoid a background that would tint entire code blocks.

Python, Bash, and JSON use pinned local grammar assets and matching tagged queries, with licenses and hashes in [parser provenance](../../../packages/ui-opentui-react/assets/parsers/PROVENANCE.md). They complement OpenTUI's bundled grammars without first-use network downloads. Unsupported languages remain readable plain text; JSONC is not falsely treated as supported JSON.

## Nord

Nord follows [the official palette roles](https://www.nordtheme.com/docs/colors-and-palettes/): Polar Night surfaces, Snow Storm text, Frost functions and types, and Aurora literals. Keywords are restrained rather than bold. Dedicated cool diff backgrounds replace inherited Ember Tide colors. Muted text is brightened for panel readability; these tints are deliberate adaptations rather than a strict sixteen-color restriction. Select with `:theme nord` or `/theme nord`; the default remains unchanged.

A native captured-span regression also covers live theme changes: OpenTUI 0.5.11 can retain old inline/list backgrounds when styles change. Markdown presentation refreshes on palette/style changes while ordinary streaming keeps its existing renderable.

## Verification

Native span tests verify actual colors and emphasis at 80 and 40 columns alongside exact source copying and measured cursor geometry. Isolated Tree-sitter worker tests load local Python, Bash, and JSON assets and check token captures. Nord contrast tests cover text, panels, selections, and diffs, including reduced-color mode.

Run `VIMEX_TEST_THEME=nord /tmp/vimex-live-venv/bin/python tests/terminal/visual-driver.py` for the optional offline terminal driver. Its reconstructed PTY screenshots are written to `/tmp/vimex-visual-e2e-nord`; these are not native OS screenshots.
