import { SyntaxStyle } from "@opentui/core"

export interface VimexTheme {
  name: string
  background: string; backgroundRaised: string; backgroundPanel: string; backgroundHover: string
  border: string; borderMuted: string; text: string; textSoft: string; textMuted: string
  blue: string; blueBright: string; sage: string; amber: string; ember: string; red: string
  selection: string; selectionText: string; diffAdded: string; diffAddedBright: string
  diffRemoved: string; diffRemovedBright: string; diffContext: string
}

const emberTideBase: VimexTheme = {
  name: "Ember Tide",
  background: "#17191d",
  backgroundRaised: "#1e2227",
  backgroundPanel: "#252a30",
  backgroundHover: "#2c3238",
  border: "#3a4149",
  borderMuted: "#2e343b",
  text: "#e7dfcf",
  textSoft: "#c5bdad",
  textMuted: "#8b908f",
  blue: "#7f9fba",
  blueBright: "#9bb8cf",
  sage: "#91a783",
  amber: "#d2a96a",
  ember: "#c77b62",
  red: "#c87676",
  selection: "#364653",
  selectionText: "#f4ecdc",
  diffAdded: "#21372d",
  diffAddedBright: "#9ebc91",
  diffRemoved: "#3d2929",
  diffRemovedBright: "#d08a82",
  diffContext: "#20252a",
}

export const nord: VimexTheme = {
  ...emberTideBase,
  name: "Nord",
  background: "#2e3440", backgroundRaised: "#343b49", backgroundPanel: "#3b4252", backgroundHover: "#434c5e",
  border: "#4c566a", borderMuted: "#3b4252", text: "#eceff4", textSoft: "#d8dee9", textMuted: "#7f8da6",
  blue: "#81a1c1", blueBright: "#88c0d0", sage: "#a3be8c", amber: "#ebcb8b", ember: "#d08770", red: "#bf616a",
  selection: "#4c566a", selectionText: "#eceff4",
}

export const kanagawa: VimexTheme = {
  ...emberTideBase,
  name: "Kanagawa",
  background: "#1f1f28", backgroundRaised: "#252535", backgroundPanel: "#2a2a37", backgroundHover: "#363646",
  border: "#54546d", borderMuted: "#363646", text: "#dcd7ba", textSoft: "#c8c093", textMuted: "#727169",
  blue: "#7e9cd8", blueBright: "#7fb4ca", sage: "#98bb6c", amber: "#e6c384", ember: "#e46876", red: "#c34043",
  selection: "#2d4f67", selectionText: "#dcd7ba",
}

const themes = { "ember-tide": emberTideBase, nord, kanagawa } as const
let selectedTheme: VimexTheme = emberTideBase
function reduced(palette: VimexTheme): VimexTheme {
  return {
    ...palette,
    blue: palette.textSoft, blueBright: palette.text, sage: palette.textSoft,
    amber: palette.text, ember: palette.textSoft, red: palette.text,
    selection: palette.backgroundHover, selectionText: palette.text,
    diffAdded: palette.backgroundPanel, diffAddedBright: palette.text,
    diffRemoved: palette.backgroundPanel, diffRemovedBright: palette.text,
  }
}
/** Live singleton palette; Vimex owns one terminal renderer per process. */
export const emberTide = new Proxy({} as VimexTheme, { get: (_target, key: keyof VimexTheme) => selectedTheme[key] })
export function selectTheme(name: keyof typeof themes, reducedColor = false): VimexTheme { selectedTheme = reducedColor ? reduced(themes[name]) : themes[name]; return selectedTheme }
export function themePalette(name: keyof typeof themes): VimexTheme { return themes[name] }

export type EmberTideTheme = VimexTheme

export function createEmberTideSyntax(name?: keyof typeof themes, reducedColor = false): SyntaxStyle {
  const base = name ? themes[name] : selectedTheme
  const palette = reducedColor ? reduced(base) : base
  return SyntaxStyle.fromStyles({
    default: { fg: palette.text },
    keyword: { fg: palette.blueBright, bold: true },
    string: { fg: palette.sage },
    number: { fg: palette.amber },
    comment: { fg: palette.textMuted, italic: true },
    function: { fg: palette.blue },
    type: { fg: palette.amber },
    variable: { fg: palette.textSoft },
    "markup.heading": { fg: palette.amber, bold: true },
    "markup.link": { fg: palette.blueBright, underline: true },
    "markup.raw": { fg: palette.sage },
  })
}
