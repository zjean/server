// The office half of the directEditing catalog. Kept in its own file because the
// office entry is config-gated and so needs the config singleton mocked, while
// nc-direct-editing.service.spec.ts deliberately runs against the real one.
vi.mock('../../../configuration/config.environment', () => ({
  configuration: {
    applications: {
      files: {
        editors: {
          onlyoffice: { enabled: false },
          eurooffice: { enabled: false }
        }
      }
    },
    auth: { token: { access: { secret: 'test-secret-for-office-catalog-spec' } } }
  }
}))

import { configuration as mockConfig } from '../../../configuration/config.environment'

import { ONLY_OFFICE_EXTENSIONS } from '../../files/editors/only-office/only-office.constants'
import { getMimeType } from '../../files/utils/files'
import {
  NcDirectEditingService,
  NC_DIRECT_EDITING_EDITOR_ID,
  NC_DIRECT_EDITING_MIMETYPES,
  NC_DIRECT_EDITING_OFFICE_MIMETYPES,
  ncDirectEditingCatalogEtag,
  ncOfficeEditorId
} from './nc-direct-editing.service'

function setEditors(onlyoffice: boolean, eurooffice: boolean): void {
  mockConfig.applications.files.editors.onlyoffice.enabled = onlyoffice
  mockConfig.applications.files.editors.eurooffice.enabled = eurooffice
}

// listEditors / isOfficeMime touch no injected dependency, and both read the
// config at call time — so one hand-built instance covers every config state.
const svc = new NcDirectEditingService(null as never)
const catalog = () => svc.listEditors()

// The canonical mime of every extension OnlyOfficeManager.getSettings would
// accept. Anything we advertise has to be in here or the Edit button dead-ends.
const servableMimes = new Set([...ONLY_OFFICE_EXTENSIONS.keys()].map((ext) => getMimeType(`f.${ext}`, false).replace('-', '/')))

