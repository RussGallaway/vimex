import { createHerdrExternalActions } from "./external-actions"

const target = process.env.HERDR_PLUGIN_CLICKED_URL
if (!target) throw new Error("Herdr did not provide HERDR_PLUGIN_CLICKED_URL")
await createHerdrExternalActions().openUrl(target)
