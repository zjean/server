import { GUARDS_METADATA, METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common'
import { NestFastifyApplication } from '@nestjs/platform-fastify'
import fs from 'node:fs/promises'
import { appBootstrap } from '../../../app.bootstrap'
import { USER_PERMISSION, USER_PERMS_SEP, USER_ROLE } from '../../users/constants/user'
import { UserModel } from '../../users/models/user.model'
import { AdminUsersManager } from '../../users/services/admin-users-manager.service'
import { generateUserTest } from '../../users/utils/test'
import { CustomMobileCompatModule } from '../custom-mobile-compat.module'
import { NC_AUTH_REALM } from '../constants/routes'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcAppPasswordService } from '../services/nc-app-password.service'

// Is NcBasicAuthGuard actually IN THE REQUEST PATH?
//
// WHY THIS EXISTS. Every controller spec in this module opens with
// `.overrideGuard(NcBasicAuthGuard).useValue({ canActivate: () => true })`, and
// the guard's own spec constructs it directly and asks it about a fabricated
// request. Between them they prove the DECISION and never its PLACEMENT — so a
// route added without `@UseGuards(NcBasicAuthGuard)` ships unauthenticated with
// the whole suite green. That is not hypothetical here: every controller in
// this module is `@AuthTokenSkip()` at class level, which switches OFF the
// global AuthTokenAccessGuard, so an unguarded NC route is not merely
// weakly authenticated — it is open.
//
// This is the same gap `versions-admin.e2e-spec.ts` was written to close for the
// versioning admin surface, and it is closed the same way: a real HTTP request
// with no credentials, plus an assertion that the SIDE EFFECT did not happen. A
// status code on its own cannot tell "refused" from "refused after doing it".
//
// The route table is DISCOVERED by reflecting over the module rather than typed
// out, so a new route cannot slip past by not being listed. Routes that declare
// the guard must answer 401; routes that do not must be named in
// UNGUARDED_ROUTES with a policy, and that list is asserted to have no strays in
// either direction.

// Nest's RequestMethod ordinals → the verb to probe a route with.
const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  // @All() accepts every verb; GET is enough to reach the guard.
  [RequestMethod.ALL]: 'GET',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.SEARCH]: 'SEARCH',
  [RequestMethod.PROPFIND]: 'PROPFIND',
  [RequestMethod.PROPPATCH]: 'PROPPATCH',
  [RequestMethod.MKCOL]: 'MKCOL',
  [RequestMethod.COPY]: 'COPY',
  [RequestMethod.MOVE]: 'MOVE',
  [RequestMethod.LOCK]: 'LOCK',
  [RequestMethod.UNLOCK]: 'UNLOCK'
}

// Policies for the routes that deliberately do NOT carry NcBasicAuthGuard.
// Every one of them has to be here, with the reason it is safe, or the
// completeness assertion fails.
type Policy =
  | 'public' // genuinely unauthenticated by design (probes, capabilities, theming, login flow)
  | 'always-401' // no declared guard, but the handler refuses anyway
  | 'other-guard' // a different guard owns it (the document server's JWT)
  | 'token-401' // authenticated by a ?token= JWT; refuses with 401 without one
  | 'token-error-page' // same, but must answer 200 with an error page (a webview blanks on a 4xx)

