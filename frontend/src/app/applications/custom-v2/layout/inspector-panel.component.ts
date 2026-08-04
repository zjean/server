import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core'
import { L10N_LOCALE, L10nLocale, L10nTranslateDirective, L10nTranslatePipe, L10nTranslationService } from 'angular-l10n'
import { FileProps } from '@sync-in-server/backend/src/applications/files/interfaces/file-props.interface'
import { SHARE_TYPE } from '@sync-in-server/backend/src/applications/shares/constants/shares'
import { SPACE_ALIAS } from '@sync-in-server/backend/src/applications/spaces/constants/spaces'
import { TimeAgoPipe } from '../../../common/pipes/time-ago.pipe'
import { ToBytesPipe } from '../../../common/pipes/to-bytes.pipe'
import { ButtonComponent } from '../components/button.component'
import { CommentsPanelComponent, CommentsStats } from '../components/comments-panel.component'
import { FileGlyphComponent, FileGlyphType } from '../components/file-glyph.component'
import { IconButtonComponent } from '../components/icon-button.component'
import { TabItem, TabsComponent } from '../components/tabs.component'
import { TooltipDirective } from '../components/tooltip.directive'
import { ShareDialogService } from '../components/share-dialog.service'
import { VersionsPanelComponent, VersionsStats } from '../components/versions-panel.component'
import { IconV2Component } from '../icons/icon-v2.component'
import { FolderSizeService } from '../services/folder-size.service'
import { VersionsService } from '../services/versions.service'
import { mimeLabel, mimeToGlyph } from '../utils/mime-to-glyph'
import { INSPECTOR_TABS, InspectorService, InspectorTabId } from './inspector.service'
import { LayoutV2Service } from './layout-v2.service'

interface AccessRow {
  id: number
  label: string
  isLink: boolean
}

// The inspector — the design's panel `2a`, docked at 340px and pushing content.
//
// This is the ONE inspector. It used to be two: this panel (Info / Comments,
// driven by an icon rail) and a second, near-identical aside inside
// file-detail (five unlabelled glyph tabs). D4 and D5 draw one panel, and the
// duplication had already produced two divergent property tables, so the file
// detail screen now publishes its file here like every other screen and the
// aside is gone.
//
// Two things are deliberately not the design's:
//
//  • Tabs whose data cannot exist are HIDDEN rather than shown empty. A folder
//    has no comments (the API is file-scoped) and no versions, and a server with
//    `files.versions.enabled` off has no version history at all — the strip stays
//    labelled and evenly divided either way, which is what the design's rejection
//    of the icon rail was actually about. The stored tab preference is NOT
//    rewritten when it is unavailable, so selecting a file again returns to it.
//  • Tab counts appear once a tab has loaded its data, not before. The counts are
//    reported UP by the panels that own them (`statsChange`), because the
//    alternative is two extra requests per selected row for numbers nothing else
//    needs. A count the panel has not learned yet renders as no count.
@Component({
  selector: 'app-v2-inspector-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './inspector-panel.component.html',
  styleUrl: './inspector-panel.component.scss',
  imports: [
    ButtonComponent,
    CommentsPanelComponent,
    FileGlyphComponent,
    IconButtonComponent,
    IconV2Component,
    TabsComponent,
    TooltipDirective,
    VersionsPanelComponent,
    ToBytesPipe,
    TimeAgoPipe,
    L10nTranslateDirective,
    L10nTranslatePipe
  ]
})
export class InspectorPanelComponent {
  protected readonly locale = inject<L10nLocale>(L10N_LOCALE)
  private readonly translation = inject(L10nTranslationService)
  private readonly layoutV2 = inject(LayoutV2Service)
  private readonly inspector = inject(InspectorService)
  private readonly folderSize = inject(FolderSizeService)
  private readonly versions = inject(VersionsService)
  private readonly shareDialog = inject(ShareDialogService)

  protected readonly file = computed(() => this.inspector.currentSelected())

  // Reported up by the two panels that load the data. Cleared whenever the file
  // changes, so a stale count from the previous row can never label this one.
  protected readonly commentStats = signal<CommentsStats | null>(null)
  protected readonly versionStats = signal<VersionsStats | null>(null)

  protected readonly shortcutLabel: string = (() => {
    if (typeof navigator === 'undefined') return 'Ctrl I'
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac/.test(navigator.userAgent || '')
    return isMac ? '⌘I' : 'Ctrl I'
  })()

  protected readonly glyphType = computed<FileGlyphType>(() => {
    const f = this.file()
    if (!f) return 'default'
    return f.isDir ? 'folder' : mimeToGlyph(f.mime)
  })

  protected readonly typeLabel = computed(() => {
    const f = this.file()
    if (!f) return ''
    return f.isDir ? this.translation.translate('Folder') : mimeLabel(f.mime)
  })

  // The path minus the file's own name: "where is this", not "what is this".
  protected readonly locationLabel = computed(() => {
    const f = this.file()
    if (!f) return ''
    const parts = f.path.split('/').filter(Boolean)
    return parts.slice(0, -1).join('/')
  })

  // Comments and versions are both file-scoped on the server; versioning is also
  // a server feature that may be switched off entirely, and `availability` is
  // settled by a probe rather than guessed.
  private readonly visibleTabs = computed<readonly InspectorTabId[]>(() => {
    const f = this.file()
    const isFile = !!f && !f.isDir
    return INSPECTOR_TABS.filter((id) => {
      if (id === 'comments') return isFile
      if (id === 'versions') return isFile && this.versions.availability() === 'available'
      return true
    })
  })

