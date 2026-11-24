// A screenshot in the dark theme and one in the light theme (CODE_NOTES_SHOTS only): the theme is set back even when
// the light shot fails, so a later test never runs in the light theme.
import * as vscode from 'vscode'
import { windowShot } from '../helpers'

const setTheme = (theme: string | undefined) =>
  vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global)

/** `<name>-dark` then `<name>-light`; `wait`: before each shot (windowShot's own default when unset). */
export async function shotsInBothThemes(name: string, wait: { dark?: number; light?: number } = {}): Promise<void> {
  await windowShot(`${name}-dark`, wait.dark === undefined ? {} : { wait: wait.dark })
  await setTheme('Default Light Modern')
  try {
    await windowShot(`${name}-light`, wait.light === undefined ? {} : { wait: wait.light })
  } finally {
    await setTheme(undefined)
  }
}
