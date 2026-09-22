import { CACHE_AUTH_WEBDAV_PREFIX } from '../../../authentication/constants/cache'
import { AUTH_SCOPE } from '../../../authentication/constants/scope'

// Cache key prefix for the fork's NC Basic-auth positive cache. Owned by
// NcBasicAuthGuard, declared here because UsersManager.deleteAppPassword has
// to be able to invalidate it — and that is an upstream file, which should
// not reach into a feature module.
export const CACHE_AUTH_NC_MOBILE_PREFIX = 'auth-nc-mobile' as const

// Every AUTH_SCOPE whose successful Basic-auth result is CACHED, mapped to the
// prefix it is cached under.
//
// This exists because revoking a credential has to evict the cache that
// credential populated, and the eviction cannot be keyed on the credential:
// the caller of a delete holds a name, not the cleartext, and the key is
// sha256(login + password). Upstream's answer is to scan the prefix and drop
// every entry whose cached user id matches — which works for any scope that
// caches the same shape. The map is what makes "which prefixes are there?" a
// single fact rather than a chain of `if (scope === …)`.
//
// A scope absent here caches nothing, so there is nothing to evict
// (AUTH_SCOPE.CLIENT).
export const CACHED_AUTH_SCOPE_PREFIXES: Partial<Record<AUTH_SCOPE, string>> = {
  [AUTH_SCOPE.WEBDAV]: CACHE_AUTH_WEBDAV_PREFIX,
  [AUTH_SCOPE.MOBILE_NC]: CACHE_AUTH_NC_MOBILE_PREFIX
}
