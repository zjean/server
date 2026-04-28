import { Test, TestingModule } from '@nestjs/testing'
import { AUTH_SCOPE } from '../../../authentication/constants/scope'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcAppPasswordService } from './nc-app-password.service'

describe(NcAppPasswordService.name, () => {
  let moduleRef: TestingModule
  let service: NcAppPasswordService
  let listAppPasswords: jest.Mock
  let deleteAppPassword: jest.Mock
  const fakeUser = { id: 7, login: 'alice' } as UserModel

  beforeAll(async () => {
    listAppPasswords = jest.fn()
    deleteAppPassword = jest.fn()
    moduleRef = await Test.createTestingModule({
      providers: [NcAppPasswordService, { provide: UsersManager, useValue: { listAppPasswords, deleteAppPassword } }]
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
})
