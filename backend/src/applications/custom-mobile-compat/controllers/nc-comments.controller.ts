import { All, Controller, HttpStatus, Param, Req, Res, UseGuards } from '@nestjs/common'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AuthTokenSkip } from '../../../authentication/decorators/auth-token-skip.decorator'
import { CommentsQueries } from '../../comments/services/comments-queries.service'
import { FilesQueries } from '../../files/services/files-queries.service'
import { UserModel } from '../../users/models/user.model'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import {
  buildCommentsMultistatus,
  buildProppatchAck,
  isMarkAsReadProppatch,
  parsePostCommentBody,
  parseProppatchUpdateBody
} from '../utils/nc-comment-xml'
import type { NcCommentXmlEntry } from '../utils/nc-comment-xml'

// /remote.php/dav/comments/files/{fileId} (and /{fileId}/{messageId}) backs
// NC iOS's per-file Comments tab. NextcloudKit's wire shape (see
// NextcloudKit+Comments.swift) is:
//
//   PROPFIND  /comments/files/{fileId}              → list (XML 207)
//   POST      /comments/files/{fileId}              → create (JSON body)
//   PROPPATCH /comments/files/{fileId}              → mark all as read (XML)
//   PROPPATCH /comments/files/{fileId}/{messageId}  → update (XML)
//   DELETE    /comments/files/{fileId}/{messageId}  → delete
//
// We map them onto Sync-in's existing `comments` app (see
// applications/comments/) by going directly through CommentsQueries — the
// REST controller in CommentsController is space-bound (uses SpaceGuard with a
// URL path), but NC mobile only gives us a fileId. Authorization is provided
// by FilesQueries.getUserFile, which only returns files owned by the
// requesting user — same constraint as nc-onlyoffice-file-resolver. That makes
// MVP comments work on personal-space files only; comments on shared/space
// files yield 404 here. iOS gates the Comments tab on the global capability,
// not per-file — taps on unsupported files surface as an empty list rather
// than a hard error, which matches our spec.
//
// MVP also has no per-user unread state: oc:isUnread is always "false" and
// the readMarker PROPPATCH is acknowledged with a 200 propstat but performs
// no write. Unread tracking is a follow-up if/when a comments_read_marker
// table is added.

const XML_CONTENT_TYPE = 'application/xml; charset=utf-8'

@Controller()
@AuthTokenSkip()
@UseGuards(NcBasicAuthGuard)
export class NcCommentsController {
  constructor(
    private readonly filesQueries: FilesQueries,
    private readonly commentsQueries: CommentsQueries
  ) {}

  // List + Create + MarkAsRead share this route — NK varies the HTTP method
  // (PROPFIND / POST / PROPPATCH respectively).
  @All('remote.php/dav/comments/files/:fileId')
  async commentsForFile(
    @Param('fileId') fileIdParam: string,
    @Req() req: FastifyRequest & { user: UserModel },
    @Res() res: FastifyReply
  ): Promise<FastifyReply> {
    const fileId = parsePositiveInt(fileIdParam)
    if (fileId === null) return res.status(HttpStatus.NOT_FOUND).send()

    const file = await this.resolveOwnedFile(req.user, fileId)
    if (!file) return res.status(HttpStatus.NOT_FOUND).send()

    switch (req.method) {
      case 'PROPFIND':
        return this.handleList(res, req.user, fileId)
      case 'POST':
        return this.handleCreate(res, req.user, fileId, req.body)
      case 'PROPPATCH':
        return this.handleMarkAsRead(res, fileId, req.body)
      default:
        // NC iOS only sends the methods above; anything else is a probe or a
        // misconfiguration. 405 surfaces cleanly in NK's NKError pipeline.
        return res.status(HttpStatus.METHOD_NOT_ALLOWED).send()
    }
  }

  // Update + Delete address an individual comment.
  @All('remote.php/dav/comments/files/:fileId/:messageId')
  async commentForMessage(
    @Param('fileId') fileIdParam: string,
    @Param('messageId') messageIdParam: string,
    @Req() req: FastifyRequest & { user: UserModel },
    @Res() res: FastifyReply
  ): Promise<FastifyReply> {
    const fileId = parsePositiveInt(fileIdParam)
    const messageId = parsePositiveInt(messageIdParam)
    if (fileId === null || messageId === null) return res.status(HttpStatus.NOT_FOUND).send()

    const file = await this.resolveOwnedFile(req.user, fileId)
    if (!file) return res.status(HttpStatus.NOT_FOUND).send()

    switch (req.method) {
      case 'PROPPATCH':
        return this.handleUpdate(res, req.user, fileId, messageId, req.body)
      case 'DELETE':
        return this.handleDelete(res, req.user, fileId, messageId)
      default:
        return res.status(HttpStatus.METHOD_NOT_ALLOWED).send()
    }
  }

