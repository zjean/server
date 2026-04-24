import { SPACE_ALIAS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { NcPathResolverService } from './nc-path-resolver.service'

// The service accepts a user-with-settings shape that is a loose subset of
// UserModel. We build minimal fixtures to keep the tests focused on path
// resolution and free of the real User model's constructor side-effects.
function user(settings?: Record<string, unknown> | null) {
  return { id: 1, login: 'u', settings: settings ?? null }
}

describe(NcPathResolverService.name, () => {
  let svc: NcPathResolverService

  beforeEach(() => {
    svc = new NcPathResolverService()
  })

  describe('resolve — home selection', () => {
    it('defaults to the personal space / files repo when no settings', () => {
      const r = svc.resolve(user(null), { mode: 'files', subpath: '' })
      expect(r.repository).toBe(SPACE_REPOSITORY.FILES)
      expect(r.spaceAlias).toBe(SPACE_ALIAS.PERSONAL)
      expect(r.rootAlias).toBeNull()
      expect(r.relativePath).toBe('')
    })

    it("uses personal when mobileHome === 'personal'", () => {
      const r = svc.resolve(user({ mobileHome: 'personal' }), { mode: 'files', subpath: '' })
      expect(r.spaceAlias).toBe(SPACE_ALIAS.PERSONAL)
      expect(r.rootAlias).toBeNull()
    })

    it("parses mobileHome 'space:marketing' into a space with no root alias", () => {
      const r = svc.resolve(user({ mobileHome: 'space:marketing' }), { mode: 'files', subpath: '' })
      expect(r.spaceAlias).toBe('marketing')
      expect(r.rootAlias).toBeNull()
    })

    it("parses mobileHome 'space:marketing/shared-root' into alias + rootAlias", () => {
      const r = svc.resolve(user({ mobileHome: 'space:marketing/shared-root' }), { mode: 'files', subpath: '' })
      expect(r.spaceAlias).toBe('marketing')
      expect(r.rootAlias).toBe('shared-root')
    })

    it('falls back to personal for an unknown mobileHome value', () => {
      const r = svc.resolve(user({ mobileHome: 'random-garbage' }), { mode: 'files', subpath: '' })
      expect(r.spaceAlias).toBe(SPACE_ALIAS.PERSONAL)
      expect(r.rootAlias).toBeNull()
    })

    it('falls back to personal for an empty string mobileHome', () => {
      const r = svc.resolve(user({ mobileHome: '' }), { mode: 'files', subpath: '' })
      expect(r.spaceAlias).toBe(SPACE_ALIAS.PERSONAL)
    })

    it('falls back to personal when mobileHome is non-string', () => {
      const r = svc.resolve(user({ mobileHome: 42 }), { mode: 'files', subpath: '' })
      expect(r.spaceAlias).toBe(SPACE_ALIAS.PERSONAL)
    })

    it('switches repository to TRASH when mode is trashbin', () => {
      const r = svc.resolve(user(null), { mode: 'trashbin', subpath: 'x/y' })
      expect(r.repository).toBe(SPACE_REPOSITORY.TRASH)
      expect(r.relativePath).toBe('x/y')
    })
  })

  describe('resolve — subpath normalization', () => {
    it('strips leading slashes', () => {
      expect(svc.resolve(user(null), { mode: 'files', subpath: '///foo/bar' }).relativePath).toBe('foo/bar')
    })

    it('strips trailing slashes', () => {
      expect(svc.resolve(user(null), { mode: 'files', subpath: 'foo/bar///' }).relativePath).toBe('foo/bar')
    })

    it('collapses double slashes', () => {
      expect(svc.resolve(user(null), { mode: 'files', subpath: 'a//b///c' }).relativePath).toBe('a/b/c')
    })

    it('rejects paths containing ".." segments (maps to empty)', () => {
      expect(svc.resolve(user(null), { mode: 'files', subpath: 'foo/../etc' }).relativePath).toBe('')
    })

    it('rejects paths containing "." segments (maps to empty)', () => {
      expect(svc.resolve(user(null), { mode: 'files', subpath: 'foo/./bar' }).relativePath).toBe('')
    })

    it('URL-decodes percent-escapes (foo%20bar → "foo bar")', () => {
      expect(svc.resolve(user(null), { mode: 'files', subpath: 'foo%20bar/baz' }).relativePath).toBe('foo bar/baz')
    })

    it('tolerates malformed percent-escapes by keeping them verbatim', () => {
      // Malformed sequence — decodeURIComponent throws, we keep the raw value.
      expect(svc.resolve(user(null), { mode: 'files', subpath: '%E0%A4%A' }).relativePath).toBe('%E0%A4%A')
    })

    it('empty subpath stays empty', () => {
      expect(svc.resolve(user(null), { mode: 'files', subpath: '' }).relativePath).toBe('')
    })
  })

  describe('toInternalPath', () => {
    it('produces files/personal/<relative>', () => {
      const r = svc.resolve(user(null), { mode: 'files', subpath: 'a/b' })
      expect(svc.toInternalPath(r)).toBe('files/personal/a/b')
    })

    it('produces files/<alias>/<relative> for a space without rootAlias', () => {
      const r = svc.resolve(user({ mobileHome: 'space:marketing' }), { mode: 'files', subpath: 'docs/x' })
      expect(svc.toInternalPath(r)).toBe('files/marketing/docs/x')
    })

    it('produces trash/<alias>/<rootAlias>/<relative> for a space with a root', () => {
      const r = svc.resolve(user({ mobileHome: 'space:marketing/shared-root' }), { mode: 'trashbin', subpath: 'x' })
      expect(svc.toInternalPath(r)).toBe('trash/marketing/shared-root/x')
    })

    it('produces just the space segments when relativePath is empty', () => {
      const r = svc.resolve(user({ mobileHome: 'space:marketing' }), { mode: 'files', subpath: '' })
      expect(svc.toInternalPath(r)).toBe('files/marketing')
    })

    it('produces trash/personal when trashbin mode on default settings', () => {
      const r = svc.resolve(user(null), { mode: 'trashbin', subpath: 'deleted.txt' })
      expect(svc.toInternalPath(r)).toBe('trash/personal/deleted.txt')
    })
  })
})
