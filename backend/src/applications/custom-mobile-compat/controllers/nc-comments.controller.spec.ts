import { Test, TestingModule } from '@nestjs/testing'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { CommentsQueries } from '../../comments/services/comments-queries.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import type { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcCommentsController } from './nc-comments.controller'

// Wire-format tests for the per-file Comments tab in NC iOS. NextcloudKit
// gates POST/PUT/DELETE on a 200..299 status and parses PROPFIND with
// SwiftyXMLParser; these specs lock down the contract on both axes so a
// future refactor can't silently regress NK to NKError.

const USER: UserModel = { id: 7, login: 'alice', fullName: 'Alice Liddell' } as UserModel

interface FakeRes {
  res: FastifyReply
  status?: number
  contentType?: string
  headers: Record<string, string>
  body?: string
}

function makeRes(): FakeRes {
  const state: FakeRes = { res: undefined as unknown as FastifyReply, headers: {} }
  const res = {
    status: (code: number) => {
      state.status = code
      return res
    },
    type: (ct: string) => {
      state.contentType = ct
      return res
    },
    header: (k: string, v: string) => {
      state.headers[k] = v
      return res
    },
    send: (payload?: string) => {
      state.body = payload
      return res
    }
  }
  state.res = res as unknown as FastifyReply
  return state
}

function makeReq(method: string, body: unknown = undefined): FastifyRequest & { user: UserModel } {
  return { method, body, user: USER } as unknown as FastifyRequest & { user: UserModel }
}

