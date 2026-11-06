# Standalone prepared text rows

Date: 2026-11-05. Baseline: `94ccaf5`; branch: `feat/transcript-prepared-navigation`.

## Result and scope

The [prototype adapter](../../../packages/ui-opentui-react/src/transcript/prepared-text-layout.ts) prepares wrapped rows and grapheme-to-cell metadata using OpenTUI 0.5.11 TextBuffer/TextBufferView, without constructing React elements, Yoga nodes, rich renderables, or highlight workers. It disposes native buffers/views before returning immutable JavaScript data. It is not wired into transcript navigation.

The supported test matrix agrees with mounted plain Text and syntax-highlighted, unconcealed Code renderables: row starts, row widths, source lines, source hit-testing, and actual painted cells. Reverse coverage checks require every nonblank native painted cell to be covered; marking difficult points invisible cannot bypass that check.

This establishes that native text geometry can be prepared separately from rich rendering. It does not establish instant movement, Markdown equivalence, complete navigation semantics, or an acceptable retained-history memory budget.

## Contract

`prepareTextLayout` takes source text, content width, native width method, wrap mode, and optional tab width, first-line offset, content kind, and work limits. It returns either `ready` with rows/points or `unsupported` with a reason.

- Rows retain native visual-row/source-line identities, absolute display-column starts, widths, and half-open canonical grapheme ranges.
- Points retain canonical grapheme offsets, row/column, native cell width, kind, and full-span visibility. Newline and EOF points are insertion boundaries, not painted cells. Consumed word-wrap whitespace is also not a painted source cell. Partial clipping is not a general cheap-viewport contract.
- Text and code are supported only without concealment or other content transforms. Markdown, tables, diffs, folds, and streaming reconciliation need separate contracts.
- Defaults allow 65,536 UTF-16 code units, 16,384 graphemes, and 16,384 visual rows. Callers can configure finite limits; these are not hard global ceilings or wall-clock guarantees. Width/tab/offset inputs also have explicit validation.
- Controls (including ANSI escapes and CRLF), unpaired surrogates, standalone zero-width clusters, transformed content, excessive input/output, or incompatible native source/cluster boundaries return `unsupported`. An eventual integration must use a correct fallback, never discard canonical text.

## Native findings

`logicalLineInfo` describes the whole wrapped block; `lineInfo` can be viewport-sliced. Native starts/widths use display-column offsets including newline units, not UTF-16 or grapheme indices. For example, the second row of `Hello\nWorld` begins at display offset 6. [Pinned native implementation](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/native/src/text-buffer-view.zig#L467), [native tests](https://github.com/anomalyco/opentui/blob/6b9863ea7c5fae22bfebb23c242ddcc4c2b0aa0e/packages/core/src/text-buffer-view.test.ts#L227).

The native glyph encoder is not a universal width oracle for native text wrapping: a family emoji encodes as width 2 but occupies width 8 in TextBuffer's `wcwidth` mode. The prototype therefore bulk-measures canonical graphemes as separate lines in a second unwrapped native text buffer. This avoids a separate JavaScript width approximation and per-grapheme FFI allocation.

It checks those widths against unwrapped logical-line widths from the original source buffer, and rejects wrapped row starts that split a canonical grapheme. Both native views are destroyed before their owning buffers. Only derived JavaScript metadata remains.

## Evidence

Seven focused tests cover boundary conventions, native width modes, tabs, empty input, wrapping, limits, and explicit refusal. The independent mounted matrix has 42 passing tests and 7,422 assertions: plain/code × word/character/no wrapping × seven fixtures, each resized through widths 13, 7, and 21. Fixtures include combining marks, CJK, emoji, tabs, blank lines, trailing newlines, long words, whitespace wrapping, and empty text.

Mounted parity uses the real test renderer's `unicode` width method. `wcwidth` and `unicode-wide` have native-buffer checks, not a claim of separate physical-terminal acceptance. First-line offset has focused native-buffer coverage. Actual-terminal cold navigation remains untested by this prototype.

Validation: all 49 prototype tests passed, followed by the complete `bun run check` gate (formatting, types, package boundaries, generated docs, and default test suite). The local full-check log is `/tmp/vimex-prepared-text-check.log`.

The [cost probe](../../../scripts/benchmark-prepared-text-layout.ts) runs standalone preparation after module import. Reproduce with `bun scripts/benchmark-prepared-text-layout.ts`; optional `VIMEX_PREPARED_TEXT_ROUNDS` accepts 2–30. The [retained result](evidence/2026-11-05-prepared-text.json) includes raw samples, implementation/probe hashes, and qualifications.

On the recorded macOS arm64/Bun 1.3.6 run, subsequent calls took roughly 0.3–0.5 ms for 288 graphemes, 3.2–5.4 ms for 4,679 graphemes, and 8.7–11.4 ms for 13,000 graphemes. These are a handful of diagnostic samples, not latency distributions or a comparison with the existing renderer. The 13,000-grapheme result serializes to about 1.1–1.2 MB; serialization size is an output-size proxy, not measured retained heap. Process memory deltas include GC and allocator retention and cannot prove native lifetime or leaks.

## Before navigation integration

The current transcript measurement path assigns newline offsets to the next visible row and EOF relative to its last observed cell. This prototype uses native insertion boundaries, including trailing empty lines and wide-grapheme widths. Those policies are not interchangeable. Painted-cell parity deliberately excludes these boundaries; cursor/selection parity needs an explicit adapter and independent tests before publishing this data as runtime geometry.

Next, prototype compact row spans and on-demand point lookup, a bounded cache keyed by identity/content/layout inputs, and bounded preparation ahead of travel. Then connect a narrow plain/code viewport experiment to the existing semantic cursor/anchor owner and deliberately delay rich detail. Preserve unsupported-content fallback and the correction-order regressions. A large synchronous native call remains uninterruptible; input/output caps alone do not guarantee a frame budget.
