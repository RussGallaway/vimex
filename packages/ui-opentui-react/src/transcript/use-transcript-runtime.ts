import { createConversation, threadId } from "@vimex/conversation"
import { createTranscriptFrame, initialTranscript, type TranscriptFrame, type TranscriptRuntimeInput } from "@vimex/transcript"
import type { TranscriptPresentationHost, TranscriptPresentationId } from "@vimex/workbench"
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react"

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
const suspendedSubscription = (_listener: () => void): (() => void) => () => {}

/** React owns subscription cleanup only; production runtime lifetime stays in Workbench. */
export function useTranscriptRuntime(
  host: TranscriptPresentationHost,
  presentationId: TranscriptPresentationId,
  input: TranscriptRuntimeInput | undefined,
  visible = true,
): TranscriptFrame {
  const owned = host.transcriptRuntime(presentationId)
  const fallbackFrame = useMemo(() => owned ? undefined : createTranscriptFrame(input ?? emptyRuntimeInput), [input, owned])
  const fallbackStore = useMemo(() => fallbackFrame && ({
    subscribe: (_listener: () => void) => () => {},
    getSnapshot: () => fallbackFrame,
  }), [fallbackFrame])
  const store = owned ?? fallbackStore!
  const retained = useRef<{ store: typeof store; frame: TranscriptFrame } | undefined>(undefined)
  if (!retained.current || retained.current.store !== store || visible) {
    retained.current = { store, frame: store.getSnapshot() }
  }
  const getSnapshot = useCallback(() => {
    if (!visible) return retained.current!.frame
    const frame = store.getSnapshot()
    retained.current = { store, frame }
    return frame
  }, [store, visible])
  return useSyncExternalStore(visible ? store.subscribe : suspendedSubscription, getSnapshot, getSnapshot)
}
