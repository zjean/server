import { HttpClient } from '@angular/common/http'
import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, signal, untracked } from '@angular/core'
import { API_SPACES_TREE } from '@sync-in-server/backend/src/applications/spaces/constants/routes'
import { SPACE_ALIAS, SPACE_OPERATION, SPACE_REPOSITORY } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import type { FileTree } from '@sync-in-server/backend/src/applications/files/interfaces/file-tree.interface'
import { firstValueFrom } from 'rxjs'
import { L10N_LOCALE, L10nLocale, L10nTranslatePipe } from 'angular-l10n'
import { IconV2Component } from '../icons/icon-v2.component'
import { ButtonComponent } from './button.component'
import { TreePickerService } from './tree-picker.service'

interface NodeState {
  tree: FileTree
  depth: number
  expanded: boolean
  loading: boolean
  children: NodeState[] | null
  // parent tracking for a flat-with-depth render
  parentId: number | null
}

const ROOT_PERSONAL: FileTree = {
  id: 0,
  name: 'Personal',
  path: `${SPACE_REPOSITORY.FILES}/${SPACE_ALIAS.PERSONAL}`,
  isDir: true,
  mime: 'directory',
  inShare: false,
  enabled: true,
  permissions: `${SPACE_OPERATION.ADD}:${SPACE_OPERATION.MODIFY}:${SPACE_OPERATION.DELETE}`,
  quotaIsExceeded: false,
  hasChildren: true
}

const ROOT_SPACES: FileTree = {
  id: -1,
  name: 'Spaces',
  path: SPACE_REPOSITORY.FILES,
  isDir: true,
  mime: 'directory',
  inShare: false,
  enabled: true,
  permissions: '',
  quotaIsExceeded: false,
  hasChildren: true
}

const ROOT_SHARES: FileTree = {
  id: -2,
  name: 'Shared with me',
  path: SPACE_REPOSITORY.SHARES,
  isDir: true,
  mime: 'directory',
  inShare: true,
  enabled: true,
  permissions: '',
  quotaIsExceeded: false,
  hasChildren: true
}

