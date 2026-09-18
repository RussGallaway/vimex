# Themes

Use `:theme NAME` or `/theme NAME`; Tab completes the available names. Changes persist. `:syntax theme` follows the UI palette (default), while `:syntax NAME` selects independent syntax colors.

| Name | Character | Syntax |
| --- | --- | --- |
| `ember-tide` | Original warm charcoal | Cool keywords, sage strings, amber values |
| `nord` | Cool, restrained Polar Night | Frost functions/types, purple values |
| `gruvbox-material` | Medium dark, warm earth tones | Red keywords, green functions/strings, purple values |
| `kanagawa` | Wave variant, ink backgrounds | Violet keywords, blue functions, aqua types, pink numbers |
| `tokyo-night` | Night variant, blue-black | Violet keywords, blue functions, cyan types, orange numbers |
| `catppuccin-mocha` | Dark pastel | Mauve keywords, blue functions, yellow types, peach numbers |

These are Vimex adaptations with syntax roles, selection colors, and diff surfaces, not Neovim plugins. Muted text and panel/diff tints are adjusted where useful for terminal readability. The original default is unchanged. Reduced-color mode neutralizes semantic accents for every palette.

Palette references:

- [Gruvbox Material](https://github.com/sainnhe/gruvbox-material), medium dark / material foreground.
- [Kanagawa](https://github.com/rebelot/kanagawa.nvim), Wave palette.
- [Tokyo Night](https://github.com/folke/tokyonight.nvim), Night palette.
- [Catppuccin](https://github.com/catppuccin/nvim), Mocha palette.
- [Nord](https://www.nordtheme.com/docs/colors-and-palettes/).

Theme identifiers live in interaction's command vocabulary and are shared by configuration, workbench preferences, and UI contracts. Concrete colors and syntax scopes belong to the OpenTUI adapter. Native Markdown tests exercise all palettes at wide and narrow widths with exact source copying; scope tests check characteristic keyword/function/number colors and readable main text across panels, selections, and diffs.
