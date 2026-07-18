import { Component, EventEmitter, Output } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ApiService, errorText } from "./api.service";

@Component({
  selector: "orkestr-login",
  standalone: true,
  imports: [FormsModule],
  template: `
    <main class="login-shell">
      <section class="login-card panel">
        <div class="brand-mark">O</div>
        <p class="eyebrow">Single-container Codex workstation</p>
        <h1>Orkestr Lite</h1>
        <p class="muted">
          Enter the administrator password printed during first boot.
        </p>
        <form (ngSubmit)="submit()">
          <label for="password">Administrator password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            [(ngModel)]="password"
            required
          />
          @if (error) {
            <p class="error" role="alert">{{ error }}</p>
          }
          <button
            class="primary full"
            type="submit"
            [disabled]="busy || !password"
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
  password = "";
  busy = false;
  error = "";

  constructor(private readonly api: ApiService) {}

  async submit(): Promise<void> {
    this.busy = true;
    this.error = "";
    try {
      await this.api.login(this.password);
      this.password = "";
      this.authenticated.emit();
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
    }
  }
}
