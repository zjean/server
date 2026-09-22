import fastifyCookie from '@fastify/cookie'
import fastifyHelmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common'
import { NestFactory, Reflector } from '@nestjs/core'
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify'
import { FastifyInstance, FastifyRequest } from 'fastify'
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino'
import { CONTENT_SECURITY_POLICY } from './app.constants'
import { AppModule } from './app.module'
import { bootstrapNcRawUploads } from './applications/custom-mobile-compat/utils/nc-raw-put'
import { registerUrlencodedParser } from './applications/custom-mobile-compat/utils/nc-urlencoded-body'
import { bootstrapWebDAV } from './applications/webdav/utils/bootstrap'
import { IS_TEST_ENV, STATIC_PATH } from './configuration/config.constants'
import { configuration } from './configuration/config.environment'
import { WebSocketAdapter } from './infrastructure/websocket/adapters/web-socket.adapter'

export async function appBootstrap(): Promise<NestFastifyApplication> {
  /* APP */
  const fastifyAdapter = new FastifyAdapter({
    logger: false,
    trustProxy: configuration.server.trustProxy,
    routerOptions: {
      ignoreTrailingSlash: true,
      maxParamLength: 256
    },
    bodyLimit: 26214400 // 25 MB
  })
  const app: NestFastifyApplication = await NestFactory.create<NestFastifyApplication>(AppModule, fastifyAdapter, {
    bufferLogs: true
  })

  // NestJS starts listening for shutdown hooks
  app.enableShutdownHooks()

  /* Fastify instance */
  const fastifyInstance: FastifyInstance = fastifyAdapter.getInstance()

  /* LOGGER */
  app.useLogger(IS_TEST_ENV ? ['fatal'] : app.get(Logger))
  // Flush bootstrap logs through Pino before lifecycle hooks can block app.listen().
  app.flushLogs()

  /* WEBDAV BOOTSTRAP RULES */
  bootstrapWebDAV(app, fastifyInstance)
  // Fork: the same rule for the Nextcloud-compat DAV tree. bootstrapWebDAV's
  // hook is scoped to /webdav and cannot see /remote.php/*, so NC PUTs carrying
  // a buffered content type (text/plain, application/json, application/xml)
  // were drained before the handler read req.raw and landed as 0-byte files.
  bootstrapNcRawUploads(fastifyInstance)

  /* PARSER */
  // Keep unknown binary payloads available through req.raw.
  // This parser does not consume or meter the payload: bodyLimit only protects buffered parsers,
  // while raw and multipart consumers meter their own streams.
  fastifyInstance.addContentTypeParser('*', (_req: FastifyRequest, _payload: FastifyRequest['raw'], done) => done(null))
  // application/x-www-form-urlencoded — consumed ONLY by the custom-mobile-compat
  // login-v2 routes (the NC poll endpoint plus the two browser-side HTML forms).
  //
  // It is registered WITHOUT `parseAs` and with a cap of its own, deliberately.
  // With `{ parseAs: 'string' }` fastify calls rawBody() BEFORE the parser
  // function (lib/content-type-parser.js `run()`), so the parser's URL check
  // ran against a stream already at EOF: every urlencoded body on EVERY route
  // was drained and buffered into a string before any guard ran — up to the
  // 25 MB server bodyLimit above, since a parser registered without its own
  // `bodyLimit` inherits the server's — and then thrown away. It also meant any
  // DAV write arriving with this content type wrote zero bytes. See
  // nc-urlencoded-body.ts; the comment that used to sit here claimed a tiny
  // body limit and a per-route parse, and the code did neither.
  registerUrlencodedParser(fastifyInstance)

  /* INTERCEPTORS */
  app.useGlobalInterceptors(
    new LoggerErrorInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector), {
      excludePrefixes: ['_']
    })
  )

  /* VALIDATION */
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))

  /* STATIC */
  app.useStaticAssets({ root: STATIC_PATH, prefixAvoidTrailingSlash: true })

  /* SECURITY */
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: CONTENT_SECURITY_POLICY(
      (configuration.applications.files.editors.onlyoffice.enabled
        ? configuration.applications.files.editors.onlyoffice
        : configuration.applications.files.editors.eurooffice
      ).externalServer,
      configuration.applications.files.editors.collabora.externalServer,
      configuration.applications.files.diagrams.editorUrl
    ),
    // Helmet defaults to `same-origin`, which places popups opened by
    // cross-origin iframes (drawio at embed.diagrams.net) in a separate
    // browsing-context group. The opener relationship is severed, so the
    // iframe can't write into the popup it just opened — that's what breaks
    // drawio's native File>Print and Ctrl+P in Firefox. Relaxing to
    // `same-origin-allow-popups` keeps top-level isolation (the parent still
    // can't be opened-and-poked-at by hostile cross-origin openers) while
    // letting popups that don't oppose us — like drawio's about:blank print
    // preview — stay in the same BCG with an intact opener handle. NC's
    // drawio integration ships with no COOP at all and works in Firefox for
    // the same reason.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
  })

  /* COOKIES */
  // we use csrf secret to unsign csrf cookie
  await app.register(fastifyCookie, {
    secret: configuration.auth.token.csrf.secret,
    parseOptions: {
      secure: 'auto',
      sameSite: configuration.auth.cookieSameSite,
      httpOnly: true
    }
  })

  /* UPLOAD */
  await app.register(multipart, {
    preservePath: true,
    limits: { parts: Infinity, fileSize: configuration.applications.files.maxUploadSize }
  })

  /* WEBSOCKET */
  if (!IS_TEST_ENV) {
    const webSocketAdapter = new WebSocketAdapter(app)
    await webSocketAdapter.initAdapter()
    app.useWebSocketAdapter(webSocketAdapter)
  }

  return app
}
