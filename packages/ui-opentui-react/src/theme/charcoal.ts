import type { VimexTheme } from "./types"

// Original Devbox Charcoal palette, read from config/devbox-palette.lua.
export const charcoal: VimexTheme = {
  name: "Charcoal",
  background: "#151515",
  backgroundRaised: "#1e1e1e",
  backgroundPanel: "#1e1e1e",
  backgroundHover: "#252525",
  border: "#454545",
  borderMuted: "#343434",
  text: "#d5d7d4",
  textSoft: "#9ba29f",
  textMuted: "#8c8c8c",
  textInverse: "#151515",
  blue: "#a0b2c2",
  blueBright: "#9fbcb5",
  sage: "#a6b29b",
  amber: "#d69a72",
  ember: "#d69a72",
  red: "#cf8a82",
  selection: "#343434",
  selectionText: "#d5d7d4",
  diffAdded: "#242b20",
  diffAddedBright: "#a6b29b",
  diffRemoved: "#302322",
  diffRemovedBright: "#cf8a82",
  diffContext: "#22292e",
  syntax: {
    keyword: "#c9a0a8",
    keywordBold: true,
    number: "#b5a5be",
    function: "#a0b2c2",
    type: "#9fbcb5",
    constant: "#c7ad98",
    property: "#aab7bd",
    heading: "#c9a0a8",
    operator: "#b5b2aa",
    variable: "#d5d7d4",
    special: "#b8a5c4",
    module: "#c2b696",
    headings: [
      "#c9a0a8",
      "#a0b2c2",
      "#a6b29b",
      "#9fbcb5",
      "#b5a5be",
      "#c7ad98",
    ],
  },
}

export const charcoalTransparent: VimexTheme = {
  ...charcoal,
  name: "Charcoal Transparent",
  // Zero alpha preserves the terminal's default background (and its opacity).
  background: "#00000000",
  backgroundRaised: "#00000000",
  backgroundPanel: "#00000000",
  diffContext: "#00000000",
  // Floating dialogs need a solid surface so transcript text cannot bleed through.
  overlayBackground: charcoal.backgroundRaised,
  overlayBackdrop: "#151515d8",
}
