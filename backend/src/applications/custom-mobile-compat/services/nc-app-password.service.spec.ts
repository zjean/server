import { Test, TestingModule } from '@nestjs/testing'
import { AUTH_SCOPE } from '../../../authentication/constants/scope'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { UsersQueries } from '../../users/services/users-queries.service'
import { NcAppPasswordService } from './nc-app-password.service'
import { Mock } from 'vitest'

describe(NcAppPasswordService.name, () => {
  let moduleRef: TestingModule
  let service: NcAppPasswordService
  let listAppPasswords: Mock
  let deleteAppPassword: Mock
  let mutateUserSecrets: Mock
  // Secrets document the stateful mutateUserSecrets mock reads and writes, mirroring
  // upstream's own users-manager spec helper.
  let currentSecrets: Record<string, any>
  const fakeUser = { id: 7, login: 'alice' } as UserModel

  beforeAll(async () => {
    listAppPasswords = vi.fn()
    deleteAppPassword = vi.fn()
    mutateUserSecrets = vi.fn().mockImplementation(async (_userId: number, mutate: (secrets: any) => { result: any; secrets?: any }) => {
      const mutation = mutate(currentSecrets)
      if (mutation.secrets !== undefined) currentSecrets = mutation.secrets
      return mutation.result
    })
    moduleRef = await Test.createTestingModule({
      providers: [
        NcAppPasswordService,
        { provide: UsersManager, useValue: { listAppPasswords, deleteAppPassword } },
        { provide: UsersQueries, useValue: { mutateUserSecrets } }
      ]
    }).compile()
    moduleRef.useLogger(['fatal'])
    service = moduleRef.get(NcAppPasswordService)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    listAppPasswords.mockReset()
    deleteAppPassword.mockReset()
    currentSecrets = {}
    // mockClear, not mockReset: the stateful implementation above must survive.
    mutateUserSecrets.mockClear()
  })

  function row(name: string, ageDays: number, app: AUTH_SCOPE = AUTH_SCOPE.MOBILE_NC) {
    return {
      name,
      app,
      // createdAt is an ISO string in the JSON column — service must tolerate
      // strings, Date instances, and missing values without crashing.
      createdAt: new Date(Date.now() - ageDays * 24 * 3600 * 1000).toISOString()
    }
  }

  it('does nothing when MOBILE_NC count is at or below the cap', async () => {
    listAppPasswords.mockResolvedValueOnce([row('mobile a', 1), row('mobile b', 2)])
    const removed = await service.pruneMobileAppPasswords(fakeUser)
    expect(removed).toBe(0)
    expect(deleteAppPassword).not.toHaveBeenCalled()
  })

  it('drops oldest MOBILE_NC rows so a fresh mint lands at exactly MAX', async () => {
    // 8 mobile rows, ages 1..8 days. With MAX=5 and we want post-mint <= 5,
    // the service should keep the (MAX-1)=4 newest and drop 4 oldest.
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => row(`mobile ${d}`, d))
    listAppPasswords.mockResolvedValueOnce(rows)
    const removed = await service.pruneMobileAppPasswords(fakeUser)
    expect(removed).toBe(4)
    const deletedNames = deleteAppPassword.mock.calls.map(([, name]) => name).sort()
    expect(deletedNames).toEqual(['mobile 5', 'mobile 6', 'mobile 7', 'mobile 8'])
  })

  it('only touches MOBILE_NC rows; other scopes are left alone', async () => {
    listAppPasswords.mockResolvedValueOnce([
      row('m a', 1),
      row('m b', 2),
      row('m c', 3),
      row('m d', 4),
      row('m e', 5),
      row('m f', 6),
      row('desktop x', 1, 'desktop' as AUTH_SCOPE),
      row('webdav y', 30, 'webdav' as AUTH_SCOPE)
    ])
    await service.pruneMobileAppPasswords(fakeUser)
    const deletedNames = deleteAppPassword.mock.calls.map(([, name]) => name)
    expect(deletedNames).not.toContain('desktop x')
    expect(deletedNames).not.toContain('webdav y')
  })

  it('tolerates a concurrent delete race (deleteAppPassword throws)', async () => {
    listAppPasswords.mockResolvedValueOnce([row('m a', 1), row('m b', 2), row('m c', 3), row('m d', 4), row('m e', 5)])
    deleteAppPassword.mockRejectedValueOnce(new Error('App password not found'))
    const removed = await service.pruneMobileAppPasswords(fakeUser)
    // One row deleted successfully, one race; service does not blow up.
    expect(removed).toBe(0) // the only over-cap row raced — accounting reflects that
    expect(deleteAppPassword).toHaveBeenCalledTimes(1)
  })

  it('honors a custom keep parameter (used by tests; default = MAX_MOBILE_PASSWORDS)', async () => {
    listAppPasswords.mockResolvedValueOnce([row('a', 1), row('b', 2), row('c', 3)])
    // keep=2 → leave 1, drop 2.
    const removed = await service.pruneMobileAppPasswords(fakeUser, 2)
    expect(removed).toBe(2)
  })

  it('treats undefined createdAt as oldest (gets pruned first)', async () => {
    // Explicit Date undefined — sort must not crash, and the row should land
    // at the bottom of the priority list (oldest), so it's dropped first.
    listAppPasswords.mockResolvedValueOnce([
      { name: 'no-date', app: AUTH_SCOPE.MOBILE_NC, createdAt: undefined },
      row('m a', 1),
      row('m b', 2),
      row('m c', 3),
      row('m d', 4),
      row('m e', 5)
    ])
    await service.pruneMobileAppPasswords(fakeUser)
    expect(deleteAppPassword.mock.calls.map(([, n]) => n)).toContain('no-date')
  })

  describe('mintMobileAppPassword', () => {
    // Why these tests live here: the cleartext returned by mintMobileAppPassword
    // gets dropped into the `nc://login/server:...&password:...` deep-link.
    // If the cleartext contains URL-special characters that the receiving NC
    // client decodes during URL parsing (e.g. `&`, `#`, `%`), the password
    // gets truncated mid-flight and the very first authenticated request
    // is rejected with 401 — surfacing as the user-visible "Fout: Unauthorized"
    // alert. The contract this test pins is: the cleartext is base64url
    // (A–Z, a–z, 0–9, `-`, `_`) and nothing else.
    const URL_SAFE_RE = /^[A-Za-z0-9_-]+$/

    it('returns URL-safe cleartext (no &, #, %, or other URL-significant chars)', async () => {
      const result = await service.mintMobileAppPassword(fakeUser, 'mobile abc12345')
      expect(result.password).toMatch(URL_SAFE_RE)
      expect(result.password.length).toBeGreaterThanOrEqual(20)
    })

    it('produces a fresh password on each call (sanity check on randomness)', async () => {
      const a = await service.mintMobileAppPassword(fakeUser, 'mobile aa')
      const b = await service.mintMobileAppPassword(fakeUser, 'mobile bb')
      expect(a.password).not.toBe(b.password)
    })

    it('persists a new MOBILE_NC row with the hashed cleartext', async () => {
      await service.mintMobileAppPassword(fakeUser, 'mobile abc12345')
      // Writes go through mutateUserSecrets so the read/check/append is serialized
      // under the row lock upstream added in 2.5.0.
      expect(mutateUserSecrets).toHaveBeenCalledTimes(1)
      expect(mutateUserSecrets.mock.calls[0][0]).toBe(fakeUser.id)
      const newRow = currentSecrets.appPasswords[0]
      expect(newRow.app).toBe(AUTH_SCOPE.MOBILE_NC)
      expect(newRow.name).toBe('mobile abc12345')
      // Stored value MUST be the bcrypt hash, not the cleartext.
      expect(newRow.password).toMatch(/^\$2[aby]\$/)
    })

    it('rejects with 400 when the slugified name collides with an existing row', async () => {
      currentSecrets = { appPasswords: [{ name: 'mobile abc12345', app: AUTH_SCOPE.MOBILE_NC, password: 'hash' }] }
      await expect(service.mintMobileAppPassword(fakeUser, 'mobile abc12345')).rejects.toMatchObject({
        message: 'Name already used',
        status: 400
      })
      // The collision is detected INSIDE the mutation callback, so the row must be
      // left untouched even though the lock was taken.
      expect(currentSecrets.appPasswords).toHaveLength(1)
    })

    it('rejects with 500 when the secrets write fails', async () => {
      mutateUserSecrets.mockRejectedValueOnce(new Error('deadlock'))
      await expect(service.mintMobileAppPassword(fakeUser, 'mobile abc12345')).rejects.toMatchObject({
        status: 500
      })
    })
  })
})
