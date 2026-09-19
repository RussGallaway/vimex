import { createConversation, threadId } from "@vimex/conversation"
import { createTranscriptFrame, initialTranscript, type TranscriptFrame, type TranscriptRuntimeInput } from "@vimex/transcript"
import type { TranscriptPresentationHost, TranscriptPresentationId } from "@vimex/workbench"
import { useMemo, useSyncExternalStore } from "react"

const emptyThread = threadId("__vimex_empty_transcript__")
const emptyRuntimeInput: TranscriptRuntimeInput = {
  threadId: emptyThread,
  canonicalGeneration: 0,
  canonicalRevision: 0,
  conversation: createConversation(emptyThread),
  transcript: initialTranscript(),
  mode: "follow",
  canonicalDamage: { kind: "full" },
}

/** React owns subscription cleanup only; production runtime lifetime stays in Workbench. */
export function useTranscriptRuntime(
  host: TranscriptPresentationHost,
  presentationId: TranscriptPresentationId,
  input: TranscriptRuntimeInput | undefined,
): TranscriptFrame {
  const owned = host.transcriptRuntime(presentationId)
  const fallbackFrame = useMemo(() => owned ? undefined : createTranscriptFrame(input ?? emptyRuntimeInput), [input, owned])
  const fallbackStore = useMemo(() => fallbackFrame && ({
    subscribe: (_listener: () => void) => () => {},
    getSnapshot: () => fallbackFrame,
  }), [fallbackFrame])
  const store = owned ?? fallbackStore!
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
