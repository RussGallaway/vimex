export const themeNames = ["ember-tide", "nord", "kanagawa"] as const
export type ThemeName = typeof themeNames[number]
export interface DisplayPreferences { theme: ThemeName; syntaxTheme: ThemeName | "theme" }
export interface PreferenceStore { initial: DisplayPreferences; save(preferences: DisplayPreferences): Promise<void> }
export function isThemeName(value: string): value is ThemeName { return themeNames.includes(value as ThemeName) }
