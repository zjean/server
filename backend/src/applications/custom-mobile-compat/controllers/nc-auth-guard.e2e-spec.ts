import { GUARDS_METADATA, METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common'
import { NestFastifyApplication } from '@nestjs/platform-fastify'
import fs from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { appBootstrap } from '../../../app.bootstrap'
import { AUTH_PROVIDER } from '../../../authentication/providers/auth-providers.constants'
import { configuration } from '../../../configuration/config.environment'
import { USER_PERMISSION, USER_PERMS_SEP, USER_ROLE } from '../../users/constants/user'
import { UserModel } from '../../users/models/user.model'
import { AdminUsersManager } from '../../users/services/admin-users-manager.service'
import { generateUserTest } from '../../users/utils/test'
import { CustomMobileCompatModule } from '../custom-mobile-compat.module'
import { NC_AUTH_REALM } from '../constants/routes'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcAppPasswordService } from '../services/nc-app-password.service'
import { NcActivityController } from './nc-activity.controller'
import { NcCommentsController } from './nc-comments.controller'
import { NcDavController } from './nc-dav.controller'
import { NcDirectEditingController } from './nc-direct-editing.controller'
import { NcDiscoveryController } from './nc-discovery.controller'
import { NcExtrasController } from './nc-extras.controller'
import { NcLoginV2Controller } from './nc-login-v2.controller'
import { NcMobileOidcController } from './nc-mobile-oidc.controller'
import { NcOcsController } from './nc-ocs.controller'
import { NcOcsSharesController } from './nc-ocs-shares.controller'
import { NcOfficeEditorController } from './nc-office-editor.controller'
import { NcOnlyOfficeCallbackController, NcOnlyOfficeController } from './nc-onlyoffice.controller'
import { NcRecommendationsController } from './nc-recommendations.controller'
import { NcTextEditorController } from './nc-text-editor.controller'
import { NcThemingController } from './nc-theming.controller'
import { NcUploadsController } from './nc-uploads.controller'
import { NcVersionsController } from './nc-versions.controller'

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
// The route table is DISCOVERED by reflection rather than typed out, so a new
// route cannot slip past by not being listed. Routes that declare the guard
// must answer 401; routes that do not must be named in UNGUARDED_ROUTES with a
// policy, and that list is asserted to have no strays in either direction.

type Ctor = new (...args: never[]) => object

// ── the controller table, and why it is not read off the module ─────────────
//
// custom-mobile-compat.module.ts spreads four of its controllers in
// CONDITIONALLY: NcMobileOidcController behind `auth.provider === 'oidc'`, and
// NcOnlyOfficeController / NcOnlyOfficeCallbackController /
// NcOfficeEditorController behind `editors.onlyoffice|eurooffice.enabled`.
//
// So reflecting `MODULE_METADATA.CONTROLLERS` — which is what this file used to
// do — makes the completeness claim above silently CONFIG-DEPENDENT: with a flag
// off, a new unguarded route inside one of those four controllers is not merely
// unprobed, it is never discovered, and the "classifies every route" case passes
// by not looking. That is the exact failure mode this file exists to prevent.
// (It was green only because .github/workflows/test-e2e.yml sed-enables
// onlyoffice for an unrelated reason — versions-editors.e2e-spec.ts.)
//
// Controllers are therefore enumerated here by direct import, and the
// classification suites run over every route in all of them regardless of what
// this run mounted. Mounting still matters for the HTTP probes — an unmounted
// route answers 404, which proves nothing — so each route also carries
// `mounted`, read from the module metadata (the ground truth for what Nest
// actually wired), and the probe suites run over the mounted subset only.
//
// The one hole a hand-written list could still have — a whole new controller
// FILE that nobody adds here — is closed by scanning the directory; see
// 'accounts for every controller class on disk' below.
const UNCONDITIONAL_CONTROLLERS: Ctor[] = [
  NcActivityController,
  NcCommentsController,
  NcDavController,
  NcDirectEditingController,
  NcDiscoveryController,
  NcExtrasController,
  NcLoginV2Controller,
  NcOcsController,
  NcOcsSharesController,
  NcRecommendationsController,
  NcTextEditorController,
  NcThemingController,
  NcUploadsController,
  NcVersionsController
]

