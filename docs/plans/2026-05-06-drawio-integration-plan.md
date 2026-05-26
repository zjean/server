# draw.io Integration Implementation Plan

> **Status (2026-05-26):** Shipped. `backend/src/applications/custom-diagrams/` carries the module/controller/service/DTOs; `backend/src/applications/custom-features/custom-features.module.ts` is the aggregator; the v2 frontend has `preview/diagram-view.component.*`, `isDiagramExt` in `utils/classify-file.ts`, and the New menu entry. Follow-up commits hardened the save path (content-hash ETag, write-tmpfile/rename, 409 recovery, mxGraph skeleton seed, autosave URL flag).

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate draw.io diagram editing into the v2 Angular web UI — create/open/edit `.drawio` and `.dwb` files via the hosted `app.diagrams.net` iframe embed protocol.

**Architecture:** Three layers: (1) NestJS `CustomDiagramsModule` under `custom-features/` aggregator — fully isolated from upstream; (2) Angular `DiagramViewComponent` in `custom-v2/preview/` that hosts the draw.io iframe and speaks `proto=json` postMessage; (3) minimal upstream file edits for MIME classification and new-file menu.

**Tech Stack:** NestJS + Node.js `fs/promises`, Angular 17 signals/standalone components, draw.io embed postMessage protocol (`proto=json`), `genEtag` + `SpaceEnv` file access pattern from existing codebase.

---

## Key patterns to follow (read these before starting)

**File-by-ID resolution** (from `nc-text-editor.controller.ts`):
```ts
const row = await this.filesQueries.getUserFile(user.id, fileId)
if (!row?.path) throw new HttpException('not found', HttpStatus.NOT_FOUND)
const pathSegments = row.path.split('/').filter(Boolean)
const space = await this.spacesManager.spaceEnv(user, ['files', 'personal', ...pathSegments])
```
`getUserFile` is owner-scoped — only personal files. Shared-space support is a follow-up.

**ETag** (strong, no `W/` prefix — consistent with NC mobile requirements):
```ts
import { genEtag } from '../../files/utils/files'
const etag = genEtag(null, space.realPath, false)
```

**File content read/write**:
```ts
import { readFile, writeFile } from 'node:fs/promises'
const xml = await readFile(space.realPath, 'utf-8')
await writeFile(space.realPath, xml, 'utf-8')
```

**Auth**: no special `@UseGuards` needed on individual methods — the global guard handles sessions. Use `@GetUser() user: UserModel` as the first param.

**DRAWIO_URL**: read from `process.env['DRAWIO_URL']` with default `'https://app.diagrams.net'`. No config system changes needed.

**Test pattern** (from `nc-extras.controller.spec.ts`):
- Mock `FilesQueries`, `SpacesManager`, `FilesManager` as plain objects with `jest.fn()`
- Use `Test.createTestingModule({ controllers: [...], providers: [...mocks] })`

---

## Task 1: Backend — CustomFeaturesModule aggregator

**Goal:** Create the stable wiring point for all custom backend modules. One upstream file touch.

**Files:**
- Create: `backend/src/applications/custom-features/custom-features.module.ts`
- Modify: `backend/src/applications/applications.module.ts`

### Step 1: Create the aggregator module

```ts
// backend/src/applications/custom-features/custom-features.module.ts
import { Module } from '@nestjs/common'

@Module({
  imports: []
})
export class CustomFeaturesModule {}
```

### Step 2: Wire into ApplicationsModule

In `backend/src/applications/applications.module.ts`:

Add import at top (after existing imports):
```ts
import { CustomFeaturesModule } from './custom-features/custom-features.module'
```

Add to `imports` array (after `CustomMobileCompatModule`):
```ts
CustomFeaturesModule
```

### Step 3: TypeScript check

```bash
cd /Users/janwiebe/prive/sync-in-server/.worktrees/feat-drawio
npx tsc -p backend/tsconfig.json --noEmit
```
Expected: no output (no errors)

### Step 4: Commit

```bash
git add backend/src/applications/custom-features/custom-features.module.ts \
        backend/src/applications/applications.module.ts
git commit -m "mod(app): register CustomFeaturesModule aggregator"
```

---

## Task 2: Backend — DTOs

**Goal:** Define the three request/response shapes.

