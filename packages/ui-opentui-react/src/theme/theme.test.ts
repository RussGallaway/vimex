import { RGBA } from "@opentui/core"
import { themeNames } from "@vimex/interaction"
import { afterEach, describe, expect, test } from "bun:test"
import { createEmberTideSyntax, emberTide, selectTheme, themePalette } from "."

describe("UI themes", () => {
  afterEach(() => selectTheme("ember-tide"))

  test("selects configured Nord and Kanagawa palettes", () => {
    selectTheme("nord")
    expect(emberTide.name).toBe("Nord")
    expect(emberTide.background).toBe("#2e3440")
    selectTheme("kanagawa")
    expect(emberTide.name).toBe("Kanagawa")
    expect(emberTide.background).toBe("#1f1f28")
  })

  test("reduces semantic accents to the text ramp", () => {
    selectTheme("ember-tide", true)
    expect(emberTide.red).toBe(emberTide.text)
    expect(emberTide.blue).toBe(emberTide.textSoft)
  })
})

for (const name of themeNames)
  test(`${name} defines native Markdown and code scopes without code backgrounds`, () => {
    const syntax = createEmberTideSyntax(name)
    const reduced = createEmberTideSyntax(name, true)
    try {
      expect(syntax.getStyle("markup.strong")?.bold).toBe(true)
      expect(syntax.getStyle("markup.italic")?.italic).toBe(true)
      expect(syntax.getStyle("markup.link.label")?.underline).toBe(true)
      expect(syntax.getStyle("markup.quote")?.italic).toBe(true)
      for (const scope of [
        "markup.raw",
        "markup.raw.inline",
        "markup.raw.block",
      ])
        expect(syntax.getStyle(scope)?.bg).toBeUndefined()
      for (const scope of [
        "function.call",
        "function.method.call",
        "type.builtin",
        "property",
        "constant.builtin",
        "operator",
        "punctuation.bracket",
        "markup.list",
        "markup.strikethrough",
      ])
        expect(syntax.getStyle(scope)?.fg).toBeDefined()
      expect(reduced.getStyle("operator")?.fg?.toString()).toBe(
        reduced.getStyle("markup.strong")?.fg?.toString(),
      )
      expect(themePalette(name).text).toBeDefined()
    } finally {
      syntax.destroy()
      reduced.destroy()
    }
  })

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const linear = [1, 3, 5]
      .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      )
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  }
  const a = luminance(foreground),
    b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test("Nord text remains readable across panels, selections and dedicated diff surfaces", () => {
  const nord = themePalette("nord")
  for (const surface of [
    nord.background,
    nord.backgroundRaised,
    nord.backgroundPanel,
    nord.selection,
  ]) {
    expect(contrast(nord.text, surface)).toBeGreaterThanOrEqual(7)
    expect(contrast(nord.textMuted, surface)).toBeGreaterThanOrEqual(3.5)
  }
  expect(contrast(nord.textMuted, nord.backgroundPanel)).toBeGreaterThanOrEqual(
    4.5,
  )
  for (const surface of [nord.diffAdded, nord.diffRemoved, nord.diffContext])
    expect(contrast(nord.textSoft, surface)).toBeGreaterThanOrEqual(7)
  expect(contrast(nord.diffAddedBright, nord.diffAdded)).toBeGreaterThanOrEqual(
    4.5,
  )
  expect(
    contrast(nord.diffRemovedBright, nord.diffRemoved),
  ).toBeGreaterThanOrEqual(3)
  expect(nord.diffAdded).not.toBe(themePalette("ember-tide").diffAdded)
  expect(nord.diffRemoved).not.toBe(themePalette("ember-tide").diffRemoved)
})

