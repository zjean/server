// Pins the two halves of v2's open-in-office decision.
//
// Both halves have to hold before the embed may mount: the extension must be one
// the OnlyOffice connector understands, AND a provider that speaks that connector
// must be enabled. #307 shipped with only the extension half, so a .docx on a
// server with no office editor mounted the embed and dead-ended on
// "editor not available" instead of falling back to the download pane.

import { describe, expect, it } from 'vitest'
import type { FileEditorProviders } from '@sync-in-server/backend/src/applications/files/editors/file-editor-providers.interface'
import { isOfficeEditorEnabled, isOfficeExtension, officeCategory } from './office'

const editors = (o: Partial<FileEditorProviders>): FileEditorProviders => ({
  collabora: false,
  eurooffice: false,
  onlyoffice: false,
  ...o
})

describe('isOfficeEditorEnabled', () => {
  it('accepts OnlyOffice', () => {
    expect(isOfficeEditorEnabled(editors({ onlyoffice: true }))).toBe(true)
  })

  it('accepts Euro-Office — it rides the same connector protocol', () => {
    expect(isOfficeEditorEnabled(editors({ eurooffice: true }))).toBe(true)
  })

  it('accepts both enabled at once', () => {
    expect(isOfficeEditorEnabled(editors({ onlyoffice: true, eurooffice: true }))).toBe(true)
  })

  it('rejects a server with no office editor at all', () => {
    expect(isOfficeEditorEnabled(editors({}))).toBe(false)
  })

  // Deliberately narrower than classic's gate (file.model.ts:189-191). Classic
  // admits Collabora because classic ships a Collabora viewer; v2's embed is
  // OnlyOffice-protocol only, so treating a Collabora-only server as
  // office-capable would mount an embed that cannot load — the very bug #307 is.
  it('rejects a Collabora-only server, unlike classic', () => {
    expect(isOfficeEditorEnabled(editors({ collabora: true }))).toBe(false)
  })

  it('survives a config that has not loaded yet', () => {
    expect(isOfficeEditorEnabled(null)).toBe(false)
    expect(isOfficeEditorEnabled(undefined)).toBe(false)
  })

  // The server config arrives as JSON, so a truthy-but-not-true value is
  // reachable. Classic compares with `=== true`; keep that strictness.
  it('requires a real boolean, not merely a truthy value', () => {
    expect(isOfficeEditorEnabled({ collabora: false, eurooffice: false, onlyoffice: 'yes' } as unknown as FileEditorProviders)).toBe(false)
  })
})

describe('isOfficeExtension', () => {
  it('accepts the OnlyOffice extension set, case-insensitively', () => {
    expect(isOfficeExtension('report.docx')).toBe(true)
    expect(isOfficeExtension('BUDGET.XLSX')).toBe(true)
    expect(isOfficeExtension('deck.pptx')).toBe(true)
  })

  it('rejects a non-office extension, a bare name, and no name', () => {
    expect(isOfficeExtension('notes.txt')).toBe(false)
    expect(isOfficeExtension('Makefile')).toBe(false)
    expect(isOfficeExtension(null)).toBe(false)
    expect(isOfficeExtension(undefined)).toBe(false)
  })

  it('reads the last dot, so a versioned name still resolves', () => {
    expect(isOfficeExtension('report.v2.final.docx')).toBe(true)
  })
})

describe('officeCategory', () => {
  it('maps an extension to the connector document type', () => {
    expect(officeCategory('report.docx')).toBe('word')
    expect(officeCategory('budget.xlsx')).toBe('cell')
    expect(officeCategory('deck.pptx')).toBe('slide')
  })

  it('returns null for anything outside the map', () => {
    expect(officeCategory('notes.txt')).toBe(null)
    expect(officeCategory('Makefile')).toBe(null)
    expect(officeCategory(null)).toBe(null)
  })
})
