import { Test, TestingModule } from '@nestjs/testing'
import { NcSyncLogScheduler } from './nc-sync-log-scheduler.service'
import { NcSyncLogService } from './nc-sync-log.service'
import { Mock } from 'vitest'

describe(NcSyncLogScheduler.name, () => {
  let moduleRef: TestingModule
  let scheduler: NcSyncLogScheduler
  let prune: Mock

  beforeAll(async () => {
    prune = vi.fn()
    moduleRef = await Test.createTestingModule({
      providers: [NcSyncLogScheduler, { provide: NcSyncLogService, useValue: { prune } }]
    }).compile()
    moduleRef.useLogger(['fatal'])
    scheduler = moduleRef.get(NcSyncLogScheduler)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    prune.mockReset()
  })

  it('invokes NcSyncLogService.prune on each scheduled run', async () => {
    prune.mockResolvedValueOnce(7)
    await scheduler.runScheduledPrune()
    expect(prune).toHaveBeenCalledTimes(1)
  })

  it('swallows prune failures so a single bad run does not crash the scheduler', async () => {
    prune.mockRejectedValueOnce(new Error('db down'))
    await expect(scheduler.runScheduledPrune()).resolves.toBeUndefined()
    expect(prune).toHaveBeenCalledTimes(1)
  })
})
