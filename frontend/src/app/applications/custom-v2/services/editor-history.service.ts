import { HttpClient, HttpErrorResponse } from '@angular/common/http'
import { inject, Injectable } from '@angular/core'
import {
  API_VERSIONS_EDITOR_HISTORY,
  API_VERSIONS_EDITOR_RESTORE,
  API_VERSIONS_EDITOR_VERSION
} from '@sync-in-server/backend/src/applications/custom-versioning/constants/routes'
import type {
  EditorHistoryEntry,
  EditorVersionData
} from '@sync-in-server/backend/src/applications/custom-versioning/interfaces/editor-history.interface'
import { ONLY_OFFICE_TOKEN_QUERY_PARAM_NAME } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.constants'
import { encodeUrl } from '@sync-in-server/backend/src/common/shared'
import { firstValueFrom, Observable } from 'rxjs'
import type {
  OnlyOfficeHistoryData,
  OnlyOfficeHistoryEditor,
  OnlyOfficeHistoryHooks,
  OnlyOfficeHistoryRow
} from '../models/only-office-history.model'

/**
 * Version history INSIDE the OnlyOffice / Euro-Office editor.
 *
 * Distinct from `VersionsService`, which backs our own versions panel on the
 * file-detail screen. This one speaks the document server's protocol: the editor
 * raises four events, and each one is answered by fetching from the matching
 * backend route and calling a method on the `DocEditor` instance. Route shapes,
 * ordinals and payloads all belong to that protocol — see
 * `custom-versioning/interfaces/editor-history.interface.ts` for the citations.
 *
 * Path handling mirrors `VersionsService`: callers pass the plain decoded space
 * path and this service encodes it, once.
 *
 * Authorization is entirely server-side. Nothing here decides who may restore;
 * the backend route carries MODIFY, so a read-only member is refused even if a
 * caller wired the hooks up anyway.
 */
@Injectable({ providedIn: 'root' })
export class EditorHistoryService {
  private readonly http = inject(HttpClient)

  history(spacePath: string): Observable<EditorHistoryEntry[]> {
    return this.http.get<EditorHistoryEntry[]>(`${API_VERSIONS_EDITOR_HISTORY}/${encodeUrl(spacePath)}`)
  }

  /**
   * Render inputs for one ordinal.
   *
   * `officeToken` is the ONLY_OFFICE JWT lifted out of the editor config's
   * document url — see `officeTokenFrom`. It is required because the `url` in the
   * response is fetched by the DOCUMENT SERVER, which has no session with us.
   */
  version(spacePath: string, ordinal: number, officeToken: string): Observable<EditorVersionData> {
    return this.http.get<EditorVersionData>(`${API_VERSIONS_EDITOR_VERSION}/${ordinal}/${encodeUrl(spacePath)}`, { params: { officeToken } })
  }

  // Answers with the REFRESHED history, so the caller can hand it straight back
  // to the panel without a second round trip.
  restore(spacePath: string, ordinal: number): Observable<EditorHistoryEntry[]> {
    return this.http.post<EditorHistoryEntry[]>(`${API_VERSIONS_EDITOR_RESTORE}/${ordinal}/${encodeUrl(spacePath)}`, null)
  }

  /**
   * The ONLY_OFFICE token the editor config already carries.
   *
   * `OnlyOfficeManager.getSettings` mints one per session and appends it to the
   * document url it hands the page (`only-office-manager.service.ts:258-262`), so
   * the page already holds exactly the credential the document server needs. This
   * lifts it rather than asking the server for a second one, because
   * `genAuthToken` is private and exposing it would be another edit to an
   * upstream file for a token that already exists.
   *
   * Returns null when the url has no token, which is the honest signal that the
   * panel cannot work for this session — the caller then leaves the hooks off
   * instead of wiring handlers that would fetch urls the document server rejects.
   */
  officeTokenFrom(documentUrl: string | undefined): string | null {
    if (!documentUrl) return null
    try {
      // A relative url is legitimate here, so a base is required for parsing; it
      // is never used, since only the query string is read.
      return new URL(documentUrl, 'https://placeholder.invalid').searchParams.get(ONLY_OFFICE_TOKEN_QUERY_PARAM_NAME)
    } catch {
      return null
    }
  }

