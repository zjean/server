import { Test, TestingModule } from '@nestjs/testing'
import { Cache } from '../../infrastructure/cache/cache.service'
import { DB_TOKEN_PROVIDER } from '../../infrastructure/database/constants'
import { FilesLockManager } from '../files/services/files-lock-manager.service'
import { FilesQueries } from '../files/services/files-queries.service'
import { FilesRecents } from '../files/services/files-recents.service'
import { LinksQueries } from '../links/services/links-queries.service'
import { NotificationsManager } from '../notifications/services/notifications-manager.service'
import { SharesManager } from '../shares/services/shares-manager.service'
import { SharesQueries } from '../shares/services/shares-queries.service'
import { UsersQueries } from '../users/services/users-queries.service'
import { SpacesBrowser } from './services/spaces-browser.service'
import { SpacesManager } from './services/spaces-manager.service'
import { SpacesQueries } from './services/spaces-queries.service'
import { SpacesController } from './spaces.controller'
import { FilesQuotaManager } from '../files/services/files-quota-manager.service'
import { VersioningService } from '../custom-versioning/services/versioning.service'

describe(SpacesController.name, () => {
  let spacesController: SpacesController

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SpacesController],
      providers: [
        // Plumbing, not a subject of this spec: a manager built by this
        // testing module (SpacesManager / AdminUsersManager) now injects
        // VersioningService so a space-alias or user-login rename repoints the
        // fork's version rows (#471). A bare testing module has no @Global
        // CustomVersioningModule to supply it.
        { provide: VersioningService, useValue: { renameUserRoot: vi.fn(), renameSpaceRoot: vi.fn() } },
        { provide: DB_TOKEN_PROVIDER, useValue: {} },
        {
          provide: NotificationsManager,
          useValue: {}
        },
        {
          provide: Cache,
          useValue: {}
        },
        {
          provide: FilesQuotaManager,
          useValue: {}
        },
        SpacesManager,
        SpacesQueries,
        SpacesBrowser,
        SharesManager,
        SharesQueries,
        FilesQueries,
        FilesLockManager,
        UsersQueries,
        LinksQueries,
        FilesRecents
      ]
    }).compile()

    spacesController = module.get<SpacesController>(SpacesController)
  })

  it('should be defined', () => {
    expect(spacesController).toBeDefined()
  })
})
