export type Installation =
  | { kind: "unknown" }
  | { kind: "source"; root?: string }
  | { kind: "homebrew" }
  | { kind: "direct"; root: string; executable: string; version: string }
