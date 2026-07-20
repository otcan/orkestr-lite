import {
  Component,
  EventEmitter,
  HostListener,
  Input,
  Output,
} from "@angular/core";

@Component({
  selector: "app-clear-context-dialog",
  standalone: true,
  template: `
    @if (open) {
      <div class="dialog-backdrop" (click)="dismiss()">
        <section
          class="context-dialog panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="clear-context-title"
          aria-describedby="clear-context-description"
          (click)="$event.stopPropagation()"
        >
          <p class="eyebrow">Codex memory</p>
          <h2 id="clear-context-title">Clear context?</h2>
          <p id="clear-context-description">
            Codex will stop remembering earlier messages. Workspace files, Desk,
            WhatsApp data, and timers will stay intact.
          </p>
          <p class="muted">
            New browser, WhatsApp, and scheduled messages will continue with a
            clean context.
          </p>
          <label class="context-history-option">
            <input
              type="checkbox"
              aria-label="Also clear visible chat history"
              [checked]="clearVisibleHistory"
              (change)="clearVisibleHistory = $any($event.target).checked"
            />
            <span>
              <strong>Also clear visible chat history</strong>
              <small>
                Start with an empty Codex UI. Existing workspace files are not
                deleted.
              </small>
            </span>
          </label>
          <div class="dialog-actions">
            <button
              type="button"
              autofocus
              (click)="dismiss()"
              [disabled]="busy"
            >
              Keep context
            </button>
            <button
              class="danger"
              type="button"
              (click)="confirm()"
              [disabled]="busy"
            >
              {{ busy ? "Clearing…" : "Clear context" }}
            </button>
          </div>
        </section>
      </div>
    }
  `,
})
export class ClearContextDialogComponent {
  private openState = false;
  @Input() busy = false;
  @Output() readonly confirmed = new EventEmitter<boolean>();
  @Output() readonly dismissed = new EventEmitter<void>();
  clearVisibleHistory = false;

  @Input()
  set open(value: boolean) {
    if (value && !this.openState) this.clearVisibleHistory = false;
    this.openState = value;
  }

  get open(): boolean {
    return this.openState;
  }

  confirm(): void {
    if (!this.busy) this.confirmed.emit(this.clearVisibleHistory);
  }

  @HostListener("document:keydown.escape")
  dismiss(): void {
    if (this.open && !this.busy) {
      this.clearVisibleHistory = false;
      this.dismissed.emit();
    }
  }
}
