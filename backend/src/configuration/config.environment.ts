import { join } from 'node:path'
import { getDocumentTypes } from '../applications/files/constants/samples'
import { FilesContentIndexingConfig } from '../applications/files/files.config'
import { AuthTokenAccessConfig, AuthTokenRefreshConfig } from '../authentication/auth.config'
import { ACCESS_KEY, CSRF_KEY, TWO_FA_VERIFY_EXPIRATION, WS_KEY } from '../authentication/constants/auth'
import { TOKEN_TYPE } from '../authentication/interfaces/token.interface'
import { transformAndValidate } from '../common/functions'
import { ServerConfig } from './config.interfaces'
import { ENVIRONMENT_PREFIX } from './config.constants'
import { configLoader } from './config.loader'
import { GlobalConfig } from './config.validation'

export const configuration: GlobalConfig = loadConfiguration()
export const serverConfig: ServerConfig = {
  twoFaEnabled: configuration.auth.mfa.totp.enabled,
  mailServerEnabled: !!configuration.mail?.host,
  files: {
    editors: {
      collabora: configuration.applications.files.editors.collabora.enabled,
      eurooffice: configuration.applications.files.editors.eurooffice.enabled,
      onlyoffice: configuration.applications.files.editors.onlyoffice.enabled
    },
    sampleDocuments: getDocumentTypes(configuration.applications.files.sampleDocuments)
  }
}
export const exportConfiguration: (reload?: boolean) => GlobalConfig = (reload = false) => (reload ? loadConfiguration() : configuration)

function loadConfiguration(): GlobalConfig {
  deprecatedFilesEditorsEnvConfig()
  removedDrawioUrlEnvConfig()
  const config: GlobalConfig = configLoader()
  // LOGGER
  if (config.logger?.stdout === false) {
    config.logger.colorize = false
  }
  // AUTHENTICATION
  // CSRF & WS & 2FA settings
  config.auth.token[TOKEN_TYPE.CSRF] = { ...config.auth.token[TOKEN_TYPE.REFRESH], name: CSRF_KEY } satisfies AuthTokenRefreshConfig
  config.auth.token[TOKEN_TYPE.WS] = { ...config.auth.token[TOKEN_TYPE.REFRESH], name: WS_KEY } satisfies AuthTokenRefreshConfig
  config.auth.token[TOKEN_TYPE.ACCESS_2FA] = {
    ...config.auth.token[TOKEN_TYPE.ACCESS],
    name: ACCESS_KEY,
    expiration: TWO_FA_VERIFY_EXPIRATION
  } satisfies AuthTokenAccessConfig
  config.auth.token[TOKEN_TYPE.CSRF_2FA] = {
    ...config.auth.token[TOKEN_TYPE.CSRF],
    expiration: TWO_FA_VERIFY_EXPIRATION
  } satisfies AuthTokenAccessConfig
  // APPLICATIONS CONFIGURATION
  // SPACES & FILES
  if (!config.applications.files.dataPath) {
    throw new Error('dataPath is not defined in environment.yaml')
  }
  config.applications.files.usersPath = join(config.applications.files.dataPath, 'users')
  config.applications.files.spacesPath = join(config.applications.files.dataPath, 'spaces')
  config.applications.files.linksPath = join(config.applications.files.dataPath, 'links')
  // DEPRECATIONS
  deprecatedFilesEditorsConfig(config)
  deprecatedFilesContentIndexingConfig(config)
  removedMaxVersionsPerFileConfig(config)

  return transformAndValidate(
    GlobalConfig,
    config,
    { exposeDefaultValues: true },
    { skipMissingProperties: false },
    'Invalid configuration in environment.yaml'
  )
}

// `DRAWIO_URL` was REMOVED in favour of applications.files.diagrams.editorUrl
// (#499). It has to be warned about EXPLICITLY, and it is the one removed
// setting in this file that cannot reuse any existing mechanism:
//
//  - it carries no ENVIRONMENT_PREFIX, so `config.loader` never looks at it and
//    its "Ignoring unknown environment variable" warning never fires;
//  - it never appeared in environment.yaml, so `removedMaxVersionsPerFileConfig`'s
//    "look for the key on the config object" shape finds nothing either.
//
// Silence here is not cosmetic. An operator who set `DRAWIO_URL` did so to keep
// diagram XML off a third party; after the upgrade the value is ignored, the
// default `https://embed.diagrams.net` applies, the CSP frame-src follows it,
// and NOTHING VISIBLY BREAKS while every diagram opened is posted to JGraph.
//
// The value is not auto-migrated: the replacement is validated as an http(s)
// URL and feeds the CSP, and quietly adopting an unvalidated legacy value would
// swap a loud misconfiguration for a silent one.
//
// EXPORTED only so it can be unit-tested, same as `removedMaxVersionsPerFileConfig`.
export function removedDrawioUrlEnvConfig(): void {
  if (process.env['DRAWIO_URL'] === undefined) {
    return
  }
  console.warn(
    '[REMOVED][ENVIRONMENT] "DRAWIO_URL" is no longer read and has been IGNORED. ' +
      'The diagram editor location is now applications.files.diagrams.editorUrl in environment.yaml, ' +
      `or the environment variable "${ENVIRONMENT_PREFIX}APPLICATIONS_FILES_DIAGRAMS_EDITORURL" ` +
      '(one segment: EDITORURL, not EDITOR_URL). ' +
      'Until you set it, diagrams are opened in the default third-party editor https://embed.diagrams.net.'
  )
}