**Files:**
- Create: `backend/src/applications/custom-diagrams/dto/load-diagram-response.dto.ts`
- Create: `backend/src/applications/custom-diagrams/dto/save-diagram.dto.ts`
- Create: `backend/src/applications/custom-diagrams/dto/new-diagram.dto.ts`

### Step 1: Load response DTO

```ts
// backend/src/applications/custom-diagrams/dto/load-diagram-response.dto.ts
export interface LoadDiagramResponse {
  xml: string
  etag: string
  mtime: number
  name: string
  isWritable: boolean
  editorUrl: string
}
```

### Step 2: Save request DTO

```ts
// backend/src/applications/custom-diagrams/dto/save-diagram.dto.ts
import { IsInt, IsString } from 'class-validator'

export class SaveDiagramDto {
  @IsInt()
  fileId: number

  @IsString()
  xml: string

  @IsString()
  etag: string
}
```

### Step 3: New diagram request DTO

```ts
// backend/src/applications/custom-diagrams/dto/new-diagram.dto.ts
import { IsString } from 'class-validator'

export class NewDiagramDto {
  @IsString()
  dirPath: string  // e.g. 'files/personal' or 'files/personal/Documents'

  @IsString()
  name: string     // e.g. 'Untitled diagram.drawio'
}
```

### Step 4: TypeScript check

```bash
npx tsc -p backend/tsconfig.json --noEmit
```
Expected: no output

### Step 5: Commit

```bash
git add backend/src/applications/custom-diagrams/
git commit -m "feat(diagrams): add load/save/new DTOs"
```

---

## Task 3: Backend — CustomDiagramsService

**Goal:** Core file logic — load by ID, save with etag check, create new file.

**Files:**
- Create: `backend/src/applications/custom-diagrams/custom-diagrams.service.ts`
- Create: `backend/src/applications/custom-diagrams/custom-diagrams.service.spec.ts`

### Step 1: Write the failing tests first

```ts
// backend/src/applications/custom-diagrams/custom-diagrams.service.spec.ts
import { HttpException, HttpStatus } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { existsSync } from 'node:fs'
import { CustomDiagramsService } from './custom-diagrams.service'
import { FilesQueries } from '../files/services/files-queries.service'
import { FilesManager } from '../files/services/files-manager.service'
import { SpacesManager } from '../spaces/services/spaces-manager.service'

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn()
}))
jest.mock('node:fs', () => ({ existsSync: jest.fn() }))
jest.mock('../files/utils/files', () => ({
  genEtag: jest.fn().mockReturnValue('abc123'),
  getProps: jest.fn().mockResolvedValue({ name: 'test.drawio', mtime: 1000, size: 10, isDir: false, path: '', id: -1 })
}))

const mockUser = { id: 7 } as any
const mockSpace = { realPath: '/data/test.drawio', relativeUrl: 'test.drawio' } as any

describe('CustomDiagramsService', () => {
  let service: CustomDiagramsService
  let filesQueries: { getUserFile: jest.Mock }
  let spacesManager: { spaceEnv: jest.Mock }
  let filesManager: { mkFile: jest.Mock }

  beforeEach(async () => {
    filesQueries = { getUserFile: jest.fn() }
    spacesManager = { spaceEnv: jest.fn() }
    filesManager = { mkFile: jest.fn() }

    const module = await Test.createTestingModule({
      providers: [
        CustomDiagramsService,
        { provide: FilesQueries, useValue: filesQueries },
        { provide: SpacesManager, useValue: spacesManager },
        { provide: FilesManager, useValue: filesManager }
      ]
    }).compile()

    service = module.get(CustomDiagramsService)
  })

  describe('load', () => {
    it('throws 404 when getUserFile returns null', async () => {
      filesQueries.getUserFile.mockResolvedValue(null)
      await expect(service.load(mockUser, 42)).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND })
    })

    it('returns xml, etag and editorUrl on success', async () => {
      filesQueries.getUserFile.mockResolvedValue({ id: 42, path: 'diagram.drawio' })
      spacesManager.spaceEnv.mockResolvedValue(mockSpace)
      ;(existsSync as jest.Mock).mockReturnValue(true)
      const { readFile } = await import('node:fs/promises')
      ;(readFile as jest.Mock).mockResolvedValue('<mxfile/>')

      const result = await service.load(mockUser, 42)
      expect(result.xml).toBe('<mxfile/>')
      expect(result.etag).toBe('abc123')
      expect(result.editorUrl).toBe('https://app.diagrams.net')
    })
  })

  describe('save', () => {
    it('throws 409 when etag mismatches', async () => {
      filesQueries.getUserFile.mockResolvedValue({ id: 42, path: 'diagram.drawio' })
      spacesManager.spaceEnv.mockResolvedValue(mockSpace)
      ;(existsSync as jest.Mock).mockReturnValue(true)

      await expect(
        service.save(mockUser, { fileId: 42, xml: '<mxfile/>', etag: 'stale' })
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT })
    })

    it('writes and returns new etag on success', async () => {
      filesQueries.getUserFile.mockResolvedValue({ id: 42, path: 'diagram.drawio' })
      spacesManager.spaceEnv.mockResolvedValue(mockSpace)
      ;(existsSync as jest.Mock).mockReturnValue(true)
      const { writeFile } = await import('node:fs/promises')
      ;(writeFile as jest.Mock).mockResolvedValue(undefined)

      const result = await service.save(mockUser, { fileId: 42, xml: '<mxfile/>', etag: 'abc123' })
      expect(writeFile).toHaveBeenCalledWith('/data/test.drawio', '<mxfile/>', 'utf-8')
      expect(result.etag).toBe('abc123')
    })
  })

  describe('createNew', () => {
    it('creates file and returns path', async () => {
      spacesManager.spaceEnv.mockResolvedValue(mockSpace)
      filesManager.mkFile.mockResolvedValue(undefined)
      const { writeFile } = await import('node:fs/promises')
      ;(writeFile as jest.Mock).mockResolvedValue(undefined)

      const result = await service.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' })
      expect(filesManager.mkFile).toHaveBeenCalled()
      expect(writeFile).toHaveBeenCalledWith('/data/test.drawio', ' ', 'utf-8')
      expect(result.path).toBe('files/personal/test.drawio')
    })
  })
})
```

