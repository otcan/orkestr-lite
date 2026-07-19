import { JsonPipe } from "@angular/common";
import { Component, OnInit, signal } from "@angular/core";
import { ApiService, errorText } from "./api.service";

@Component({
  standalone: true,
  imports: [JsonPipe],
  template: `
    <main class="page narrow">
      <header class="page-header">
        <div>
          <p class="eyebrow">Diagnostics</p>
          <h1>Runtime state</h1>
        </div>
      </header>
      @if (error()) {
        <div class="callout error">{{ error() }}</div>
      }
      <section class="panel diagnostics-raw">
        <pre>{{ data() | json }}</pre>
      </section>
    </main>
  `,
})
export class DiagnosticsComponent implements OnInit {
  readonly data = signal<unknown>({});
  readonly error = signal("");
  constructor(private readonly api: ApiService) {}
  async ngOnInit(): Promise<void> {
    try {
      const [conversation, setup, whatsapp] = await Promise.all([
        this.api.get("/api/conversation/status"),
        this.api.get("/api/setup/status"),
        this.api.get("/api/setup/whatsapp/status"),
      ]);
      this.data.set({ conversation, setup, whatsapp });
    } catch (error) {
      this.error.set(errorText(error));
    }
  }
}