test("Nord syntax uses Frost functions/types and Aurora purple values with restrained keywords", () => {
  const syntax = createEmberTideSyntax("nord"),
    reduced = createEmberTideSyntax("nord", true)
  try {
    const color = (scope: string) => syntax.getStyle(scope)!.fg!.toString()
    expect(color("number")).toBe(color("constant"))
    expect(color("number")).not.toBe(color("type"))
    expect(color("function.call")).toBe(color("markup.heading"))
    expect(color("function.call")).not.toBe(color("keyword"))
    expect(syntax.getStyle("keyword")!.bold).toBe(false)
    for (const scope of ["number", "constant", "type", "keyword", "operator"])
      expect(reduced.getStyle(scope)!.fg!.toString()).toBe(
        reduced.getStyle("default")!.fg!.toString(),
      )
  } finally {
    syntax.destroy()
    reduced.destroy()
  }
  const ember = createEmberTideSyntax("ember-tide"),
    kanagawa = createEmberTideSyntax("kanagawa")
  try {
    expect(ember.getStyle("keyword")!.bold).toBe(true)
    expect(kanagawa.getStyle("keyword")!.bold).toBe(true)
  } finally {
    ember.destroy()
    kanagawa.destroy()
  }
})

for (const [name, keyword, fn, number] of [
  ["gruvbox-material", "#ea6962", "#a9b665", "#d3869b"],
  ["kanagawa", "#957fb8", "#7e9cd8", "#d27e99"],
  ["tokyo-night", "#bb9af7", "#7aa2f7", "#ff9e64"],
  ["catppuccin-mocha", "#cba6f7", "#89b4fa", "#fab387"],
  ["rose-pine-dawn", "#963452", "#245f77", "#815200"],
  ["everforest", "#e67e80", "#a7c080", "#d699b6"],
  ["solarized-light", "#b43335", "#1e698f", "#806000"],
  ["solarized-dark", "#ef7774", "#62b3df", "#b3a8e6"],
  ["one-dark", "#c678dd", "#61afef", "#d19a66"],
  ["dracula", "#ff79c6", "#50fa7b", "#bd93f9"],
] as const)
  test(`${name} preserves its distinct syntax roles and readable surfaces`, () => {
    const syntax = createEmberTideSyntax(name)
    const palette = themePalette(name)
    try {
      for (const [scope, hex] of [
        ["keyword", keyword],
        ["function.call", fn],
        ["number", number],
      ]) {
        expect(syntax.getStyle(scope!)!.fg!.toString()).toBe(
          RGBA.fromHex(hex!).toString(),
        )
      }
      for (const surface of [
        palette.background,
        palette.backgroundPanel,
        palette.selection,
        palette.diffAdded,
        palette.diffRemoved,
      ]) {
        expect(contrast(palette.text, surface)).toBeGreaterThanOrEqual(4.5)
      }
      if (name === "kanagawa")
        expect(
          contrast(palette.textMuted, palette.backgroundPanel),
        ).toBeGreaterThanOrEqual(4.5)
      expect(syntax.getStyle("string")!.fg!.toString()).toBe(
        RGBA.fromHex(palette.sage).toString(),
      )
      expect(syntax.getStyle("comment")!.italic).toBe(true)
    } finally {
      syntax.destroy()
    }
  })

for (const name of [
  "rose-pine-dawn",
  "everforest",
  "solarized-light",
  "solarized-dark",
  "one-dark",
  "dracula",
] as const)
  test(`${name} keeps panel, selection, and diff labels readable`, () => {
    const palette = themePalette(name)
    for (const surface of [
      palette.background,
      palette.backgroundRaised,
      palette.backgroundPanel,
      palette.selection,
      palette.diffAdded,
      palette.diffRemoved,
      palette.diffContext,
    ]) {
      expect(contrast(palette.text, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.textSoft, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.textMuted, surface)).toBeGreaterThanOrEqual(4.5)
    }
    expect(
      contrast(palette.diffAddedBright, palette.diffAdded),
    ).toBeGreaterThanOrEqual(3)
    expect(
      contrast(palette.diffRemovedBright, palette.diffRemoved),
    ).toBeGreaterThanOrEqual(3)
  })
