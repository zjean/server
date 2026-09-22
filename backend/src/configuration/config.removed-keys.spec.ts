import 'reflect-metadata'
import type { GlobalConfig } from './config.validation'
import { removedDrawioUrlEnvConfig, removedMaxVersionsPerFileConfig } from './config.environment'

// A config object shaped only as far as this function reaches into it.
const configWith = (versions: Record<string, unknown>): GlobalConfig => ({ applications: { files: { versions } } }) as unknown as GlobalConfig

describe('removedMaxVersionsPerFileConfig', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
  })

  // The whole point: an unknown YAML key is otherwise dropped in SILENCE, because
  // validation runs with no whitelist/forbidNonWhitelisted. That is the #384
  // failure class — the operator's retention behaviour changes with no signal.
  it('warns when the removed key is present', () => {
    removedMaxVersionsPerFileConfig(configWith({ enabled: true, maxVersionsPerFile: 20 }))

    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain('maxVersionsPerFile')
  })

  // Deleted as well as warned about: plainToInstance copies unknown properties
  // onto the instance, so leaving it would carry a dead untyped field forward.
  it('deletes the key so it cannot survive onto the validated instance', () => {
    const config = configWith({ enabled: true, maxVersionsPerFile: 20 })

    removedMaxVersionsPerFileConfig(config)

    expect('maxVersionsPerFile' in (config.applications.files.versions as object)).toBe(false)
  })

  it('says nothing and changes nothing when the key is absent', () => {
    const config = configWith({ enabled: true })

    removedMaxVersionsPerFileConfig(config)

    expect(warn).not.toHaveBeenCalled()
    expect(config.applications.files.versions).toEqual({ enabled: true })
  })

  // A yaml with no versions block at all, or a partially-built config: must not
  // throw during boot.
  it('tolerates a missing versions block', () => {
    expect(() => removedMaxVersionsPerFileConfig({} as GlobalConfig)).not.toThrow()
  })
})

// #499. DRAWIO_URL is the one removed setting that no existing mechanism can
// report: it carries no SYNCIN_ prefix, so `config.loader`'s "Ignoring unknown
// environment variable" never fires for it, and it never lived in
// environment.yaml, so the "look for the key on the config object" shape above
// finds nothing either. Its silence is the harmful kind — the default is a
// third-party editor and nothing visibly breaks.
describe('removedDrawioUrlEnvConfig', () => {
  let warn: ReturnType<typeof vi.spyOn>
  const previous = process.env['DRAWIO_URL']

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    delete process.env['DRAWIO_URL']
  })

  afterEach(() => {
    warn.mockRestore()
    if (previous === undefined) delete process.env['DRAWIO_URL']
    else process.env['DRAWIO_URL'] = previous
  })

  it('warns when the removed variable is still set', () => {
    process.env['DRAWIO_URL'] = 'https://drawio.internal'

    removedDrawioUrlEnvConfig()

    expect(warn).toHaveBeenCalledOnce()
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('DRAWIO_URL')
    // The replacement has to be NAMED, and with the exact spelling: a camelCase
    // key is a single segment, so ..._EDITOR_URL would be discarded with a
    // different warning and the default would stand.
    expect(message).toContain('SYNCIN_APPLICATIONS_FILES_DIAGRAMS_EDITORURL')
    expect(message).not.toContain('EDITOR_URL"')
    // And the consequence has to be stated, because that is the part an
    // operator cannot see: the fallback is a third party.
    expect(message).toContain('https://embed.diagrams.net')
  })

  it('warns for an empty value too — set-but-blank is still set', () => {
    process.env['DRAWIO_URL'] = ''

    removedDrawioUrlEnvConfig()

    expect(warn).toHaveBeenCalledOnce()
  })

  it('says nothing when the variable is absent', () => {
    removedDrawioUrlEnvConfig()

    expect(warn).not.toHaveBeenCalled()
  })
})
