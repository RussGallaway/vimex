import { SyntaxStyle } from "@opentui/core"

import type { VimexTheme } from "./types"
import type { ThemeName } from "@vimex/interaction"
import {
  gruvboxMaterial,
  tokyoNight,
  catppuccinMocha,
} from "./additional-palettes"
import {
  rosePineDawn,
  everforest,
  solarizedLight,
  solarizedDark,
  oneDark,
  dracula,
} from "./new-palettes"
export type { VimexTheme } from "./types"

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
  background: "#2e3440",
  backgroundRaised: "#343b49",
  backgroundPanel: "#3b4252",
  backgroundHover: "#434c5e",
  border: "#4c566a",
  borderMuted: "#3b4252",
  text: "#eceff4",
  textSoft: "#d8dee9",
  textMuted: "#a3b0c5",
  blue: "#81a1c1",
  blueBright: "#88c0d0",
  sage: "#a3be8c",
  amber: "#ebcb8b",
  ember: "#d08770",
  red: "#bf616a",
  selection: "#434c5e",
  selectionText: "#eceff4",
  // Polar Night bases tinted with Aurora; never inherit the warmer Ember diff surfaces.
  diffAdded: "#354441",
  diffAddedBright: "#a3be8c",
  diffRemoved: "#453b48",
  diffRemovedBright: "#d08790",
  diffContext: "#343b49",
  syntax: {
    keyword: "#81a1c1",
    keywordBold: false,
    number: "#b48ead",
    function: "#88c0d0",
    type: "#8fbcbb",
    constant: "#b48ead",
    property: "#d8dee9",
    heading: "#88c0d0",
    operator: "#81a1c1",
  },
}

export const kanagawa: VimexTheme = {
  ...emberTideBase,
  name: "Kanagawa",
  background: "#1f1f28",
  backgroundRaised: "#252535",
  backgroundPanel: "#2a2a37",
  backgroundHover: "#363646",
  border: "#54546d",
  borderMuted: "#363646",
  text: "#dcd7ba",
  textSoft: "#c8c093",
  textMuted: "#989486",
  blue: "#7e9cd8",
  blueBright: "#7fb4ca",
  sage: "#98bb6c",
  amber: "#e6c384",
  ember: "#e46876",
  red: "#c34043",
  selection: "#2d4f67",
  selectionText: "#dcd7ba",
  diffAdded: "#2b3328",
  diffAddedBright: "#98bb6c",
  diffRemoved: "#43242b",
  diffRemovedBright: "#e46876",
  diffContext: "#252535",
  syntax: {
    keyword: "#957fb8",
    keywordBold: true,
    number: "#d27e99",
    function: "#7e9cd8",
    type: "#7aa89f",
    constant: "#ffa066",
    property: "#dcd7ba",
    heading: "#e6c384",
    operator: "#c0a36e",
  },
}

const themes = {
  "ember-tide": emberTideBase,
  nord,
  kanagawa,
  "gruvbox-material": gruvboxMaterial,
  "tokyo-night": tokyoNight,
  "catppuccin-mocha": catppuccinMocha,
  "rose-pine-dawn": rosePineDawn,
  everforest,
  "solarized-light": solarizedLight,
  "solarized-dark": solarizedDark,
  "one-dark": oneDark,
  dracula,
} satisfies Record<ThemeName, VimexTheme>
let selectedTheme: VimexTheme = emberTideBase
function reduced(palette: VimexTheme): VimexTheme {
  return {
    ...palette,
    ...(palette.syntax
      ? {
          syntax: {
            keyword: palette.text,
            keywordBold: palette.syntax.keywordBold,
            number: palette.text,
            function: palette.textSoft,
            type: palette.text,
            constant: palette.text,
            property: palette.textSoft,
            heading: palette.text,
            operator: palette.text,
          },
        }
      : {}),
    blue: palette.textSoft,
    blueBright: palette.text,
    sage: palette.textSoft,
    amber: palette.text,
    ember: palette.textSoft,
    red: palette.text,
    selection: palette.backgroundHover,
    selectionText: palette.text,
    diffAdded: palette.backgroundPanel,
    diffAddedBright: palette.text,
    diffRemoved: palette.backgroundPanel,
    diffRemovedBright: palette.text,
  }
}
/** Live singleton palette; Vimex owns one terminal renderer per process. */
export const emberTide = new Proxy({} as VimexTheme, {
  get: (_target, key: keyof VimexTheme) => selectedTheme[key],
})
export function selectTheme(
  name: keyof typeof themes,
  reducedColor = false,
): VimexTheme {
  selectedTheme = reducedColor ? reduced(themes[name]) : themes[name]
  return selectedTheme
}
export function themePalette(name: keyof typeof themes): VimexTheme {
  return themes[name]
}

