import 'reflect-metadata'
import { instanceToPlain } from 'class-transformer'
import * as yaml from 'js-yaml'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { FilesVersionsConfig } from '../applications/files/files.config'
import { ENVIRONMENT_PREFIX } from './config.constants'
import { configLoader } from './config.loader'

describe(configLoader.name, () => {
  const initialEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith(ENVIRONMENT_PREFIX)))
  const temporaryPaths: string[] = []

  beforeEach(() => {
    clearSyncInEnv()
  })

  afterEach(() => {
    clearSyncInEnv()
    Object.assign(process.env, initialEnv)
    for (const temporaryPath of temporaryPaths.splice(0)) {
      fs.rmSync(temporaryPath, { force: true, recursive: true })
    }
    vi.restoreAllMocks()
  })

  it.each([
    ['false', false],
    ['"false"', false],
    ["'false'", false],
    [`"'false'"`, "'false'"]
  ])('should parse %s as %s', (rawValue, expectedValue) => {
    const envKey = `${ENVIRONMENT_PREFIX}LOGGER_COLORIZE`
    process.env[envKey] = rawValue

    expect(configLoader().logger.colorize).toBe(expectedValue)
  })

  it('should apply nested overrides while preserving camelCase keys', () => {
    process.env[`${ENVIRONMENT_PREFIX}APPLICATIONS_FILES_EDITORS_ONLYOFFICE_EXTERNALSERVER`] = 'https://onlyoffice.example.com'

    expect(configLoader().applications.files.editors.onlyoffice.externalServer).toBe('https://onlyoffice.example.com')
  })

  it.each([`${ENVIRONMENT_PREFIX}UNKNOWN_PROPERTY`, `${ENVIRONMENT_PREFIX}LOGGER_UNKNOWN`])(
    'should ignore the unknown environment variable %s',
    (envKey) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      process.env[`${ENVIRONMENT_PREFIX}LOGGER_LEVEL`] = 'info'
      process.env[envKey] = 'value'

      const config = configLoader()

      expect(config.logger.level).toBe('info')
      expect(warnSpy).toHaveBeenCalledWith(`Ignoring unknown environment variable: "${envKey}".`)
    }
  )

  it('should load and trim a secret from a file', () => {
    const secretPath = createTemporaryFile('  secret-from-file\n')
    process.env[`${ENVIRONMENT_PREFIX}AUTH_TOKEN_ACCESS_SECRET_FILE`] = secretPath

    expect(configLoader().auth.token.access.secret).toBe('secret-from-file')
  })

  it('should preserve the base configuration when its secret file cannot be read', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const secretFileKey = `${ENVIRONMENT_PREFIX}AUTH_TOKEN_ACCESS_SECRET_FILE`
    const temporaryDirectory = createTemporaryDirectory()
    const missingSecretPath = path.join(temporaryDirectory, 'missing-secret')
    const baseSecret = configLoader().auth.token.access.secret
    process.env[secretFileKey] = missingSecretPath

    const config = configLoader()

    expect(config.auth.token.access.secret).toBe(baseSecret)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`Unable to store secret from file ${missingSecretPath}`))
  })

  it('should merge an environment override without replacing sibling base configuration', () => {
    const baseSecret = configLoader().auth.token.access.secret
    process.env[`${ENVIRONMENT_PREFIX}AUTH_TOKEN_ACCESS_EXPIRATION`] = '10m'

    const accessToken = configLoader().auth.token.access

    expect(accessToken.expiration).toBe('10m')
    expect(accessToken.secret).toBe(baseSecret)
  })

  /* --------------------------------------------------- file versioning (fork) */

  // These four exist because for a while NONE of them worked. `getEnvOverrides`
  // validates every SYNCIN_* name against environment.dist.yaml, and
  // `applications.files.versions` was missing from that file — so every
  // versioning variable was discarded with a warning and no effect, including
  // the one that turns the feature OFF. On the Docker deployment that left the
  // whole feature configurable only by mounting a YAML file.
  //
  // The values below are deliberately NOT the defaults: an override that happens
  // to match the default proves nothing.
  it.each([
    ['ENABLED', 'true', (c: any) => c.applications.files.versions.enabled, true],
    ['MAXVERSIONSPERFILE', '7', (c: any) => c.applications.files.versions.maxVersionsPerFile, 7],
    ['QUOTASHARE', '0.25', (c: any) => c.applications.files.versions.quotaShare, 0.25],
    ['MININTERVALSECONDS', '1234', (c: any) => c.applications.files.versions.minIntervalSeconds, 1234],
    ['RETENTIONDAYS_USERS', '30', (c: any) => c.applications.files.versions.retentionDays.users, 30],
    ['MININTERVALSECONDSBYORIGIN_ONLYOFFICE', '42', (c: any) => c.applications.files.versions.minIntervalSecondsByOrigin.onlyoffice, 42]
  ])('should apply the versions override %s', (suffix, rawValue, read, expected) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const envKey = `${ENVIRONMENT_PREFIX}APPLICATIONS_FILES_VERSIONS_${suffix}`
    process.env[envKey] = rawValue

    expect(read(configLoader())).toBe(expected)
    // The failure mode this guards against is silent: the value is ignored and
    // only a console warning says so.
    expect(warnSpy).not.toHaveBeenCalledWith(`Ignoring unknown environment variable: "${envKey}".`)
  })

  // Documented defaults drifting from the code is the other half of the same
  // problem: this file is what an operator reads to learn what a setting does
  // and what it defaults to. Compared against the class rather than a literal so
  // changing a default in one place fails here rather than misinforming quietly.
  it('should document the file-versioning defaults exactly as the config class declares them', () => {
    const dist: any = yaml.load(fs.readFileSync(path.join(__dirname, '../../../environment/environment.dist.yaml'), 'utf8'))

    expect(dist.applications.files.versions).toEqual(instanceToPlain(new FilesVersionsConfig()))
  })

  function clearSyncInEnv() {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(ENVIRONMENT_PREFIX)) {
        delete process.env[key]
      }
    }
  }

  function createTemporaryFile(content: string): string {
    const temporaryDirectory = createTemporaryDirectory()
    const temporaryFile = path.join(temporaryDirectory, 'secret')
    fs.writeFileSync(temporaryFile, content)
    return temporaryFile
  }

  function createTemporaryDirectory(): string {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-in-config-loader-'))
    temporaryPaths.push(temporaryDirectory)
    return temporaryDirectory
  }
})
