# Favorites (Custom, Fork-Isolated) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a per-user file favorites feature for the zjean/server fork — a `custom-favorites` backend module plus a v2 UI — touching upstream files in only two additive single lines, so weekly upstream syncs never conflict.

**Architecture:** A new isolated NestJS module (`backend/src/applications/custom-favorites/`) owns its own table (`custom_files_favorites`), queries, manager, and controller. Path-based add/remove reuses upstream `FilesQueries.getOrCreateSpaceFile`/`getSpaceFileId` (read-only) to handle unindexed files. The v2 frontend gets a dedicated `FavoritesService`, a Favorites screen, a left-nav entry, and a context-menu star toggle in the file browser — all under `custom-v2/`. Per-row star state comes from `GET /api/favorites/ids` merged client-side (instead of editing the upstream `browseFiles` query).

**Tech Stack:** NestJS, Drizzle ORM (MySQL/MariaDB), vitest (backend tests use the `vi` global — NOT `jest`), Angular 18 signals, angular-l10n, chrome-devtools MCP for browser verification.

**Reference:** Full design in `docs/plans/2026-06-10-favorites-custom-design.md`. Original (non-merging) upstream work in branch `upstream-contrib/favorites` — copy logic from it, but rename the table to `custom_files_favorites` and convert any `jest.*` to `vi.*`.

**Conventions (from CLAUDE.md — do not violate):**
- Never `git push origin main`; every change flows through a PR with `--repo zjean/server`.
- Remotes use the `github-prive` SSH alias.
- Drizzle: never hand-write migration SQL — always `npm run -w backend db:generate`.
- fork i18n goes in `frontend/src/i18n/custom/{en,nl}.json`, never the upstream bundles.
- `rtk proxy gh api ...` when you need raw JSON; `git commit --allow-empty` needs `rtk proxy`.

---

## Task 0: Branch setup

**Step 1: Create the feature branch from `main`**

This is fork code (not an upstream contribution), so root at `main`:

```bash
cd /Users/janwiebe/prive/sync-in-server
git fetch origin
git checkout main && git pull --ff-only
git checkout -b feat/favorites-custom
```

Expected: `Switched to a new branch 'feat/favorites-custom'`.

**Step 2: Verify the dev DB is up (needed for db:generate/migrate later)**

```bash
npm run dev:db
```

Expected: mariadb container healthy (or already running).

---

## Task 1: Database schema + migration

**Files:**
- Create: `backend/src/applications/custom-favorites/schemas/files-favorites.schema.ts`
- Modify: `backend/src/infrastructure/database/schema.ts` (one export line)
- Generated: `backend/migrations/0005_*.sql` + `meta/0005_snapshot.json` + `meta/_journal.json`

**Step 1: Write the schema file**

Create `backend/src/applications/custom-favorites/schemas/files-favorites.schema.ts`:

```ts
import { Column, SQL, sql } from 'drizzle-orm'
import { bigint, datetime, index, mysqlTable, primaryKey } from 'drizzle-orm/mysql-core'
import { files } from '../../files/schemas/files.schema'
import { users } from '../../users/schemas/users.schema'

// Fork-owned favorites table. Renamed from upstream-contrib's `files_favorites`
// to `custom_files_favorites` so there is never a table-name collision if
// upstream ships its own favorites. See docs/plans/2026-06-10-favorites-custom-design.md.
export const customFilesFavorites = mysqlTable(
  'custom_files_favorites',
  {
    userId: bigint('userId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fileId: bigint('fileId', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    createdAt: datetime('createdAt', { mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.fileId] }),
    index('custom_files_favorites_user_idx').on(table.userId),
    index('custom_files_favorites_file_idx').on(table.fileId)
  ]
)

// EXISTS predicate helper — used by the favorites queries service to compute
// the favorited-id set without pulling the whole table.
export const fileIsFavoriteForUserSQL = (fileId: Column | SQL, userId: Column | SQL): SQL =>
  sql`EXISTS(SELECT 1 FROM ${customFilesFavorites} WHERE ${customFilesFavorites.fileId} = ${fileId} AND ${customFilesFavorites.userId} = ${userId})`
```

**Step 2: Add the schema export**

In `backend/src/infrastructure/database/schema.ts`, add one line next to the existing
`custom-mobile-compat` export (~line 18):

```ts
export * from '../../applications/custom-favorites/schemas/files-favorites.schema'
```