export type EmberTideTheme = VimexTheme

export function createEmberTideSyntax(
  name?: keyof typeof themes,
  reducedColor = false,
): SyntaxStyle {
  const base = name ? themes[name] : selectedTheme
  const palette = reducedColor ? reduced(base) : base
  return SyntaxStyle.fromStyles({
    default: { fg: palette.text },
    keyword: {
      fg: palette.syntax?.keyword ?? palette.blueBright,
      bold: palette.syntax?.keywordBold ?? true,
    },
    string: { fg: palette.sage },
    number: { fg: palette.syntax?.number ?? palette.amber },
    comment: { fg: palette.textMuted, italic: true },
    function: { fg: palette.syntax?.function ?? palette.blue },
    type: { fg: palette.syntax?.type ?? palette.amber },
    variable: { fg: palette.textSoft },
    "variable.builtin": { fg: palette.ember },
    "variable.parameter": { fg: palette.textSoft },
    property: { fg: palette.syntax?.property ?? palette.blue },
    "function.call": { fg: palette.syntax?.function ?? palette.blue },
    "function.method": { fg: palette.syntax?.function ?? palette.blue },
    "function.method.call": { fg: palette.syntax?.function ?? palette.blue },
    "function.builtin": { fg: palette.syntax?.function ?? palette.blueBright },
    constructor: { fg: palette.syntax?.type ?? palette.amber },
    "type.builtin": { fg: palette.syntax?.type ?? palette.amber },
    constant: { fg: palette.syntax?.constant ?? palette.amber },
    "constant.builtin": { fg: palette.syntax?.constant ?? palette.ember },
    boolean: { fg: palette.syntax?.constant ?? palette.ember },
    operator: { fg: palette.syntax?.operator ?? palette.blueBright },
    "keyword.operator": { fg: palette.syntax?.operator ?? palette.blueBright },
    punctuation: { fg: palette.textSoft },
    "punctuation.bracket": { fg: palette.textSoft },
    "punctuation.delimiter": { fg: palette.textSoft },
    "punctuation.special": { fg: palette.blueBright },
    "string.special": { fg: palette.sage },
    "string.escape": { fg: palette.ember },
    "comment.documentation": { fg: palette.textMuted, italic: true },
    attribute: { fg: palette.amber },
    module: { fg: palette.blue },
    tag: { fg: palette.blueBright },
    "markup.heading": {
      fg: palette.syntax?.heading ?? palette.amber,
      bold: true,
    },
    "markup.heading.1": {
      fg: palette.syntax?.heading ?? palette.amber,
      bold: true,
      underline: true,
    },
    "markup.heading.2": {
      fg: palette.syntax?.heading ?? palette.amber,
      bold: true,
    },
    "markup.heading.3": { fg: palette.blueBright, bold: true },
    "markup.heading.4": { fg: palette.blueBright, bold: true },
    "markup.heading.5": { fg: palette.text, bold: true },
    "markup.heading.6": { fg: palette.text, bold: true },
    "markup.strong": { fg: palette.text, bold: true },
    "markup.bold": { fg: palette.text, bold: true },
    "markup.italic": { fg: palette.textSoft, italic: true },
    // SyntaxStyle does not expose a strike attribute; preserve a muted semantic distinction.
    "markup.strikethrough": { fg: palette.textMuted },
    "markup.list": { fg: palette.blueBright },
    "markup.list.checked": { fg: palette.sage },
    "markup.list.unchecked": { fg: palette.textMuted },
    "markup.quote": { fg: palette.textSoft, italic: true },
    "markup.link.label": { fg: palette.blueBright, underline: true },
    "markup.link.url": { fg: palette.blue, underline: true },
    "markup.link": { fg: palette.blueBright, underline: true },
    // Native inline chunks and fenced injection scopes share markup.raw.
    // Foreground-only styling keeps entire code blocks from acquiring inline backgrounds.
    "markup.raw": { fg: palette.sage },
    "markup.raw.inline": { fg: palette.sage },
    "markup.raw.block": { fg: palette.textSoft },
  })
}
