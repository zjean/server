import { Controller, Delete, Get, HttpException, HttpStatus, Param, Req, Res, UseGuards } from '@nestjs/common'
import { FastifyReply, FastifyRequest } from 'fastify'
import { UserModel } from '../../users/models/user.model'
import { UsersManager } from '../../users/services/users-manager.service'
import { ncCapabilities, type NcCapabilitiesPayload } from '../constants/capabilities'
import { NcBasicAuthGuard } from '../guards/nc-basic-auth.guard'
import { NcResponseService } from '../services/nc-response.service'
import { type OcsEnvelope } from '../utils/ocs-envelope'

// OCS endpoints hit by the NC mobile clients. Responses are JSON-only; see
// NcResponseService.requireJson. Not covered here (deferred): shares, sharees,
// notifications, search — see design doc §non-goals.
@Controller()
export class NcOcsController {
  constructor(
    private readonly response: NcResponseService,
    private readonly usersManager: UsersManager
  ) {}

  // Capabilities — public. Called both pre-login (server selection) and
  // post-login (to re-check features).
  @Get('ocs/v1.php/cloud/capabilities')
  capabilitiesV1(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply): OcsEnvelope<NcCapabilitiesPayload> {
    this.response.requireJson(req)
    return this.response.json(res, ncCapabilities(this.response.baseUrl(req)))
  }

  @Get('ocs/v2.php/cloud/capabilities')
  capabilitiesV2(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply): OcsEnvelope<NcCapabilitiesPayload> {
    this.response.requireJson(req)
    return this.response.json(res, ncCapabilities(this.response.baseUrl(req)))
  }

  // "Who am I" — Nextcloud clients call this right after login to pin the
  // loginName and quota. Uses the authenticated user attached by the guard.
  @Get('ocs/v2.php/cloud/user')
  @UseGuards(NcBasicAuthGuard)
  currentUser(@Req() req: FastifyRequest & { user: UserModel }, @Res({ passthrough: true }) res: FastifyReply): OcsEnvelope<NcUserPayload> {
    this.response.requireJson(req)
    return this.response.json(res, buildUserPayload(req.user))
  }

  // Per-user provisioning lookup. Mobile clients call /cloud/users/<me> after
  // /cloud/user; we only allow reading your own profile here.
  @Get('ocs/v1.php/cloud/users/:userid')
  userProvisioningV1(
    @Param('userid') userid: string,
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply
  ): OcsEnvelope<NcUserPayload> {
    return this.doUserProvisioning(userid, req, res)
  }

  @Get('ocs/v2.php/cloud/users/:userid')
  @UseGuards(NcBasicAuthGuard)
  userProvisioningV2(
    @Param('userid') userid: string,
    @Req() req: FastifyRequest & { user: UserModel },
    @Res({ passthrough: true }) res: FastifyReply
  ): OcsEnvelope<NcUserPayload> {
    return this.doUserProvisioning(userid, req, res)
  }

  // DELETE apppassword — clients call this on explicit logout to invalidate
  // their minted credentials. We find the app-password whose hashed value
  // matches the one the guard just verified and drop it.
  @Delete('ocs/v2.php/core/apppassword')
  @UseGuards(NcBasicAuthGuard)
  async revokeAppPassword(
    @Req() req: FastifyRequest & { user: UserModel; headers: FastifyRequest['headers'] },
    @Res({ passthrough: true }) res: FastifyReply
  ): Promise<OcsEnvelope<Record<string, never>>> {
    this.response.requireJson(req)
    const auth = req.headers['authorization']
    const parsed = parseAuth(auth)
    if (!parsed) throw new HttpException('Missing credentials', HttpStatus.BAD_REQUEST)

    const found = await this.findAppPasswordName(req.user, parsed.password)
    if (found) {
      await this.usersManager.deleteAppPassword(req.user, found)
    }
    return this.response.json(res, {})
  }

  // Look up the named app-password entry whose hash matches `candidate`. We
  // need the name (slug) to call deleteAppPassword. O(app-passwords) — tiny.
  private async findAppPasswordName(user: UserModel, candidate: string): Promise<string | null> {
    const list = await this.usersManager.listAppPasswords(user)
    // listAppPasswords strips `password`; we need the raw secrets to compare
    // hashes. Delegate to the manager's verify path: it already walks the
    // hashed list. Simpler: re-walk and compare via comparePassword.
    // To avoid private-field access we re-use validateAppPassword which sets
    // `currentAccess` as a side effect — fine — then delete by iterating the
    // list for the newly-accessed entry. The list ordering is insertion-desc;
    // the first entry whose currentAccess matches "just now" is our match.
    const beforeTs = list[0]?.currentAccess ?? null
    const ok = await this.usersManager.validateAppPassword(user, candidate, '0.0.0.0', (await import('../../../authentication/constants/scope')).AUTH_SCOPE.MOBILE_NC)
    if (!ok) return null
    const after = await this.usersManager.listAppPasswords(user)
    // Find the entry whose currentAccess changed.
    for (const entry of after) {
      const prev = list.find((p) => p.name === entry.name)
      if (!prev || `${prev.currentAccess ?? ''}` !== `${entry.currentAccess ?? ''}`) {
        return entry.name
      }
    }
    // Fall-back: if we can't pinpoint, return the newest entry's name.
    return after[0]?.name ?? null
  }

  private doUserProvisioning(
    userid: string,
    req: FastifyRequest & { user: UserModel },
    res: FastifyReply
  ): OcsEnvelope<NcUserPayload> {
    this.response.requireJson(req)
    if (userid !== req.user.login) {
      throw new HttpException('forbidden', HttpStatus.FORBIDDEN)
    }
    return this.response.json(res, buildUserPayload(req.user))
  }
}

interface NcUserPayload {
  enabled: boolean
  id: string
  lastLogin: number
  backend: string
  subadmin: string[]
  quota: { free: number; used: number; total: number; relative: number; quota: number }
  email: string | null
  phone: string
  address: string
  website: string
  twitter: string
  groups: string[]
  language: string
  locale: string
  backendCapabilities: { setDisplayName: boolean; setPassword: boolean }
  displayname: string
  'display-name': string
}

function buildUserPayload(user: UserModel): NcUserPayload {
  const total = user.storageQuota ?? -1
  const used = user.storageUsage ?? 0
  const free = total < 0 ? -1 : Math.max(0, total - used)
  const relative = total > 0 ? Math.round((used / total) * 10000) / 100 : 0
  return {
    enabled: !!user.isActive,
    id: user.login,
    lastLogin: user.lastAccess ? new Date(user.lastAccess).getTime() : 0,
    backend: 'Database',
    subadmin: [],
    quota: { free, used, total, relative, quota: total },
    email: user.email ?? null,
    phone: '',
    address: '',
    website: '',
    twitter: '',
    groups: [],
    language: user.language ?? 'en',
    locale: user.language ?? 'en',
    backendCapabilities: { setDisplayName: false, setPassword: false },
    displayname: user.fullName ?? user.login,
    'display-name': user.fullName ?? user.login
  }
}

function parseAuth(authHeader: string | string[] | undefined): { login: string; password: string } | null {
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader
  if (!header) return null
  const match = /^Basic\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  const sep = decoded.indexOf(':')
  if (sep < 1) return null
  return { login: decoded.slice(0, sep), password: decoded.slice(sep + 1) }
}