  // The user's stored preference, narrowed to what this selection can show. The
  // preference itself is left alone — see the class comment.
  protected readonly tab = computed<InspectorTabId>(() => {
    const stored = this.layoutV2.dockTab()
    return this.visibleTabs().includes(stored) ? stored : 'properties'
  })

  protected readonly tabs = computed<TabItem<InspectorTabId>[]>(() => {
    const comments = this.commentStats()
    const versions = this.versionStats()
    const labels: Record<InspectorTabId, { label: string; count: number | null }> = {
      properties: { label: 'Properties', count: null },
      // A zero renders as no count. The design's strip reads "Comments 4"; a
      // "Comments 0" would be a number whose only content is the absence the empty
      // state already states, in the one place where every character costs width.
      comments: { label: 'Comments', count: comments?.count || null },
      versions: { label: 'Versions', count: versions?.count || null },
      activity: { label: 'Activity', count: null }
    }
    return this.visibleTabs().map((id) => ({
      id,
      label: this.translation.translate(labels[id].label),
      count: labels[id].count
    }))
  })

  // What the tab is about, restated under the file name — the design varies this
  // line per tab (`markdown · 721 B` / `3 versions · 1.5 KB`). It falls back to
  // the file line whenever the tab's own numbers are not in yet.
  protected readonly headMeta = computed(() => {
    const f = this.file()
    if (!f) return ''
    const tab = this.tab()
    if (tab === 'versions') {
      const s = this.versionStats()
      if (s && s.count > 0) {
        return this.translation.translate(s.count === 1 ? 'v2_inspector_one_version' : 'v2_inspector_versions', {
          count: s.count,
          total: this.bytes(s.bytes)
        })
      }
    }
    if (tab === 'comments') {
      const s = this.commentStats()
      if (s && s.count > 0) {
        return this.translation.translate(s.count === 1 ? 'v2_inspector_one_comment' : 'v2_inspector_comments', { count: s.count })
      }
    }
    const type = f.isDir ? this.translation.translate('Folder') : mimeLabel(f.mime)
    return f.isDir ? type : `${type} · ${this.bytes(f.size)}`
  })

  protected readonly folderSizeState = computed(() => {
    const f = this.file()
    if (!f || !f.isDir) return 'idle'
    return this.folderSize.state(f.id).status
  })

  protected readonly folderSizeBytes = computed(() => {
    const f = this.file()
    if (!f) return 0
    const st = this.folderSize.state(f.id)
    return st.status === 'done' ? st.bytes : 0
  })

  // Trash and the shares list are read-only surfaces for sharing purposes — the
  // same gate file-detail applies before offering its Share button.
  protected readonly canShare = computed(() => {
    const f = this.file()
    if (!f) return false
    const alias = f.path.split('/').filter(Boolean)[1] ?? ''
    return alias !== SPACE_ALIAS.TRASH && alias !== SPACE_ALIAS.SHARES
  })

  // Whatever the browse response already told us. No request of its own: the
  // ACCESS band reports what is known and the Manage sharing button is the way
  // to see the authoritative list.
  protected readonly shares = computed<AccessRow[]>(() => {
    const f = this.file()
    if (!f?.shares?.length) return []
    return f.shares.map((s) => ({
      id: s.id,
      isLink: s.type === SHARE_TYPE.LINK,
      label: s.name || s.alias || this.translation.translate(s.type === SHARE_TYPE.LINK ? 'Link' : 'Share')
    }))
  })

  private readonly toBytes = new ToBytesPipe()

  constructor() {
    // A new file means every reported count belongs to the previous one.
    effect(() => {
      this.file()
      untracked(() => {
        this.commentStats.set(null)
        this.versionStats.set(null)
      })
    })

    // Two lazy loads that only a visible panel justifies:
    //   • the recursive folder size, because the endpoint walks the subtree per
    //     call (issue #205) — never as part of a listing;
    //   • the versions probe, which is what decides whether the Versions tab
    //     exists at all, and no-ops after the first answer of the session.
    effect(() => {
      if (!this.layoutV2.dockOpen()) return
      const f = this.file()
      if (!f) return
      untracked(() => {
        if (f.isDir) {
          if (this.tab() === 'properties') this.folderSize.compute(f as unknown as FileProps, f.path)
          return
        }
        this.versions.probe(f.path)
      })
    })
  }

  // A restore rewrote the live file. Whoever is rendering it has to reload; this
  // panel does not know how, and does not guess.
  protected onRestored(): void {
    this.inspector.contentReplaced.next()
  }

  protected setTab(tab: InspectorTabId): void {
    this.layoutV2.setDockTab(tab)
  }

  protected close(): void {
    this.layoutV2.closeDock()
  }

  protected stamp(ms: number): string {
    return formatStamp(ms)
  }

  protected bytes(n: number): string {
    return this.toBytes.transform(n, 1, true)
  }

  // Mirrors file-detail's own Share entry point, including the space alias split
  // the dialog expects.
  protected async manageSharing(): Promise<void> {
    const f = this.file()
    if (!f) return
    const parts = f.path.split('/').filter(Boolean)
    const alias = parts[1] ?? ''
    await this.shareDialog.open({
      file: {
        id: f.id,
        name: f.name,
        isDir: f.isDir,
        mime: f.mime,
        space: { alias, name: alias, root: { alias, name: alias } } as never
      },
      relativePath: parts.slice(2).join('/'),
      ownerId: null
    })
  }
}

// `2026-07-30 14:12`, which is what the design's property table shows and what a
// record wants: sortable, unambiguous, and the same string for every reader. The
// relative form ("14 min ago") is the identity band's job and stays in the title
// attribute here.
export function formatStamp(ms: number): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