### Step 2: Run tests to verify they fail

```bash
cd /Users/janwiebe/prive/sync-in-server/.worktrees/feat-drawio
npx jest backend/src/applications/custom-diagrams/custom-diagrams.service.spec.ts --no-coverage 2>&1 | tail -15
```
Expected: FAIL — `Cannot find module './custom-diagrams.service'`

### Step 3: Implement the service

```ts
// backend/src/applications/custom-diagrams/custom-diagrams.service.ts
import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { FilesManager } from '../files/services/files-manager.service'
import { FilesQueries } from '../files/services/files-queries.service'
import { genEtag, getProps } from '../files/utils/files'
import { SpacesManager } from '../spaces/services/spaces-manager.service'
import { UserModel } from '../users/models/user.model'
import type { LoadDiagramResponse } from './dto/load-diagram-response.dto'
import type { NewDiagramDto } from './dto/new-diagram.dto'
import type { SaveDiagramDto } from './dto/save-diagram.dto'

const MAX_DIAGRAM_BYTES = 10 * 1024 * 1024
const EDITOR_URL = process.env['DRAWIO_URL'] ?? 'https://app.diagrams.net'

@Injectable()
export class CustomDiagramsService {
  constructor(
    private readonly filesQueries: FilesQueries,
    private readonly spacesManager: SpacesManager,
    private readonly filesManager: FilesManager
  ) {}

  async load(user: UserModel, fileId: number): Promise<LoadDiagramResponse> {
    const space = await this.resolveSpace(user, fileId)
    if (!existsSync(space.realPath)) throw new HttpException('file not found on disk', HttpStatus.NOT_FOUND)
    const stat = await getProps(space.realPath)
    if (stat.size > MAX_DIAGRAM_BYTES) throw new HttpException('file too large', HttpStatus.PAYLOAD_TOO_LARGE)
    const xml = await readFile(space.realPath, 'utf-8')
    const etag = genEtag(null, space.realPath, false)
    return {
      xml,
      etag,
      mtime: stat.mtime,
      name: stat.name,
      isWritable: true,
      editorUrl: EDITOR_URL
    }
  }

  async save(user: UserModel, dto: SaveDiagramDto): Promise<{ etag: string; mtime: number }> {
    const space = await this.resolveSpace(user, dto.fileId)
    if (!existsSync(space.realPath)) throw new HttpException('file not found on disk', HttpStatus.NOT_FOUND)
    const current = genEtag(null, space.realPath, false)
    if (current !== dto.etag) throw new HttpException('etag mismatch — file was modified elsewhere', HttpStatus.CONFLICT)
    await writeFile(space.realPath, dto.xml, 'utf-8')
    const newEtag = genEtag(null, space.realPath, false)
    const stat = await getProps(space.realPath)
    return { etag: newEtag, mtime: stat.mtime }
  }

  async createNew(user: UserModel, dto: NewDiagramDto): Promise<{ path: string }> {
    const segments = [...dto.dirPath.split('/').filter(Boolean), dto.name]
    const space = await this.spacesManager.spaceEnv(user, segments)
    await this.filesManager.mkFile(user, space, false, true, false)
    await writeFile(space.realPath, ' ', 'utf-8')
    return { path: segments.join('/') }
  }

  private async resolveSpace(user: UserModel, fileId: number) {
    const row = await this.filesQueries.getUserFile(user.id, fileId)
    if (!row?.path) throw new HttpException('file not found', HttpStatus.NOT_FOUND)
    const pathSegments = row.path.split('/').filter(Boolean)
    const space = await this.spacesManager.spaceEnv(user, ['files', 'personal', ...pathSegments])
    return space
  }
}
```

