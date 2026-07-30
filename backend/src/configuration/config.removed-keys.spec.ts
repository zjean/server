import 'reflect-metadata'
import type { GlobalConfig } from './config.validation'
import { removedMaxVersionsPerFileConfig } from './config.environment'

// A config object shaped only as far as this function reaches into it.
const configWith = (versions: Record<string, unknown>): GlobalConfig =>
  ({ applications: { files: { versions } } }) as unknown as GlobalConfig

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
