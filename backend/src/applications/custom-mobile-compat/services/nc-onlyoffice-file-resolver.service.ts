import { Injectable } from '@nestjs/common'
import { FilesQueries } from '../../files/services/files-queries.service'
import type { SpaceEnv } from '../../spaces/models/space-env.model'
import { SpacesManager } from '../../spaces/services/spaces-manager.service'
import type { UserModel } from '../../users/models/user.model'

// Shared by NcOnlyOfficeController (/config) and NcOnlyOfficeCallbackController
// (/track). Mirrors nc-extras.controller's resolveFileId — files in
// non-personal spaces are not yet addressable via fileId from the
// mobile-compat surface.
@Injectable()
export class NcOnlyOfficeFileResolver {
  constructor(
    private readonly filesQueries: FilesQueries,
    private readonly spacesManager: SpacesManager
  ) {}

  async resolve(user: UserModel, fileId: number): Promise<SpaceEnv | null> {
    let row: { id: number; path: string } | null = null
    try {
      row = await this.filesQueries.getUserFile(user.id, fileId)
    } catch {
      return null
    }
    if (!row?.path) return null
    const pathSegments = row.path.split('/').filter(Boolean)
    const urlSegments = ['files', 'personal', ...pathSegments]
    try {
      return await this.spacesManager.spaceEnv(user, urlSegments)
    } catch {
      return null
    }
  }
}
