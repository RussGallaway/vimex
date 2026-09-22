export interface VimexTheme {
  name: string
  background: string
  backgroundRaised: string
  backgroundPanel: string
  backgroundHover: string
  border: string
  borderMuted: string
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
  }
}
