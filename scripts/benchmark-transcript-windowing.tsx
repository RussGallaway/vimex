// Diagnostic Stage 5 scaling benchmark; timings are curves, never CI gates.
//
// Native baselines intentionally require an explicit size selection because
// the inherited pass-through renderer mounts every block. Run one isolated
// cell at a time, for example:
//   VIMEX_WINDOWING_NATIVE_BASELINE=1 VIMEX_WINDOWING_GEOMETRY_BASELINE=1 \
//   VIMEX_WINDOWING_SIZES=100 VIMEX_WINDOWING_VIEWPORTS=80x24 \
//   bun scripts/benchmark-transcript-windowing.tsx
import assert from "node:assert/strict"
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import {
  appendTranscriptScalingTail,
  buildOversizedTranscriptFixtures,
  buildTranscriptScalingFixture,
  transcriptScalingBlockCounts,
  type TranscriptFixtureSnapshot,
} from "@vimex/testkit"
import {
  blockKey,
  createTranscriptFrame,
  passThroughWindow,
  TranscriptRuntime,
  type BlockGeometry,
  type TranscriptFrame,
  type TranscriptRuntimeInput,
} from "@vimex/transcript"
import { act, createRef, Profiler, useSyncExternalStore, type RefObject } from "react"
import { createEmberTideSyntax } from "../packages/ui-opentui-react/src/theme"
import { blockNativeRevision } from "../packages/ui-opentui-react/src/transcript/measure-rendered-block"
import { measureRenderedTranscript, transcriptBlockRenderableId } from "../packages/ui-opentui-react/src/transcript/rendered-layout"
import { TranscriptViewport } from "../packages/ui-opentui-react/src/transcript/TranscriptViewport"

interface TimingStats {
  readonly count: number
  readonly min: number
  readonly median: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

const primaryViewport = Object.freeze({ width: 100, height: 30 })
const defaultNativeViewports = Object.freeze([
  Object.freeze({ width: 48, height: 18 }),
  Object.freeze({ width: 80, height: 24 }),
  Object.freeze({ width: 140, height: 40 }),
])
const styleRevision = "stage-5.0-baseline"

function stats(values: readonly number[]): TimingStats {
  assert(values.length > 0)
  const sorted = [...values].sort((left, right) => left - right)
  const rounded = (value: number) => Number(value.toFixed(6))
  return Object.freeze({
    count: values.length,
    min: rounded(sorted[0]!),
    median: rounded(sorted[Math.floor(sorted.length / 2)]!),
    p95: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]!),
    max: rounded(sorted.at(-1)!),
    mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
  })
}

function printResult(result: object): void {
  console.log(JSON.stringify({ benchmark: "transcript-windowing", fixtureVersion: "transcript-scaling-v1", ...result }))
}

function runtimeInput(
  fixture: ReturnType<typeof buildTranscriptScalingFixture>,
  snapshot: TranscriptFixtureSnapshot,
  mode: "follow" | "detached",
  options: Pick<TranscriptRuntimeInput, "canonicalDamage" | "presentationDamage" | "reveal"> = {},
): TranscriptRuntimeInput {
  return {
    threadId: fixture.threadId,
    canonicalGeneration: 0,
    canonicalRevision: snapshot.canonicalRevision,
    conversation: snapshot.conversation,
    transcript: snapshot.transcript,
    mode,
    canonicalDamage: options.canonicalDamage ?? { kind: "none" },
    presentationDamage: options.presentationDamage,
    reveal: options.reveal,
  }
}

const sharedPoint = Object.freeze({ 0: Object.freeze({ graphemeOffset: 0, x: 0, y: 0, row: 0, column: 0 }) })
const sharedOffsets = Object.freeze({ 0: Object.freeze([0]) })
const sharedLine = Object.freeze({ from: 0, to: 0, row: 0 })
const sharedLines = Object.freeze([sharedLine])
const sharedLineByRow = Object.freeze({ 0: sharedLine })