const UNGUARDED_ROUTES: Record<string, { policy: Policy; why: string }> = {
  // ── discovery / probes
  'GET /status.php': { policy: 'public', why: 'the connectivity probe every client makes before it has credentials' },
  'GET /index.php/204': { policy: 'public', why: 'the captive-portal probe; must answer before login' },
  'GET /remote.php/dav': {
    policy: 'always-401',
    why: 'the DAV probe answers 401 unconditionally and inline-invokes the guard for SEARCH only, so the cold probe costs no DB hit'
  },

  // ── capabilities: read before the client has an app password
  'GET /ocs/v1.php/cloud/capabilities': { policy: 'public', why: 'NC clients read capabilities pre-login to decide what to offer' },
  'GET /ocs/v2.php/cloud/capabilities': { policy: 'public', why: 'as above' },

  // ── login flow v2: this is how a credential is obtained, so it cannot need one
  'POST /index.php/login/v2': { policy: 'public', why: 'starts the login flow — the endpoint that has no credential yet by definition' },
  'POST /index.php/login/v2/poll': { policy: 'public', why: 'flow poll; the poll token is the secret' },
  'POST /login/v2/poll': { policy: 'public', why: 'alias of the above for clients that drop the index.php prefix' },
  'GET /login/v2/flow/:token': { policy: 'public', why: 'the browser login page; the flow token in the URL is the secret' },
  'POST /login/v2/flow/:token': { policy: 'public', why: 'the login POST itself' },
  'POST /login/v2/grant/:token': { policy: 'public', why: 'the grant step; gated on the session the flow page established, not on Basic auth' },

  // ── theming: iOS fetches the logo and manifest on the login screen
  'GET /index.php/apps/theming/image/logo': { policy: 'public', why: 'rendered on the pre-login screen' },
  'GET /index.php/apps/theming/image/background': { policy: 'public', why: 'as above' },
  'GET /index.php/apps/theming/favicon/:app': { policy: 'public', why: 'as above' },
  'GET /index.php/apps/theming/icon/:app/:image': { policy: 'public', why: 'as above' },
  'GET /index.php/apps/theming/manifest/:theme': { policy: 'public', why: 'as above' },

  // ── the in-app editors: a WKWebView does not carry the OCS Basic header, so
  //    these authenticate on a short-lived JWT minted by directEditing/open
  'GET /custom-mobile-compat/text-editor': {
    policy: 'token-error-page',
    why: 'token-authenticated; a non-200 makes the host webview render its own blank page instead of the reason'
  },
  'GET /custom-mobile-compat/text-editor/content': { policy: 'token-401', why: 'token-authenticated; a data endpoint, so it may 401' },
  'PUT /custom-mobile-compat/text-editor/content': { policy: 'token-401', why: 'as above' },
  'GET /custom-mobile-compat/text-editor/codemirror.bundle.js': { policy: 'public', why: 'a static build artifact, no user data' },
  'GET /custom-mobile-compat/text-editor/tiptap.bundle.js': { policy: 'public', why: 'a static build artifact, no user data' },
  'GET /custom-mobile-compat/office-editor': { policy: 'token-error-page', why: 'same webview contract as the text editor page' },

  // ── the document server's own callback
  'POST /index.php/apps/onlyoffice/track': {
    policy: 'other-guard',
    why: 'OnlyOfficeGuard — the caller is the document server, which holds a JWT, not a user'
  },

  // ── mounted only when auth.provider === 'oidc'; listed so enabling OIDC does
  //    not trip the completeness check with an unclassified route
  'GET /custom-mobile/oidc/login/:token': { policy: 'public', why: 'the browser hop to the IdP; the flow token is the secret' },
  'GET /custom-mobile/oidc/callback': { policy: 'public', why: 'the IdP redirects here with its own code; no Basic credential exists yet' }
}

interface DiscoveredRoute {
  key: string // 'VERB /path'
  method: string
  path: string
  controller: string
  guarded: boolean // declares NcBasicAuthGuard on the handler or the class
}

function discoverRoutes(): DiscoveredRoute[] {
  const controllers: (new (...args: never[]) => object)[] = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CustomMobileCompatModule) ?? []
  const routes: DiscoveredRoute[] = []

  for (const controller of controllers) {
    const prefixMeta = Reflect.getMetadata(PATH_METADATA, controller) ?? '/'
    const prefixes = (Array.isArray(prefixMeta) ? prefixMeta : [prefixMeta]).map(String)
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, controller) ?? []
    const proto = controller.prototype as Record<string, unknown>

    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue
      const handler = proto[name]
      if (typeof handler !== 'function') continue
      const pathMeta = Reflect.getMetadata(PATH_METADATA, handler)
      if (pathMeta === undefined) continue
      const methodMeta: number = Reflect.getMetadata(METHOD_METADATA, handler)
      const handlerGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? []
      const guarded = [...classGuards, ...handlerGuards].includes(NcBasicAuthGuard)
      const verb = METHOD_NAMES[methodMeta]
      if (!verb) throw new Error(`unmapped RequestMethod ${methodMeta} on ${controller.name}.${name}`)

      for (const prefix of prefixes) {
        for (const sub of (Array.isArray(pathMeta) ? pathMeta : [pathMeta]).map(String)) {
          const path = `/${[prefix, sub]
            .map((s) => s.replace(/^\/+|\/+$/g, ''))
            .filter(Boolean)
            .join('/')}`
          routes.push({ key: `${verb} ${path}`, method: verb, path, controller: controller.name, guarded })
        }
      }
    }
  }
  return routes
}