**Step 3: Generate the migration with tooling (NEVER hand-write)**

```bash
npm run -w backend db:generate
```

Expected: a new `backend/migrations/0005_<name>.sql` creating `custom_files_favorites`,
a new `meta/0005_snapshot.json`, and a new entry appended to `meta/_journal.json`.
Verify the journal got the new tag:

```bash
git status backend/migrations
```

Expected: 3 changed/new files under `backend/migrations/`.

**Step 4: Apply the migration locally**

```bash
npm run -w backend db:migrate
```

Expected: migration applied, no error. (If it says nothing pending, the journal is out of
sync — re-run db:generate.)

**Step 5: Commit**

```bash
git add backend/src/applications/custom-favorites/schemas/files-favorites.schema.ts \
        backend/src/infrastructure/database/schema.ts \
        backend/migrations
git commit -m "feat(custom-favorites): add custom_files_favorites table + migration"
```

---

## Task 2: FileFavorite interface

**Files:**
- Create: `backend/src/applications/custom-favorites/interfaces/file-favorite.interface.ts`

**Step 1: Write the interface**

```ts
import type { FileProps } from '../../files/interfaces/file-props.interface'

export interface FileFavorite extends Pick<FileProps, 'id' | 'name' | 'isDir' | 'mime' | 'size' | 'mtime' | 'ctime'> {
  isFavorite: boolean
  navPath: string
}
```

**Step 2: Commit**

```bash
git add backend/src/applications/custom-favorites/interfaces/file-favorite.interface.ts
git commit -m "feat(custom-favorites): add FileFavorite interface"
```

---

## Task 3: Favorites routes constants

**Files:**
- Create: `backend/src/applications/custom-favorites/constants/routes.ts`

**Step 1: Write the constants**

```ts
export const CUSTOM_FAVORITES_ROUTE = {
  BASE: 'favorites',
  SPACES: 'spaces',
  IDS: 'ids'
} as const

// Imported by the v2 frontend (cross-package import, same pattern as API_SPACES_BROWSE).
export const API_CUSTOM_FAVORITES = `api/${CUSTOM_FAVORITES_ROUTE.BASE}` as const
```

**Step 2: Commit**

```bash
git add backend/src/applications/custom-favorites/constants/routes.ts
git commit -m "feat(custom-favorites): add route constants"
```

---

## Task 4: FavoritesQueries service (TDD)

Owns all DB access against `customFilesFavorites`, keeping favorites SQL out of the upstream
`FilesQueries`. Copy the join/navPath logic from the branch's `FilesQueries` favorites
methods (see design doc §2), adapted to this service.

**Files:**
- Create: `backend/src/applications/custom-favorites/services/favorites-queries.service.ts`
- Test: `backend/src/applications/custom-favorites/services/favorites-queries.service.spec.ts`

**Step 1: Write the failing test**

DB is mocked at the drizzle-builder level (matches `nc-sync-log.service.spec.ts` pattern).
Use the `vi` global — this repo runs vitest, not jest.

```ts
import { Test, TestingModule } from '@nestjs/testing'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { FavoritesQueries } from './favorites-queries.service'

describe(FavoritesQueries.name, () => {
  let service: FavoritesQueries
  let db: any

  beforeEach(async () => {
    // chainable drizzle stub; terminal calls resolve to rows
    const chain: any = {}
    for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
      chain[m] = vi.fn(() => chain)
    }
    db = {
      ...chain,
      insert: vi.fn(() => ({ ignore: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })) })),
      delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ affectedRows: 1 }]) }))
    }
    const module: TestingModule = await Test.createTestingModule({
      providers: [FavoritesQueries, { provide: DB_TOKEN_PROVIDER, useValue: db }]
    }).compile()
    module.useLogger(['fatal'])
    service = module.get(FavoritesQueries)
  })

  afterEach(() => vi.clearAllMocks())

  it('is defined', () => expect(service).toBeDefined())

  it('getFavoriteIdsForUser returns the fileId list', async () => {
    db.where.mockResolvedValueOnce([{ fileId: 7 }, { fileId: 9 }])
    const ids = await service.getFavoriteIdsForUser(1)
    expect(ids).toEqual([7, 9])
  })

  it('addFavorite issues insert-ignore', async () => {
    await service.addFavorite(1, 7)
    expect(db.insert).toHaveBeenCalled()
  })

  it('removeFavorite throws NotFound when nothing deleted', async () => {
    db.delete.mockReturnValueOnce({ where: vi.fn().mockResolvedValue([{ affectedRows: 0 }]) })
    await expect(service.removeFavorite(1, 7)).rejects.toThrow()
  })
})
```