describe(NcCommentsController.name, () => {
  let moduleRef: TestingModule
  let controller: NcCommentsController
  let getUserFile: jest.Mock
  let getComments: jest.Mock
  let createComment: jest.Mock
  let updateComment: jest.Mock
  let deleteComment: jest.Mock

  beforeAll(async () => {
    getUserFile = jest.fn()
    getComments = jest.fn()
    createComment = jest.fn()
    updateComment = jest.fn()
    deleteComment = jest.fn()

    moduleRef = await Test.createTestingModule({
      controllers: [NcCommentsController],
      providers: [
        { provide: FilesQueries, useValue: { getUserFile } },
        { provide: CommentsQueries, useValue: { getComments, createComment, updateComment, deleteComment } },
        { provide: NcBasicAuthGuard, useValue: { canActivate: () => true } }
      ]
    })
      .overrideGuard(NcBasicAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    moduleRef.useLogger(['fatal'])
    controller = moduleRef.get(NcCommentsController)
  })

  afterAll(async () => {
    await moduleRef.close()
  })

  beforeEach(() => {
    getUserFile.mockReset()
    getComments.mockReset()
    createComment.mockReset()
    updateComment.mockReset()
    deleteComment.mockReset()
    getUserFile.mockResolvedValue({ id: 42, path: 'files/personal/Documents/report.docx' })
  })

  describe('PROPFIND /comments/files/:fileId — list', () => {
    it('returns 207 multistatus with one <d:response> per comment in NK wire shape', async () => {
      getComments.mockResolvedValue([
        {
          id: 1,
          userId: 7,
          fileId: 42,
          content: 'first',
          createdAt: new Date('2026-05-03T14:00:00Z'),
          modifiedAt: new Date('2026-05-03T14:00:00Z'),
          author: { login: 'alice', fullName: 'Alice Liddell', email: 'a@x', isAuthor: true },
          isFileOwner: true
        },
        {
          id: 2,
          userId: 8,
          fileId: 42,
          content: 'second',
          createdAt: new Date('2026-05-03T15:00:00Z'),
          modifiedAt: new Date('2026-05-03T15:00:00Z'),
          author: { login: 'bob', fullName: 'Bob Builder', email: 'b@x', isAuthor: false },
          isFileOwner: false
        }
      ])
      const r = makeRes()

      await controller.commentsForFile('42', makeReq('PROPFIND'), r.res)

      expect(r.status).toBe(207)
      expect(r.contentType).toBe('application/xml; charset=utf-8')
      expect(r.body).toContain('<oc:id>1</oc:id>')
      expect(r.body).toContain('<oc:id>2</oc:id>')
      expect(r.body).toContain('<oc:actorId>alice</oc:actorId>')
      expect(r.body).toContain('<oc:actorDisplayName>Bob Builder</oc:actorDisplayName>')
      expect(r.body).toContain('<oc:objectId>42</oc:objectId>')
      // NKDataFileXML.swift:735 drops entries whose status doesn't contain 200.
      expect(r.body).toContain('<d:status>HTTP/1.1 200 OK</d:status>')
    })

    it('falls back to login when fullName is empty (no blank byline in iOS)', async () => {
      getComments.mockResolvedValue([
        {
          id: 1,
          userId: 7,
          fileId: 42,
          content: 'x',
          createdAt: new Date('2026-05-03T14:00:00Z'),
          modifiedAt: new Date('2026-05-03T14:00:00Z'),
          author: { login: 'alice', fullName: '', email: '', isAuthor: true },
          isFileOwner: true
        }
      ])
      const r = makeRes()

      await controller.commentsForFile('42', makeReq('PROPFIND'), r.res)

      expect(r.body).toContain('<oc:actorDisplayName>alice</oc:actorDisplayName>')
    })

    it('returns an empty multistatus when there are no comments', async () => {
      getComments.mockResolvedValue([])
      const r = makeRes()

      await controller.commentsForFile('42', makeReq('PROPFIND'), r.res)

      expect(r.status).toBe(207)
      expect(r.body).toContain('<d:multistatus')
      expect(r.body).not.toContain('<d:response>')
    })

    it('passes isFileOwner=true to CommentsQueries (getUserFile already proved ownership)', async () => {
      getComments.mockResolvedValue([])
      await controller.commentsForFile('42', makeReq('PROPFIND'), makeRes().res)
      expect(getComments).toHaveBeenCalledWith(7, true, 42)
    })
  })

  describe('POST /comments/files/:fileId — create', () => {
    it('creates the comment from the JSON body and returns 201 with Content-Location', async () => {
      createComment.mockResolvedValue(99)
      const r = makeRes()

      await controller.commentsForFile('42', makeReq('POST', { actorType: 'users', verb: 'comment', message: 'looks good' }), r.res)

      expect(createComment).toHaveBeenCalledWith(7, 42, 'looks good')
      expect(r.status).toBe(201)
      expect(r.headers['Content-Location']).toBe('/remote.php/dav/comments/files/42/99')
    })

    it('400s on a missing message field', async () => {
      const r = makeRes()
      await controller.commentsForFile('42', makeReq('POST', { actorType: 'users', verb: 'comment' }), r.res)
      expect(r.status).toBe(400)
      expect(createComment).not.toHaveBeenCalled()
    })

    it('400s on a whitespace-only message', async () => {
      const r = makeRes()
      await controller.commentsForFile('42', makeReq('POST', { message: '   ' }), r.res)
      expect(r.status).toBe(400)
    })
  })

  describe('PROPPATCH /comments/files/:fileId — mark all as read', () => {
    const markBody = `<?xml version="1.0"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:set><d:prop><readMarker xmlns="http://owncloud.org/ns"/></d:prop></d:set>
</d:propertyupdate>`

    it('acknowledges with 207 multistatus + 200 propstat for oc:readMarker', async () => {
      const r = makeRes()
      await controller.commentsForFile('42', makeReq('PROPPATCH', markBody), r.res)
      expect(r.status).toBe(207)
      expect(r.contentType).toBe('application/xml; charset=utf-8')
      expect(r.body).toContain('<oc:readMarker')
      expect(r.body).toContain('<d:status>HTTP/1.1 200 OK</d:status>')
    })

    it('400s on a PROPPATCH body that is neither readMarker nor an update on this route', async () => {
      // The fileId-only route only accepts mark-as-read; updates need a
      // messageId segment.
      const r = makeRes()
      await controller.commentsForFile('42', makeReq('PROPPATCH', '<oc:message>x</oc:message>'), r.res)
      expect(r.status).toBe(400)
    })

    it('handles a Buffer body the same as a string body', async () => {
      const r = makeRes()
      await controller.commentsForFile('42', makeReq('PROPPATCH', Buffer.from(markBody, 'utf8')), r.res)
      expect(r.status).toBe(207)
    })
  })

  describe('PROPPATCH /comments/files/:fileId/:messageId — update', () => {
    const updateBody = `<?xml version="1.0"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:set><d:prop><oc:message>updated body</oc:message></d:prop></d:set>
</d:propertyupdate>`

    it('updates and acknowledges with 207 multistatus referencing oc:message', async () => {
      updateComment.mockResolvedValue(true)
      const r = makeRes()

      await controller.commentForMessage('42', '99', makeReq('PROPPATCH', updateBody), r.res)

      expect(updateComment).toHaveBeenCalledWith(7, 99, 42, 'updated body')
      expect(r.status).toBe(207)
      expect(r.body).toContain('<oc:message')
      expect(r.body).toContain('<d:status>HTTP/1.1 200 OK</d:status>')
    })

    it('404s when the comment does not belong to the user (CommentsQueries returns false)', async () => {
      updateComment.mockResolvedValue(false)
      const r = makeRes()

      await controller.commentForMessage('42', '99', makeReq('PROPPATCH', updateBody), r.res)

      expect(r.status).toBe(404)
    })

    it('400s on a malformed XML body', async () => {
      const r = makeRes()
      await controller.commentForMessage('42', '99', makeReq('PROPPATCH', '<not xml'), r.res)
      expect(r.status).toBe(400)
      expect(updateComment).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /comments/files/:fileId/:messageId', () => {
    it('returns 204 on a successful delete', async () => {
      deleteComment.mockResolvedValue(true)
      const r = makeRes()

      await controller.commentForMessage('42', '99', makeReq('DELETE'), r.res)

      // isFileOwner=true because getUserFile already proved it.
      expect(deleteComment).toHaveBeenCalledWith(7, 99, 42, true)
      expect(r.status).toBe(204)
    })

    it('404s when the comment is missing or not deletable by this user', async () => {
      deleteComment.mockResolvedValue(false)
      const r = makeRes()

      await controller.commentForMessage('42', '99', makeReq('DELETE'), r.res)

      expect(r.status).toBe(404)
    })
  })

  describe('authorization (FilesQueries.getUserFile)', () => {
    it('404s when fileId is not owned by the requesting user', async () => {
      getUserFile.mockResolvedValue(undefined)
      const r = makeRes()

      await controller.commentsForFile('42', makeReq('PROPFIND'), r.res)

      expect(r.status).toBe(404)
      expect(getComments).not.toHaveBeenCalled()
    })

    it('404s when getUserFile throws (defensive — invalid id, DB error, etc.)', async () => {
      getUserFile.mockRejectedValue(new Error('boom'))
      const r = makeRes()

      await controller.commentsForFile('42', makeReq('PROPFIND'), r.res)

      expect(r.status).toBe(404)
    })

    it('404s on the messageId route when the file is not owned', async () => {
      getUserFile.mockResolvedValue(undefined)
      const r = makeRes()

      await controller.commentForMessage('42', '99', makeReq('DELETE'), r.res)

      expect(r.status).toBe(404)
      expect(deleteComment).not.toHaveBeenCalled()
    })
  })

  describe('id validation', () => {
    it('404s on non-numeric fileId', async () => {
      const r = makeRes()
      await controller.commentsForFile('abc', makeReq('PROPFIND'), r.res)
      expect(r.status).toBe(404)
      expect(getUserFile).not.toHaveBeenCalled()
    })

    it('404s on zero / negative ids', async () => {
      const r1 = makeRes()
      await controller.commentsForFile('0', makeReq('PROPFIND'), r1.res)
      expect(r1.status).toBe(404)

      const r2 = makeRes()
      await controller.commentsForFile('-5', makeReq('PROPFIND'), r2.res)
      expect(r2.status).toBe(404)

      expect(getUserFile).not.toHaveBeenCalled()
    })

    it('404s on non-numeric messageId', async () => {
      const r = makeRes()
      await controller.commentForMessage('42', 'abc', makeReq('DELETE'), r.res)
      expect(r.status).toBe(404)
      expect(deleteComment).not.toHaveBeenCalled()
    })
  })

  describe('method routing', () => {
    it('returns 405 for unexpected methods on the fileId route', async () => {
      const r = makeRes()
      await controller.commentsForFile('42', makeReq('GET'), r.res)
      expect(r.status).toBe(405)
    })

    it('returns 405 for unexpected methods on the messageId route', async () => {
      const r = makeRes()
      await controller.commentForMessage('42', '99', makeReq('POST'), r.res)
      expect(r.status).toBe(405)
    })
  })
})
