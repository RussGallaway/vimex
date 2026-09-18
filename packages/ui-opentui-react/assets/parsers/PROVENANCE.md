# Vendored Tree-sitter parsers

These parsers and highlight queries are loaded from local files so Vimex syntax highlighting does not require network access at runtime. Each upstream project is MIT licensed; its license is preserved in the corresponding directory.

| Language | Upstream release | Asset | SHA-256 |
| --- | --- | --- | --- |
| Python | [tree-sitter-python v0.23.6](https://github.com/tree-sitter/tree-sitter-python/tree/v0.23.6) | `python/tree-sitter-python.wasm` | `8c93692fb368e288a5824cee55773c9b3602804f513bda48c97661e52e9c2da2` |
| Python | same tag | `python/highlights.scm` | `a6708f209381618e2b398972c8f1ccd892f0c064eab35a2a3f911c3e22e79a7e` |
| Python | same tag | `python/LICENSE` | `d724405ce238a22c0d35769c5a36b386ad5958192efe8bbb304fb2896254575f` |
| Bash | [tree-sitter-bash v0.25.0](https://github.com/tree-sitter/tree-sitter-bash/tree/v0.25.0) | `bash/tree-sitter-bash.wasm` | `364f0a2cd385c792239423026ef442dbd073d34c396b7bc9e5932426b8e4aa5d` |
| Bash | same tag | `bash/highlights.scm` | `b74220d954f485b7626d2b2b61f37b522e12eb1830803e388e57dd797dc99f11` |
| Bash | same tag | `bash/LICENSE` | `49bf33cf78ef5897e4e161ce1517df7de1ae5042a65b6bcfd44401e0fc606559` |
| JSON | [tree-sitter-json v0.24.8](https://github.com/tree-sitter/tree-sitter-json/tree/v0.24.8) | `json/tree-sitter-json.wasm` | `d2119fb98d5912719b13f9458574f8608d2d29dfbe45f6be1f860ea1fe2a2405` |
| JSON | same tag | `json/highlights.scm` | `0511524465b56aed122580792254e68b6abbbfde7119f1d02b135acbe278233f` |
| JSON | same tag | `json/LICENSE` | `2e0110e07abef7c2548b26ec9d6969775617ca539a0dc8dbeeb14d6452c711d1` |

The WASM files come from the release artifacts. Queries and licenses come from the matching Git tags rather than a moving branch.
