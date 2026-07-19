import { Component } from "@angular/core";
import { TerminalComponent } from "./terminal.component";

@Component({
  standalone: true,
  imports: [TerminalComponent],
  template: `
    <main class="page terminal-page">
      <header class="page-header">
        <div>
          <p class="eyebrow">Terminal</p>
          <h1>Workstation shell</h1>
          <p class="muted">A live shell inside the Orkestr container.</p>
        </div>
      </header>
      <orkestr-terminal />
    </main>
  `,
})
export class TerminalPageComponent {}
