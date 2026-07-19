import { Component, OnInit, signal } from "@angular/core";
import {
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from "@angular/router";
import { ApiService } from "./api.service";
import { LoginComponent } from "./login.component";

@Component({
  selector: "orkestr-root",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LoginComponent],
  template: `
    @if (checkingSession()) {
      <main class="loading-screen">
        <div class="spinner"></div>
        <span>Opening workstation…</span>
      </main>
    } @else if (!authenticated()) {
      <orkestr-login (authenticated)="onAuthenticated()" />
    } @else {
      <div class="app-shell">
        <header class="topbar">
          <a class="brand" routerLink="/chat">
            <span class="brand-mark small">O</span>
            <span>Orkestr Lite</span>
          </a>
          <nav class="desktop-nav" aria-label="Primary navigation">
            <a routerLink="/chat" routerLinkActive="active">Chat</a>
            @if (deskEnabled()) {
              <a routerLink="/desk" routerLinkActive="active">Desk</a>
            }
            <a routerLink="/files" routerLinkActive="active">Files</a>
            <a routerLink="/terminal" routerLinkActive="active">Terminal</a>
            <a routerLink="/timers" routerLinkActive="active">Timers</a>
            <a routerLink="/settings" routerLinkActive="active">Settings</a>
          </nav>
          <button class="quiet" type="button" (click)="logout()">
            Sign out
          </button>
        </header>
        <router-outlet />
        <nav class="mobile-nav" aria-label="Mobile navigation">
          <a routerLink="/chat">Chat</a>
          @if (deskEnabled()) {
            <a routerLink="/desk">Desk</a>
          }
          <a routerLink="/files">Files</a>
          <a routerLink="/terminal">Terminal</a>
          <a routerLink="/timers">Timers</a>
          <a routerLink="/settings">Settings</a>
        </nav>
      </div>
    }
  `,
})
export class AppComponent implements OnInit {
  readonly checkingSession = signal(true);
  readonly authenticated = signal(false);
  readonly deskEnabled = signal(false);

  constructor(
    private readonly api: ApiService,
    private readonly router: Router,
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      const authenticated = await this.api.session();
      this.authenticated.set(authenticated);
      if (authenticated) {
        await Promise.all([this.openFirstRunSetup(), this.loadDeskStatus()]);
      }
    } catch {
      this.authenticated.set(false);
    } finally {
      this.checkingSession.set(false);
    }
  }

  async onAuthenticated(): Promise<void> {
    this.authenticated.set(true);
    await Promise.all([this.openFirstRunSetup(), this.loadDeskStatus()]);
  }

  async logout(): Promise<void> {
    await this.api.logout();
    this.authenticated.set(false);
  }

  private async openFirstRunSetup(): Promise<void> {
    const status = await this.api.get<{ setupCompleted: boolean }>(
      "/api/conversation/status",
    );
    if (!status.setupCompleted) await this.router.navigateByUrl("/setup");
  }

  private async loadDeskStatus(): Promise<void> {
    try {
      const status = await this.api.get<{ enabled: boolean }>(
        "/api/desk/status",
      );
      this.deskEnabled.set(status.enabled);
    } catch {
      this.deskEnabled.set(false);
    }
  }
}
