import { UI_VERSION_STORAGE_KEY, UiVersion } from './v2.constants'

const hasStorage = (): boolean => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'

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
