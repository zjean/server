import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Mock } from 'vitest'
import type { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcActivityService } from '../services/nc-activity.service'
import { NcResponseService } from '../services/nc-response.service'
import { NcActivityController } from './nc-activity.controller'

const USER = { id: 7, login: 'alice' } as UserModel

const ENTRY = {
  activity_id: 77,
  datetime: '2025-07-20T10:00:00.000Z',
  date: '2025-07-20T10:00:00.000Z',
  app: 'files',
  type: 'file_changed',
  user: 'alice',
  affecteduser: 'alice',
  subject: 'You changed report.txt',
  message: '',
  icon: '',
  link: 'https://cloud.example.test/remote.php/dav/files/alice/docs/report.txt',
  object_type: 'files',
  object_id: 4242,
  object_name: 'report.txt',
  previews: [],
  subject_rich: []
}

function makeRes() {
  const headers: Record<string, string> = {}
  return {
    headers,
    res: { header: (k: string, v: string) => (headers[k] = v) } as unknown as FastifyReply
  }
}

const req = () => ({ headers: {}, user: USER }) as unknown as FastifyRequest & { user: UserModel }

describe(NcActivityController.name, () => {
  let moduleRef: TestingModule
  let controller: NcActivityController
  let recent: Mock
  let forFile: Mock

  beforeEach(async () => {
    recent = vi.fn().mockResolvedValue([])
    forFile = vi.fn().mockResolvedValue([])

    moduleRef = await Test.createTestingModule({
      controllers: [NcActivityController],
      providers: [
        { provide: NcActivityService, useValue: { recent, forFile } },
        { provide: NcResponseService, useValue: new NcResponseService() }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcActivityController)
  })

  afterEach(async () => await moduleRef?.close())

  /* ----------------------------------------------------------- the envelope */

  // THE ASSERTION THE WHOLE ENDPOINT EXISTS FOR.
  //
  // GetActivitiesRemoteOperation.parseResult navigates
  // jo.getAsJsonObject("ocs").getAsJsonArray("data") unconditionally. Any body
  // without an `ocs` key — Nest's own 404 JSON, for instance — makes that throw
  // NullPointerException, which is not caught anywhere up the stack, so NC
  // Android's file-detail list (file VERSIONS included) never renders. The
  // envelope is the fix; the data is the bonus.
  it('answers with an ocs envelope whose data is an array, which is what the Android parser navigates', async () => {
    const { res } = makeRes()
    const body = await controller.activities(req(), res)

    expect(body.ocs).toBeDefined()
    expect(Array.isArray(body.ocs.data)).toBe(true)
    expect(body.ocs.meta.statuscode).toBe(200)
    expect(body.ocs.meta.status).toBe('ok')
  })

  it('keeps the envelope shape for an empty feed, which is already enough to unblock the version list', async () => {
    const { res } = makeRes()
    const body = await controller.filtered(req(), res, 'files', '4242')

    expect(body.ocs.data).toEqual([])
    expect(body.ocs.meta.statuscode).toBe(200)
  })

  it('sets the JSON content type NC clients expect', async () => {
    const { res, headers } = makeRes()
    await controller.activities(req(), res)
    expect(headers['Content-Type']).toBe('application/json; charset=utf-8')
  })

  // hasMoreActivities() is `lastGiven > 0`, read from this header, and it drives
  // infinite scroll. Emitting it without implementing `since` would make Android
  // re-request the same page forever.
  it('does NOT set X-Activity-Last-Given, because paging is not implemented', async () => {
    const { res, headers } = makeRes()
    recent.mockResolvedValue([ENTRY])
    await controller.activities(req(), res)

    expect(Object.keys(headers)).not.toContain('X-Activity-Last-Given')
  })

  it('rejects an xml-only Accept, like every other OCS handler here', async () => {
    const xmlReq = { headers: { accept: 'application/xml' }, user: USER } as unknown as FastifyRequest & { user: UserModel }
    await expect(controller.activities(xmlReq, makeRes().res)).rejects.toMatchObject({ status: HttpStatus.NOT_ACCEPTABLE })
    await expect(controller.activities(xmlReq, makeRes().res)).rejects.toBeInstanceOf(HttpException)
  })

  /* ------------------------------------------------------------ the feeds */

  it('returns the account-wide feed', async () => {
    recent.mockResolvedValue([ENTRY])
    const body = await controller.activities(req(), makeRes().res)

    expect(recent).toHaveBeenCalledWith(USER, expect.any(String), 50)
    expect(body.ocs.data).toEqual([ENTRY])
    expect(body.ocs.meta.totalitems).toBe('1')
  })

  it('returns the per-file feed for the Android file-detail tab’s query shape', async () => {
    forFile.mockResolvedValue([ENTRY])
    // object_type=files & object_id=<fileId> & sort=desc is exactly what
    // GetActivitiesRemoteOperation sends when constructed with a fileId.
    const body = await controller.filtered(req(), makeRes().res, 'files', '4242')

    expect(forFile).toHaveBeenCalledWith(USER, 4242, expect.any(String), 50)
    expect(body.ocs.data).toEqual([ENTRY])
  })

  // Every one of these is an EMPTY FEED rather than a 4xx. A non-OCS error body
  // is the failure this endpoint exists to prevent, so there is no input for
  // which it may answer with one.
  it.each([
    ['a missing object_id', undefined, undefined],
    ['a non-numeric object_id', 'files', 'not-a-number'],
    ['a zero object_id', 'files', '0'],
    ['a negative object_id', 'files', '-1'],
    ['an object_type this fork records no activity for', 'comments', '4242']
  ])('answers an empty feed for %s', async (_label, objectType, objectId) => {
    const body = await controller.filtered(req(), makeRes().res, objectType, objectId)

    expect(body.ocs.data).toEqual([])
    expect(body.ocs.meta.statuscode).toBe(200)
    expect(forFile).not.toHaveBeenCalled()
  })

  /* -------------------------------------------------------------- limits */

  it.each([
    ['no limit', undefined, 50],
    ['an explicit limit', '10', 10],
    ['a limit above the cap', '9999', 200],
    ['a zero limit', '0', 50],
    ['a junk limit', 'abc', 50],
    ['a negative limit', '-5', 50]
  ])('clamps %s to %i', async (_label, raw, expected) => {
    await controller.activities(req(), makeRes().res, raw)
    expect(recent).toHaveBeenCalledWith(USER, expect.any(String), expected)
  })

  it('applies the same clamp to the filtered feed', async () => {
    await controller.filtered(req(), makeRes().res, 'files', '4242', '9999')
    expect(forFile).toHaveBeenCalledWith(USER, 4242, expect.any(String), 200)
  })
})
