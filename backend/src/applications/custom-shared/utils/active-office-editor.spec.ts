import { beforeEach, describe, expect, it, vi } from 'vitest'

// The selection reads the config singleton at CALL time, so the mock is a
// mutable object the cases rewrite rather than a fixed literal. vi.hoisted
// because the vi.mock factory below is lifted above ordinary top-level consts.
const editors = vi.hoisted(() => ({
  onlyoffice: { enabled: false, secret: 'oo-secret' },
  eurooffice: { enabled: false, secret: 'eo-secret' }
}))

vi.mock('../../../configuration/config.environment', () => ({
  configuration: { applications: { files: { editors } } },
  serverConfig: {},
  exportConfiguration: vi.fn()
}))

import { activeOfficeEditorConfig, activeOfficeEditorSecret } from './active-office-editor'

// Pins the fork's copy of OnlyOfficeManager's officeConfig choice
// (only-office-manager.service.ts:82-85). Nothing can assert the two agree at
// runtime — the manager's field is private — so these expectations are the only
// thing standing between an upstream change to that choice and a Euro-Office
// deployment silently signing with the wrong secret.
describe('activeOfficeEditorConfig', () => {
  beforeEach(() => {
    editors.onlyoffice = { enabled: false, secret: 'oo-secret' }
    editors.eurooffice = { enabled: false, secret: 'eo-secret' }
  })

  it('picks onlyoffice when onlyoffice is enabled', () => {
    editors.onlyoffice.enabled = true
    expect(activeOfficeEditorSecret()).toBe('oo-secret')
  })

  it('picks eurooffice when only eurooffice is enabled', () => {
    editors.eurooffice.enabled = true
    expect(activeOfficeEditorSecret()).toBe('eo-secret')
  })

  // The manager's ternary keys on onlyoffice.enabled ALONE, so onlyoffice wins a
  // both-enabled config. Asserted because the intuitive reading of "the active
  // editor" is an either-or, and a copy that resolved the tie the other way
  // would work on every single-editor install and break only on this one.
  it('prefers onlyoffice when BOTH are enabled', () => {
    editors.onlyoffice.enabled = true
    editors.eurooffice.enabled = true
    expect(activeOfficeEditorSecret()).toBe('oo-secret')
  })

  // Also the manager's behaviour: the ternary's else-branch is unconditional, so
  // a config with neither editor enabled yields the eurooffice block. Nothing
  // should be signing anything in that state, but the fallback must not be
  // undefined — activeOfficeEditorConfig().secret would throw.
  it('falls back to the eurooffice block when neither is enabled', () => {
    expect(activeOfficeEditorConfig()).toBe(editors.eurooffice)
  })

  // `secret` is @ValidateIf(enabled) in OnlyOfficeConfig, so it is legitimately
  // absent on a disabled editor. Callers gate signing on this being null; an
  // empty string must not read as "sign with ''".
  it('reports no secret rather than an empty one', () => {
    editors.onlyoffice = { enabled: true, secret: '' }
    expect(activeOfficeEditorSecret()).toBeNull()
    editors.onlyoffice = { enabled: true, secret: undefined as unknown as string }
    expect(activeOfficeEditorSecret()).toBeNull()
  })
})
