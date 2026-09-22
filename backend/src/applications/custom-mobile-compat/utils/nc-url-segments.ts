import { SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import type { UserModel } from '../../users/models/user.model'
import { NcPathResolverService, normalizeNcSubpath, type NcPathInput } from '../services/nc-path-resolver.service'
import type { NcShareMount, NcShareMountResolverService } from '../services/nc-share-mount-resolver.service'

// Resolve an NC subpath into Sync-in spaceEnv segments — i.e.
// [repository, spaceAlias, ...path], consumable by SpacesManager.spaceEnv.
//
// This used to be a private method on NcDavController, which is why
// NcUploadsController did not have it: the chunked-upload assembly called
// NcPathResolverService.resolve() directly, so `Destination:
// /remote.php/dav/files/alice/TeamShare/big.iso` resolved to
// ['files','personal','TeamShare','big.iso'] and wrote into the user's home
// while the follow-up PROPFIND of the same URL read the SHARE. Small files
// landed in the share, large ones vanished (#516). Both controllers now
// address a path the same way, because there is now only one way.
//
// Tries the share-mount alias first: if the subpath's first segment matches
// one of the user's incoming shares, route into the shares repository.
// Otherwise fall through to NcPathResolverService for the user's home setting
// (personal or mobileHome-configured space).
//
// Edge case: a share alias that collides with a real folder in the user's
// personal/home space — the share wins (matches real NC behaviour for
// recipient-side mountpoints). The personal-space folder remains reachable
// via Sync-in's native /webdav route, just not via NC mobile.
//
// `getMounts` is an optional request-scope memo. When provided, the share
// listing is fetched at most once per request even when two call sites need
// it (the COPY/MOVE flow).
//
// Returns null when the subpath is not addressable — see
// NcPathResolverService.resolve.
export async function buildNcUrlSegments(
  deps: { resolver: NcPathResolverService; shareMounts: NcShareMountResolverService },
  user: UserModel,
  input: NcPathInput,
  getMounts?: NcMountsMemo
): Promise<string[] | null> {
  const normalized = normalizeNcSubpath(input.subpath)
  if (normalized === null) return null

  if (input.mode === 'files' && normalized) {
    const parts = normalized.split('/').filter(Boolean)
    const firstSeg = parts[0]
    if (firstSeg) {
      const mounts = getMounts ? await getMounts() : await deps.shareMounts.listMounts(user)
      const mount = mounts.find((m) => m.alias === firstSeg) ?? null
      if (mount) {
        return [SPACE_REPOSITORY.SHARES, mount.alias, ...parts.slice(1)]
      }
    }
  }

  const resolved = deps.resolver.resolve(user, input)
  if (!resolved) return null
  const segs: string[] = [resolved.repository, resolved.spaceAlias]
  if (resolved.rootAlias) segs.push(resolved.rootAlias)
  if (resolved.relativePath) segs.push(...resolved.relativePath.split('/').filter(Boolean))
  return segs
}

// Request-scope memo for the user's incoming share-mounts. First call hits
// the DB via NcShareMountResolverService.listMounts; subsequent calls return
// the cached promise. Resolvers themselves stay stateless — caching lives at
// the request boundary (the controller method that created the memo).
export type NcMountsMemo = () => Promise<NcShareMount[]>

export function makeMountsMemo(resolver: NcShareMountResolverService, user: UserModel): NcMountsMemo {
  let p: Promise<NcShareMount[]> | undefined
  return () => (p ??= resolver.listMounts(user))
}