### Step 4: Run tests

```bash
npx jest backend/src/applications/custom-diagrams/custom-diagrams.service.spec.ts --no-coverage 2>&1 | tail -15
```
Expected: PASS (3 test suites, all green)

### Step 5: Commit

```bash
git add backend/src/applications/custom-diagrams/
git commit -m "feat(diagrams): CustomDiagramsService — load/save/createNew"
```

---

## Task 4: Backend — CustomDiagramsController + Module

**Goal:** Expose the three HTTP endpoints and wire everything into the CustomFeaturesModule.

**Files:**
- Create: `backend/src/applications/custom-diagrams/custom-diagrams.controller.ts`
- Create: `backend/src/applications/custom-diagrams/custom-diagrams.controller.spec.ts`
- Create: `backend/src/applications/custom-diagrams/custom-diagrams.module.ts`
- Modify: `backend/src/applications/custom-features/custom-features.module.ts`

### Step 1: Write failing controller tests

```ts
// backend/src/applications/custom-diagrams/custom-diagrams.controller.spec.ts
import { HttpStatus } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { CustomDiagramsController } from './custom-diagrams.controller'
import { CustomDiagramsService } from './custom-diagrams.service'

const mockUser = { id: 7 } as any
const mockService = {
  load: jest.fn(),
  save: jest.fn(),
  createNew: jest.fn()
}

describe('CustomDiagramsController', () => {
  let controller: CustomDiagramsController

  beforeEach(async () => {
    jest.clearAllMocks()
    const module = await Test.createTestingModule({
      controllers: [CustomDiagramsController],
      providers: [{ provide: CustomDiagramsService, useValue: mockService }]
    }).compile()
    controller = module.get(CustomDiagramsController)
  })

  it('load delegates to service', async () => {
    mockService.load.mockResolvedValue({ xml: '<mxfile/>', etag: 'abc', mtime: 0, name: 'f.drawio', isWritable: true, editorUrl: 'https://app.diagrams.net' })
    const result = await controller.load(mockUser, 42)
    expect(mockService.load).toHaveBeenCalledWith(mockUser, 42)
    expect(result.xml).toBe('<mxfile/>')
  })

  it('save delegates to service', async () => {
    mockService.save.mockResolvedValue({ etag: 'new', mtime: 1 })
    const result = await controller.save(mockUser, { fileId: 42, xml: '<mxfile/>', etag: 'abc' })
    expect(mockService.save).toHaveBeenCalledWith(mockUser, { fileId: 42, xml: '<mxfile/>', etag: 'abc' })
    expect(result.etag).toBe('new')
  })

  it('createNew delegates to service', async () => {
    mockService.createNew.mockResolvedValue({ path: 'files/personal/test.drawio' })
    const result = await controller.createNew(mockUser, { dirPath: 'files/personal', name: 'test.drawio' })
    expect(result.path).toBe('files/personal/test.drawio')
  })
})
```