**Step 2: Run the test — expect failure**

```bash
npm -w backend test -- favorites-queries
```

Expected: FAIL — `Cannot find module './favorites-queries.service'`.

**Step 3: Implement the service**

Create `favorites-queries.service.ts`. Build `navPath` in TypeScript (copy
`buildFavoriteNavPath` + `toFileFavorite` from the branch's `files-queries.service.ts`
diff — see design doc). Key methods:

```ts
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { DB_TOKEN_PROVIDER } from '../../../infrastructure/database/constants'
import { DBSchema } from '../../../infrastructure/database/interfaces/database.interface'
import { shares } from '../../shares/schemas/shares.schema'
import { SPACE_ALIAS, SPACE_REPOSITORY } from '../../spaces/constants/spaces'
import { spaces } from '../../spaces/schemas/spaces.schema'
import { files } from '../../files/schemas/files.schema'
import { FileFavorite } from '../interfaces/file-favorite.interface'
import { customFilesFavorites } from '../schemas/files-favorites.schema'

// favoriteFileSelect, FavoriteFileRow, buildFavoriteNavPath, toFileFavorite:
// copy verbatim from upstream-contrib/favorites files-queries.service.ts.

@Injectable()
export class FavoritesQueries {
  private readonly logger = new Logger(FavoritesQueries.name)
  constructor(@Inject(DB_TOKEN_PROVIDER) private readonly db: DBSchema) {}

  async getFavorites(userId: number, spaceIds: number[], shareIds: number[], limit = 100): Promise<FileFavorite[]> {
    const rows = await this.db
      .select(favoriteFileSelect)
      .from(customFilesFavorites)
      .innerJoin(files, eq(files.id, customFilesFavorites.fileId))
      .leftJoin(spaces, eq(spaces.id, files.spaceId))
      .leftJoin(shares, eq(shares.id, files.shareExternalId))
      .where(
        and(
          eq(customFilesFavorites.userId, userId),
          eq(files.inTrash, false),
          or(
            eq(files.ownerId, userId),
            ...(spaceIds.length ? [inArray(files.spaceId, spaceIds)] : []),
            ...(shareIds.length ? [inArray(files.shareExternalId, shareIds)] : [])
          )
        )
      )
      .orderBy(desc(customFilesFavorites.createdAt))
      .limit(limit)
    return rows.map(toFileFavorite)
  }

  async getFavoriteIdsForUser(userId: number): Promise<number[]> {
    const rows = await this.db
      .select({ fileId: customFilesFavorites.fileId })
      .from(customFilesFavorites)
      .where(eq(customFilesFavorites.userId, userId))
    return rows.map((r) => r.fileId)
  }

  async addFavorite(userId: number, fileId: number): Promise<void> {
    await this.db.insert(customFilesFavorites).ignore().values({ userId, fileId })
  }

  async removeFavorite(userId: number, fileId: number): Promise<void> {
    const result = await this.db
      .delete(customFilesFavorites)
      .where(and(eq(customFilesFavorites.userId, userId), eq(customFilesFavorites.fileId, fileId)))
    if (!result[0].affectedRows) throw new NotFoundException()
  }
}
```

**Step 4: Run the test — expect pass**

```bash
npm -w backend test -- favorites-queries
```

Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add backend/src/applications/custom-favorites/services/favorites-queries.service.ts \
        backend/src/applications/custom-favorites/services/favorites-queries.service.spec.ts
git commit -m "feat(custom-favorites): favorites queries service with tests"
```

---

## Task 5: FavoritesManager service (TDD)

Path-based add/remove. Reuses upstream `FilesQueries.getOrCreateSpaceFile`/`getSpaceFileId`
and `utils/files` helpers. Copy logic from the branch's `favorites-manager.service.ts`.

**Files:**
- Create: `backend/src/applications/custom-favorites/services/favorites-manager.service.ts`
- Test: `backend/src/applications/custom-favorites/services/favorites-manager.service.spec.ts`

**Step 1: Write the failing test** (convert the branch's jest spec to `vi`)

```ts
import { Test, TestingModule } from '@nestjs/testing'
import { FilesQueries } from '../../files/services/files-queries.service'
import { SharesQueries } from '../../shares/services/shares-queries.service'
import { SpacesQueries } from '../../spaces/services/spaces-queries.service'
import { UserModel } from '../../users/models/user.model'
import { FavoritesQueries } from './favorites-queries.service'
import { FavoritesManager } from './favorites-manager.service'