describe('office directEditing catalog', () => {
  afterEach(() => setEditors(false, false))

  describe('ncOfficeEditorId', () => {
    it('is null when no office document server is enabled', () => {
      setEditors(false, false)
      expect(ncOfficeEditorId()).toBeNull()
    })

    it('names the server that is enabled', () => {
      setEditors(true, false)
      expect(ncOfficeEditorId()).toBe('onlyoffice')
      setEditors(false, true)
      expect(ncOfficeEditorId()).toBe('eurooffice')
    })

    it('prefers onlyoffice when both are enabled, matching OnlyOfficeManager', () => {
      // OnlyOfficeManager picks its officeConfig with the same precedence
      // (only-office-manager.service.ts:83-86). If these disagreed we would
      // advertise one editor and serve the other's document server.
      setEditors(true, true)
      expect(ncOfficeEditorId()).toBe('onlyoffice')
    })
  })

  describe('listEditors', () => {
    it('carries the text editor alone when no office server is enabled', () => {
      setEditors(false, false)
      expect(Object.keys(catalog())).toEqual([NC_DIRECT_EDITING_EDITOR_ID])
    })

    it('adds an entry keyed by an id both stock clients recognise', () => {
      // The iOS NCDirectEditorAdapter registry and Android's OFFICE_EDITOR_IDS
      // both contain exactly these two strings; any other id is an editor no
      // client will ever open.
      setEditors(true, false)
      expect(catalog().onlyoffice?.id).toBe('onlyoffice')
      setEditors(false, true)
      expect(catalog().eurooffice?.id).toBe('eurooffice')
    })

    it('declares the text editor FIRST — the tie-break Android depends on', () => {
      // EditorUtils.kt::getAvailableEditor returns
      // `editors.firstOrNull { mime in it.mimetypes }` over a Gson
      // LinkedHashMap, so declaration order decides which editor claims a
      // mimetype both advertise. iOS needs no equivalent care: NCViewer.swift
      // forces ["text"] whenever text matches at all.
      setEditors(true, false)
      expect(Object.keys(catalog())[0]).toBe(NC_DIRECT_EDITING_EDITOR_ID)
    })

    it('gives the office entry a name that satisfies the older iOS name gate too', () => {
      setEditors(true, false)
      expect(catalog().onlyoffice.name.toLowerCase()).toBe('onlyoffice')
    })

    it('emits every field NKEditorDetailsEditor decodes', () => {
      // NKEditorDetailsResponse decodes with JSONDecoder and non-optional
      // fields, so ONE missing key throws and iOS discards the whole
      // editors+creators payload — taking the text editor down with it.
      setEditors(true, false)
      expect(Object.keys(catalog().onlyoffice).sort()).toEqual(['id', 'mimetypes', 'name', 'optionalMimetypes', 'secure'])
    })
  })

  describe('NC_DIRECT_EDITING_OFFICE_MIMETYPES', () => {
    it('advertises the canonical mimetype for the formats we can edit', () => {
      expect(NC_DIRECT_EDITING_OFFICE_MIMETYPES).toEqual(
        expect.arrayContaining([
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/vnd.oasis.opendocument.text',
          'application/vnd.oasis.opendocument.spreadsheet',
          'application/vnd.oasis.opendocument.presentation',
          'application/msword',
          'application/vnd.ms-excel',
          'application/vnd.ms-powerpoint'
        ])
      )
    })

    it('keeps the subtype hyphens intact', () => {
      // The whole reason the list is derived through getMimeType: both clients
      // compare against `d:getcontenttype` with exact equality, and a mimetype
      // whose subtype lost its hyphens matches nothing at all.
      for (const mime of NC_DIRECT_EDITING_OFFICE_MIMETYPES) {
        expect(mime.split('/')).toHaveLength(2)
      }
    })

    it('never advertises a format OnlyOfficeManager would refuse to open', () => {
      for (const mime of NC_DIRECT_EDITING_OFFICE_MIMETYPES) {
        expect(servableMimes.has(mime)).toBe(true)
      }
    })

    it('leaves pdf and diagram formats to their own viewers', () => {
      // iOS routes every PDF to NCViewerPDF before it consults the catalog, so
      // advertising application/pdf would light up Edit on Android alone.
      // Diagrams are view-only in OnlyOffice.
      const excluded = [...ONLY_OFFICE_EXTENSIONS.entries()]
        .filter(([, documentType]) => documentType === 'pdf' || documentType === 'diagram')
        .map(([ext]) => getMimeType(`f.${ext}`, false).replace('-', '/'))
      for (const mime of excluded) {
        expect(NC_DIRECT_EDITING_OFFICE_MIMETYPES).not.toContain(mime)
      }
      expect(excluded).toContain('application/pdf')
    })

    it('shares no mimetype with the text editor, csv included', () => {
      // csv is a `cell` extension AND in the text catalog; CodeMirror is the
      // better editor for it. Zero overlap means Android's declaration order
      // never has to arbitrate anything.
      expect(NC_DIRECT_EDITING_MIMETYPES).toContain('text/csv')
      expect(NC_DIRECT_EDITING_OFFICE_MIMETYPES.filter((m) => NC_DIRECT_EDITING_MIMETYPES.includes(m))).toEqual([])
    })
  })

  describe('ncDirectEditingCatalogEtag', () => {
    it('changes when the office entry appears', () => {
      // Android refetches /info only when this etag differs from the stored
      // DIRECT_EDITING_ETAG (RefreshFolderOperation). An etag that did not move
      // would leave every already-paired Android client on the text-only
      // catalog forever.
      setEditors(false, false)
      const withoutOffice = ncDirectEditingCatalogEtag()
      setEditors(true, false)
      expect(ncDirectEditingCatalogEtag()).not.toBe(withoutOffice)
    })

    it('differs between onlyoffice and eurooffice', () => {
      setEditors(true, false)
      const oo = ncDirectEditingCatalogEtag()
      setEditors(false, true)
      expect(ncDirectEditingCatalogEtag()).not.toBe(oo)
    })
  })

  describe('isOfficeMime', () => {
    it('accepts the canonical form and the stored dash form', () => {
      expect(svc.isOfficeMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true)
      // Sync-in stores the mime with only the FIRST slash replaced by a dash.
      expect(svc.isOfficeMime('application-vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true)
    })

    it('refuses a text mime, a pdf and empty input', () => {
      expect(svc.isOfficeMime('text/plain')).toBe(false)
      expect(svc.isOfficeMime('application/pdf')).toBe(false)
      expect(svc.isOfficeMime(undefined)).toBe(false)
      expect(svc.isOfficeMime('')).toBe(false)
    })
  })
})