function syntheticGeometry(frame: TranscriptFrame, nativeRevision = 1): readonly BlockGeometry[] {
  return frame.window.blocks.map(block => Object.freeze({
    key: Object.freeze({
      blockKey: blockKey(block),
      contentRevision: block.contentRevision,
      width: primaryViewport.width,
      styleRevision,
      folded: block.key.kind === "item" && Boolean(frame.transcript.folded[block.key.itemId]),
    }),
    nativeRevision,
    rows: 1,
    pointCount: 1,
    points: sharedPoint,
    pointOffsetsByRow: sharedOffsets,
    lines: sharedLines,
    lineByRow: sharedLineByRow,
  }))
}

function forceGc(): void {
  Bun.gc(true)
}

function timed<T>(operation: () => T): Readonly<{ value: T; milliseconds: number }> {
  const started = performance.now()
  const value = operation()
  return Object.freeze({ value, milliseconds: performance.now() - started })
}

function runtimeBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>): void {
  forceGc()
  const constructed = timed(() => new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } })))
  const runtime = constructed.value
  try {
    const cold = runtime.getSnapshot()
    assert.equal(cold.blocks.length, fixture.blockCount)
    assert.equal(cold.window.blocks, cold.blocks)
    const planned = timed(() => passThroughWindow(cold.blocks))
    assert.equal(planned.value.blocks, cold.blocks)

    const measurements = syntheticGeometry(cold)
    const geometryPublication = timed(() => runtime.reportMeasurements({ ...runtime.measurementBase(), measurements }))
    assert.equal(geometryPublication.value.geometry.measuredBlockCount, fixture.blockCount)
    const measured = runtime.getSnapshot()
    const historyGeometry = measured.geometry.byBlockKey

    let publications = 0
    const unsubscribe = runtime.subscribe(() => { publications++ })
    const followed = timed(() => runtime.update(runtimeInput(fixture, fixture.afterTailDelta, "follow", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    })))
    assert.equal(publications, 1)
    let changedBlocks = 0, preservedBlockIdentities = 0, preservedGeometryIdentities = 0
    const tailKey = `item:${fixture.tailItemId}:root`
    for (let index = 0; index < fixture.blockCount; index++) {
      const beforeBlock = measured.blocks[index]!, afterBlock = followed.value.blocks[index]!
      if (beforeBlock === afterBlock) preservedBlockIdentities++
      else changedBlocks++
      const key = blockKey(afterBlock)
      if (key !== tailKey && followed.value.geometry.byBlockKey[key] === historyGeometry[key]) preservedGeometryIdentities++
    }
    assert.equal(changedBlocks, 1)
    assert.equal(preservedBlockIdentities, fixture.blockCount - 1)
    assert.equal(preservedGeometryIdentities, fixture.blockCount - 1)
    assert.equal(followed.value.geometry.byBlockKey[tailKey], undefined)

    publications = 0
    const navigatedTranscript = Object.freeze({
      ...fixture.afterTailDelta.transcript,
      cursor: Object.freeze({ itemId: fixture.targets.quarter, graphemeOffset: 0 }),
      viewport: Object.freeze({ kind: "point" as const, point: Object.freeze({ itemId: fixture.targets.quarter, graphemeOffset: 0 }), preferredScreenRow: 7 }),
    })
    const navigatedSnapshot = Object.freeze({ ...fixture.afterTailDelta, transcript: navigatedTranscript })
    const navigation = timed(() => runtime.update(runtimeInput(fixture, navigatedSnapshot, "follow", { presentationDamage: { kind: "view" } })))
    assert.equal(publications, 1)

    runtime.update(runtimeInput(fixture, navigatedSnapshot, "detached"))
    assert.equal(publications, 2, "navigation and detach must each publish once")
    const pinned = runtime.getSnapshot()
    publications = 0
    const hidden = appendTranscriptScalingTail(navigatedSnapshot, fixture.tailItemId, fixture.tailDelta)
    const detached = timed(() => runtime.update(runtimeInput(fixture, hidden, "detached", {
      canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
    })))
    assert.equal(detached.value, pinned)
    assert.equal(publications, 0)

    const hiddenTail = hidden.transcript.projectionById[fixture.tailItemId]!
    const revealPoint = Object.freeze({ itemId: fixture.tailItemId, graphemeOffset: hiddenTail.sourceSpans.length })
    const revealedTranscript = Object.freeze({
      ...hidden.transcript,
      cursor: revealPoint,
      viewport: Object.freeze({ kind: "point" as const, point: revealPoint, preferredScreenRow: 7 }),
    })
    const revealedSnapshot = Object.freeze({ ...hidden, transcript: revealedTranscript })
    const reveal = timed(() => runtime.update(runtimeInput(fixture, revealedSnapshot, "detached", {
      reveal: { id: fixture.blockCount, point: revealPoint, reason: "jump" },
    })))
    assert.equal(publications, 1)
    assert.equal(reveal.value.displayedCanonicalRevision, hidden.canonicalRevision)
    assert.deepEqual(reveal.value.transcript.cursor, revealPoint)
    assert.deepEqual(reveal.value.transcript.viewport, { kind: "point", point: revealPoint, preferredScreenRow: 7 })

    const latest = appendTranscriptScalingTail(revealedSnapshot, fixture.tailItemId, fixture.tailDelta)
    runtime.update(runtimeInput(fixture, latest, "detached", { canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] } }))
    assert.equal(publications, 1, "hidden output after reveal must not publish the pinned presentation")
    publications = 0
    const reattach = timed(() => runtime.update(runtimeInput(fixture, latest, "follow")))
    assert.equal(publications, 1)
    const reference = createTranscriptFrame(runtimeInput(fixture, latest, "follow", { canonicalDamage: { kind: "full" } }))
    assert.deepEqual(reattach.value.transcript, reference.transcript)
    assert.deepEqual(reattach.value.blocks.map(blockKey), reference.blocks.map(blockKey))
    unsubscribe()

    printResult({
      scenario: "scaling-workloads",
      boundary: "runtime",
      blockCount: fixture.blockCount,
      viewport: primaryViewport,
      mode: "follow-and-detached",
      fixture: { contentShape: "mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: {
        completeBlocks: fixture.blockCount,
        mountedBlocks: 0,
        measuredBlocks: 0,
        changedBlocks,
        publications: 5,
        materializedWindowBlocks: cold.window.blocks.length,
        syntheticSeededMeasurements: measurements.length,
        invalidatedMeasurements: 1,
        retainedMeasurementsAfterFollow: followed.value.geometry.measuredBlockCount,
        followPublications: 1,
        navigationPublications: 1,
        detachPublications: 1,
        detachedPublications: 0,
        revealPublications: 1,
        reattachPublications: 1,
      },
      identityCounts: { preservedBlockIdentities, preservedGeometryIdentities },
      timingsMs: {
        coldRuntimeConstruction: Number(constructed.milliseconds.toFixed(6)),
        passThroughPlanning: Number(planned.milliseconds.toFixed(6)),
        geometryPublication: Number(geometryPublication.milliseconds.toFixed(6)),
        followReconciliation: Number(followed.milliseconds.toFixed(6)),
        warmNavigation: Number(navigation.milliseconds.toFixed(6)),
        detachedHiddenDelta: Number(detached.milliseconds.toFixed(6)),
        explicitReveal: Number(reveal.milliseconds.toFixed(6)),
        reattach: Number(reattach.milliseconds.toFixed(6)),
      },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
  }
}