// Mounted only when their flag is on. Named explicitly so 'not mounted in this
// run' is an expected state rather than an unexplained absence.
const CONDITIONAL_CONTROLLERS: Ctor[] = [
  NcMobileOidcController, // auth.provider === 'oidc'
  NcOnlyOfficeController, // editors.onlyoffice.enabled || editors.eurooffice.enabled
  NcOnlyOfficeCallbackController,
  NcOfficeEditorController
]

const ALL_CONTROLLERS: Ctor[] = [...UNCONDITIONAL_CONTROLLERS, ...CONDITIONAL_CONTROLLERS]
const CONDITIONAL_NAMES = new Set(CONDITIONAL_CONTROLLERS.map((c) => c.name))
const MOUNTED_CONTROLLERS = new Set<unknown>(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CustomMobileCompatModule) ?? [])

// The same two conditions custom-mobile-compat.module.ts evaluates, restated
// from the same `configuration` object. Not used to BUILD the route table — the
// whole point above is that the table does not depend on config — but asserted
// against what Nest actually mounted, so 'this controller is missing' is always
// either explained by a flag or a failure.
const EXPECTED_MOUNTED = (controller: Ctor): boolean => {
  if (controller === NcMobileOidcController) return configuration.auth?.provider === AUTH_PROVIDER.OIDC
  if (controller === NcOnlyOfficeController || controller === NcOnlyOfficeCallbackController || controller === NcOfficeEditorController) {
    return (
      configuration.applications.files.editors.onlyoffice?.enabled === true || configuration.applications.files.editors.eurooffice?.enabled === true
    )
  }
  return true
}

// Resolved against the vitest root (backend/), which is where `npm -w backend
// run test:e2e` puts the cwd. A missing directory throws rather than yielding an
// empty list — a scan that silently finds nothing would re-open the very hole it
// is here to close.
const CONTROLLERS_DIR = path.resolve(process.cwd(), 'src/applications/custom-mobile-compat/controllers')

// Every `@Controller()`-decorated exported class in the directory, by name. Read
// from source rather than by importing, so this stays synchronous (the route
// table is built at collect time for `it.each`) and so it cannot be fooled by a
// controller that fails to import.
function controllerClassNamesOnDisk(): string[] {
  const names: string[] = []
  for (const file of readdirSync(CONTROLLERS_DIR).filter((f) => f.endsWith('.controller.ts'))) {
    const source = readFileSync(path.join(CONTROLLERS_DIR, file), 'utf8')
    // Each `@Controller(...)` owns the next `export class X` below it; a file
    // may hold several (nc-onlyoffice.controller.ts holds two).
    for (const decorator of source.matchAll(/@Controller\s*\(/g)) {
      const rest = source.slice(decorator.index)
      const declaration = /export\s+(?:abstract\s+)?class\s+(\w+)/.exec(rest)
      if (declaration) names.push(declaration[1])
    }
  }
  return names
}

// Nest's RequestMethod ordinals → the verb to probe a route with.
const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  // @All() accepts every verb; GET is the representative one. See ALL_VERB_PROBES.
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

// `@All` expands to every verb Fastify exposes. For a route whose CLASS carries
// NcBasicAuthGuard one verb is enough — a class-level guard runs on all of them,
// so the guarded assertions lose nothing. An UNGUARDED `@All` is different: its
// policy is a property of the handler's own `req.method` dispatch, which is
// per-verb (nc-discovery's dav root answers 401 flat for everything but SEARCH,
// which it inline-invokes the guard for). Those get probed across a spread.
const ALL_VERB_PROBES = ['GET', 'POST', 'PUT', 'DELETE', 'PROPFIND', 'MKCOL']

// Policies for the routes that deliberately do NOT carry NcBasicAuthGuard.
// Every one of them has to be here, with the reason it is safe, or the
// completeness assertion fails.
type Policy =
  | 'public' // genuinely unauthenticated by design (probes, capabilities, theming, login flow)
  | 'always-401' // no declared guard, but the handler refuses anyway
  | 'other-guard' // a different guard owns it (the document server's JWT)
  | 'token-401' // authenticated by a ?token= JWT; refuses with 401 without one
  | 'token-error-page' // same, but must answer 200 with an error page (a webview blanks on a 4xx)

// What a 'public' route is allowed to answer to an anonymous probe. The claim is
// REACHABILITY, not success: an unbuilt bundle 404s, a flow token of 32 zeros
// matches nothing, a POST with no body is a 400 — all fine. What is NOT fine is
// being refused for want of a credential (401/403) or being throttled (429).
// The old assertion here was a bare `not.toBe(401)`, which a permanent 429 would
// satisfy — and #523 puts a per-IP rate limiter on exactly the login-v2 routes.
const PUBLIC_STATUSES = [200, 201, 204, 302, 303, 400, 404, 415]

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

  // ── NcMobileOidcController, mounted only when auth.provider === 'oidc'. CI
  //    leaves the provider local, so these two are classified here but NOT
  //    probed over HTTP in that configuration — see the visibility case below.
  'GET /custom-mobile/oidc/login/:token': { policy: 'public', why: 'the browser hop to the IdP; the flow token is the secret' },
  'GET /custom-mobile/oidc/callback': { policy: 'public', why: 'the IdP redirects here with its own code; no Basic credential exists yet' }
}

