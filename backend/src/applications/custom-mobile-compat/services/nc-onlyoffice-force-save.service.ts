import { HttpService } from '@nestjs/axios'
import { Injectable, Logger } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import https from 'node:https'
import { configuration } from '../../../configuration/config.environment'
import { Cache } from '../../../infrastructure/cache/services/cache.service'
import { ONLY_OFFICE_CACHE_KEY } from '../../files/modules/only-office/only-office.constants'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import { genUniqHashFromFileDBProps } from '../../files/utils/files'

// Issues a `forcesave` command to the OnlyOffice document server. Used by the
// /index.php/apps/onlyoffice/save endpoint so the mobile app's "Save" button
// produces an immediate persist instead of waiting for the doc server's
// autosave timer (default 1–2 minutes — bounded but surprising window for
// users hitting Save explicitly).
//
// Pure composition of primitives: cache to read the document key Sync-in's
// OnlyOfficeManager already minted at /config time, JwtService to sign the
// command payload with applications.files.onlyoffice.secret, HttpService for
// the POST. No upstream modification needed.
//
// On success the doc server immediately re-invokes our /track callback with
// status 6 (force-save complete) — that's the path real persistence runs
// through. We don't wait for /track; the command POST only confirms the
// doc server received the trigger.
@Injectable()
export class NcOnlyOfficeForceSaveService {
  private readonly logger = new Logger(NcOnlyOfficeForceSaveService.name)

  constructor(
    private readonly cache: Cache,
    private readonly jwt: JwtService,
    private readonly http: HttpService
  ) {}

  async forceSave(space: SpaceEnv): Promise<{ ok: boolean; reason?: string }> {
    const oo = configuration.applications.files.onlyoffice
    const externalServer = oo?.externalServer
    if (!externalServer) {
      return { ok: false, reason: 'doc server not configured' }
    }

    // Read the cached document key OnlyOfficeManager.getDocumentKey set when
    // /config was answered. Cache key format is identical so we can peek
    // without going through the manager. If the cache has dropped the key,
    // there's no active doc-server session to forcesave anyway — return ok
    // so the mobile UI doesn't surface a spurious error.
    const cacheKey = `${ONLY_OFFICE_CACHE_KEY}|${genUniqHashFromFileDBProps(space.dbFile)}`
    const docKey = await this.cache.get(cacheKey)
    if (!docKey) {
      return { ok: true, reason: 'no active session' }
    }

    const cmd = { c: 'forcesave', key: String(docKey) }
    const token = await this.jwt.signAsync(cmd, { secret: oo.secret, expiresIn: 60 })
    const payload = { ...cmd, token }

    const rejectUnauthorized = !oo.verifySSL
    try {
      await this.http.axiosRef({
        method: 'POST',
        url: `${externalServer}/coauthoring/CommandService.ashx`,
        data: payload,
        httpsAgent: new https.Agent({ rejectUnauthorized })
      })
      return { ok: true }
    } catch (e: any) {
      const reason = String(e?.message ?? e)
      this.logger.warn({ tag: this.forceSave.name, msg: `forcesave failed: ${reason}` })
      return { ok: false, reason }
    }
  }
}
