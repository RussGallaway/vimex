# Themes

Use `:theme NAME` or `/theme NAME`; Tab completes the available names. Changes persist. `:syntax theme` follows the UI palette (default), while `:syntax NAME` selects independent syntax colors.

| Name                   | Character                         | Syntax                                                                    |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `charcoal`             | Devbox neutral charcoal           | Dusty rose keywords, sage strings, misty blue functions, lavender numbers |
| `charcoal-transparent` | Charcoal with terminal background | Same muted pastel syntax as Charcoal                                      |
| `ember-tide`           | Original warm charcoal            | Cool keywords, sage strings, amber values                                 |
| `nord`                 | Cool, restrained Polar Night      | Frost functions/types, purple values                                      |
| `gruvbox-material`     | Medium dark, warm earth tones     | Red keywords, green functions/strings, purple values                      |
| `kanagawa`             | Wave variant, ink backgrounds     | Violet keywords, blue functions, aqua types, pink numbers                 |
| `tokyo-night`          | Night variant, blue-black         | Violet keywords, blue functions, cyan types, orange numbers               |
| `catppuccin-mocha`     | Dark pastel                       | Mauve keywords, blue functions, yellow types, peach numbers               |
| `rose-pine-dawn`       | Light cream and muted violet      | Rose keywords, pine functions, gold values                                |
| `everforest`           | Medium dark, warm green           | Red keywords, green functions, purple numbers                             |
| `solarized-light`      | Light cream and blue-grey         | Red keywords, blue functions, yellow values                               |
| `solarized-dark`       | Deep blue-green                   | Coral keywords, blue functions, violet values                             |
| `one-dark`             | Atom-inspired charcoal            | Purple keywords, blue functions, orange values                            |
| `dracula`              | Dark purple and vivid accents     | Pink keywords, green functions, purple values                             |

These are Vimex adaptations with syntax roles, selection colors, and diff surfaces, not Neovim plugins. Muted text and panel/diff tints are adjusted where useful for terminal readability. The original default is unchanged. Reduced-color mode neutralizes semantic accents for every palette.

Rosé Pine Dawn and Solarized Light use darker text and accent roles than some upstream UI uses so transcript panels and diffs remain readable on a terminal. Solarized Dark uses the upstream `base03` background and `base02` raised surface, with brighter text and accents for Vimex panels. Everforest, One Dark, and Dracula likewise adjust muted labels and selected diff signs where the upstream shades are too faint against Vimex panels.

Charcoal uses the original Devbox Charcoal Neovim palette: `#151515` canvas, `#1e1e1e` panels, soft gray text, muted pastel syntax, and burnt-orange focus accents. `:theme charcoal-transparent` preserves your terminal background and opacity across the main canvas, agent replies, statusline, and tool panels. User messages have a subtle `#252525` fill and burnt-orange border; agent replies use a misty-blue border. The composer has a `#1e1e1e` fill. These shaded surfaces distinguish your writing without adding role labels. Selections, hover states, and added/removed diff lines remain shaded; floating dialogs, jump prompts, notices, and completion menus keep solid charcoal surfaces for readability. The transparent canvas uses the terminal default background; the terminal configuration controls its color and opacity, while Vimex text stays opaque. Transparency works best over a dark terminal background. Both names also work with `:syntax NAME`; `:syntax theme` follows the selected UI palette.

Palette references:

- [Gruvbox Material](https://github.com/sainnhe/gruvbox-material), medium dark / material foreground.
- [Kanagawa](https://github.com/rebelot/kanagawa.nvim), Wave palette.
- [Tokyo Night](https://github.com/folke/tokyonight.nvim), Night palette.
- [Catppuccin](https://github.com/catppuccin/nvim), Mocha palette.
- [Nord](https://www.nordtheme.com/docs/colors-and-palettes/).
- [Rosé Pine](https://github.com/rose-pine/neovim/blob/main/lua/rose-pine/palette.lua), Dawn palette.
- [Everforest](https://github.com/sainnhe/everforest/blob/master/palette.md), dark medium palette.
- [Solarized](https://github.com/altercation/solarized), Light and Dark palettes.
- [One Dark](https://github.com/navarasu/onedark.nvim/blob/master/lua/onedark/palette.lua), dark palette.
- [Dracula](https://github.com/Mofiqul/dracula.nvim), default palette.

Theme identifiers live in interaction's command vocabulary and are shared by configuration, workbench preferences, and UI contracts. Concrete colors and syntax scopes belong to the OpenTUI adapter. Native Markdown tests exercise all palettes at wide and narrow widths with exact source copying; scope tests check characteristic keyword/function/number colors and readable main text across panels, selections, and diffs.
