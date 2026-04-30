import { FILE_MODE } from '../../files/constants/operations'
import type { OnlyOfficeReqDto } from '../../files/modules/only-office/only-office.dtos'
import { NcOnlyOfficeTranslatorService } from './nc-onlyoffice-translator.service'

// Reshapes Sync-in's internal OnlyOfficeReqDto (designed for the v2 web SPA's
// iframe embed) into the envelope NC's OnlyOffice plugin emits. The OnlyOffice
// document server itself accepts both shapes — the difference is what NC
// mobile expects to find at the top level when it parses /config response.
//
// Critically, the JWT under config.token is signed with the same secret the
// doc server was provisioned with; we pass it through unchanged.
describe('NcOnlyOfficeTranslatorService', () => {
  const translator = new NcOnlyOfficeTranslatorService()

  const baseSyncIn: OnlyOfficeReqDto = {
    documentServerUrl: 'https://docs.example.test/onlyoffice',
    hasLock: false,
    config: {
      documentType: 'word',
      type: 'desktop',
      document: {
        title: 'a.docx',
        fileType: 'docx',
        key: 'doc-key-1',
        url: 'https://sync-in.test/api/spaces/onlyoffice/document/personal/a.docx?token=xyz',
        permissions: { download: true, edit: true, comment: true, print: true, review: true, fillForms: true, changeHistory: false }
      },
      editorConfig: {
        mode: FILE_MODE.EDIT,
        callbackUrl: 'https://sync-in.test/api/spaces/onlyoffice/callback/personal/a.docx?token=xyz',
        user: { id: '7', name: 'Jane (jane@example.test)', image: '' },
        lang: 'en',
        region: 'en',
        coEditing: { mode: 'fast', change: true },
        embedded: { embedUrl: 'x', saveUrl: 'x', shareUrl: 'x', toolbarDocked: 'top' },
        customization: { autosave: false, forcesave: true }
      },
      token: 'signed-payload-jwt'
    }
  }

  it('returns top-level NC envelope keys: document / editorConfig / type / documentType / token', () => {
    const out = translator.toNcEnvelope(baseSyncIn)
    expect(Object.keys(out).sort()).toEqual(['document', 'documentType', 'editorConfig', 'documentServerUrl', 'token', 'type'].sort())
  })

  it('preserves the document URL + key + fileType + permissions verbatim', () => {
    const out = translator.toNcEnvelope(baseSyncIn)
    expect(out.document.url).toBe(baseSyncIn.config.document.url)
    expect(out.document.key).toBe('doc-key-1')
    expect(out.document.fileType).toBe('docx')
    expect(out.document.title).toBe('a.docx')
    expect(out.document.permissions).toEqual(baseSyncIn.config.document.permissions)
  })

  it('preserves callbackUrl + mode + user fields on editorConfig', () => {
    const out = translator.toNcEnvelope(baseSyncIn)
    expect(out.editorConfig.callbackUrl).toBe(baseSyncIn.config.editorConfig.callbackUrl)
    expect(out.editorConfig.mode).toBe(FILE_MODE.EDIT)
    expect(out.editorConfig.user).toEqual({ id: '7', name: 'Jane (jane@example.test)', image: '' })
    expect(out.editorConfig.lang).toBe('en')
  })

  it('passes through the signed token (same secret signs Sync-in and NC payloads)', () => {
    const out = translator.toNcEnvelope(baseSyncIn)
    expect(out.token).toBe('signed-payload-jwt')
  })

  it('passes through documentServerUrl so the mobile app loads the editor JS from the right host', () => {
    const out = translator.toNcEnvelope(baseSyncIn)
    expect(out.documentServerUrl).toBe('https://docs.example.test/onlyoffice')
  })

  it('drops keys NC connector does not consume (height, width, embedded, customization, coEditing)', () => {
    const out = translator.toNcEnvelope(baseSyncIn)
    expect(out.editorConfig).not.toHaveProperty('embedded')
    expect(out.editorConfig).not.toHaveProperty('customization')
    expect(out.editorConfig).not.toHaveProperty('coEditing')
  })

  it('returns mode=view when Sync-in sees a lock conflict (hasLock truthy → mode=view upstream)', () => {
    const locked: OnlyOfficeReqDto = {
      ...baseSyncIn,
      hasLock: { app: 'OnlyOffice', owner: { id: 99, login: 'other', fullName: 'Other' } } as any,
      config: { ...baseSyncIn.config, editorConfig: { ...baseSyncIn.config.editorConfig, mode: FILE_MODE.VIEW } }
    }
    const out = translator.toNcEnvelope(locked)
    expect(out.editorConfig.mode).toBe(FILE_MODE.VIEW)
  })
})
