import { UI_VERSION_STORAGE_KEY, UI_VERSION_SUSPEND_KEY, UiVersion } from './v2.constants'

const hasStorage = (): boolean => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

// sessionStorage, not localStorage: a suspension is one excursion into the classic
// UI in one tab, and it must not outlive the tab even if nothing clears it.
const hasSessionStorage = (): boolean => typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined'

export function getUiVersion(): UiVersion | null {
  if (!hasStorage()) return null
  const raw = window.localStorage.getItem(UI_VERSION_STORAGE_KEY)
  return raw === 'v2' || raw === 'classic' ? raw : null
}

export function setUiVersion(version: UiVersion): void {
  if (!hasStorage()) return
  window.localStorage.setItem(UI_VERSION_STORAGE_KEY, version)
}

export function clearUiVersion(): void {
  if (!hasStorage()) return
  window.localStorage.removeItem(UI_VERSION_STORAGE_KEY)
}

/**
 * Stand `uiVersionGuard` down for this browser tab.
 *
 * v2 has no browser for the shares repository, so a shared FOLDER hands off to the
 * classic one — and the guard bounces every classic URL back to /v2 while the
 * preference says 'v2'. Clearing the preference got past it at the cost of opting the
 * user OUT of v2 permanently, over a single click on a list row.
 *
 * A suspension is the narrow version of that: the preference survives, the guard
 * stands down until the user reaches a /v2 route again, and `resumeUiVersion()` there
 * puts it back. It is deliberately NOT one-shot — the guard sits on the classic layout
 * route and re-runs on every navigation inside classic, so a token consumed on first
 * activation would bounce the user out on their next click.
 */
export function suspendUiVersion(): void {
  if (!hasSessionStorage()) return
  window.sessionStorage.setItem(UI_VERSION_SUSPEND_KEY, '1')
}

export function isUiVersionSuspended(): boolean {
  if (!hasSessionStorage()) return false
  return window.sessionStorage.getItem(UI_VERSION_SUSPEND_KEY) === '1'
}

export function resumeUiVersion(): void {
  if (!hasSessionStorage()) return
  window.sessionStorage.removeItem(UI_VERSION_SUSPEND_KEY)
}