function RuntimePublicationProbeInner(props: { runtime: TranscriptRuntime }) {
  const frame = useSyncExternalStore(props.runtime.subscribe, props.runtime.getSnapshot, props.runtime.getSnapshot)
  return <text>{frame.presentationRevision}</text>
}

function RuntimePublicationProbe(props: { runtime: TranscriptRuntime; commits: number[] }) {
  return <Profiler id="runtime-publication" onRender={(_id, _phase, duration) => props.commits.push(duration)}>
    <RuntimePublicationProbeInner runtime={props.runtime} />
  </Profiler>
}

async function reactPublicationBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>): Promise<void> {
  forceGc()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }))
  const commits: number[] = []
  const setup = await testRender(<RuntimePublicationProbe runtime={runtime} commits={commits} />, primaryViewport)
  try {
    await act(async () => { await setup.flush(); await setup.renderOnce() })
    commits.length = 0
    let runtimeUpdateMs = 0, runtimePublications = 0
    const unsubscribe = runtime.subscribe(() => { runtimePublications++ })
    const started = performance.now()
    await act(async () => {
      const updateStarted = performance.now()
      runtime.update(runtimeInput(fixture, fixture.afterTailDelta, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
      }))
      runtimeUpdateMs = performance.now() - updateStarted
      await setup.flush()
      await setup.renderOnce()
    })
    unsubscribe()
    assert.equal(runtimePublications, 1)
    assert.equal(commits.length, 1)
    printResult({
      scenario: "follow-publication",
      boundary: "react",
      blockCount: fixture.blockCount,
      viewport: primaryViewport,
      mode: "follow",
      fixture: { contentShape: "constant-one-node-subscriber", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: { mountedBlocks: 0, measuredBlocks: 0, changedBlocks: 1, publications: runtimePublications,
        runtimePublications, reactCommits: commits.length },
      timingsMs: { runtimeUpdate: Number(runtimeUpdateMs.toFixed(6)), postUpdateFlushAndFrame: Number((performance.now() - started - runtimeUpdateMs).toFixed(6)), reactCommitDurations: stats(commits) },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
    await act(async () => setup.renderer.destroy())
  }
}

function RuntimeNativeMountProbeInner(props: {
  runtime: TranscriptRuntime
  scrollRef: RefObject<ScrollBoxRenderable | null>
  syntax: ReturnType<typeof createEmberTideSyntax>
}) {
  const frame = useSyncExternalStore(props.runtime.subscribe, props.runtime.getSnapshot, props.runtime.getSnapshot)
  return <TranscriptViewport window={frame.window} state={frame.transcript} surface="transcript"
    syntax={props.syntax} scrollRef={props.scrollRef} />
}

function RuntimeNativeMountProbe(props: {
  runtime: TranscriptRuntime
  commits: number[]
  scrollRef: RefObject<ScrollBoxRenderable | null>
  syntax: ReturnType<typeof createEmberTideSyntax>
}) {
  return <Profiler id="native-mount" onRender={(_id, _phase, duration) => props.commits.push(duration)}>
    <RuntimeNativeMountProbeInner runtime={props.runtime} scrollRef={props.scrollRef} syntax={props.syntax} />
  </Profiler>
}

function mountedBlockRoots(scroll: ScrollBoxRenderable): ReadonlyMap<string, Renderable> {
  const roots = new Map<string, Renderable>()
  const pending = [...scroll.getChildren()]
  while (pending.length) {
    const renderable = pending.pop()!
    if (renderable.id.startsWith("transcript-block:")) {
      assert(!roots.has(renderable.id), `duplicate mounted transcript root ${renderable.id}`)
      roots.set(renderable.id, renderable)
    }
    pending.push(...renderable.getChildren())
  }
  return roots
}

function assertMountedRoots(frame: TranscriptFrame, roots: ReadonlyMap<string, Renderable>): void {
  assert.equal(roots.size, frame.window.blocks.length)
  for (const block of frame.window.blocks) assert(roots.has(transcriptBlockRenderableId(block)), `missing mounted root ${blockKey(block)}`)
}

async function nativeMountBaseline(fixture: ReturnType<typeof buildTranscriptScalingFixture>, viewport: Readonly<{ width: number; height: number }>): Promise<void> {
  forceGc()
  const runtime = new TranscriptRuntime(runtimeInput(fixture, fixture.before, "follow", { canonicalDamage: { kind: "full" } }))
  const frame = runtime.getSnapshot()
  const commits: number[] = []
  const scrollRef = createRef<ScrollBoxRenderable | null>()
  const syntax = createEmberTideSyntax()
  const started = performance.now()
  const setup = await testRender(<RuntimeNativeMountProbe runtime={runtime} commits={commits} scrollRef={scrollRef} syntax={syntax} />, viewport)
  try {
    for (let frameIndex = 0; frameIndex < 4; frameIndex++) {
      await act(async () => { await setup.flush(); await setup.renderOnce(); await Bun.sleep(2) })
    }
    const nativeMountAndLayoutMs = performance.now() - started
    const scroll = scrollRef.current
    assert(scroll, "TranscriptViewport did not mount its scrollbox")
    const rootsBefore = mountedBlockRoots(scroll)
    assertMountedRoots(frame, rootsBefore)
    if (process.env.VIMEX_WINDOWING_GEOMETRY_BASELINE === "1") {
      const revisionsBefore = new Map(frame.window.blocks.map(block => {
        const root = rootsBefore.get(transcriptBlockRenderableId(block))!
        return [blockKey(block), blockNativeRevision(root)] as const
      }))
      let measurementPublications = 0
      const unsubscribeMeasurement = runtime.subscribe(() => { measurementPublications++ })
      let measurement!: ReturnType<typeof timed<ReturnType<typeof measureRenderedTranscript>>>
      await act(async () => {
        measurement = timed(() => measureRenderedTranscript(setup.renderer, scroll, {
          frame: runtime.getSnapshot(), runtime, styleRevision,
        }))
        await setup.flush()
      })
      unsubscribeMeasurement()
      assert.equal(measurement.value, undefined, "the first scheduler pass must publish geometry before returning a layout")
      const measuredFrame = runtime.getSnapshot()
      const measuredBlocks = measuredFrame.window.blocks.filter(block => {
        const root = rootsBefore.get(transcriptBlockRenderableId(block))!
        return blockNativeRevision(root) > (revisionsBefore.get(blockKey(block)) ?? 0)
      }).length
      assert.equal(measuredBlocks, fixture.blockCount)
      assert.equal(measuredFrame.geometry.measuredBlockCount, fixture.blockCount)
      assert.equal(measurementPublications, 1)
      let settledLayout: ReturnType<typeof measureRenderedTranscript>
      await act(async () => {
        settledLayout = measureRenderedTranscript(setup.renderer, scroll, { frame: measuredFrame, runtime, styleRevision })
      })
      assert(settledLayout, "published native geometry must build a layout on the next scheduler pass")
      const blocksWithPoints = Object.values(measuredFrame.geometry.byBlockKey).filter(geometry => (geometry.pointCount ?? Object.keys(geometry.points).length) > 0).length
      printResult({
        scenario: "native-geometry-measurement",
        boundary: "rendered-layout-scheduler",
        blockCount: fixture.blockCount,
        viewport,
        mode: "follow",
        fixture: { contentShape: "rendered-mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
        operationCounts: { mountedBlocks: rootsBefore.size, measuredBlocks, changedBlocks: 0, publications: measurementPublications,
          materializedWindowBlocks: measuredFrame.window.blocks.length, acceptedMeasurements: measuredFrame.geometry.measuredBlockCount,
          blocksWithPoints, zeroPointMeasurements: measuredFrame.geometry.measuredBlockCount - blocksWithPoints,
          measuredPoints: measuredFrame.geometry.totalPoints },
        timingsMs: { measurementSchedulerAndGeometryPublication: Number(measurement.milliseconds.toFixed(6)) },
        samples: { warmup: 0, measured: 1 },
      })
    }
    commits.length = 0
    let runtimePublications = 0, runtimeUpdateMs = 0
    const unsubscribe = runtime.subscribe(() => { runtimePublications++ })
    const settlementStarted = performance.now()
    await act(async () => {
      const updateStarted = performance.now()
      runtime.update(runtimeInput(fixture, fixture.afterTailDelta, "follow", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
      }))
      runtimeUpdateMs = performance.now() - updateStarted
      await setup.flush()
      await setup.renderOnce()
    })
    const endToEndFollowSettlementMs = performance.now() - settlementStarted
    unsubscribe()
    const rootsAfter = mountedBlockRoots(scroll)
    assertMountedRoots(runtime.getSnapshot(), rootsAfter)
    let retainedBlockRoots = 0
    for (const [id, root] of rootsBefore) if (rootsAfter.get(id) === root) retainedBlockRoots++
    assert.equal(retainedBlockRoots, fixture.blockCount)
    assert.equal(runtimePublications, 1)
    assert.equal(commits.length, 1)
    printResult({
      scenario: "native-root-mount-and-follow-reconciliation",
      boundary: "runtime-react-native-root",
      blockCount: fixture.blockCount,
      viewport,
      mode: "follow",
      fixture: { contentShape: "rendered-mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: false },
      operationCounts: { mountedBlocks: rootsBefore.size, measuredBlocks: 0, changedBlocks: 1, publications: runtimePublications,
        completeBlocks: frame.blocks.length, materializedWindowBlocks: frame.window.blocks.length, observedMountedBlockRoots: rootsBefore.size,
        retainedBlockRoots, mountedRootsDuringFollow: rootsAfter.size - retainedBlockRoots, unmountedRootsDuringFollow: rootsBefore.size - retainedBlockRoots,
        runtimePublications, reactCommits: commits.length },
      timingsMs: { testRendererReactSetupAndNativeMount: Number(nativeMountAndLayoutMs.toFixed(6)), runtimeUpdate: Number(runtimeUpdateMs.toFixed(6)),
        postUpdateReactAndNativeFrame: Number((endToEndFollowSettlementMs - runtimeUpdateMs).toFixed(6)), presentationSettlement: Number(endToEndFollowSettlementMs.toFixed(6)),
        reactCommitDurations: stats(commits) },
      samples: { warmup: 0, measured: 1 },
    })

    if (process.env.VIMEX_WINDOWING_GEOMETRY_BASELINE === "1") {
      const beforeFollowMeasurement = new Map(runtime.getSnapshot().window.blocks.map(block => {
        const root = rootsAfter.get(transcriptBlockRenderableId(block))!
        return [blockKey(block), blockNativeRevision(root)] as const
      }))
      let followMeasurementPublications = 0
      const unsubscribeFollowMeasurement = runtime.subscribe(() => { followMeasurementPublications++ })
      let followMeasurement!: ReturnType<typeof timed<ReturnType<typeof measureRenderedTranscript>>>
      await act(async () => {
        followMeasurement = timed(() => measureRenderedTranscript(setup.renderer, scroll, {
          frame: runtime.getSnapshot(), runtime, styleRevision,
        }))
        await setup.flush()
      })
      unsubscribeFollowMeasurement()
      const followMeasuredFrame = runtime.getSnapshot()
      const measuredBlocks = followMeasuredFrame.window.blocks.filter(block => {
        const root = rootsAfter.get(transcriptBlockRenderableId(block))!
        return blockNativeRevision(root) > (beforeFollowMeasurement.get(blockKey(block)) ?? 0)
      }).length
      assert.equal(measuredBlocks, 1)
      assert.equal(followMeasurementPublications, 1)
      let followedLayout: ReturnType<typeof measureRenderedTranscript>
      await act(async () => {
        followedLayout = measureRenderedTranscript(setup.renderer, scroll, { frame: followMeasuredFrame, runtime, styleRevision })
      })
      assert(followedLayout, "changed tail geometry must settle on the next scheduler pass")
      printResult({
        scenario: "follow-tail-native-measurement",
        boundary: "rendered-layout-scheduler",
        blockCount: fixture.blockCount,
        viewport,
        mode: "follow",
        fixture: { contentShape: "rendered-mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
        operationCounts: { mountedBlocks: rootsAfter.size, measuredBlocks, changedBlocks: 1, publications: followMeasurementPublications,
          materializedWindowBlocks: followMeasuredFrame.window.blocks.length, retainedMeasurements: followMeasuredFrame.geometry.measuredBlockCount,
          measuredPoints: followMeasuredFrame.geometry.totalPoints },
        timingsMs: { measurementSchedulerAndGeometryPublication: Number(followMeasurement.milliseconds.toFixed(6)) },
        samples: { warmup: 0, measured: 1 },
      })
    }

    const detachedTranscript = Object.freeze({
      ...fixture.afterTailDelta.transcript,
      viewport: Object.freeze({ kind: "point" as const, point: Object.freeze({ itemId: fixture.targets.middle, graphemeOffset: 0 }), preferredScreenRow: 7 }),
    })
    const detachedSnapshot = Object.freeze({ ...fixture.afterTailDelta, transcript: detachedTranscript })
    await act(async () => {
      runtime.update(runtimeInput(fixture, detachedSnapshot, "detached", { presentationDamage: { kind: "view" } }))
      await setup.flush(); await setup.renderOnce()
    })
    const pinned = runtime.getSnapshot()
    const detachedRootsBefore = mountedBlockRoots(scroll)
    assertMountedRoots(pinned, detachedRootsBefore)
    const hidden = appendTranscriptScalingTail(detachedSnapshot, fixture.tailItemId, fixture.tailDelta)
    let detachedPublications = 0
    const unsubscribeDetached = runtime.subscribe(() => { detachedPublications++ })
    commits.length = 0
    const detachedStarted = performance.now()
    await act(async () => {
      const result = runtime.update(runtimeInput(fixture, hidden, "detached", {
        canonicalDamage: { kind: "blocks", itemIds: [fixture.tailItemId] },
      }))
      assert.equal(result, pinned)
      await setup.flush(); await setup.renderOnce()
    })
    const detachedSettlementMs = performance.now() - detachedStarted
    unsubscribeDetached()
    const detachedRootsAfter = mountedBlockRoots(scroll)
    assertMountedRoots(pinned, detachedRootsAfter)
    let detachedRetainedRoots = 0
    for (const [id, root] of detachedRootsBefore) if (detachedRootsAfter.get(id) === root) detachedRetainedRoots++
    assert.equal(detachedRetainedRoots, detachedRootsBefore.size)
    assert.equal(detachedPublications, 0)
    assert.equal(commits.length, 0)
    printResult({
      scenario: "detached-hidden-delta-presentation",
      boundary: "runtime-react-native-root",
      blockCount: fixture.blockCount,
      viewport,
      mode: "detached",
      fixture: { contentShape: "rendered-mixed-semantic-root-blocks", contentHash: fixture.contentHash, setupExcludedFromTiming: true },
      operationCounts: { mountedBlocks: detachedRootsBefore.size, measuredBlocks: 0, changedBlocks: 0, publications: detachedPublications,
        canonicalChangedBlocks: 1, retainedBlockRoots: detachedRetainedRoots, mountedRootsDuringHiddenDelta: 0,
        unmountedRootsDuringHiddenDelta: 0, runtimePublications: detachedPublications, reactCommits: commits.length },
      timingsMs: { hiddenDeltaPresentationSettlement: Number(detachedSettlementMs.toFixed(6)) },
      samples: { warmup: 0, measured: 1 },
    })
  } finally {
    runtime.dispose()
    syntax.destroy()
    await act(async () => setup.renderer.destroy())
  }
}

const requestedSizes = process.env.VIMEX_WINDOWING_SIZES
  ? process.env.VIMEX_WINDOWING_SIZES.split(",").map(Number)
  : [...transcriptScalingBlockCounts]
const requestedNativeViewports = process.env.VIMEX_WINDOWING_VIEWPORTS
  ? process.env.VIMEX_WINDOWING_VIEWPORTS.split(",").map(value => {
    const [width, height] = value.split("x").map(Number)
    assert(Number.isInteger(width) && width! > 0 && Number.isInteger(height) && height! > 0, `invalid viewport ${value}`)
    return Object.freeze({ width: width!, height: height! })
  })
  : defaultNativeViewports
if (process.env.VIMEX_WINDOWING_NATIVE_BASELINE === "1" && !process.env.VIMEX_WINDOWING_SIZES) {
  throw new Error("Native pass-through baselines require an explicit VIMEX_WINDOWING_SIZES cell selection; see the file header")
}
for (const blockCount of requestedSizes) {
  assert(transcriptScalingBlockCounts.includes(blockCount as typeof transcriptScalingBlockCounts[number]), `unsupported block count ${blockCount}`)
  const fixture = buildTranscriptScalingFixture(blockCount)
  runtimeBaseline(fixture)
  await reactPublicationBaseline(fixture)
  if (process.env.VIMEX_WINDOWING_NATIVE_BASELINE === "1") {
    for (const viewport of requestedNativeViewports) await nativeMountBaseline(fixture, viewport)
  }
}

for (const fixture of buildOversizedTranscriptFixtures()) printResult({
  scenario: "oversized-fixture",
  boundary: "fixture",
  blockCount: 1,
  viewport: primaryViewport,
  mode: "follow-and-detached",
  fixture: { contentShape: fixture.shape, chars: fixture.source.length, stableSegments: fixture.segments.length, rootBlocksBeforeSubBlockPlanning: 1 },
  operationCounts: { fixtureItems: 1, deterministicFixtureSegments: fixture.segments.length },
  samples: { warmup: 0, measured: 1 },
})
