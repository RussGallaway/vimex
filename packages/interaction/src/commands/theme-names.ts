/** Supported display identifiers shared by commands, configuration, and UI. */
export const themeNames = [
  "ember-tide",
  "nord",
  "kanagawa",
  "gruvbox-material",
  "tokyo-night",
  "catppuccin-mocha",
] as const
export type ThemeName = (typeof themeNames)[number]
