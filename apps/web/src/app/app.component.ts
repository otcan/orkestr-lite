import { Component, OnInit } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { ApiService } from "./api.service";
import { LoginComponent } from "./login.component";

@Component({
  selector: "orkestr-root",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LoginComponent],
  template: `
    @if (checkingSession) {
      <main class="loading-screen">
        <div class="spinner"></div>
        <span>Opening workstation…</span>
      </main>
    } @else if (!authenticated) {
      <orkestr-login (authenticated)="onAuthenticated()" />
    } @else {
      <div class="app-shell">
        <header class="topbar">
          <a class="brand" routerLink="/missions">
            <span class="brand-mark small">O</span>
            <span>Orkestr Lite</span>
          </a>
          <nav aria-label="Primary navigation">
            <a routerLink="/missions" routerLinkActive="active">Missions</a>
            <a routerLink="/setup" routerLinkActive="active">Setup</a>
          </nav>
          <button class="quiet" type="button" (click)="logout()">
            Sign out
          </button>
        </header>
        <router-outlet />
      </div>
    }
  `,
})
export class AppComponent implements OnInit {
  checkingSession = true;
  authenticated = false;

  constructor(private readonly api: ApiService) {}

  async ngOnInit(): Promise<void> {
    try {
      this.authenticated = await this.api.session();
    } catch {
      this.authenticated = false;
    } finally {
      this.checkingSession = false;
    }
  }

  onAuthenticated(): void {
    this.authenticated = true;
  }

  async logout(): Promise<void> {
    await this.api.logout();
    this.authenticated = false;
  }
}