describe(FavoritesManager.name, () => {
  let service: FavoritesManager
  const user = { id: 1, isAdmin: 0 } as unknown as UserModel
  let favoritesQueries: any
  let spacesQueries: any
  let sharesQueries: any

  beforeEach(async () => {
    favoritesQueries = {
      getFavorites: vi.fn().mockResolvedValue([]),
      getFavoriteIdsForUser: vi.fn().mockResolvedValue([3, 4]),
      addFavorite: vi.fn().mockResolvedValue(undefined),
      removeFavorite: vi.fn().mockResolvedValue(undefined)
    }
    spacesQueries = { spaceIds: vi.fn().mockResolvedValue([]) }
    sharesQueries = { shareIds: vi.fn().mockResolvedValue([]) }
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FavoritesManager,
        { provide: FavoritesQueries, useValue: favoritesQueries },
        { provide: FilesQueries, useValue: { getOrCreateSpaceFile: vi.fn(), getSpaceFileId: vi.fn() } },
        { provide: SpacesQueries, useValue: spacesQueries },
        { provide: SharesQueries, useValue: sharesQueries }
      ]
    }).compile()
    module.useLogger(['fatal'])
    service = module.get(FavoritesManager)
  })

  afterEach(() => vi.clearAllMocks())

  it('is defined', () => expect(service).toBeDefined())

  it('getFavorites resolves access scopes then delegates with capped limit', async () => {
    await service.getFavorites(user, 9999)
    expect(spacesQueries.spaceIds).toHaveBeenCalledWith(user.id)
    expect(favoritesQueries.getFavorites).toHaveBeenCalledWith(user.id, [], [], 1000)
  })

  it('getFavoriteIds delegates to queries', async () => {
    expect(await service.getFavoriteIds(user)).toEqual([3, 4])
  })
})
```

**Step 2: Run — expect failure**

```bash
npm -w backend test -- favorites-manager
```

Expected: FAIL — module not found.

**Step 3: Implement the manager**

Copy the branch's `favorites-manager.service.ts`, but: inject `FavoritesQueries` (not the
old `FilesFavorites`), add `getFavoriteIds`, and fold in the limit-cap + access-scope
resolution that the branch had in `FilesFavorites`:

```ts
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common'
import type { FileProps } from '../../files/interfaces/file-props.interface'
import { FilesQueries } from '../../files/services/files-queries.service'
import { getProps, isPathExists } from '../../files/utils/files'
import { SharesQueries } from '../../shares/services/shares-queries.service'
import { SpacesQueries } from '../../spaces/services/spaces-queries.service'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { UserModel } from '../../users/models/user.model'
import type { FileFavorite } from '../interfaces/file-favorite.interface'
import { FavoritesQueries } from './favorites-queries.service'

@Injectable()
export class FavoritesManager {
  private readonly logger = new Logger(FavoritesManager.name)
  constructor(
    private readonly favoritesQueries: FavoritesQueries,
    private readonly filesQueries: FilesQueries,
    private readonly spacesQueries: SpacesQueries,
    private readonly sharesQueries: SharesQueries
  ) {}

  async getFavorites(user: UserModel, limit?: number): Promise<FileFavorite[]> {
    const [spaceIds, shareIds] = await Promise.all([
      this.spacesQueries.spaceIds(user.id),
      this.sharesQueries.shareIds(user.id, +user.isAdmin)
    ])
    return this.favoritesQueries.getFavorites(user.id, spaceIds, shareIds, Math.min(limit ?? 100, 1000))
  }

  getFavoriteIds(user: UserModel): Promise<number[]> {
    return this.favoritesQueries.getFavoriteIdsForUser(user.id)
  }

