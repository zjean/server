import { HttpService } from '@nestjs/axios'
import { Injectable, Logger } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import https from 'node:https'
import { Cache } from '../../../infrastructure/cache/cache.service'
import { activeOfficeEditorConfig } from '../../custom-shared/utils/active-office-editor'
import { onlyOfficeDocKeyCacheKey } from '../../custom-shared/utils/only-office-doc-key'
import type { SpaceEnv } from '../../spaces/models/space-env.model'

// Issues a `forcesave` command to the active OnlyOffice-protocol document
// server (OnlyOffice or Euro-Office). Used by the
// /index.php/apps/onlyoffice/save endpoint so the mobile app's "Save" button
// produces an immediate persist instead of waiting for the doc server's
// autosave timer (default 1–2 minutes — bounded but surprising window for
// users hitting Save explicitly).
//
// Pure composition of primitives: cache to read the document key Sync-in's
// OnlyOfficeManager already minted at /config time, JwtService to sign the
// command payload with the active editor's `secret`, HttpService for the POST.
// No upstream modification needed.
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
    // Which document server is actually active. Euro-Office speaks the same
    // OnlyOffice protocol and only one of the two can be on, so this mirrors the
    // selection OnlyOfficeManager makes (only-office-manager.service.ts:82-85)
    // rather than reading `onlyoffice` unconditionally — on a Euro-Office
    // deployment that read left externalServer null and every mobile Save
    // returned 'doc server not configured'.
    //
    // The expression itself lives in custom-shared because a second fork caller
    // now needs the same choice for the same reason: EditorHistoryService signs
    // the editor's version responses with this secret.
    const oo = activeOfficeEditorConfig()
    const externalServer = oo?.externalServer
    if (!externalServer) {
      return { ok: false, reason: 'doc server not configured' }
    }

    // Read the cached document key OnlyOfficeManager.getDocumentKey set when
    // /config was answered. Cache key format is identical so we can peek
    // without going through the manager — see onlyOfficeDocKeyCacheKey for why
    // the format lives in custom-shared rather than being rebuilt here. If the
    // cache has dropped the key, there's no active doc-server session to
    // forcesave anyway — return ok so the mobile UI doesn't surface a spurious
    // error.
    const docKey = await this.cache.get(onlyOfficeDocKeyCacheKey(space.dbFile))
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