  /**
   * The four handlers, bound to one open document.
   *
   * A factory rather than four public methods because the editor calls them with
   * no context of its own: each needs the space path, the token and a way to
   * reach the `DocEditor` instance, and threading those through the component on
   * every event is how the ordinal/token plumbing gets subtly wrong.
   *
   * `editor()` is resolved lazily on each call, not captured: the instance lives
   * in `window.DocEditor.instances[id]` and is replaced whenever the component
   * re-mounts, so a captured reference would address a destroyed editor after a
   * restore.
   *
   * `onRestored` fires after a successful restore, and the caller MUST re-mount
   * the editor in response — see the note on the handler.
   */
  hooksFor(opts: {
    spacePath: string
    officeToken: string
    editor: () => OnlyOfficeHistoryEditor | undefined
    locale: string
    onRestored?: () => void
    onError?: (e: unknown) => void
  }): OnlyOfficeHistoryHooks {
    const { spacePath, officeToken, editor, locale } = opts

    // Every entry's `created` becomes a locale string before the editor sees it,
    // because the editor displays this text rather than parsing it
    // (`editor.js:734-735`). The server sends unix SECONDS, hence the ×1000.
    const formatter = new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'short', timeStyle: 'medium' })
    const toPanelData = (entries: EditorHistoryEntry[]): OnlyOfficeHistoryData => ({
      // The maximum ordinal, which the live entry is — the server appends it last
      // precisely so "current" has something to point at.
      currentVersion: entries.reduce((max, e) => Math.max(max, e.version), 0),
      history: entries.map((e): OnlyOfficeHistoryRow => ({ ...e, created: formatter.format(new Date(e.created * 1000)) }))
    })

    // The editor renders whatever `error` string it is handed, so a failure shows
    // up in the panel instead of as a spinner that never resolves.
    const fail = (e: unknown): string => {
      opts.onError?.(e)
      return e instanceof HttpErrorResponse ? (e.error?.message ?? e.statusText ?? 'Request failed') : 'Request failed'
    }

    return {
      onRequestHistory: async () => {
        try {
          editor()?.refreshHistory(toPanelData(await firstValueFrom(this.history(spacePath))))
        } catch (e) {
          editor()?.refreshHistory({ error: fail(e) })
        }
      },

      onRequestHistoryData: async (event) => {
        // The ordinal is `event.data` here and `event.data.version` in
        // onRequestRestore below. Upstream's inconsistency, not ours.
        const version = event?.data
        try {
          editor()?.setHistoryData(await firstValueFrom(this.version(spacePath, version, officeToken)))
        } catch (e) {
          // Shaped this way on upstream's precedent (`editor.js:244-249`): the
          // editor needs the ordinal back to know which row failed.
          editor()?.setHistoryData({ error: fail(e), version })
        }
      },

      onRequestRestore: async (event) => {
        try {
          const refreshed = await firstValueFrom(this.restore(spacePath, event?.data?.version))
          editor()?.refreshHistory(toPanelData(refreshed))
          // NOT optional, and not cosmetic. A restore replaces the live bytes and
          // invalidates the cached document key server-side (invariant 7, #378) —
          // but the config in THIS page still carries the old key. Left alone, the
          // editor keeps editing pre-restore content under a key the document
          // server still recognises, and the next save writes that content back
          // over the restore. Upstream solves it with `location.reload()`; the
          // caller re-mounts instead.
          opts.onRestored?.()
        } catch (e) {
          editor()?.refreshHistory({ error: fail(e) })
        }
      },

      // Upstream does `location.reload(true)` (`editor.js:268`). Doing that here
      // would discard the whole v2 SPA — its route, its file list, any other open
      // panel — to solve a problem that only exists after a restore, which
      // `onRestored` already handles at the moment it happens. So closing the
      // panel is deliberately inert.
      onRequestHistoryClose: () => undefined
    }
  }
}