function deprecatedFilesEditorsEnvConfig(): void {
  for (const editor of ['ONLYOFFICE', 'COLLABORA']) {
    const deprecatedPrefix = `${ENVIRONMENT_PREFIX}APPLICATIONS_FILES_${editor}_`
    const currentPrefix = `${ENVIRONMENT_PREFIX}APPLICATIONS_FILES_EDITORS_${editor}_`

    for (const [deprecatedEnvKey, value] of Object.entries(process.env)) {
      if (!deprecatedEnvKey.startsWith(deprecatedPrefix) || value === undefined) {
        continue
      }

      const suffix = deprecatedEnvKey.slice(deprecatedPrefix.length)
      const currentEnvKey = `${currentPrefix}${suffix}`
      const alternateCurrentEnvKey = suffix.endsWith('_FILE') ? `${currentPrefix}${suffix.slice(0, -5)}` : `${currentEnvKey}_FILE`
      const configuredCurrentEnvKey = [currentEnvKey, alternateCurrentEnvKey].find((key) => process.env[key] !== undefined)

      if (configuredCurrentEnvKey) {
        console.warn(`Ignoring deprecated environment variable: "${deprecatedEnvKey}" because "${configuredCurrentEnvKey}" is set.`)
        continue
      }

      process.env[currentEnvKey] = value
      console.warn(`Environment variable "${deprecatedEnvKey}" is deprecated. Please use "${currentEnvKey}" instead.`)
    }
  }
}

function deprecatedFilesEditorsConfig(config: GlobalConfig): void {
  const files = config.applications.files as unknown as Record<string, any>
  const legacyEditors = ['onlyoffice', 'collabora'].filter((editor) => Object.prototype.hasOwnProperty.call(files, editor))

  if (legacyEditors.length === 0) {
    return
  }

  files.editors ??= {}
  for (const editor of legacyEditors) {
    const legacyConfig = files[editor]
    const currentConfig = files.editors[editor]
    files.editors[editor] =
      legacyConfig && currentConfig && typeof legacyConfig === 'object' && typeof currentConfig === 'object'
        ? { ...legacyConfig, ...currentConfig }
        : (currentConfig ?? legacyConfig)
    delete files[editor]
  }

  console.warn(
    '[DEPRECATED][CONFIGURATION] applications.files.onlyoffice and applications.files.collabora are deprecated and will be removed in a future version. ' +
      'Please use applications.files.editors.onlyoffice and applications.files.editors.collabora instead.'
  )
}

function deprecatedFilesContentIndexingConfig(config: GlobalConfig): void {
  // applications.files.contentIndexing → applications.files.contentIndexing.enabled
  if (typeof config.applications.files.contentIndexing !== 'boolean') {
    return
  }

  const filesContentIndexingConfig = new FilesContentIndexingConfig()
  filesContentIndexingConfig.enabled = config.applications.files.contentIndexing
  config.applications.files.contentIndexing = filesContentIndexingConfig
  console.warn(
    '[DEPRECATED][CONFIGURATION] applications.files.contentIndexing is deprecated and will be removed in a future version. ' +
      'Please use applications.files.contentIndexing.enabled instead.'
  )
}

// applications.files.versions.maxVersionsPerFile was REMOVED: age-tiered thinning
// replaced the per-file FIFO cap
// (docs/superpowers/specs/2026-07-29-version-thinning-design.md).
//
// Warned about rather than ignored, because ignoring it is SILENT here. Config
// validation runs with no `whitelist`/`forbidNonWhitelisted`, so an unknown yaml
// key is simply dropped and the operator's retention behaviour changes with no
// signal — the #384 failure class. (The env-var form is already loud: its path is
// validated against environment.dist.yaml, which logs "Ignoring unknown
// environment variable".) Deleted from the object as well as warned about, since
// plainToInstance would otherwise copy it onto the instance as an untyped field.
//
// EXPORTED only so it can be unit-tested: the env path is rejected before a
// config object exists and the yaml path would need a fixture on disk, so a
// direct call is the only way to exercise it. The sibling deprecatedFiles*
// helpers stay private because nothing about them is testable either way.
export function removedMaxVersionsPerFileConfig(config: GlobalConfig): void {
  const versions = config.applications?.files?.versions as unknown as Record<string, unknown> | undefined
  if (!versions || !('maxVersionsPerFile' in versions)) {
    return
  }
  delete versions.maxVersionsPerFile
  console.warn(
    '[REMOVED][CONFIGURATION] applications.files.versions.maxVersionsPerFile no longer applies and has been ignored. ' +
      'Version history is now shaped by age-tiered thinning and bounded by applications.files.versions.quotaShare ' +
      'and applications.files.versions.retentionDays.'
  )
}
