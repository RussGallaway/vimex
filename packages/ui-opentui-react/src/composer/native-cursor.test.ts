import { describe, expect, test } from "bun:test"
import {
  graphemeOffsetToNativeOffset,
  nativeOffsetToGraphemeOffset,
} from "./native-cursor"

describe("native composer cursor offsets", () => {
  test("maps visual cells around wide graphemes without moving the picker query", () => {
    const text = "😀 @foo"
    const afterSpace = graphemeOffsetToNativeOffset(text, 2)

    expect(afterSpace).toBe(3)
    expect(nativeOffsetToGraphemeOffset(text, afterSpace)).toBe(2)
    expect(nativeOffsetToGraphemeOffset(text, afterSpace + 1)).toBe(3)
  })
})
