import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core'
import type { OnlyOfficeConfig } from '@sync-in-server/backend/src/applications/files/editors/only-office/only-office.interface'
import type { OnlyOfficeHistoryHooks } from '../../../custom-v2/models/only-office-history.model'
import loadScript from './only-office.utils'

@Component({
  selector: 'app-files-onlyoffice-document',
  template: '<div [id]="id"></div>'
})
export class OnlyOfficeComponent implements OnInit, OnChanges, OnDestroy {
  @Input({ required: true }) id: string
  @Input({ required: true }) editorName: string
  @Input({ required: true }) documentServerUrl: string
  @Input({ required: true }) config: OnlyOfficeConfig
  // Fork: optional version-history event handlers. Absent — which is every
  // caller but the v2 office view — behaviour is byte-for-byte what it was.
  //
  // They arrive as their OWN input rather than inside `config` because they
  // cannot survive the trip: onLoad deep-clones the config through
  // JSON.parse(JSON.stringify(...)) below, and functions do not survive that.
  @Input() historyHooks?: OnlyOfficeHistoryHooks
  @Output() loadError = new EventEmitter<{ title: string; message: string }>()
  @Output() wasSaved = new EventEmitter<string>()
  private isFirstOnChanges = true

  ngOnInit(): void {
    let url = this.documentServerUrl
    if (!url.endsWith('/')) url += '/'
    const docApiUrl = `${url}web-apps/apps/api/documents/api.js`
    loadScript(docApiUrl, 'onlyoffice-api-script')
      .then(() => this.onLoad())
      .catch(() => {
        this.onError(-2)
      })
  }

  ngOnChanges(changes: SimpleChanges) {
    if (this.isFirstOnChanges) {
      this.isFirstOnChanges = false
      return
    }

    if ('config' in changes) {
      if (window?.DocEditor?.instances[this.id]) {
        window.DocEditor.instances[this.id].destroyEditor()
        window.DocEditor.instances[this.id] = undefined
        console.warn('Important props have been changed, reloading ...')
        this.onLoad()
        return
      }
    }
  }

  ngOnDestroy() {
    if (window?.DocEditor?.instances[this.id]) {
      window.DocEditor.instances[this.id].destroyEditor()
      window.DocEditor.instances[this.id] = undefined
      delete window.DocEditor.instances[this.id]
    }
  }

  private onLoad = () => {
    try {
      if (!window.DocsAPI) {
        this.onError(-3)
        return
      }

      if (window?.DocEditor?.instances[this.id]) {
        console.log('Skip loading, instance already exists', this.id)
        return
      }

      if (!window?.DocEditor?.instances) {
        window.DocEditor = { instances: {} }
      }

      const config: OnlyOfficeConfig = JSON.parse(JSON.stringify(this.config))
      // Fork: the history hooks are spread AFTER the clone, for the reason on the
      // input. The cast is because upstream declares the four history events as
      // `(event: object) => void` while their real payloads carry fields the
      // handlers must read (`{data: number}`, `{data: {version}}`) — so the fork's
      // precise signatures are not assignable to the looser declared ones. The
      // narrower types are the useful ones; see only-office-history.model.ts.
      config.events = {
        onDocumentStateChange: (e: { data: boolean }) => (e.data ? this.wasSaved.emit() : null),
        ...(this.historyHooks ?? {})
      } as OnlyOfficeConfig['events']
      window.DocEditor.instances[this.id] = window.DocsAPI.DocEditor(this.id, config)
    } catch (err) {
      console.error(err)
      this.onError(-1)
    }
  }

  private onError(errorCode: number) {
    const error = { title: `Unknown ${this.editorName} error`, message: `Code: ${errorCode}` }

    switch (errorCode) {
      case -2:
        error.title = `Unable to load ${this.editorName} editor`
        error.message = 'The document server may be unreachable or the configuration is invalid'
        break
      case -3:
        error.title = `${this.editorName} editor failed to initialize`
        error.message = 'DocsAPI not available'
        break
    }

    this.loadError.emit(error)
  }
}
