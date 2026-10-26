import { expect, test } from "bun:test"
import { mapThreadItem } from "./map-item"

test("user-message mapping preserves client correlation independently of the server item ID", () => {
  const item = mapThreadItem(
    {
      type: "userMessage",
      id: "server-item",
      clientId: "local-submission",
      content: [{ type: "text", text: "hello", text_elements: [] }],
    },
    "server-turn",
    true,
  )
  expect(item).toMatchObject({
    id: "server-item",
    clientMessageId: "local-submission",
    kind: "user",
    markdown: "hello",
  })
})
