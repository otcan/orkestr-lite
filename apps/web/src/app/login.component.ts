import { Component, EventEmitter, Output, signal } from "@angular/core";
import { ApiService, errorText } from "./api.service";

@Component({
  selector: "orkestr-login",
  standalone: true,
  template: `
    <main class="login-shell">
      <section class="login-card panel">
        <div class="brand-mark">O</div>
        <p class="eyebrow">Single-container Codex workstation</p>
        <h1>Orkestr Lite</h1>
        <p class="muted">
          Enter the administrator password printed during first boot.
        </p>
        <form (submit)="submit(); $event.preventDefault()">
          <label for="password">Administrator password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            [value]="password()"
            (input)="password.set($any($event.target).value)"
            required
          />
          @if (error) {
            <p class="error" role="alert">{{ error }}</p>
          }
          <button
            class="primary full"
            type="submit"
            [disabled]="busy || !password()"
          >
            {{ busy ? "Signing in…" : "Open workstation" }}
          </button>
        </form>
      </section>
    </main>
  `,
})
export class LoginComponent {
  @Output() readonly authenticated = new EventEmitter<void>();
  readonly password = signal("");
  private readonly busyState = signal(false);
  private readonly errorState = signal("");

  get busy(): boolean {
    return this.busyState();
  }

  get error(): string {
    return this.errorState();
  }

  constructor(private readonly api: ApiService) {}

  async submit(): Promise<void> {
    this.busyState.set(true);
    this.errorState.set("");
    try {
      await this.api.login(this.password());
      this.password.set("");
      this.authenticated.emit();
    } catch (error) {
      this.errorState.set(errorText(error));
    } finally {
      this.busyState.set(false);
    }
  }
}