@Component({
  selector: 'app-v2-tree-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconV2Component, ButtonComponent, L10nTranslatePipe],
  template: `
    @if (pending(); as p) {
      <div class="tree-picker__backdrop" (click)="cancel()"></div>
      <div class="tree-picker" role="dialog" aria-modal="true" (click)="$event.stopPropagation()">
        <header class="tree-picker__head">
          <div class="tree-picker__title">{{ p.title | translate: locale.language }}</div>
          <button type="button" class="tree-picker__close" (click)="cancel()" aria-label="Close">
            <app-v2-icon name="x" [size]="14" />
          </button>
        </header>
        <div class="tree-picker__body">
          @for (n of flatNodes(); track n.tree.id + ':' + n.tree.path) {
            <div
              class="tp-node"
              [class.tp-node--selected]="selected()?.tree?.id === n.tree.id && selected()?.tree?.path === n.tree.path"
              [class.tp-node--disabled]="isDisabled(n)"
              [style.padding-left.px]="10 + n.depth * 16"
              (click)="onSelect(n)"
            >
              @if (n.tree.hasChildren) {
                <button
                  type="button"
                  class="tp-node__chev"
                  [class.tp-node__chev--open]="n.expanded"
                  (click)="toggle(n); $event.stopPropagation()"
                  [attr.aria-label]="n.expanded ? 'Collapse' : 'Expand'"
                >
                  @if (n.loading) {
                    <app-v2-icon name="refresh" [size]="11" />
                  } @else {
                    <app-v2-icon name="chevRight" [size]="11" />
                  }
                </button>
              } @else {
                <span class="tp-node__chev tp-node__chev--leaf"></span>
              }
              <app-v2-icon [name]="n.tree.inShare ? 'shareTree' : 'folder'" [size]="14" />
              <span class="tp-node__name">{{ n.tree.name }}</span>
            </div>
          }
        </div>
        <footer class="tree-picker__foot">
          <div class="tree-picker__hint">
            @if (selected(); as sel) {
              <span class="tree-picker__path">/{{ sel.tree.path }}</span>
            } @else {
              <span class="tree-picker__path-empty" l10nTranslate>Select a destination folder.</span>
            }
            @if (errorMsg(); as err) {
              <div class="tree-picker__error">{{ err | translate: locale.language }}</div>
            }
          </div>
          <div class="tree-picker__actions">
            <app-v2-btn kind="ghost" size="sm" (click)="cancel()">{{ 'Cancel' | translate: locale.language }}</app-v2-btn>
            <app-v2-btn kind="primary" size="sm" [disabled]="!canSubmit()" (click)="submit()">
              {{ p.submitLabel | translate: locale.language }}
            </app-v2-btn>
          </div>
        </footer>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }
      .tree-picker__backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        z-index: 70;
      }
      .tree-picker {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 71;
        width: 420px;
        max-height: 560px;
        display: flex;
        flex-direction: column;
        background: var(--si-bg1);
        border: 1px solid var(--si-border);
        border-radius: 10px;
        box-shadow:
          0 4px 14px rgba(0, 0, 0, 0.12),
          0 18px 40px rgba(0, 0, 0, 0.16);
      }
      .tree-picker__head {
        display: flex;
        align-items: center;
        padding: 14px 14px 8px;
      }
      .tree-picker__title {
        flex: 1 1 auto;
        font-size: 15px;
        font-weight: 600;
        color: var(--si-fg);
      }
      .tree-picker__close {
        background: transparent;
        border: none;
        color: var(--si-fg-muted);
        cursor: pointer;
        padding: 4px;
        border-radius: 6px;
        display: inline-flex;
      }
      .tree-picker__close:hover {
        background: var(--si-bg3);
        color: var(--si-fg);
      }
      .tree-picker__body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: auto;
        padding: 4px 0;
        border-top: 1px solid var(--si-line);
        border-bottom: 1px solid var(--si-line);
      }
      .tp-node {
        display: flex;
        align-items: center;
        gap: 8px;
        height: 30px;
        padding-right: 12px;
        cursor: pointer;
        font-size: 13px;
        color: var(--si-fg);
      }
      .tp-node:hover {
        background: var(--si-bg2);
      }
      .tp-node--selected {
        background: color-mix(in srgb, var(--si-accent, #3b82f6) 14%, transparent);
      }
      .tp-node--disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .tp-node__chev {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border: none;
        background: transparent;
        color: var(--si-fg-muted);
        cursor: pointer;
        border-radius: 3px;
        transition: transform 120ms ease;
      }
      .tp-node__chev:hover {
        background: var(--si-bg3);
      }
      .tp-node__chev--open {
        transform: rotate(90deg);
      }
      .tp-node__chev--leaf {
        cursor: default;
      }
      .tp-node__name {
        flex: 1 1 auto;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tree-picker__foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 14px 14px;
      }
      .tree-picker__hint {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 12px;
        color: var(--si-fg-muted);
      }
      .tree-picker__path {
        font-family: var(--si-mono, ui-monospace, monospace);
        color: var(--si-fg);
        word-break: break-all;
      }
      .tree-picker__path-empty {
        color: var(--si-fg-muted);
      }
      .tree-picker__error {
        color: var(--si-rose, #c0392b);
        font-size: 11px;
        margin-top: 2px;
      }
      .tree-picker__actions {
        display: inline-flex;
        gap: 8px;
        flex-shrink: 0;
      }
    `
  ]
})
export class TreePickerComponent {
  private readonly http = inject(HttpClient)
  private readonly service = inject(TreePickerService)
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)

  private readonly rootNodes = signal<NodeState[]>([])
  protected readonly selected = signal<NodeState | null>(null)

  protected readonly pending = computed(() => this.service.pending())

  protected readonly flatNodes = computed(() => {
    const out: NodeState[] = []
    const walk = (nodes: NodeState[]) => {
      for (const n of nodes) {
        out.push(n)
        if (n.expanded && n.children) walk(n.children)
      }
    }
    walk(this.rootNodes())
    return out
  })

  protected readonly errorMsg = signal<string | null>(null)

  protected readonly canSubmit = computed(() => {
    const s = this.selected()
    const p = this.pending()
    if (!s || !p) return false
    if (this.isDisabled(s)) return false
    return true
  })

  constructor() {
    effect(() => {
      const p = this.pending()
      untracked(() => {
        if (p) {
          this.seedRoots(p)
        } else {
          this.rootNodes.set([])
          this.selected.set(null)
          this.errorMsg.set(null)
        }
      })
    })
  }

  private seedRoots(opts: { allowSpaces?: boolean; allowShares?: boolean }): void {
    const roots: NodeState[] = [this.makeNode(ROOT_PERSONAL, 0, null)]
    if (opts.allowSpaces !== false) roots.push(this.makeNode(ROOT_SPACES, 0, null))
    if (opts.allowShares !== false) roots.push(this.makeNode(ROOT_SHARES, 0, null))
    this.rootNodes.set(roots)
    this.selected.set(null)
    this.errorMsg.set(null)
    // Auto-expand Personal for speed
    void this.loadChildren(roots[0])
    roots[0].expanded = true
  }

  private makeNode(tree: FileTree, depth: number, parentId: number | null): NodeState {
    return { tree, depth, expanded: false, loading: false, children: null, parentId }
  }

  protected async toggle(node: NodeState): Promise<void> {
    if (!node.tree.hasChildren) return
    if (!node.expanded && !node.children) {
      await this.loadChildren(node)
    }
    node.expanded = !node.expanded
    this.rootNodes.set([...this.rootNodes()])
  }

  private async loadChildren(node: NodeState): Promise<void> {
    if (node.loading) return
    node.loading = true
    this.rootNodes.set([...this.rootNodes()])
    try {
      const children = await firstValueFrom(this.http.get<FileTree[]>(`${API_SPACES_TREE}/${node.tree.path}`))
      node.children = children.map((c) => this.makeNode(c, node.depth + 1, node.tree.id))
    } catch {
      node.children = []
    } finally {
      node.loading = false
      this.rootNodes.set([...this.rootNodes()])
    }
  }

  protected onSelect(node: NodeState): void {
    if (this.isDisabled(node)) return
    this.selected.set(node)
    this.errorMsg.set(null)
    if (node.tree.hasChildren && !node.expanded) {
      void this.toggle(node)
    }
  }

  protected isDisabled(node: NodeState): boolean {
    if (!node.tree.enabled) return true
    if (node.tree.quotaIsExceeded) return true
    if (node.tree.id === -1 || node.tree.id === -2) return true // browsing-only roots
    const p = this.pending()
    if (p?.disabledPath && node.tree.path === p.disabledPath) return true
    // permissions check: must allow ADD for destination writes
    if (!node.tree.permissions.includes(SPACE_OPERATION.ADD)) return true
    return false
  }

  protected cancel(): void {
    this.service.resolve(null)
  }

  protected submit(): void {
    const s = this.selected()
    if (!s || !this.canSubmit()) return
    this.service.resolve({ path: s.tree.path, name: s.tree.name, mime: s.tree.mime })
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    if (this.pending()) this.cancel()
  }
}
