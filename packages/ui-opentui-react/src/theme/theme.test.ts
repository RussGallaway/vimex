import { afterEach, describe, expect, test } from "bun:test"
import { emberTide, selectTheme } from "."

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
})
