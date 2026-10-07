export interface VimexTheme {
  name: string
  background: string
  backgroundRaised: string
  backgroundPanel: string
  backgroundHover: string
  border: string
  borderMuted: string
  /** Foreground on colored badges, independent of canvas transparency. */
  textInverse?: string
  /** Solid dialog surface and valid alpha backdrop for transparent canvases. */
  overlayBackground?: string
  overlayBackdrop?: string
  text: string
  textSoft: string
  textMuted: string
  blue: string
  blueBright: string
  sage: string
  amber: string
  ember: string
  red: string
  selection: string
  selectionText: string
  diffAdded: string
  diffAddedBright: string
  diffRemoved: string
  diffRemovedBright: string
  diffContext: string
  syntax?: {
    keyword: string
    keywordBold: boolean
    number: string
    function: string
    type: string
    constant: string
    property: string
    heading: string
    operator: string
    variable?: string
    special?: string
    module?: string
    headings?: readonly [string, string, string, string, string, string]
  }
}
