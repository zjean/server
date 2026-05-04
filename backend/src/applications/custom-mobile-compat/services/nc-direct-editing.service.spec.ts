import { JwtModule, JwtService } from '@nestjs/jwt'
import { Test, type TestingModule } from '@nestjs/testing'
import { UserModel } from '../../users/models/user.model'
import { NcDirectEditingService, NC_DIRECT_EDITING_EDITOR_ID, NC_DIRECT_EDITING_EDITOR_NAME, NC_DIRECT_EDITING_TOKEN_TTL_SEC } from './nc-direct-editing.service'

function makeUser(overrides: Partial<UserModel> = {}): UserModel {
  return new UserModel({
    id: 7,
    login: 'alice',
    email: 'alice@example.test',
    firstName: 'Alice',
    lastName: 'Example',
    language: 'en',
    role: 1,
    permissions: '',
    applications: [],
    ...overrides
  } as Partial<UserModel>)
}

// Token signing secret for the test JwtModule. Production uses
// configuration.auth.token.access.secret — see service implementation.
const TEST_SECRET = 'test-secret-for-direct-editing-spec'

describe(NcDirectEditingService.name, () => {
  let moduleRef: TestingModule
  let svc: NcDirectEditingService
  let jwt: JwtService

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: TEST_SECRET })],
      providers: [NcDirectEditingService]
    }).compile()
    moduleRef.useLogger(['fatal'])
    svc = moduleRef.get(NcDirectEditingService)
    jwt = moduleRef.get(JwtService)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  describe('listEditors', () => {
    it('returns exactly one editor whose lowercased name matches what NC iOS gates on', () => {
      // iOS gates `isAvailableDirectEditingEditorView` on
      // `editors.contains("nextcloud text") || editors.contains("onlyoffice")`
      // (lowercased compare). Without this exact name, the Edit button never
      // appears in NC iOS.
      const editors = svc.listEditors()
      const names = Object.values(editors).map((e) => e.name.toLowerCase())
      expect(names).toContain('nextcloud text')
    })

    it('exposes the editor under a stable id (not the editor name)', () => {
      // The dict key is the editor *id*, used in /open?editorId=<id>.
      const editors = svc.listEditors()
      expect(editors[NC_DIRECT_EDITING_EDITOR_ID]).toBeDefined()
      expect(editors[NC_DIRECT_EDITING_EDITOR_ID].id).toBe(NC_DIRECT_EDITING_EDITOR_ID)
      expect(editors[NC_DIRECT_EDITING_EDITOR_ID].name).toBe(NC_DIRECT_EDITING_EDITOR_NAME)
    })

    it("declares secure=false because we don't gate on Files-Access-Control", () => {
      const editors = svc.listEditors()
      expect(editors[NC_DIRECT_EDITING_EDITOR_ID].secure).toBe(false)
    })

    it('advertises common text mimetypes that an in-browser textarea/CodeMirror can edit', () => {
      const editors = svc.listEditors()
      const mimes = editors[NC_DIRECT_EDITING_EDITOR_ID].mimetypes
      // Sanity-check a representative slice — full list lives in the impl.
      expect(mimes).toEqual(expect.arrayContaining(['text/plain', 'text/markdown', 'application/json', 'text/css', 'text/html']))
    })

    it('does not advertise binary office mimetypes (those are OnlyOffice territory)', () => {
      const editors = svc.listEditors()
      const mimes = editors[NC_DIRECT_EDITING_EDITOR_ID].mimetypes
      expect(mimes).not.toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      expect(mimes).not.toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    })
  })

  describe('listCreators', () => {
    it('returns empty for now — NC iOS does not require creators to show Edit on existing files', () => {
      // Creators power the "+" new-document menu inside NC iOS. Edit-existing
      // doesn't read this. Keep empty until we implement template-creation.
      expect(svc.listCreators()).toEqual({})
    })
  })

  describe('editorCatalogEtag', () => {
    it('returns a stable etag string for the same catalog', () => {
      const a = svc.editorCatalogEtag()
      const b = svc.editorCatalogEtag()
      expect(a).toBe(b)
      expect(a).toMatch(/^[a-f0-9]+$/)
      expect(a.length).toBeGreaterThanOrEqual(8)
    })
  })

  describe('mintEditToken / verifyEditToken', () => {
    it('round-trips identity + fileId through a signed JWT', async () => {
      const user = makeUser({ id: 7, login: 'alice', email: 'alice@example.test' })
      const token = await svc.mintEditToken({ user, fileId: 42 })
      expect(typeof token).toBe('string')
      expect(token.split('.').length).toBe(3) // header.payload.signature

      const claims = await svc.verifyEditToken(token)
      expect(claims.fileId).toBe(42)
      expect(claims.identity).toMatchObject({ id: 7, login: 'alice', email: 'alice@example.test' })
    })

    it('issues tokens with the documented short TTL (so leaked URLs expire fast)', async () => {
      const token = await svc.mintEditToken({ user: makeUser(), fileId: 1 })
      const decoded = jwt.decode(token) as { iat: number; exp: number; scope: string }
      expect(decoded.exp - decoded.iat).toBe(NC_DIRECT_EDITING_TOKEN_TTL_SEC)
      // Scope claim narrows the token's blast radius if the access secret
      // is reused for other internal flows. Editor endpoints check it.
      expect(decoded.scope).toBe('nc-direct-editing:edit')
    })

    it('reconstructs only the safe identity fields — no password, no secrets', async () => {
      // Defense in depth: even if someone passes a UserModel that still
      // carries password/secrets, the token must not leak them. Confirms
      // identityFromUser whitelists fields rather than spreading.
      const user = makeUser({ id: 7, login: 'alice' })
      ;(user as unknown as Record<string, unknown>).password = 'should-not-leak'
      ;(user as unknown as Record<string, unknown>).secrets = { totpSecret: 'never' }

      const token = await svc.mintEditToken({ user, fileId: 1 })
      const decoded = jwt.decode(token) as { identity: Record<string, unknown> }
      expect(decoded.identity.password).toBeUndefined()
      expect(decoded.identity.secrets).toBeUndefined()
    })

    it('rejects tokens signed with a different secret', async () => {
      // Sign a payload with a DIFFERENT secret — verify must reject.
      const wrong = await jwt.signAsync(
        { identity: { id: 7, login: 'alice' }, fileId: 42, scope: 'nc-direct-editing:edit' },
        { secret: 'different-secret', expiresIn: 60 }
      )
      await expect(svc.verifyEditToken(wrong)).rejects.toBeDefined()
    })

    it('rejects tokens with the wrong scope (defense in depth if secret is reused)', async () => {
      const wrongScope = await jwt.signAsync(
        { identity: { id: 7, login: 'alice' }, fileId: 42, scope: 'something-else' },
        { secret: TEST_SECRET, expiresIn: 60 }
      )
      await expect(svc.verifyEditToken(wrongScope)).rejects.toBeDefined()
    })

    it('rejects tokens missing the identity claim entirely', async () => {
      const noIdentity = await jwt.signAsync({ fileId: 42, scope: 'nc-direct-editing:edit' }, { secret: TEST_SECRET, expiresIn: 60 })
      await expect(svc.verifyEditToken(noIdentity)).rejects.toBeDefined()
    })

    it('rejects expired tokens', async () => {
      // Sign with a negative expiry → already expired at issue time.
      const expired = await jwt.signAsync(
        { identity: { id: 7, login: 'alice' }, fileId: 42, scope: 'nc-direct-editing:edit' },
        { secret: TEST_SECRET, expiresIn: -1 }
      )
      await expect(svc.verifyEditToken(expired)).rejects.toBeDefined()
    })

    it('rejects garbage tokens', async () => {
      await expect(svc.verifyEditToken('not.a.jwt')).rejects.toBeDefined()
      await expect(svc.verifyEditToken('')).rejects.toBeDefined()
    })
  })

  describe('isEditableMime', () => {
    it('returns true for any mimetype the catalog advertises', () => {
      expect(svc.isEditableMime('text/plain')).toBe(true)
      expect(svc.isEditableMime('text/markdown')).toBe(true)
      expect(svc.isEditableMime('application/json')).toBe(true)
    })

    it("returns true for Sync-in's stored form (slash replaced by dash) — defensive", () => {
      // Sync-in stores mimes as `image-jpeg`, `text-plain`. Callers may pass
      // either form depending on whether they pulled from DB or REST.
      expect(svc.isEditableMime('text-plain')).toBe(true)
      expect(svc.isEditableMime('text-markdown')).toBe(true)
    })

    it('returns false for binary types not in the catalog', () => {
      expect(svc.isEditableMime('image/jpeg')).toBe(false)
      expect(svc.isEditableMime('application/octet-stream')).toBe(false)
      expect(svc.isEditableMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false)
    })

    it('handles undefined / empty inputs gracefully (returns false)', () => {
      expect(svc.isEditableMime(undefined)).toBe(false)
      expect(svc.isEditableMime('')).toBe(false)
      expect(svc.isEditableMime(null as unknown as string)).toBe(false)
    })
  })
})
