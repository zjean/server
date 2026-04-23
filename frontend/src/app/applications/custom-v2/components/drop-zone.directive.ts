import { Directive, EventEmitter, HostListener, Output, signal } from '@angular/core'

@Directive({
  selector: '[appV2DropZone]',
  standalone: true,
  host: {
    '[class.drop-zone--active]': 'active()'
  }
})
export class DropZoneDirective {
  @Output() readonly dropped = new EventEmitter<DragEvent>()

  protected readonly active = signal(false)
  private depth = 0

  @HostListener('dragenter', ['$event'])
  onDragEnter(ev: DragEvent): void {
    if (!this.hasFiles(ev)) return
    ev.preventDefault()
    this.depth++
    this.active.set(true)
  }

  @HostListener('dragover', ['$event'])
  onDragOver(ev: DragEvent): void {
    if (!this.hasFiles(ev)) return
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(ev: DragEvent): void {
    if (!this.hasFiles(ev)) return
    ev.preventDefault()
    this.depth = Math.max(0, this.depth - 1)
    if (this.depth === 0) this.active.set(false)
  }

  @HostListener('drop', ['$event'])
  onDrop(ev: DragEvent): void {
    if (!this.hasFiles(ev)) return
    ev.preventDefault()
    this.depth = 0
    this.active.set(false)
    this.dropped.emit(ev)
  }

  private hasFiles(ev: DragEvent): boolean {
    const types = ev.dataTransfer?.types
    if (!types) return false
    for (const type of types) {
      if (type === 'Files') return true
    }
    return false
  }
}
