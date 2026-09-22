import type { Cache } from '../../../infrastructure/cache/cache.service'
import type { CacheRateLimitResult } from '../../../infrastructure/cache/interfaces/cache-rate-limit.interface'

// A working in-memory stand-in for `Cache`, for specs of code that keeps state
// there rather than in the process.
//
// It exists because a `vi.fn()` mock cannot express the property those specs
// need to prove. `NcLoginFlowService` is replica-safe precisely BECAUSE its
// state round-trips through the cache and `del` reports whether the caller was
// the one that removed a key (#482); a mock that returns whatever the test
// tells it to would go green against a service that never wrote anything.
// This double stores, serializes and expires for real, so only a service that
// genuinely keeps its state in the cache passes.
//
// Deliberately faithful on three points that have bitten callers:
//   - values round-trip through JSON, so a caller cannot rely on holding the
//     same object reference back (the whole hazard of moving off a Map);
//   - `set(key, value, 0)` means NEVER EXPIRE, per the Cache contract;
//   - `del` returns false when the key was already gone, which is what makes
//     it usable as an exactly-once gate.
export interface InMemoryCache extends Cache {
  // Move the fake clock forward, in milliseconds, to test expiry without
  // touching real timers.
  advance(ms: number): void
  size(): number
}

export function createInMemoryCache(): InMemoryCache {
  const store = new Map<string, { value: string; expiresAt: number }>()
  let offsetMs = 0
  const now = () => Date.now() + offsetMs

  const live = (key: string): { value: string; expiresAt: number } | undefined => {
    const entry = store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== Infinity && entry.expiresAt <= now()) {
      store.delete(key)
      return undefined
    }
    return entry
  }

  const cache: InMemoryCache = {
    defaultTTL: 600,
    infiniteExpiration: -1,
    onModuleInit: () => undefined,
    onModuleDestroy: () => undefined,
    advance: (ms: number) => {
      offsetMs += ms
    },
    size: () => {
      for (const key of [...store.keys()]) live(key)
      return store.size
    },
    has: async (key: string) => !!live(key),
    keys: async (pattern: string) => {
      const rx = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : `\\${c}`))}$`)
      return [...store.keys()].filter((k) => !!live(k) && rx.test(k))
    },
    get: async (key: string) => {
      const entry = live(key)
      return entry === undefined ? undefined : JSON.parse(entry.value)
    },
    mget: async (keys: string[]) => Promise.all(keys.map((k) => cache.get(k))),
    increment: async (key: string, amount = 1) => {
      const current = Number((await cache.get(key)) ?? 0) + amount
      await cache.set(key, current, 0)
      return current
    },
    consumeRateLimit: async (key: string, ttl: number, limit: number, blockDuration: number): Promise<CacheRateLimitResult> => {
      const state: { hits: number[]; blockExpiresAt: number } = (await cache.get(key)) ?? { hits: [], blockExpiresAt: 0 }
      const t = now()
      if (state.blockExpiresAt > 0 && state.blockExpiresAt <= t) {
        state.hits = []
        state.blockExpiresAt = 0
      }
      state.hits = state.hits.filter((expiresAt) => expiresAt > t)
      if (state.blockExpiresAt === 0) {
        state.hits.push(t + ttl)
        if (state.hits.length > limit) state.blockExpiresAt = t + blockDuration
      }
      await cache.set(key, state, Math.ceil(Math.max(state.blockExpiresAt, ...state.hits, t) / 1000))
      return {
        totalHits: state.hits.length,
        timeToExpire: Math.max(0, Math.ceil(((state.hits[0] ?? t) - t) / 1000)),
        isBlocked: state.blockExpiresAt > t,
        timeToBlockExpire: Math.max(0, Math.ceil((state.blockExpiresAt - t) / 1000))
      }
    },
    set: async (key: string, data: unknown, ttl?: number) => {
      // Mirrors the adapters' getTTL(): 0 is infinite, undefined is the default.
      const seconds = ttl ? ttl : ttl === 0 ? -1 : cache.defaultTTL
      store.set(key, { value: JSON.stringify(data ?? null), expiresAt: seconds < 0 ? Infinity : now() + seconds * 1000 })
      return true
    },
    del: async (key: string) => {
      const existed = !!live(key)
      store.delete(key)
      return existed
    },
    mdel: async (keys: string[]) => {
      let deleted = false
      for (const key of keys) deleted = (await cache.del(key)) || deleted
      return deleted
    },
    genSlugKey: (...args: unknown[]) => args.join('-')
  }
  return cache
}
