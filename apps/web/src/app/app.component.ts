import { Component, HostListener, OnInit, signal } from "@angular/core";
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
          <button
            class="quiet desktop-signout"
            type="button"
            (click)="logout()"
          >
            Sign out
          </button>
          <button
            class="quiet mobile-menu-toggle"
            type="button"
            aria-controls="mobile-navigation"
            [attr.aria-expanded]="mobileMenuOpen()"
            (click)="mobileMenuOpen.set(true)"
          >
            <span class="mobile-menu-icon" aria-hidden="true"></span>
            Menu
          </button>
        </header>
        <router-outlet />
        @if (mobileMenuOpen()) {
          <div class="mobile-menu-backdrop" (click)="closeMobileMenu()">
            <nav
              id="mobile-navigation"
              class="mobile-menu-panel"
              aria-label="Mobile navigation"
              (click)="$event.stopPropagation()"
            >
              <header>
                <div>
                  <p class="eyebrow">Workstation</p>
                  <strong>Navigate Orkestr</strong>
                </div>
                <button
                  class="quiet mobile-menu-close"
                  type="button"
                  aria-label="Close navigation menu"
                  (click)="closeMobileMenu()"
                >
                  ×
                </button>
              </header>
              <div class="mobile-menu-links">
                <a
                  routerLink="/chat"
                  routerLinkActive="active"
                  (click)="closeMobileMenu()"
                >
                  <span class="mobile-menu-glyph">C</span>
                  <span
                    ><strong>Chat</strong
                    ><small>Codex conversation</small></span
                  >
                </a>
                @if (deskEnabled()) {
                  <a
                    routerLink="/desk"
                    routerLinkActive="active"
                    (click)="closeMobileMenu()"
                  >
                    <span class="mobile-menu-glyph">D</span>
                    <span
                      ><strong>Desk</strong
                      ><small>Ubuntu workspace</small></span
                    >
                  </a>
                }
                <a
                  routerLink="/files"
                  routerLinkActive="active"
                  (click)="closeMobileMenu()"
                >
                  <span class="mobile-menu-glyph">F</span>
                  <span
                    ><strong>Files</strong><small>Browse the box</small></span
                  >
                </a>
                <a
                  routerLink="/terminal"
                  routerLinkActive="active"
                  (click)="closeMobileMenu()"
                >
                  <span class="mobile-menu-glyph">T</span>
                  <span
                    ><strong>Terminal</strong
                    ><small>Interactive shell</small></span
                  >
                </a>
                <a
                  routerLink="/timers"
                  routerLinkActive="active"
                  (click)="closeMobileMenu()"
                >
                  <span class="mobile-menu-glyph">S</span>
                  <span
                    ><strong>Timers</strong><small>Scheduled work</small></span
                  >
                </a>
                <a
                  routerLink="/settings"
                  routerLinkActive="active"
                  (click)="closeMobileMenu()"
                >
                  <span class="mobile-menu-glyph">⚙</span>
                  <span
                    ><strong>Settings</strong
                    ><small>Connections and context</small></span
                  >
                </a>
              </div>
              <button
                class="quiet mobile-menu-signout"
                type="button"
                (click)="logout()"
              >
                Sign out
              </button>
            </nav>
          </div>
        }
      </div>
    }
  `,
})
export class AppComponent implements OnInit {
  readonly checkingSession = signal(true);
  readonly authenticated = signal(false);
  readonly deskEnabled = signal(false);
  readonly mobileMenuOpen = signal(false);

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
    this.mobileMenuOpen.set(false);
    await this.api.logout();
    this.authenticated.set(false);
  }

  closeMobileMenu(): void {
    this.mobileMenuOpen.set(false);
  }

  @HostListener("document:keydown.escape")
  closeMobileMenuWithEscape(): void {
    this.closeMobileMenu();
  }

  @HostListener("window:resize")
  closeMobileMenuAboveBreakpoint(): void {
    if (globalThis.innerWidth > 840) this.closeMobileMenu();
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
