# Research: movement independent of rich rendering

Research date: 2026-11-05. Three parallel research tracks covered Virtuoso, TanStack Virtual, and editor/terminal implementations; the synthesis also examined browser compositors, Pretext, and the xi retrospective. Sources below are primary project documentation, source code, maintainer discussions, and author essays.

Repository links refer to the upstream branch inspected during research, not a pinned dependency version. They may change. Verify and pin a relevant upstream revision before porting a mechanism. No external library was installed, and source behavior is not evidence of Vimex performance.

## Synthesis

The useful common structure is:

1. Keep layout/navigation data independently of mounted rich content.
2. Move the viewport using cheap, available geometry.
3. Coordinate geometry changes, content extent/spacers, and scroll compensation before presentation.
4. Prepare in the direction of travel and reduce visual fidelity without changing layout.
5. Admit that unknown wrapped geometry still needs computation; an estimate or placeholder is not an exact cursor destination.

For Vimex, this suggests a retained, width-specific row representation and a coherent geometry-commit protocol. It does not imply adopting a browser component, replacing the state library, or splitting the application into processes.

## React Virtuoso

Virtuoso's scroll-seek mode replaces expensive content at high velocity while preserving item height. Separate enter/exit conditions avoid toggling continuously. Its size tree and restoration state exist independently of mounted components. Cold index jumps still use available size information and retry when the list changes; placeholders do not make unknown heights exact.

The particularly relevant mechanism is coordinated compensation. Upstream's upward-scroll correction waits for the renderer to acknowledge the new content extent before applying the corresponding scroll correction, avoiding both clamping against an old extent and exposing an intermediate displaced paint. This is an ordering mechanism, not a recommendation to copy browser-specific timers.

Vimex implication: changing geometry and compensating the anchor should form one coherent presentation operation. Scalar heights alone are insufficient for Vim motions; retain row/source-point maps too.

Sources:

- [Scroll-seek placeholders](https://virtuoso.dev/react-virtuoso/virtuoso/scroll-seek-placeholders/)
- [Scroll-seek state machine](https://github.com/petyosi/react-virtuoso/blob/main/packages/react-virtuoso/src/scrollSeekSystem.ts)
- [Size system](https://github.com/petyosi/react-virtuoso/blob/main/packages/react-virtuoso/src/sizeSystem.ts) and [state restoration](https://github.com/petyosi/react-virtuoso/blob/main/packages/react-virtuoso/src/stateLoadSystem.ts)
- [Upward-scroll compensation](https://github.com/petyosi/react-virtuoso/blob/main/packages/react-virtuoso/src/upwardScrollFixSystem.ts) and [renderer integration](https://github.com/petyosi/react-virtuoso/blob/main/packages/react-virtuoso/src/Virtuoso.tsx)
- [Cold index-jump implementation](https://github.com/petyosi/react-virtuoso/blob/main/packages/react-virtuoso/src/scrollToIndexSystem.ts)
- [Petyo's architecture essay](https://dev.to/petyosi/why-i-wrote-my-own-state-management-for-react-virtuoso-1b54)
- [Message List scroll modifiers](https://virtuoso.dev/message-list/scroll-modifier/): associates a data update with its scroll policy; a useful ownership pattern, not a proposed dependency.

## TanStack Virtual

The React adapter's `directDomUpdates` path separates scroll-only positioning from React range/content updates. The transferable idea is inexpensive native viewport movement, not DOM APIs in OpenTUI.

Maintainer fixes distinguish first estimate-to-measurement corrections from later resizing of known items during backward scrolling. Another diagnosis identifies a correct scroll offset still producing a jump because item transforms and compensation became visible in different paints. Current core also separates held visual compensation from layout positions. These mechanisms make correction ownership explicit.

Vimex implication: label first measurements and remeasurements separately; resolve ordered motions against defined geometry revisions; commit placement and compensation coherently. A temporarily displayed offset is presentation state, not another canonical semantic cursor.

Sources:

- [React adapter API](https://tanstack.com/virtual/latest/docs/framework/react/react-virtual)
- [Virtualizer API](https://tanstack.com/virtual/latest/docs/api/virtualizer)
- [First-measurement/backward-scroll repair, PR 1199](https://github.com/TanStack/virtual/pull/1199)
- [Compensation and presentation ordering, issue 1227](https://github.com/TanStack/virtual/issues/1227)
- [Current core implementation](https://github.com/TanStack/virtual/blob/main/packages/virtual-core/src/index.ts)
- [Tanner Linsley's performance essay](https://old.tanstack.com/blog/tanstack-virtual-perf-and-ios): allocation, cache invalidation, and platform correction costs; its workload results are not Vimex evidence.

## CodeMirror

CodeMirror retains whole-document height information separately from viewport DOM. Unrendered content can still have estimated heights rather than exact coordinates. Its measurement loop captures an anchor and compensates around geometry updates; viewport margins follow travel direction, and separate small viewports protect selection endpoints. It also limits rendering work within very long lines.

Vimex implication: preserve compact geometry after native-node eviction, prepare ahead of travel, and bound work inside oversized blocks. Most importantly, background measurement must not redefine an in-flight row motion without coordinated anchor compensation.

Sources:

- [Viewport system guide](https://codemirror.net/docs/guide/#viewport)
- [Maintainer discussion of first-scroll height changes](https://discuss.codemirror.net/t/cannot-initially-scroll-all-the-way-down-in-a-large-document/4784)
- [Measurement and anchoring loop](https://github.com/codemirror/view/blob/main/src/editorview.ts)
- [Viewport and selection preparation](https://github.com/codemirror/view/blob/main/src/viewstate.ts)

## xterm.js

xterm.js stores terminal cell rows and a display offset independently of drawing. Scrolling changes `ydisp` and emits a scroll event; rendering is scheduled separately. It does not mount content to discover the next screen row because the row buffer already resolves that geometry.

Vimex implication: a viewport over prepared row/cell fragments is a stronger model for dependable movement than a viewport over unmeasured rich components. The crucial limitation is that Markdown, tables, and diffs must first produce equivalent width-specific rows and source mappings. Resizing, folding, and content changes invalidate those results.

Sources:

- [Buffer representation](https://github.com/xtermjs/xterm.js/blob/master/src/common/buffer/Buffer.ts)
- [Buffer scrolling](https://github.com/xtermjs/xterm.js/blob/master/src/common/services/BufferService.ts)
- [Render scheduling](https://github.com/xtermjs/xterm.js/blob/master/src/browser/services/RenderService.ts)

## Pretext

Pretext separates expensive text preparation, width-dependent line layout, and materializing visible lines. Its Markdown chat demonstration keeps geometry outside the DOM and paints from model values. It also documents startup/memory costs and unsupported interactions; preparing all history is not free.

TanStack's integration guide restricts its sizing approach to content whose height follows from known text, style, and width. Mixed block layout needs another sizing path, and measurement and painting inputs must agree.

Vimex implication: investigate a terminal-native equivalent using the same wrapping/cell-width rules as presentation, starting with completed text/code. Do not import browser canvas metrics or duplicate a subtly different wrapping engine. A retained row map should be derivable before rich-node construction.

Sources:

- [Library and caveats](https://github.com/chenglou/pretext)
- [Markdown chat engineering notes](https://github.com/chenglou/pretext/blob/main/pages/demos/markdown-chat.md)
- [TanStack Pretext guidance](https://tanstack.com/virtual/latest/docs/pretext)

## Browser compositor architecture

Firefox APZ and Chromium's compositor architecture move already prepared content while expensive main-thread work continues. Firefox prepares a surrounding display region using direction/velocity and reconciles scrolling with newly rendered content through explicit generations. Movement can outrun prepared content, exposing missing regions; this architecture does not guarantee unlimited cold coverage.

Vimex implication: retain a cheap visible representation and prepare ahead. Separate computation from presentation where practical, but verify that input and output can still progress when native layout is expensive. An asynchronous function or separate store on the same blocked event loop is insufficient.

Sources:

- [Firefox asynchronous panning and zooming](https://firefox-source-docs.mozilla.org/gfx/AsyncPanZoom.html)
- [Chromium compositor architecture](https://www.chromium.org/developers/design-documents/compositor-thread-architecture/)
- [RenderingNG architecture](https://developer.chrome.com/docs/chromium/renderingng-architecture)

## Cautions from editor engineering

Raph Levien's xi retrospective describes wrapping races and tearing introduced by asynchronous frontend/core separation. Scrolling across the frontend cache boundary became much more complex than querying in-process text. It argues for careful ownership and interfaces before additional process boundaries.

VS Code's text-buffer retrospective describes how integrated workloads changed the apparent optimization priorities: view rendering, tokenization, allocation, and actual API usage mattered. It supports investigating a real cold transition before assuming a particular data structure is the bottleneck.

Sources:

- [xi-editor retrospective](https://raphlinus.github.io/xi/2020/06/27/xi-retrospective.html)
- [VS Code text-buffer reimplementation](https://code.visualstudio.com/blogs/2018/03/23/text-buffer-reimplementation)

## Decisions informed by this research

- Prefer coordinated geometry commits and a prepared-row prototype over further tuning of the failed offscreen budget.
- Preserve ordered Vim input; obsolete rendering/preparation may be discarded, actual motion semantics may not.
- Keep one semantic cursor/anchor authority and a revisioned presentation view.
- Treat rich-content substitution as safe only when it preserves row geometry and source mapping.
- Begin with shared terminal layout primitives and a small supported content subset. Expand only after native parity.
- Do not promise exact movement through completely unknown geometry. Make its preparation cheap, bounded, and anticipatory, and define the cold-gap behavior explicitly.

The [implementation plan](plan.md) records how to test these inferences. None is accepted as a performance improvement merely because an upstream project uses a related technique.
