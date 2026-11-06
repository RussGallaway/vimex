/** Public windowing API. Implementations depend on leaf modules, never this facade. */
export type {
  Immutable,
  TranscriptBlockItem,
  TranscriptBlockProjection,
  TranscriptItemFragment,
  TranscriptItemBlock,
  TranscriptTurnActivityBlock,
  TranscriptBlock,
  TranscriptActivityFamily,
  TranscriptActivityBatch,
  TranscriptBlockPresentation,
  TranscriptActivityPresentation,
  TranscriptBlockPlanDiagnostics,
  TranscriptWindow,
  TranscriptWindowAttachment,
  TranscriptWindowDiagnostics,
  PlanTranscriptWindowInput,
  BuildTranscriptBlocksInput,
} from "./window/types"
export {
  persistentTranscriptBlockPlan,
  replaceTranscriptBlock,
  appendTranscriptBlock,
  replaceTranscriptTailItem,
  isTranscriptTailItemReplacement,
  spliceTranscriptItemBlocks,
  isTranscriptBlockSplice,
  isTranscriptBlockReplacement,
  isTranscriptBlockAppend,
} from "./window/block-plan"
export {
  hasTurnActivity,
  buildTranscriptTurnActivityBlock,
  buildTranscriptItemBlocks,
  buildTranscriptItemBlock,
  buildTranscriptBlocks,
} from "./window/blocks"
export {
  transcriptActivityPresentation,
  passThroughWindow,
  passThroughWindowWithActivityPlan,
} from "./window/activity"
export {
  transcriptPointBlockIndex,
  blockKey,
  blockGraphemeRange,
  pointIsMaterialized,
} from "./window/addressing"
export { planTranscriptWindow } from "./window/planner"
