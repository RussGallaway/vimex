import type { ThemeName } from "@vimex/interaction"
import type {
  WorkbenchState,
  WorkbenchActions,
  TranscriptPresentationHost,
  TranscriptPresentationId,
} from "@vimex/workbench"
export type { TranscriptAction as TranscriptUiCommand } from "@vimex/workbench"
export type VimexUiController = WorkbenchActions & TranscriptPresentationHost

export interface VimexAppProps {
  state: WorkbenchState
  controller: VimexUiController
  settings?: Partial<VimexUiSettings>
  interactive?: boolean
  /** Whether this mounted pane is physically presented. Hidden panes keep state but own no animation timers. */
  presentationVisible?: boolean
  paneLabel?: "MAIN" | "SIDE"
  presentationId?: TranscriptPresentationId
}

export interface VimexUiSettings {
  theme: ThemeName
  syntaxTheme: "theme" | ThemeName
  reducedColor: boolean
  insertEnter: "newline" | "submit"
  busySubmit: "queue" | "steer"
  foldTools: boolean
  composerMaxHeight: number
  keybindings: Readonly<Record<string, string>>
}

export const defaultVimexUiSettings: VimexUiSettings = {
  theme: "ember-tide",
  syntaxTheme: "theme",
  reducedColor: false,
  insertEnter: "submit",
  busySubmit: "queue",
  foldTools: true,
  composerMaxHeight: 0.32,
  keybindings: {},
}

export const inertController: VimexUiController = {
  transcriptRuntime() {
    return undefined
  },
  dispatchInteraction() {},
  changeDraft() {},
  attachImageFromClipboard() {},
  attachImageFromPath() {},
  removeImage() {},
  submit() {
    return true
  },
  transcript() {},
  answerQuestions() {},
  openChildThread() {},
  returnToParent() {},
  cycleAgent() {},
  sideChat() {},
  anchorThread() {},
  requestFork() {},
  confirmFork() {},
  cancelFork() {},
  restart() {},
  openThread() {},
  renameThread() {},
  toggleFavorite() {},
  resolveApproval() {},
  executeCommand() {},
  executeNamedCommand() {},
  interrupt() {},
  retryOutgoing() {},
  copyText() {},
}