interface DiscoveredRoute {
  key: string // 'VERB /path'
  method: string
  path: string
  controller: string
  guarded: boolean // declares NcBasicAuthGuard on the handler or the class
  mounted: boolean // this configuration actually wired the controller into Nest
  isAll: boolean // declared with @All, so the verb above is only representative
}

// Every method name on the class AND on anything it extends. No controller in
// this module uses inheritance today, so this is latent — but a handler moved to
// a shared base class would otherwise vanish from the table, silently, which is
// the same failure mode as the conditional mounting above.
function methodNames(ctor: Ctor): string[] {
  const names = new Set<string>()
  for (let proto = ctor.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor') names.add(name)
    }
  }
  return [...names]
}

function discoverRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = []

  for (const controller of ALL_CONTROLLERS) {
    const prefixMeta = Reflect.getMetadata(PATH_METADATA, controller) ?? '/'
    const prefixes = (Array.isArray(prefixMeta) ? prefixMeta : [prefixMeta]).map(String)
    // Reflect.getMetadata walks the prototype chain for classes, so a guard
    // declared on a base class is seen here too.
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, controller) ?? []
    const proto = controller.prototype as Record<string, unknown>
    const mounted = MOUNTED_CONTROLLERS.has(controller)

    for (const name of methodNames(controller)) {
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
          routes.push({
            key: `${verb} ${path}`,
            method: verb,
            path,
            controller: controller.name,
            guarded,
            mounted,
            isAll: methodMeta === RequestMethod.ALL
          })
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
    // The HTTP probes only cover mounted routes, so that subset must be
    // substantial too — otherwise a misconfigured run would classify everything
    // and prove nothing.
    expect(routes.filter((r) => r.mounted).length).toBeGreaterThan(30)
  })

  it('accounts for every controller class on disk — a new controller file cannot escape the table', () => {
    const onDisk = controllerClassNamesOnDisk()
    const declared = ALL_CONTROLLERS.map((c) => c.name)
    // Anti-vacuity: an empty or truncated scan must not read as agreement.
    expect(onDisk.length).toBeGreaterThan(15)
    expect(onDisk.filter((n) => !declared.includes(n)).sort()).toEqual([])
    expect(declared.filter((n) => !onDisk.includes(n)).sort()).toEqual([])
  })

  it('states which controllers this run mounted, and only the conditional ones may be absent', () => {
    const mounted = ALL_CONTROLLERS.filter((c) => MOUNTED_CONTROLLERS.has(c)).map((c) => c.name)
    const notMounted = ALL_CONTROLLERS.filter((c) => !MOUNTED_CONTROLLERS.has(c)).map((c) => c.name)
    // Say it out loud. The classification cases cover every controller, but the
    // HTTP probes only reach the mounted ones, and which those are is config —
    // so a reader of the output should never have to infer it. (Written to
    // stdout directly: the app bootstrap swaps the Nest logger in and console.*
    // does not survive it.)
    process.stdout.write(
      `\n[nc-auth-guard] mounted in this run (${mounted.length}): ${mounted.join(', ')}\n` +
        `[nc-auth-guard] NOT mounted (${notMounted.length}) — classified below, but NOT probed over HTTP: ${notMounted.join(', ') || 'none'}\n`
    )
    // An unconditional controller that failed to mount means the module changed
    // under this file, not that the configuration differs.
    expect(notMounted.filter((n) => !CONDITIONAL_NAMES.has(n))).toEqual([])
    // Nest must not have mounted anything this table does not know about.
    const declared = new Set<unknown>(ALL_CONTROLLERS)
    expect([...MOUNTED_CONTROLLERS].filter((c) => !declared.has(c)).map((c) => (c as Ctor).name)).toEqual([])
    // ...and every absence is explained by the flag the module actually reads,
    // so a controller silently dropped from the module's `controllers` array
    // fails here rather than quietly losing its HTTP coverage.
    expect(ALL_CONTROLLERS.filter((c) => MOUNTED_CONTROLLERS.has(c) !== EXPECTED_MOUNTED(c)).map((c) => c.name)).toEqual([])
  })

  it('classifies every route that does NOT declare the guard — a new unguarded route fails here', () => {
    // Deliberately over ALL routes, mounted or not: a new unguarded route inside
    // a conditionally-mounted controller must fail this even with its flag off.
    const unclassified = routes.filter((r) => !r.guarded && !UNGUARDED_ROUTES[r.key]).map((r) => `${r.key}  (${r.controller})`)
    expect(unclassified).toEqual([])
  })

  it('has no stale entries in the unguarded list either — a route that GAINED the guard must be removed from it', () => {
    const known = new Set(routes.map((r) => r.key))
    const guardedButListed = routes.filter((r) => r.guarded && UNGUARDED_ROUTES[r.key]).map((r) => r.key)
    expect(guardedButListed).toEqual([])
    // No allow-list of "might not be mounted" entries is needed any more: the
    // route table is built from the controller classes, not from what Nest
    // wired, so a conditionally-mounted route is still a known route. A phantom
    // is therefore a genuinely dead entry.
    const phantom = Object.keys(UNGUARDED_ROUTES).filter((k) => !known.has(k))
    expect(phantom).toEqual([])
  })

  describe('routes that declare NcBasicAuthGuard refuse an anonymous request', () => {
    const guarded = routes.filter((r) => r.guarded && r.mounted)

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
    const unguarded = routes.filter((r) => !r.guarded && r.mounted && UNGUARDED_ROUTES[r.key])

    const assertPolicy = (policy: Policy, res: { statusCode: number; body: string }, where: string) => {
      switch (policy) {
        case 'public':
          // REACHABLE without credentials is the claim — not success. See
          // PUBLIC_STATUSES for why this is an allow-list and not `not.toBe(401)`.
          expect(PUBLIC_STATUSES, `${where} answered ${res.statusCode}`).toContain(res.statusCode)
          break
        case 'always-401':
        case 'other-guard':
        case 'token-401':
          expect(res.statusCode, where).toBe(401)
          break
        case 'token-error-page':
          // A 4xx makes the host webview show its own blank page, so the refusal
          // has to arrive as a readable 200.
          expect(res.statusCode, where).toBe(200)
          expect(res.body).toContain('expired')
          break
      }
    }

    it.each(unguarded.map((r) => [`${r.key} [${UNGUARDED_ROUTES[r.key].policy}]`, r] as const))('%s', async (_key, route) => {
      const { policy } = UNGUARDED_ROUTES[route.key]
      // An unguarded @All dispatches per-verb inside the handler, so one verb is
      // not the whole contract.
      const verbs = route.isAll ? ALL_VERB_PROBES : [route.method]
      for (const verb of verbs) {
        const res = await anon(verb, concretize(route.path, user.login))
        assertPolicy(policy, res as unknown as { statusCode: number; body: string }, `${verb} ${route.path}`)
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
