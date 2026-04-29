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

  // Resolve a parent fileId + child name into a SpaceEnv pointing at the
  // (possibly non-existent) child. Used by /empty when NC mobile asks to
  // create a new document inside an existing folder. Empty parent path is
  // accepted — that's the personal-space root case.
  async resolveChild(user: UserModel, parentFileId: number, childName: string): Promise<SpaceEnv | null> {
    if (!childName || childName.includes('/') || childName.includes('\\')) return null
    let row: { id: number; path: string } | null = null
    try {
      row = await this.filesQueries.getUserFile(user.id, parentFileId)
    } catch {
      return null
    }
    if (!row) return null
    const parentSegments = (row.path ?? '').split('/').filter(Boolean)
    const urlSegments = ['files', 'personal', ...parentSegments, childName]
    try {
      return await this.spacesManager.spaceEnv(user, urlSegments)
    } catch {
      return null
    }
  }
}
