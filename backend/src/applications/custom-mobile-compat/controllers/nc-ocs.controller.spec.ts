import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { UsersManager } from '../../users/services/users-manager.service'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcResponseService } from '../services/nc-response.service'
import { NcOcsController } from './nc-ocs.controller'

// Bare-bones request/reply doubles. The OCS handlers we exercise here only
// touch headers + return shape, so we don't need a full fastify-inject setup.
function makeReq(): FastifyRequest {
  return { headers: { accept: 'application/json' } } as unknown as FastifyRequest
}
function makeRes(): { res: FastifyReply; headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  const res = {
    header: (k: string, v: string) => {
      headers[k] = v
      return res
    }
  }
  return { res: res as unknown as FastifyReply, headers }
}

describe(NcOcsController.name, () => {
  let moduleRef: TestingModule
  let controller: NcOcsController

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [NcOcsController],
      providers: [
        NcResponseService,
        { provide: UsersManager, useValue: { listAppPasswords: jest.fn(), validateAppPassword: jest.fn(), deleteAppPassword: jest.fn() } },
        { provide: NcBasicAuthGuard, useValue: { canActivate: () => true, evictCache: jest.fn() } }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcOcsController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  describe('directEditing', () => {
    // NC iOS calls /ocs/v2.php/apps/files/api/v1/directEditing the first time
    // it considers showing an Edit button (NextcloudKit+NCText.swift). A 404
    // raises a "Direct editing unavailable" toast on every editable file open.
    // We return an empty editor/creator map so iOS treats direct-editing as
    // disabled silently. OnlyOffice continues to work via its own connector
    // at /index.php/apps/onlyoffice/config -- that path is unaffected.
    it('returns an OCS envelope with empty editors and creators maps', () => {
      const { res, headers } = makeRes()
      const out = controller.directEditing(makeReq(), res)
      expect(out).toEqual({
        ocs: {
          meta: { status: 'ok', statuscode: 200, message: '' },
          data: { editors: {}, creators: {} }
        }
      })
      expect(headers['Content-Type']).toBe('application/json; charset=utf-8')
    })
  })
})
