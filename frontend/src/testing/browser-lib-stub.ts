// Stand-in for browser-only libraries that touch `document` at module scope.
//
// The v2 screens inject upstream's FilesService, whose module graph reaches the
// classic viewer components, which statically import editor/player libraries
// (plyr, codemirror, …). Those libraries evaluate `document` on import, which
// fails in a DOM-less test process. None of them are reachable from the code
// under test, so vitest.config.mts aliases them to this no-op module.
const stub: Record<string, unknown> = new Proxy(
  {},
  {
    get: () => stub
  }
)

export default stub
