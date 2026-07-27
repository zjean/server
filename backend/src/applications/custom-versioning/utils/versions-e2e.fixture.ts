import { NestFastifyApplication } from '@nestjs/platform-fastify'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { appBootstrap } from '../../../app.bootstrap'
import { API_AUTH_LOGIN } from '../../../authentication/constants/routes'
import { configuration } from '../../../configuration/config.environment'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import type { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import type { FilesVersionsConfig } from '../../files/files.config'
import { FilesManager } from '../../files/services/files-manager.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import { NcAppPasswordService } from '../../custom-mobile-compat/services/nc-app-password.service'
import { USER_PERMISSION, USER_PERMS_SEP, USER_ROLE } from '../../users/constants/user'
import { UserModel } from '../../users/models/user.model'
import { AdminUsersManager } from '../../users/services/admin-users-manager.service'
import { generateUserTest } from '../../users/utils/test'
import { VERSIONS_STAGING_DIR } from '../constants/versioning'
import type { VersionOrigin, VersionProps } from '../interfaces/version.interface'
import { VersioningQueries } from '../services/versioning-queries.service'
import { VersioningService } from '../services/versioning.service'
import { VersionsRetention } from '../services/versions-retention.service'
import {
  API_VERSIONS_CONTENT,
  API_VERSIONS_DELETE,
  API_VERSIONS_DIFF,
  API_VERSIONS_LABEL,
  API_VERSIONS_LIST,
  API_VERSIONS_RESTORE,
  API_VERSIONS_USAGE
} from '../constants/routes'

// Shared harness for the Phase E versioning e2e suite. TEST-ONLY code living in
// src/, following the precedent of users/utils/test.ts.
//
// It exists because four environment facts cost a session to discover and would
// cost the next one the same:
//
//  1. A TEST USER NEEDS `permissions`, NOT `applications`. The DB column is
//     `users.permissions` — a comma-joined varchar — and `UserModel` derives its
//     `applications` string[] from it at construction. `generateUserTest()` sets
//     `applications`, which is not a column, so a user created straight from it
//     lands with `permissions = ''`. Everything then 403s: SpaceGuard's
//     `canAccessToSpaceUrl` needs `personal_space`, and WebDAV needs
//     `webdav_access`. The symptom is a 403 "You are not allowed to access to
//     this repository" on a request that looks perfectly authenticated, which
//     reads like a bug in the feature under test.
//  2. WRITES NEED THE CSRF HEADER. Login sets four cookies; non-safe methods
//     also require `sync-in-csrf` echoed as a header (auth.service.ts
//     csrfValidation). Without it a restore is a 403, asserted in the suite so
//     the requirement is documented rather than folklore.
//  3. THE ROUTE CONSTANTS ALREADY CARRY THE `/api/app/spaces` PREFIX. Adding
//     one produces a 404 that looks like a missing route.
//  4. `configuration` IS A PROCESS SINGLETON shared by every spec in the run.
//     A case that flips `enabled` or `minIntervalSeconds` must restore it, so
//     the fixture snapshots the versions block and `restoreConfig()` puts it
//     back.
//
// The suite deliberately mixes two levels, and the split is not laziness:
//   - HTTP (app.inject) for the versions REST API, because guards, the
//     ValidationPipe and the exception filter are exactly where the bugs in
//     PR #322 lived, and a service-level call would have missed both.
//   - Service-level for PRODUCING writes, because the seven destructive entry
//     points are reached over five different protocols and fabricating each
//     one's transport would test the transport rather than the hook.

export interface VersionsE2EContext {
  app: NestFastifyApplication
  db: DBSchema
  user: UserModel
  versioning: VersioningService
  versioningQueries: VersioningQueries
  retention: VersionsRetention
  filesManager: FilesManager
  spacesManager: SpacesManager
  config: FilesVersionsConfig

  /** Absolute path inside the user's files repository. */
  filesPath: (rel?: string) => string
  /** Absolute path inside the user's versions store (a SIBLING of files/). */
  versionsPath: (rel?: string) => string
  /** Every blob currently in the store, excluding the staging directory. */
  blobs: () => Promise<string[]>
  /** Write a file directly, as an upload would leave it. Creates parents. */
  seed: (rel: string, content: string) => Promise<void>
  /** Resolve the SpaceEnv for a personal-space path. */
  spaceEnv: (rel: string) => Promise<SpaceEnv>
  /** Overwrite through the real saveStream write path, so the hooks run. */
  overwrite: (rel: string, content: string, origin?: VersionOrigin) => Promise<void>
  /** Version rows for a path, newest first, straight from the service. */
  versionsOf: (rel: string) => Promise<VersionProps[]>

  api: VersionsApi
  /**
   * Authorization header for the NC-compat route tree.
   *
   * NcBasicAuthGuard accepts ONLY app-passwords scoped to AUTH_SCOPE.MOBILE_NC
   * and deliberately rejects the user's main login password — matching
   * Nextcloud's own posture. So an NC-route test cannot reuse the Basic header
   * that works for WebDAV; it needs a minted credential.
   */
  ncAuth: string
  restoreConfig: () => void
  teardown: () => Promise<void>
}

export interface VersionsApi {
  list: (rel: string) => Promise<{ status: number; body: VersionProps[] }>
  usage: (rel: string) => Promise<{ status: number; body: { used: number; ceiling: number | null; count: number } }>
  content: (versionId: number, rel: string) => Promise<{ status: number; body: string; headers: Record<string, unknown> }>
  restore: (versionId: number, rel: string, opts?: { csrf?: boolean }) => Promise<{ status: number; body: string }>
  label: (versionId: number, rel: string, label: string | null) => Promise<{ status: number; body: string }>
  remove: (versionId: number, rel: string, query?: string) => Promise<{ status: number; body: string }>
  diff: (versionId: number, rel: string, query?: string) => Promise<{ status: number; body: string }>
}

export async function setupVersionsE2E(): Promise<VersionsE2EContext> {
  const app = await appBootstrap()
  await app.init()
  await app.getHttpAdapter().getInstance().ready()

  const admin = app.get(AdminUsersManager)
  const user = await admin.createUserOrGuest(
    // See note (1): `permissions` is the column; `applications` is derived.
    { ...generateUserTest(false), permissions: Object.values(USER_PERMISSION).join(USER_PERMS_SEP) } as never,
    USER_ROLE.USER
  )

  const login = await app.inject({ method: 'POST', url: API_AUTH_LOGIN, body: { login: user.login, password: 'password' } })
  if (login.statusCode !== 201) {
    throw new Error(`versions e2e fixture: login failed with ${login.statusCode} — ${login.body}`)
  }
  const setCookies = login.headers['set-cookie'] as string[]
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
  const csrf = setCookies
    .find((c) => c.startsWith('sync-in-csrf='))
    ?.split(';')[0]
    .split('=')
    .slice(1)
    .join('=')
  if (!csrf) throw new Error('versions e2e fixture: no csrf cookie in the login response')

  const config = configuration.applications.files.versions
  // See note (4): one process, one config object, many spec files.
  const configSnapshot = JSON.parse(JSON.stringify(config)) as FilesVersionsConfig

  const filesRoot = UserModel.getFilesPath(user.login)
  const versionsRoot = path.join(UserModel.getHomePath(user.login), 'versions')
  const filesPath = (rel = '') => (rel ? path.join(filesRoot, rel) : filesRoot)
  const versionsPath = (rel = '') => (rel ? path.join(versionsRoot, rel) : versionsRoot)

  const spacesManager = app.get(SpacesManager)
  const filesManager = app.get(FilesManager)
  const versioning = app.get(VersioningService)

  const spaceEnv = (rel: string) => spacesManager.spaceEnv(user, ['files', 'personal', ...rel.split('/').filter(Boolean)])

  // See note (3): the constants already carry the prefix.
  const url = (base: string, rel: string, versionId?: number) =>
    versionId === undefined ? `${base}/files/personal/${rel}` : `${base}/${versionId}/files/personal/${rel}`

  // See note (2): non-safe methods need the csrf header as well as the cookie.
  const write = async (method: 'POST' | 'PATCH' | 'DELETE', target: string, body?: unknown, opts?: { csrf?: boolean }) => {
    const res = await app.inject({
      method,
      url: target,
      headers: { cookie, ...(opts?.csrf === false ? {} : { 'sync-in-csrf': csrf }) },
      ...(body === undefined ? {} : { body })
    } as never)
    return { status: res.statusCode, body: res.body }
  }

  const api: VersionsApi = {
    async list(rel) {
      const res = await app.inject({ method: 'GET', url: url(API_VERSIONS_LIST, rel), headers: { cookie } } as never)
      return { status: res.statusCode, body: res.statusCode === 200 ? (res.json() as VersionProps[]) : [] }
    },
    async usage(rel) {
      const res = await app.inject({ method: 'GET', url: url(API_VERSIONS_USAGE, rel), headers: { cookie } } as never)
      return { status: res.statusCode, body: res.statusCode === 200 ? res.json() : { used: 0, ceiling: null, count: 0 } }
    },
    async content(versionId, rel) {
      const res = await app.inject({ method: 'GET', url: url(API_VERSIONS_CONTENT, rel, versionId), headers: { cookie } } as never)
      return { status: res.statusCode, body: res.body, headers: res.headers as Record<string, unknown> }
    },
    restore: (versionId, rel, opts) => write('POST', url(API_VERSIONS_RESTORE, rel, versionId), undefined, opts),
    label: (versionId, rel, label) => write('PATCH', url(API_VERSIONS_LABEL, rel, versionId), { label }),
    remove: (versionId, rel, query) => write('DELETE', `${url(API_VERSIONS_DELETE, rel, versionId)}${query ?? ''}`),
    async diff(versionId, rel, query) {
      const res = await app.inject({ method: 'GET', url: `${url(API_VERSIONS_DIFF, rel, versionId)}${query ?? ''}`, headers: { cookie } } as never)
      return { status: res.statusCode, body: res.body }
    }
  }

  // Mint the NC app-password up front so NC-route specs have a working
  // credential without each one rediscovering that the main password is refused.
  const minted = await app.get(NcAppPasswordService).mintMobileAppPassword(user, 'versions-e2e')
  const ncAuth = `Basic ${Buffer.from(`${user.login}:${minted.password}`).toString('base64')}`

  return {
    app,
    ncAuth,
    db: app.get<DBSchema>(DB_TOKEN_PROVIDER),
    user,
    versioning,
    versioningQueries: app.get(VersioningQueries),
    retention: app.get(VersionsRetention),
    filesManager,
    spacesManager,
    config,
    filesPath,
    versionsPath,
    async blobs() {
      const found: string[] = []
      const walk = async (dir: string) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.name === VERSIONS_STAGING_DIR) continue
          const p = path.join(dir, entry.name)
          if (entry.isDirectory()) await walk(p)
          else found.push(p)
        }
      }
      await walk(versionsRoot)
      return found.sort()
    },
    async seed(rel, content) {
      await fs.mkdir(path.dirname(filesPath(rel)), { recursive: true })
      await fs.writeFile(filesPath(rel), content)
    },
    spaceEnv,
    async overwrite(rel, content, origin: VersionOrigin = 'web') {
      const space = await spaceEnv(rel)
      await filesManager.saveStream(
        user,
        space,
        { method: 'PUT', headers: {}, raw: Readable.from([content]) } as never,
        {
          versionOrigin: origin
        } as never
      )
    },
    async versionsOf(rel) {
      return versioning.listVersions(user, await spaceEnv(rel))
    },
    api,
    restoreConfig() {
      Object.assign(config, JSON.parse(JSON.stringify(configSnapshot)))
    },
    async teardown() {
      Object.assign(config, JSON.parse(JSON.stringify(configSnapshot)))
      if (user?.id) {
        await admin.deleteUserOrGuest(user.id, user.login, { deleteSpace: true, isGuest: false } as never)
      }
      await app.close()
    }
  }
}