  async addFavorite(user: UserModel, space: SpaceEnv): Promise<FileFavorite> {
    const fileId = await this.getOrCreateFileId(space)
    await this.favoritesQueries.addFavorite(user.id, fileId)
    const [favorite] = await this.favoritesQueries.getFavorites(user.id,
      await this.spacesQueries.spaceIds(user.id),
      await this.sharesQueries.shareIds(user.id, +user.isAdmin), 1000)
    // simpler: add a getFavoriteForFile(userId, fileId) to FavoritesQueries and use it here.
    return favorite
  }

  async removeFavorite(user: UserModel, space: SpaceEnv): Promise<void> {
    const fileId = await this.getFileId(space)
    if (fileId === undefined) throw new HttpException('Location not found', HttpStatus.NOT_FOUND)
    return this.favoritesQueries.removeFavorite(user.id, fileId)
  }

  private async getOrCreateFileId(space: SpaceEnv): Promise<number> {
    if (!(await isPathExists(space.realPath))) throw new HttpException('Location not found', HttpStatus.NOT_FOUND)
    const fileProps: FileProps = { ...(await getProps(space.realPath, space.dbFile.path)), id: undefined }
    return this.filesQueries.getOrCreateSpaceFile(0, fileProps, space.dbFile)
  }

  private async getFileId(space: SpaceEnv): Promise<number | undefined> {
    if (!(await isPathExists(space.realPath))) throw new HttpException('Location not found', HttpStatus.NOT_FOUND)
    const fileProps: FileProps = { ...(await getProps(space.realPath, space.dbFile.path)), id: undefined }
    return this.filesQueries.getSpaceFileId(fileProps, space.dbFile)
  }
}
```

> **Cleanup note:** add a `getFavoriteForFile(userId, fileId)` method to `FavoritesQueries`
> (copy from the branch) and use it in `addFavorite` instead of re-listing all favorites.
> Add a unit test for it in Task 4's spec before wiring it here.

**Step 4: Run — expect pass**

```bash
npm -w backend test -- favorites-manager
```

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/src/applications/custom-favorites/services/favorites-manager.service.ts \
        backend/src/applications/custom-favorites/services/favorites-manager.service.spec.ts
git commit -m "feat(custom-favorites): path-based favorites manager with tests"
```

---

## Task 6: FavoritesController

**Files:**
- Create: `backend/src/applications/custom-favorites/controllers/favorites.controller.ts`