### Step 2: Run tests to verify they fail

```bash
npx jest backend/src/applications/custom-diagrams/custom-diagrams.controller.spec.ts --no-coverage 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module './custom-diagrams.controller'`

### Step 3: Implement the controller

```ts
// backend/src/applications/custom-diagrams/custom-diagrams.controller.ts
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query } from '@nestjs/common'
import { GetUser } from '../users/decorators/user.decorator'
import { UserModel } from '../users/models/user.model'
import { CustomDiagramsService } from './custom-diagrams.service'
import type { LoadDiagramResponse } from './dto/load-diagram-response.dto'
import { NewDiagramDto } from './dto/new-diagram.dto'
import { SaveDiagramDto } from './dto/save-diagram.dto'

@Controller('diagrams')
export class CustomDiagramsController {
  constructor(private readonly service: CustomDiagramsService) {}

  @Get('load')
  load(@GetUser() user: UserModel, @Query('fileId') fileId: number): Promise<LoadDiagramResponse> {
    return this.service.load(user, Number(fileId))
  }

  @Put('save')
  @HttpCode(HttpStatus.OK)
  save(@GetUser() user: UserModel, @Body() dto: SaveDiagramDto): Promise<{ etag: string; mtime: number }> {
    return this.service.save(user, dto)
  }

  @Post('new')
  @HttpCode(HttpStatus.CREATED)
  createNew(@GetUser() user: UserModel, @Body() dto: NewDiagramDto): Promise<{ path: string }> {
    return this.service.createNew(user, dto)
  }
}
```

### Step 4: Create the module

```ts
// backend/src/applications/custom-diagrams/custom-diagrams.module.ts
import { Module } from '@nestjs/common'
import { FilesManager } from '../files/services/files-manager.service'
import { FilesQueries } from '../files/services/files-queries.service'
import { SpacesManager } from '../spaces/services/spaces-manager.service'
import { CustomDiagramsController } from './custom-diagrams.controller'
import { CustomDiagramsService } from './custom-diagrams.service'

@Module({
  controllers: [CustomDiagramsController],
  providers: [CustomDiagramsService, FilesQueries, SpacesManager, FilesManager]
})
export class CustomDiagramsModule {}
```

> **Note on providers:** `FilesQueries`, `SpacesManager`, and `FilesManager` are exported by `ApplicationsModule` (which is `@Global()`). Listing them here just makes the DI explicit — NestJS will inject the global singletons.

### Step 5: Wire into CustomFeaturesModule

```ts
// backend/src/applications/custom-features/custom-features.module.ts
import { Module } from '@nestjs/common'
import { CustomDiagramsModule } from '../custom-diagrams/custom-diagrams.module'

@Module({
  imports: [CustomDiagramsModule]
})
export class CustomFeaturesModule {}
```

### Step 6: Run all tests + TypeScript check

```bash
npx jest backend/src/applications/custom-diagrams/ --no-coverage 2>&1 | tail -15
npx tsc -p backend/tsconfig.json --noEmit
```
Expected: all tests pass, no TypeScript errors

### Step 7: Commit

```bash
git add backend/src/applications/custom-diagrams/ \
        backend/src/applications/custom-features/
git commit -m "feat(diagrams): CustomDiagramsController + Module (load/save/new endpoints)"
```

---

## Task 5: Frontend — MIME / extension classification

**Goal:** Add `isDiagramExt` helper so `FileDetailComponent` can detect diagram files.

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/utils/classify-file.ts`

### Step 1: Add the helper at the bottom of classify-file.ts

```ts
// Add after the existing isTextEditable and getExtension functions:

const DIAGRAM_EXTENSIONS = new Set(['drawio', 'dwb'])