// Fill route params with something that reaches the handler. The guard runs
// before any of them is read, so only the SHAPE matters.
function concretize(path: string, login: string): string {
  return path
    .replace(/:urlUser\b/g, login)
    .replace(/:user\b/g, login)
    .replace(/:userid\b/g, login)
    .replace(/:token\b/g, '0'.repeat(32))
    .replace(/:fileId\b/g, '1')
    .replace(/:messageId\b/g, '1')
    .replace(/:revision\b/g, '1')
    .replace(/:uploadId\b/g, 'probe-upload')
    .replace(/:size\b/g, '64')
    .replace(/:theme\b/g, 'default')
    .replace(/:image\b/g, 'app.svg')
    .replace(/:app\b/g, 'core')
    .replace(/\*$/, 'probe-guard.txt')
}

describe('NcBasicAuthGuard is in the request path for every NC route that claims it (e2e)', () => {
  let app: NestFastifyApplication
  let admin: AdminUsersManager
  let user: UserModel
  let ncAuth: string
  let ncPassword: string
  const routes = discoverRoutes()

  beforeAll(async () => {
    app = await appBootstrap()
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
    admin = app.get(AdminUsersManager)
    // `permissions` is the column; `applications` is derived from it and is not
    // one — a user built straight from generateUserTest() 403s on every request.
    user = await admin.createUserOrGuest(
      { ...generateUserTest(false), permissions: Object.values(USER_PERMISSION).join(USER_PERMS_SEP) } as never,
      USER_ROLE.USER
    )
    const minted = await app.get(NcAppPasswordService).mintMobileAppPassword(user, 'nc-auth-guard-e2e')
    ncPassword = minted.password
    ncAuth = `Basic ${Buffer.from(`${user.login}:${ncPassword}`).toString('base64')}`
  })

  afterAll(async () => {
    if (user?.id) {
      await admin.deleteUserOrGuest(user.id, user.login, { deleteSpace: true, isGuest: false } as never).catch(() => undefined)
    }
    await app?.close()
  })

  // No Authorization header at all.
  const anon = (method: string, url: string, opts: { payload?: string; headers?: Record<string, string> } = {}) =>
    app.inject({ method, url, headers: { ...(opts.headers ?? {}) }, ...(opts.payload === undefined ? {} : { payload: opts.payload }) } as never)

  const nc = (method: string, url: string, opts: { payload?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method,
      url,
      headers: { authorization: ncAuth, ...(opts.headers ?? {}) },
      ...(opts.payload === undefined ? {} : { payload: opts.payload })
    } as never)

  it('discovered a non-trivial route table (the reflection itself must not go vacuous)', () => {
    expect(routes.length).toBeGreaterThan(30)
    expect(routes.filter((r) => r.guarded).length).toBeGreaterThan(15)
  })

  it('classifies every route that does NOT declare the guard — a new unguarded route fails here', () => {
    const unclassified = routes.filter((r) => !r.guarded && !UNGUARDED_ROUTES[r.key]).map((r) => `${r.key}  (${r.controller})`)
    expect(unclassified).toEqual([])
  })

  it('has no stale entries in the unguarded list either — a route that GAINED the guard must be removed from it', () => {
    const mounted = new Set(routes.map((r) => r.key))
    const guardedButListed = routes.filter((r) => r.guarded && UNGUARDED_ROUTES[r.key]).map((r) => r.key)
    expect(guardedButListed).toEqual([])
    // Entries for routes that are not mounted in this configuration are allowed
    // (the OIDC pair), but nothing else may be listed that does not exist at all.
    const optional = new Set(['GET /custom-mobile/oidc/login/:token', 'GET /custom-mobile/oidc/callback'])
    const phantom = Object.keys(UNGUARDED_ROUTES).filter((k) => !mounted.has(k) && !optional.has(k))
    expect(phantom).toEqual([])
  })

  describe('routes that declare NcBasicAuthGuard refuse an anonymous request', () => {
    const guarded = discoverRoutes().filter((r) => r.guarded)

    it.each(guarded.map((r) => [r.key, r] as const))('%s → 401 with a Basic challenge', async (_key, route) => {
      const res = await anon(route.method, concretize(route.path, user.login))
      // 404 here would mean the probe never reached the route and the 401 proves
      // nothing; 200 would mean the route is open.
      expect(res.statusCode).toBe(401)
      // The challenge is what makes stock clients re-prompt instead of giving up.
      expect(String(res.headers['www-authenticate'])).toBe(`Basic realm="${NC_AUTH_REALM}"`)
    })

    it.each(guarded.map((r) => [r.key, r] as const))('%s → 401 for a syntactically valid but wrong credential', async (_key, route) => {
      const wrong = `Basic ${Buffer.from(`${user.login}:not-the-app-password`).toString('base64')}`
      const res = await anon(route.method, concretize(route.path, user.login), { headers: { authorization: wrong } })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('routes that do not declare the guard behave as their policy says', () => {
    const unguarded = discoverRoutes().filter((r) => !r.guarded && UNGUARDED_ROUTES[r.key])

    it.each(unguarded.map((r) => [`${r.key} [${UNGUARDED_ROUTES[r.key].policy}]`, r] as const))('%s', async (_key, route) => {
      const { policy } = UNGUARDED_ROUTES[route.key]
      const res = await anon(route.method, concretize(route.path, user.login))
      switch (policy) {
        case 'public':
          // The point is that it is REACHABLE without credentials. It may 404
          // (an unbuilt bundle, a flow token that matches nothing) but it must
          // not be refused for want of a credential.
          expect(res.statusCode).not.toBe(401)
          break
        case 'always-401':
        case 'other-guard':
        case 'token-401':
          expect(res.statusCode).toBe(401)
          break
        case 'token-error-page':
          // A 4xx makes the host webview show its own blank page, so the refusal
          // has to arrive as a readable 200.
          expect(res.statusCode).toBe(200)
          expect(res.body).toContain('expired')
          break
      }
    })
  })

  // ── the part a status code cannot tell you ──────────────────────────────────
  //
  // "Refused" and "refused after doing the thing" are the same 401 from outside.

  describe('an anonymous write is refused AND does not happen', () => {
    const filesPath = () => UserModel.getFilesPath(user.login)

    it('PUT: no file is created', async () => {
      const rel = 'nc-guard-anon-put.txt'
      const target = `${filesPath()}/${rel}`
      try {
        const res = await anon('PUT', `/remote.php/dav/files/${user.login}/${rel}`, { payload: 'should never land' })
        expect(res.statusCode).toBe(401)
        await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await fs.rm(target, { force: true }).catch(() => undefined)
      }
    })

    it('DELETE: the file is still there afterwards', async () => {
      const rel = 'nc-guard-anon-delete.txt'
      const target = `${filesPath()}/${rel}`
      try {
        expect([200, 201, 204]).toContain((await nc('PUT', `/remote.php/dav/files/${user.login}/${rel}`, { payload: 'keep me' })).statusCode)
        const res = await anon('DELETE', `/remote.php/dav/files/${user.login}/${rel}`)
        expect(res.statusCode).toBe(401)
        expect(await fs.readFile(target, 'utf8')).toBe('keep me')
      } finally {
        await fs.rm(target, { force: true }).catch(() => undefined)
      }
    })

    it('MKCOL: no directory is created', async () => {
      const rel = 'nc-guard-anon-mkcol'
      const target = `${filesPath()}/${rel}`
      try {
        expect((await anon('MKCOL', `/remote.php/dav/files/${user.login}/${rel}`)).statusCode).toBe(401)
        await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await fs.rm(target, { force: true, recursive: true }).catch(() => undefined)
      }
    })

    it('MOVE: the source is untouched and nothing appears at the destination', async () => {
      const src = 'nc-guard-anon-move-src.txt'
      const dst = 'nc-guard-anon-move-dst.txt'
      try {
        expect([200, 201, 204]).toContain((await nc('PUT', `/remote.php/dav/files/${user.login}/${src}`, { payload: 'stay put' })).statusCode)
        const res = await anon('MOVE', `/remote.php/dav/files/${user.login}/${src}`, {
          headers: { destination: `/remote.php/dav/files/${user.login}/${dst}` }
        })
        expect(res.statusCode).toBe(401)
        expect(await fs.readFile(`${filesPath()}/${src}`, 'utf8')).toBe('stay put')
        await expect(fs.stat(`${filesPath()}/${dst}`)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await fs.rm(`${filesPath()}/${src}`, { force: true }).catch(() => undefined)
        await fs.rm(`${filesPath()}/${dst}`, { force: true }).catch(() => undefined)
      }
    })

    it('DELETE apppassword: the credential it would have revoked still authenticates', async () => {
      const res = await anon('DELETE', '/ocs/v2.php/core/apppassword')
      expect(res.statusCode).toBe(401)
      // If the revoke had run before the refusal, this would now be 401 too.
      expect((await nc('PROPFIND', `/remote.php/dav/files/${user.login}`, { headers: { depth: '0' } })).statusCode).toBe(207)
    })

    it('an anonymous PROPFIND discloses nothing — no multistatus body comes back with the 401', async () => {
      const rel = 'nc-guard-anon-listing.txt'
      try {
        await nc('PUT', `/remote.php/dav/files/${user.login}/${rel}`, { payload: 'secret' })
        const res = await anon('PROPFIND', `/remote.php/dav/files/${user.login}`, { headers: { depth: '1' } })
        expect(res.statusCode).toBe(401)
        expect(res.body).not.toContain('multistatus')
        expect(res.body).not.toContain(rel)
      } finally {
        await fs.rm(`${UserModel.getFilesPath(user.login)}/${rel}`, { force: true }).catch(() => undefined)
      }
    })
  })

  describe('the credential the guard accepts is narrower than "a correct password"', () => {
    const probe = (authorization: string) =>
      app.inject({ method: 'PROPFIND', url: `/remote.php/dav/files/${user.login}`, headers: { authorization, depth: '0' } } as never)

    it('accepts the MOBILE_NC app password (so the negatives below are not vacuous)', async () => {
      expect((await probe(ncAuth)).statusCode).toBe(207)
    })

    it("REFUSES the user's own main login password — matching Nextcloud's posture", async () => {
      // 'password' is what generateUserTest sets, and it is the real login
      // password for this account: it works at Sync-in's own login endpoint.
      const res = await probe(`Basic ${Buffer.from(`${user.login}:password`).toString('base64')}`)
      expect(res.statusCode).toBe(401)
    })

    it('refuses an unknown user', async () => {
      expect((await probe(`Basic ${Buffer.from(`no-such-user-${Date.now()}:${ncPassword}`).toString('base64')}`)).statusCode).toBe(401)
    })

    it('refuses a malformed or non-Basic Authorization header', async () => {
      for (const header of ['', 'Basic', 'Basic !!!not-base64!!!', `Bearer ${ncPassword}`, `Basic ${Buffer.from('no-colon').toString('base64')}`]) {
        expect((await probe(header)).statusCode).toBe(401)
      }
    })
  })
  // Two probe URLs the reflection above cannot see, because `@All('remote.php/dav')`
  // and `@All('remote.php/dav/')` are stacked on ONE handler and the outer
  // decorator overwrites the inner's PATH_METADATA — only the slashless spelling
  // survives into the metadata. Both spellings are in the wild, so both are
  // probed by hand here.
  describe('the DAV probe, both spellings', () => {
    it.each(['/remote.php/dav', '/remote.php/dav/'])('%s answers 401 with a Basic challenge to an anonymous GET', async (url) => {
      const res = await anon('GET', url)
      expect(res.statusCode).toBe(401)
      expect(String(res.headers['www-authenticate'])).toBe(`Basic realm="${NC_AUTH_REALM}"`)
    })

    // SEARCH is the one verb on this route that inline-invokes NcBasicAuthGuard
    // instead of answering 401 flat — the 401 above would pass either way, so
    // this is what proves the inline invocation is really wired up.
    it('refuses an anonymous SEARCH and returns no results body', async () => {
      const res = await anon('SEARCH', '/remote.php/dav', {
        headers: { 'content-type': 'application/xml' },
        payload: '<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:"/>'
      })
      expect(res.statusCode).toBe(401)
      expect(res.body).not.toContain('multistatus')
    })

    it('serves a SEARCH once the credential is supplied (so the refusal above is not a 401 for some other reason)', async () => {
      const res = await nc('SEARCH', '/remote.php/dav', {
        headers: { 'content-type': 'application/xml' },
        payload:
          '<?xml version="1.0"?><d:searchrequest xmlns:d="DAV:"><d:basicsearch><d:select><d:prop><d:displayname/></d:prop></d:select>' +
          '<d:from><d:scope><d:href>/remote.php/dav/files/' +
          user.login +
          '</d:href><d:depth>infinity</d:depth></d:scope></d:from>' +
          '<d:where><d:like><d:prop><d:displayname/></d:prop><d:literal>%nc-guard%</d:literal></d:like></d:where></d:basicsearch></d:searchrequest>'
      })
      expect(res.statusCode).toBe(207)
    })
  })
})
