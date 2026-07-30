import mime from 'mime-types'
import { getMimeType } from '../../files/utils/files'
import { WebDAVFile } from './webdav-file.model'

// Minimal FileProps-shaped fixture. Only the fields the getters under test read
// are populated; the constructor Object.assigns whatever it is handed.
function file(overrides: Record<string, unknown> = {}): WebDAVFile {
  return new WebDAVFile(
    {
      id: 1,
      name: 'doc.docx',
      isDir: false,
      size: 10,
      ctime: 0,
      mtime: 0,
      mime: 'application-vnd.openxmlformats-officedocument.wordprocessingml.document',
      ...overrides
    } as never,
    '/remote.php/dav/files/alice'
  )
}

describe('WebDAVFile.getcontenttype', () => {
  it('round-trips the stored mime back to its canonical form', () => {
    // Sync-in stores a mime by replacing only the FIRST '/' with '-'. The getter
    // is the exact inverse, so any mime whose SUBTYPE contains hyphens has to
    // survive intact.
    expect(file().getcontenttype).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  it('is a true inverse of getMimeType for every hyphenated mime we advertise', () => {
    // The regression this pins: `replaceAll('-', '/')` also ate the subtype's
    // own hyphens, so a .docx went out as
    // `application/vnd.openxmlformats/officedocument.…` — a string no NC client
    // can match. Both NC mobile clients compare the advertised directEditing
    // mimetype to this value with exact equality.
    //
    // Expectations are written out rather than derived from `mime.lookup`,
    // because `getMimeType` consults EXTRA_MIMES_TYPE first (`.ts` is
    // `text/typescript` here, not mime-types' `video/mp2t`).
    const cases: [string, string][] = [
      ['file.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['file.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['file.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['file.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
      ['file.ott', 'application/vnd.oasis.opendocument.text-template'],
      ['file.py', 'text/x-python'],
      ['file.sh', 'application/x-sh'],
      ['file.yaml', 'text/yaml'],
      ['file.ts', 'text/typescript'],
      ['file.tgz', 'application/gzip']
    ]
    for (const [name, canonical] of cases) {
      const stored = getMimeType(name, false)
      // Stored form carries no '/' at all — that is what makes the getter's
      // single replacement the whole inverse.
      expect(stored).not.toContain('/')
      expect(file({ name, mime: stored }).getcontenttype).toBe(canonical)
    }
  })

  it('leaves a hyphen-free mime alone', () => {
    expect(file({ name: 'a.txt', mime: 'text-plain' }).getcontenttype).toBe('text/plain')
    expect(file({ name: 'a.jpg', mime: 'image-jpeg' }).getcontenttype).toBe('image/jpeg')
  })

  it('returns undefined for a directory and the default for a mime-less file', () => {
    expect(file({ isDir: true }).getcontenttype).toBeUndefined()
    expect(file({ mime: undefined }).getcontenttype).toBe('application/octet-stream')
  })
})