export function isDiagramExt(name: string): boolean {
  return DIAGRAM_EXTENSIONS.has(getExtension(name).toLowerCase())
}
```

### Step 2: TypeScript check

```bash
npx tsc -p frontend/tsconfig.app.json --noEmit 2>&1 | head -20
```
Expected: no errors

### Step 3: Commit

```bash
git add frontend/src/app/applications/custom-v2/utils/classify-file.ts
git commit -m "feat(v2/diagrams): add isDiagramExt classification helper"
```

---

## Task 6: Frontend — DiagramViewComponent

**Goal:** The Angular component that wraps the draw.io iframe and handles all postMessage communication.

**Files:**
- Create: `frontend/src/app/applications/custom-v2/preview/diagram-view.component.ts`
- Create: `frontend/src/app/applications/custom-v2/preview/diagram-view.component.html`
- Create: `frontend/src/app/applications/custom-v2/preview/diagram-view.component.scss`

### Step 1: Create the HTML template

```html
<!-- frontend/src/app/applications/custom-v2/preview/diagram-view.component.html -->
@if (loading()) {
  <div class="diagram-view__state">Loading diagram…</div>
} @else if (errorMessage()) {
  <div class="diagram-view__state diagram-view__state--error">{{ errorMessage() }}</div>
} @else if (iframeSrc()) {
  <iframe
    #editorFrame
    class="diagram-view__frame"
    [src]="iframeSrc()"
    [title]="'Diagram editor'"
    sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
  ></iframe>
}
```

### Step 2: Create the SCSS

```scss
// frontend/src/app/applications/custom-v2/preview/diagram-view.component.scss
:host {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.diagram-view__frame {
  flex: 1;
  border: none;
  width: 100%;
  height: 100%;
}

.diagram-view__state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted, #888);
  font-size: 14px;
}

.diagram-view__state--error {
  color: var(--danger, #dc3545);
}
```

### Step 3: Implement the component

```ts
// frontend/src/app/applications/custom-v2/preview/diagram-view.component.ts
import { HttpClient } from '@angular/common/http'
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  HostListener,
  inject,
  Input,
  OnInit,
  signal,
  viewChild
} from '@angular/core'
import { takeUntilDestroyed } from '@angular/core/rxjs-interop'
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser'

interface DrawioEvent {
  event: string
  xml?: string
  message?: string
}

interface LoadResponse {
  xml: string
  etag: string
  mtime: number
  name: string
  isWritable: boolean
  editorUrl: string
}

@Component({
  selector: 'app-v2-preview-diagram-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './diagram-view.component.html',
  styleUrl: './diagram-view.component.scss'
})
export class DiagramViewComponent implements OnInit {
  @Input({ required: true }) fileId!: number

  private readonly http = inject(HttpClient)
  private readonly sanitizer = inject(DomSanitizer)
  private readonly destroyRef = inject(DestroyRef)
  private readonly editorFrame = viewChild<ElementRef<HTMLIFrameElement>>('editorFrame')

  protected readonly loading = signal(true)
  protected readonly errorMessage = signal<string | null>(null)
  protected readonly iframeSrc = signal<SafeResourceUrl | null>(null)

  private etag = ''
  private editorOrigin = ''
  private isWritable = false

