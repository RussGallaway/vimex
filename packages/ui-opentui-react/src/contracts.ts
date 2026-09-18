import type { ThemeName } from "@vimex/interaction"
import type { WorkbenchState, WorkbenchActions } from "@vimex/workbench"
export type { WorkbenchActions as VimexUiController, TranscriptAction as TranscriptUiCommand } from "@vimex/workbench"
type VimexUiController = WorkbenchActions

export interface VimexAppProps {
  state: WorkbenchState
  controller: VimexUiController
  settings?: Partial<VimexUiSettings>
}

export interface VimexUiSettings {
  theme: ThemeName
  syntaxTheme: "theme" | ThemeName
  reducedColor: boolean
  insertEnter: "newline" | "submit"
  busySubmit: "queue" | "steer"
  foldTools: boolean
  foldReasoning: boolean
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
  foldReasoning: false,
  composerMaxHeight: 0.32,
  keybindings: {},
}

export const inertController: VimexUiController = {
  dispatchInteraction() {},
  changeDraft() {},
  submit() {},
  transcript() {},
  answerQuestions() {},
  openChildThread() {},
  returnToParent() {},
  cycleAgent() {},
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
