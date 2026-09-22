import { themeNames, type ThemeName } from "@vimex/interaction"
export { themeNames } from "@vimex/interaction"
export type { ThemeName } from "@vimex/interaction"
export interface DisplayPreferences {
  theme: ThemeName
  syntaxTheme: ThemeName | "theme"
}
export interface PreferenceStore {
  initial: DisplayPreferences
  save(preferences: DisplayPreferences): Promise<void>
}
export function isThemeName(value: string): value is ThemeName {
  return themeNames.includes(value as ThemeName)
}