  // ──────── handlers ────────

  private async handleList(res: FastifyReply, user: UserModel, fileId: number): Promise<FastifyReply> {
    // getUserFile already proved ownership, so the file owner IS the
    // requester — pass isFileOwner=true so CommentsQueries doesn't redact.
    const comments = await this.commentsQueries.getComments(user.id, true, fileId)
    const entries: NcCommentXmlEntry[] = comments.map((c) => ({
      commentId: c.id,
      fileId,
      actorId: c.author.login,
      // NC iOS happily renders an empty actorDisplayName — fall back to login
      // so we don't leave the byline blank when fullName isn't set.
      actorDisplayName: c.author.fullName?.trim() || c.author.login,
      message: c.content ?? '',
      createdAt: c.createdAt
    }))
    return res.type(XML_CONTENT_TYPE).status(HttpStatus.MULTI_STATUS).send(buildCommentsMultistatus(entries))
  }

  private async handleCreate(res: FastifyReply, user: UserModel, fileId: number, body: unknown): Promise<FastifyReply> {
    const message = parsePostCommentBody(body)
    if (!message) return res.status(HttpStatus.BAD_REQUEST).send()

    const commentId = await this.commentsQueries.createComment(user.id, fileId, message)
    // NC iOS doesn't read the response body for POST (NKError checks status
    // only), but a Content-Location header pointing at the new resource is
    // the WebDAV-correct shape and useful for debugging.
    return res.status(HttpStatus.CREATED).header('Content-Location', `/remote.php/dav/comments/files/${fileId}/${commentId}`).send()
  }

  private async handleMarkAsRead(res: FastifyReply, fileId: number, body: unknown): Promise<FastifyReply> {
    if (!isMarkAsReadProppatch(toBodyString(body))) {
      return res.status(HttpStatus.BAD_REQUEST).send()
    }
    // No-op in MVP — there's no per-user read state. Acknowledge so NK's
    // markAsReadComments completion handler reports success.
    const ack = buildProppatchAck(`/remote.php/dav/comments/files/${fileId}`, 'oc:readMarker')
    return res.type(XML_CONTENT_TYPE).status(HttpStatus.MULTI_STATUS).send(ack)
  }

  private async handleUpdate(res: FastifyReply, user: UserModel, fileId: number, messageId: number, body: unknown): Promise<FastifyReply> {
    const message = parseProppatchUpdateBody(toBodyString(body))
    if (!message) return res.status(HttpStatus.BAD_REQUEST).send()

    // CommentsQueries.updateComment scopes the WHERE to (userId, commentId,
    // fileId), so a user can only edit their own comments. Returns false on
    // 0 affected rows — surface as 404 (NK's evaluateResponse will report it
    // as an NKError without retry, matching upstream NC behavior on
    // unauthorized edits).
    const ok = await this.commentsQueries.updateComment(user.id, messageId, fileId, message)
    if (!ok) return res.status(HttpStatus.NOT_FOUND).send()

    const ack = buildProppatchAck(`/remote.php/dav/comments/files/${fileId}/${messageId}`, 'oc:message')
    return res.type(XML_CONTENT_TYPE).status(HttpStatus.MULTI_STATUS).send(ack)
  }

  private async handleDelete(res: FastifyReply, user: UserModel, fileId: number, messageId: number): Promise<FastifyReply> {
    // getUserFile guarantees ownership, so isFileOwner=true — file owners can
    // delete any comment on their files (matches CommentsManager's policy).
    const ok = await this.commentsQueries.deleteComment(user.id, messageId, fileId, true)
    if (!ok) return res.status(HttpStatus.NOT_FOUND).send()
    return res.status(HttpStatus.NO_CONTENT).send()
  }

  // ──────── helpers ────────

  private async resolveOwnedFile(user: UserModel, fileId: number): Promise<{ id: number; path: string } | null> {
    try {
      const row = await this.filesQueries.getUserFile(user.id, fileId)
      return row ?? null
    } catch {
      return null
    }
  }
}

// Coerce :fileId / :messageId into a positive integer or null. NC iOS only
// ever sends digits, but an attacker could probe with negative ids or
// non-numeric junk; reject those at the door.
function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// PROPPATCH bodies arrive via Nest's XML body parser as either a Buffer
// (Fastify's '*' fallback) or a string (when the parser short-circuited the
// stream into a string). Coerce to the latter for the regex / XML-parse
// helpers in nc-comment-xml.
function toBodyString(body: unknown): string | null {
  if (typeof body === 'string') return body
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  return null
}
