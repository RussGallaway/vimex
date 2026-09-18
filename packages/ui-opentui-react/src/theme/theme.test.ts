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


for (const name of ["ember-tide", "nord", "kanagawa"] as const) test(`${name} defines native Markdown and code scopes without code backgrounds`, () => {
  const syntax = createEmberTideSyntax(name)
  const reduced = createEmberTideSyntax(name, true)
  try {
    expect(syntax.getStyle("markup.strong")?.bold).toBe(true)
    expect(syntax.getStyle("markup.italic")?.italic).toBe(true)
    expect(syntax.getStyle("markup.link.label")?.underline).toBe(true)
    expect(syntax.getStyle("markup.quote")?.italic).toBe(true)
    for (const scope of ["markup.raw", "markup.raw.inline", "markup.raw.block"]) expect(syntax.getStyle(scope)?.bg).toBeUndefined()
    for (const scope of ["function.call", "function.method.call", "type.builtin", "property", "constant.builtin", "operator", "punctuation.bracket", "markup.list", "markup.strikethrough"]) expect(syntax.getStyle(scope)?.fg).toBeDefined()
    expect(reduced.getStyle("operator")?.fg?.toString()).toBe(reduced.getStyle("markup.strong")?.fg?.toString())
    expect(themePalette(name).text).toBeDefined()
  } finally { syntax.destroy(); reduced.destroy() }
})

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const linear = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  }
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test("Nord text remains readable across panels, selections and dedicated diff surfaces", () => {
  const nord = themePalette("nord")
  for (const surface of [nord.background, nord.backgroundRaised, nord.backgroundPanel, nord.selection]) {
    expect(contrast(nord.text, surface)).toBeGreaterThanOrEqual(7)
    expect(contrast(nord.textMuted, surface)).toBeGreaterThanOrEqual(3.5)
  }
  expect(contrast(nord.textMuted, nord.backgroundPanel)).toBeGreaterThanOrEqual(4.5)
  for (const surface of [nord.diffAdded, nord.diffRemoved, nord.diffContext]) expect(contrast(nord.textSoft, surface)).toBeGreaterThanOrEqual(7)
  expect(contrast(nord.diffAddedBright, nord.diffAdded)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(nord.diffRemovedBright, nord.diffRemoved)).toBeGreaterThanOrEqual(3)
  expect(nord.diffAdded).not.toBe(themePalette("ember-tide").diffAdded)
  expect(nord.diffRemoved).not.toBe(themePalette("ember-tide").diffRemoved)
})

test("Nord syntax uses Frost functions/types and Aurora purple values with restrained keywords", () => {
  const syntax = createEmberTideSyntax("nord"), reduced = createEmberTideSyntax("nord", true)
  try {
    const color = (scope: string) => syntax.getStyle(scope)!.fg!.toString()
    expect(color("number")).toBe(color("constant"))
    expect(color("number")).not.toBe(color("type"))
    expect(color("function.call")).toBe(color("markup.heading"))
    expect(color("function.call")).not.toBe(color("keyword"))
    expect(syntax.getStyle("keyword")!.bold).toBe(false)
    for (const scope of ["number", "constant", "type", "keyword", "operator"]) expect(reduced.getStyle(scope)!.fg!.toString()).toBe(reduced.getStyle("default")!.fg!.toString())
  } finally { syntax.destroy(); reduced.destroy() }
  const ember = createEmberTideSyntax("ember-tide"), kanagawa = createEmberTideSyntax("kanagawa")
  try { expect(ember.getStyle("keyword")!.bold).toBe(true); expect(kanagawa.getStyle("keyword")!.bold).toBe(true) }
  finally { ember.destroy(); kanagawa.destroy() }
})