**Step 1: Write the controller** (copy structure from the branch's controller; add `/ids`)

```ts
import { Controller, Delete, Get, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common'
import { SkipSpaceGuard } from '../../spaces/decorators/space-skip-guard.decorator'
import { SkipSpacePermissionsCheck } from '../../spaces/decorators/space-skip-permissions.decorator'
import { GetSpace } from '../../spaces/decorators/space.decorator'
import { SpaceGuard } from '../../spaces/guards/space.guard'
import { SpaceEnv } from '../../spaces/models/space-env.model'
import { GetUser } from '../../users/decorators/user.decorator'
import type { UserModel } from '../../users/models/user.model'
import type { FileFavorite } from '../interfaces/file-favorite.interface'
import { CUSTOM_FAVORITES_ROUTE } from '../constants/routes'
import { FavoritesManager } from '../services/favorites-manager.service'

@Controller(CUSTOM_FAVORITES_ROUTE.BASE)
@SkipSpacePermissionsCheck()
@UseGuards(SpaceGuard)
export class FavoritesController {
  constructor(private readonly favoritesManager: FavoritesManager) {}

  @Get()
  @SkipSpaceGuard()
  getFavorites(@GetUser() user: UserModel, @Query('limit', new ParseIntPipe({ optional: true })) limit?: number): Promise<FileFavorite[]> {
    return this.favoritesManager.getFavorites(user, limit)
  }

  @Get(CUSTOM_FAVORITES_ROUTE.IDS)
  @SkipSpaceGuard()
  getFavoriteIds(@GetUser() user: UserModel): Promise<number[]> {
    return this.favoritesManager.getFavoriteIds(user)
  }

  @Post(`${CUSTOM_FAVORITES_ROUTE.SPACES}/*`)
  addFavorite(@GetUser() user: UserModel, @GetSpace() space: SpaceEnv): Promise<FileFavorite> {
    return this.favoritesManager.addFavorite(user, space)
  }

  @Delete(`${CUSTOM_FAVORITES_ROUTE.SPACES}/*`)
  removeFavorite(@GetUser() user: UserModel, @GetSpace() space: SpaceEnv): Promise<void> {
    return this.favoritesManager.removeFavorite(user, space)
  }
}
```

**Step 2: Commit**

```bash
git add backend/src/applications/custom-favorites/controllers/favorites.controller.ts
git commit -m "feat(custom-favorites): controller (list/ids/add/remove)"
```

---

## Task 7: Module wiring + boot check

**Files:**
- Create: `backend/src/applications/custom-favorites/custom-favorites.module.ts`
- Modify: `backend/src/applications/applications.module.ts` (import + imports[] entry)

**Step 1: Write the module**

```ts
import { Module } from '@nestjs/common'
import { FilesModule } from '../files/files.module'
import { SharesModule } from '../shares/shares.module'
import { SpacesModule } from '../spaces/spaces.module'
import { UsersModule } from '../users/users.module'
import { FavoritesController } from './controllers/favorites.controller'
import { FavoritesManager } from './services/favorites-manager.service'
import { FavoritesQueries } from './services/favorites-queries.service'

// Fork add-on: per-user file favorites. Fully isolated; see
// docs/plans/2026-06-10-favorites-custom-design.md.
@Module({
  imports: [UsersModule, FilesModule, SpacesModule, SharesModule],
  controllers: [FavoritesController],
  providers: [FavoritesManager, FavoritesQueries]
})
export class CustomFavoritesModule {}
```

**Step 2: Register it** in `backend/src/applications/applications.module.ts` — add the
import near the other `Custom*` imports and add `CustomFavoritesModule` to the `imports`
array next to `CustomFeaturesModule`:

```ts
import { CustomFavoritesModule } from './custom-favorites/custom-favorites.module'
// ...
    CustomFeaturesModule,
    CustomFavoritesModule
```

> Check whether `SpaceGuard` needs `SpacesModule` to export it for DI — if the controller
> fails to resolve `SpaceGuard` at boot, mirror how `custom-mobile-compat` obtains it
> (it imports `SpacesModule`). It already does here.

**Step 3: Build + boot to verify DI**

```bash
npm -w backend run build
```

Expected: build succeeds, no unresolved-dependency error. Then run the full backend test +
lint gate:

```bash
npm run -w backend lint && npm -w backend test -- custom-favorites
```

Expected: lint clean, favorites specs pass.

**Step 4: Commit**

```bash
git add backend/src/applications/custom-favorites/custom-favorites.module.ts \
        backend/src/applications/applications.module.ts
git commit -m "feat(custom-favorites): wire module into applications module"
```

---

## Task 8: v2 FavoritesService (frontend state + HTTP)

**Files:**
- Create: `frontend/src/app/applications/custom-v2/services/favorites.service.ts`

**Step 1: Write the service** (does NOT touch upstream StoreService/FilesService)

```ts
import { HttpClient } from '@angular/common/http'
import { Injectable, inject, signal } from '@angular/core'
import { API_CUSTOM_FAVORITES } from '@sync-in-server/backend/src/applications/custom-favorites/constants/routes'
import type { FileFavorite } from '@sync-in-server/backend/src/applications/custom-favorites/interfaces/file-favorite.interface'

@Injectable({ providedIn: 'root' })
export class FavoritesService {
  private readonly http = inject(HttpClient)
  readonly favorites = signal<FileFavorite[]>([])
  readonly favoriteIds = signal<Set<number>>(new Set())

  loadFavorites(limit = 100): void {
    this.http.get<FileFavorite[]>(API_CUSTOM_FAVORITES, { params: { limit } })
      .subscribe((list) => this.favorites.set(list))
  }

  loadFavoriteIds(): void {
    this.http.get<number[]>(`${API_CUSTOM_FAVORITES}/ids`)
      .subscribe((ids) => this.favoriteIds.set(new Set(ids)))
  }

  isFavorite(fileId: number): boolean {
    return this.favoriteIds().has(fileId)
  }

  // spacePath e.g. 'files/personal/sub/file.txt'
  toggle(spacePath: string, fileId: number, add: boolean): void {
    // optimistic
    const next = new Set(this.favoriteIds())
    add ? next.add(fileId) : next.delete(fileId)
    this.favoriteIds.set(next)
    const url = `${API_CUSTOM_FAVORITES}/spaces/${spacePath}`
    const req = add ? this.http.post(url, {}) : this.http.delete(url)
    req.subscribe({
      error: () => {
        // rollback
        const rb = new Set(this.favoriteIds())
        add ? rb.delete(fileId) : rb.add(fileId)
        this.favoriteIds.set(rb)
      }
    })
  }
}
```

> Verify the exact `API_CUSTOM_FAVORITES` value against how v2 builds other API URLs
> (`API_SPACES_BROWSE` is `'api/spaces/browse'`). If v2 calls without the `api/` prefix
> anywhere, match that convention. Confirm by grepping a working v2 HTTP call.

**Step 2: Commit**

```bash
git add frontend/src/app/applications/custom-v2/services/favorites.service.ts
git commit -m "feat(custom-v2): FavoritesService (signals + HTTP)"
```

---

## Task 9: Favorites screen + route + nav entry

**Files:**
- Create: `frontend/src/app/applications/custom-v2/screens/favorites/favorites.component.{ts,html,scss}`
- Modify: `frontend/src/app/applications/custom-v2/v2.constants.ts`
- Modify: `frontend/src/app/applications/custom-v2/v2.routes.ts`
- Modify: `frontend/src/app/applications/custom-v2/layout/left-nav.component.ts`
- Possibly modify: `frontend/src/app/applications/custom-v2/icons/icon-v2.component.ts` (add `star` glyph if missing)

**Step 1: Add the route constant** — in `v2.constants.ts` `V2_ROUTES`, add:

```ts
  FAVORITES: 'favorites',
```

**Step 2: Build the component** by mirroring `screens/recents/recents.component.ts`. Read
`favoritesService.favorites()`, render rows with `FileGlyphComponent`, navigate via the
backend-provided `navPath`, and call `favoritesService.loadFavorites()` in `ngOnInit`.
Set breadcrumb `[{ label: 'Favorites', icon: 'star' }]`. Keep the `.html`/`.scss` close to
the recents screen's empty-state + list markup.

**Step 3: Register the route** in `v2.routes.ts`:

```ts
import { FavoritesComponent } from './screens/favorites/favorites.component'
// ...
  { path: V2_ROUTES.FAVORITES, component: FavoritesComponent },
```

**Step 4: Add the left-nav entry** in `left-nav.component.ts`, right after the `recents`
item (add a `star` icon to `icon-v2.component.ts` first if it doesn't exist):

```ts
{ id: 'favorites', label: 'Favorites', icon: 'star', route: `/${V2_PATH}/${V2_ROUTES.FAVORITES}` },
```

**Step 5: Build the frontend to typecheck**

```bash
npm run -w frontend build
```

Expected: build succeeds.

**Step 6: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/favorites \
        frontend/src/app/applications/custom-v2/v2.constants.ts \
        frontend/src/app/applications/custom-v2/v2.routes.ts \
        frontend/src/app/applications/custom-v2/layout/left-nav.component.ts \
        frontend/src/app/applications/custom-v2/icons/icon-v2.component.ts
git commit -m "feat(custom-v2): Favorites screen, route, and left-nav entry"
```

---

## Task 10: Star toggle + context-menu action in the file browser

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts`
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.html`

**Step 1: Inject the service + load ids on folder load**

In `space-files.component.ts`, `inject(FavoritesService)`. In the existing nav
subscription that calls `this.loadFiles()` (ngOnInit `combineLatest(...).subscribe`), also
call `this.favoritesService.loadFavoriteIds()`.

**Step 2: Add the context-menu entry** to the `menuItems` computed (after `share`):

```ts
{
  id: 'favorite',
  label: this.favoritesService.isFavorite(f.id) ? 'Remove from favorites' : 'Add to favorites',
  icon: 'star',
  action: () => this.toggleFavorite(f)
},
```

**Step 3: Implement `toggleFavorite`** — build the space path exactly like the existing
dock-context effect does:

```ts
protected toggleFavorite(f: FileModel): void {
  const alias = this.currentAlias()
  if (!alias) return
  const segs = this.pathSegments().map((s) => s.path)
  const path = [SPACE_REPOSITORY.FILES, alias, ...segs, f.name].join('/')
  this.favoritesService.toggle(path, f.id, !this.favoritesService.isFavorite(f.id))
}
```

**Step 4: Render a star indicator** in `space-files.component.html` on rows where
`favoritesService.isFavorite(f.id)` — a small `<app-icon-v2 name="star">` next to the file
name (only when true). Keep it consistent with how existing row badges render.

**Step 5: Build to typecheck**

```bash
npm run -w frontend build
```

Expected: build succeeds.

**Step 6: Commit**

```bash
git add frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts \
        frontend/src/app/applications/custom-v2/screens/space/space-files.component.html
git commit -m "feat(custom-v2): star toggle + favorite context action in file browser"
```

---

## Task 11: i18n (fork-owned bundle only)

**Files:**
- Modify: `frontend/src/i18n/custom/en.json`
- Modify: `frontend/src/i18n/custom/nl.json`

**Step 1: Add keys** to BOTH files (never the upstream bundles). Static literals as keys
(identity-mapping pattern), `v2_*` named keys only if you introduce a parameterised toast:

```json
{
  "Favorites": "Favorites",
  "Add to favorites": "Add to favorites",
  "Remove from favorites": "Remove from favorites"
}
```

nl.json:

```json
{
  "Favorites": "Favorieten",
  "Add to favorites": "Toevoegen aan favorieten",
  "Remove from favorites": "Verwijderen uit favorieten"
}
```

**Step 2: Commit**

```bash
git add frontend/src/i18n/custom/en.json frontend/src/i18n/custom/nl.json
git commit -m "feat(custom-v2): favorites i18n (en/nl custom bundle)"
```

---

## Task 12: Browser verification

**REQUIRED SUB-SKILL:** Use `v2-dev-loop-verify` to verify against the local dev server.

Verify, capturing a screenshot for each:
1. Left-nav shows **Favorites** after Recents; clicking it loads the (empty) Favorites screen.
2. In a space/personal folder, the row context menu shows **Add to favorites**; clicking it
   adds a star to the row and a toast/no-error.
3. The Favorites screen now lists that file; clicking it navigates to the file via `navPath`.
4. Re-open the context menu → it now reads **Remove from favorites**; removing clears the
   star and drops it from the Favorites screen.
5. Reload the page → favorites persist (DB round-trip works).

Dev server: `localhost:8080`, login `sync-in`/`password`, reach v2 via `/#/v2/recents` or
the "Probeer de nieuwe UI" toggle.

If any step fails, debug with `systematic-debugging`; compare the failing network request
shape against the classic-UI ground truth where relevant.

---

## Task 13: Open the PR

**Step 1: Push the branch** (uses the `github-prive` SSH alias automatically via remote URL)

```bash
git push -u origin feat/favorites-custom
```

**Step 2: Open the PR against the fork** (explicit `--repo`, per CLAUDE.md)

```bash
gh pr create --repo zjean/server --base main --head feat/favorites-custom \
  --title "feat(custom-favorites): per-user file favorites (backend + v2 UI)" \
  --body "$(cat <<'EOF'
## Summary
Re-homes the favorites feature (the upstream-contrib/favorites PR isn't being merged) into
fork-isolated custom code: a new `custom-favorites` backend module + a v2 UI.

- Backend: `custom_files_favorites` table, isolated module (controller/manager/queries),
  path-based add/remove reusing upstream `getOrCreateSpaceFile`/`getSpaceFileId`.
- Per-row star state via `GET /api/favorites/ids` merged client-side — no edit to the
  upstream `browseFiles` query.
- Frontend: Favorites screen, left-nav entry, context-menu star toggle — all under
  `custom-v2/`. i18n in `i18n/custom/{en,nl}.json`.

Upstream files touched: one additive `export` line in `schema.ts`, one module import in
`applications.module.ts`.

Design: `docs/plans/2026-06-10-favorites-custom-design.md`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 3: Wait for `test` to go green, resolve any conversations, then squash-merge**
(feature PR → Squash and merge, per CLAUDE.md). The `upstream-contrib/favorites` PR stays
open and untouched.

---

## Notes for the implementer

- **Migration ordering:** if a later upstream sync adds a migration with the same numeric
  prefix, reconcile via the `sync-in-fork-maintenance` skill. The `custom_` table name
  guarantees no table collision.
- **Don't** add favorites methods to upstream `FilesQueries`, `FilesService`, `StoreService`,
  `spaces-browser.component`, or the upstream i18n bundles — that's the merge surface we're
  avoiding. Everything favorites-specific lives in `custom-favorites/` or `custom-v2/`.
- **vitest, not jest:** use `vi.fn()` / `import { Mock } from 'vitest'`. The branch's specs
  use `jest.*` — convert them.