  ngOnInit(): void {
    this.http
      .get<LoadResponse>(`/diagrams/load?fileId=${this.fileId}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.etag = res.etag
          this.isWritable = res.isWritable
          this.editorOrigin = new URL(res.editorUrl).origin
          const src = `${res.editorUrl}?embed=1&spin=1&proto=json`
          this.iframeSrc.set(this.sanitizer.bypassSecurityTrustResourceUrl(src))
          this.loading.set(false)
          // stash xml to send on init event
          this._pendingXml = res.xml
        },
        error: () => {
          this.errorMessage.set('Failed to load diagram.')
          this.loading.set(false)
        }
      })
  }

  private _pendingXml = ''

  @HostListener('window:message', ['$event'])
  onMessage(event: MessageEvent): void {
    if (event.origin !== this.editorOrigin) return
    let data: DrawioEvent
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
    } catch {
      return
    }
    switch (data.event) {
      case 'init':
        this.postToEditor({ action: 'load', xml: this._pendingXml })
        break
      case 'save':
      case 'autosave':
        if (data.xml != null) this.saveXml(data.xml)
        break
      case 'exit':
        // Parent component handles close via router, nothing to do here
        break
    }
  }

  private postToEditor(msg: unknown): void {
    const frame = this.editorFrame()?.nativeElement
    frame?.contentWindow?.postMessage(JSON.stringify(msg), this.editorOrigin)
  }

  private saveXml(xml: string): void {
    if (!this.isWritable) return
    this.http
      .put<{ etag: string; mtime: number }>('/diagrams/save', { fileId: this.fileId, xml, etag: this.etag })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.etag = res.etag
          this.postToEditor({ action: 'status', message: '' })
        },
        error: (e) => {
          const msg = e.status === 409 ? 'File was modified by someone else — reload to continue.' : 'Save failed.'
          this.postToEditor({ action: 'status', message: msg })
        }
      })
  }
}
```

### Step 4: TypeScript check

```bash
npx tsc -p frontend/tsconfig.app.json --noEmit 2>&1 | head -20
```
Expected: no errors

### Step 5: Commit

```bash
git add frontend/src/app/applications/custom-v2/preview/diagram-view.component.ts \
        frontend/src/app/applications/custom-v2/preview/diagram-view.component.html \
        frontend/src/app/applications/custom-v2/preview/diagram-view.component.scss
git commit -m "feat(v2/diagrams): DiagramViewComponent — iframe + postMessage protocol"
```

---

## Task 7: Frontend — FileDetailComponent — add isDiagram support

**Goal:** Wire the DiagramViewComponent into the v2 file detail screen.

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/file-detail/file-detail.component.ts`
- Modify: `frontend/src/app/applications/custom-v2/screens/file-detail/file-detail.component.html`

### Step 1: Update the component TS

In `file-detail.component.ts`:

1. Add import at top (with other preview imports):
```ts
import { isDiagramExt } from '../../utils/classify-file'
import { DiagramViewComponent } from '../../preview/diagram-view.component'
```

2. Add `DiagramViewComponent` to the `imports` array in `@Component`.

3. Add `isDiagram` computed signal (after `isAudio`):
```ts
protected readonly isDiagram = computed(() => {
  const f = this.file()
  return !!f && !f.isDir && isDiagramExt(f.name)
})
```

4. Add `diagramFileId` computed signal:
```ts
protected readonly diagramFileId = computed(() => this.file()?.id ?? 0)
```

### Step 2: Update the template

In `file-detail.component.html`, add the diagram branch after `@else if (isAudio() && previewUrl())` and before `@else` (the no-preview fallback):

```html
} @else if (isDiagram() && diagramFileId()) {
  <app-v2-preview-diagram-view [fileId]="diagramFileId()" />
```

Also update the `detail__stage--bare` class binding to include diagrams (they also need a full-bleed stage):

Change:
```html
[class.detail__stage--bare]="isPdf() || showOfficeEmbed() || isText()"
```
To:
```html
[class.detail__stage--bare]="isPdf() || showOfficeEmbed() || isText() || isDiagram()"
```

### Step 3: TypeScript check

```bash
npx tsc -p frontend/tsconfig.app.json --noEmit 2>&1 | head -20
```
Expected: no errors

### Step 4: Commit

```bash
git add frontend/src/app/applications/custom-v2/screens/file-detail/
git commit -m "feat(v2/diagrams): wire DiagramViewComponent into file-detail screen"
```

---

## Task 8: Frontend — New diagram action

**Goal:** Add "New diagram" to the + New menu and dispatch it in both personal and space-files screens.

**Files:**
- Modify: `frontend/src/app/applications/custom-v2/screens/files/new-entry-menu.ts`
- Modify: `frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts`
- Modify: `frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts`

### Step 1: Update new-entry-menu.ts

1. Extend `NewEntryId` type:
```ts
export type NewEntryId = 'new-docx' | 'new-xlsx' | 'new-pptx' | 'new-folder' | 'new-text' | 'new-diagram'
```

2. Add to `buildNewEntryMenu` — append after the `new-folder` / `new-text` block:
```ts
{ id: 'new-diagram', label: 'Diagram', icon: 'default', action: () => opts.onSelect('new-diagram') }
```
(Use `'default'` as the icon since the diagram glyph icon doesn't exist as an `IconV2Name` yet — it falls back to the neutral doc glyph.)

3. Add to `buildNewEntrySheetItems`:
```ts
{ id: 'new-diagram', label: 'Diagram', icon: 'default' }
```

### Step 2: Add `newDiagramFile` to personal.component.ts

1. Add `'new-diagram'` case to `dispatchNewEntry`:
```ts
case 'new-diagram':
  this.newDiagramFile()
  return
```

2. Add the method (after `newTextFile`):
```ts
private newDiagramFile(): void {
  const dirPath = this.currentUploadRoute()
  const name = this.uniqueName('Untitled diagram', 'drawio')
  this.http.post<{ path: string }>('/diagrams/new', { dirPath, name }).subscribe({
    next: (res) => {
      this.toast.success(`"${name}" created`)
      this.refresh()
      this.router.navigate(['/', V2_PATH, V2_ROUTES.FILE], { queryParams: { path: res.path } }).catch(console.error)
    },
    error: (e: HttpErrorResponse) => {
      this.toast.error(e.error?.message ?? 'Diagram creation failed')
    }
  })
}
```

### Step 3: Add `newDiagramFile` to space-files.component.ts

Same pattern as Step 2 — find `dispatchNewEntry`, add `'new-diagram'` case, add `newDiagramFile()` method following the same `currentUploadRoute()` + `uniqueName()` + HTTP POST + navigate pattern.

### Step 4: TypeScript check

```bash
npx tsc -p frontend/tsconfig.app.json --noEmit 2>&1 | head -20
```
Expected: no errors

### Step 5: Commit

```bash
git add frontend/src/app/applications/custom-v2/screens/files/new-entry-menu.ts \
        frontend/src/app/applications/custom-v2/screens/personal/personal.component.ts \
        frontend/src/app/applications/custom-v2/screens/space/space-files.component.ts
git commit -m "feat(v2/diagrams): new diagram action in + New menu (personal + space-files)"
```

---

## Final verification

### Run full TypeScript check

```bash
cd /Users/janwiebe/prive/sync-in-server/.worktrees/feat-drawio
npx tsc -p backend/tsconfig.json --noEmit
npx tsc -p frontend/tsconfig.app.json --noEmit
```
Both expected: clean (no output)

### Run backend tests

```bash
npx jest backend/src/applications/custom-diagrams/ --no-coverage
```
Expected: all pass

### Git log

```bash
git log --oneline -10
```
Expected: 8 commits since the design doc commit, one per task.

---

## Files created / modified summary

| Action | File | Commit |
|---|---|---|
| Create | `backend/src/applications/custom-features/custom-features.module.ts` | Task 1 |
| **Modify** | `backend/src/applications/applications.module.ts` | Task 1 |
| Create | `backend/src/applications/custom-diagrams/dto/*.ts` (3 files) | Task 2 |
| Create | `backend/src/applications/custom-diagrams/custom-diagrams.service.ts` | Task 3 |
| Create | `backend/src/applications/custom-diagrams/custom-diagrams.service.spec.ts` | Task 3 |
| Create | `backend/src/applications/custom-diagrams/custom-diagrams.controller.ts` | Task 4 |
| Create | `backend/src/applications/custom-diagrams/custom-diagrams.controller.spec.ts` | Task 4 |
| Create | `backend/src/applications/custom-diagrams/custom-diagrams.module.ts` | Task 4 |
| **Modify** | `backend/src/applications/custom-features/custom-features.module.ts` | Task 4 |
| **Modify** | `frontend/.../custom-v2/utils/classify-file.ts` | Task 5 |
| Create | `frontend/.../custom-v2/preview/diagram-view.component.ts` | Task 6 |
| Create | `frontend/.../custom-v2/preview/diagram-view.component.html` | Task 6 |
| Create | `frontend/.../custom-v2/preview/diagram-view.component.scss` | Task 6 |
| **Modify** | `frontend/.../custom-v2/screens/file-detail/file-detail.component.ts` | Task 7 |
| **Modify** | `frontend/.../custom-v2/screens/file-detail/file-detail.component.html` | Task 7 |
| **Modify** | `frontend/.../custom-v2/screens/files/new-entry-menu.ts` | Task 8 |
| **Modify** | `frontend/.../custom-v2/screens/personal/personal.component.ts` | Task 8 |
| **Modify** | `frontend/.../custom-v2/screens/space/space-files.component.ts` | Task 8 |

**Upstream file touches (bold + italic):** only `applications.module.ts` — one line. All other modifications are to `custom-v2` or `custom-features` files owned by this fork.
