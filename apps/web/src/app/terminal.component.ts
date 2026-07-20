import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  signal,
} from "@angular/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { ApiService, errorText } from "./api.service";

interface TerminalSession {
  id: string;
  status: string;
  websocketToken: string;
}

@Component({
  selector: "orkestr-terminal",
  standalone: true,
  template: `
    <section class="terminal-shell">
      <div class="terminal-toolbar">
        <span class="terminal-status" [class.ready]="connected()">
          {{ connected() ? "Connected" : status() }}
        </span>
        <div>
          <button type="button" class="quiet terminal-button" (click)="copy()">
            Copy
          </button>
          <button type="button" class="quiet terminal-button" (click)="paste()">
            Paste
          </button>
          @if (!connected()) {
            <button
              type="button"
              class="quiet terminal-button"
              (click)="reconnect()"
            >
              Reconnect
            </button>
          }
          <button
            type="button"
            class="quiet terminal-button"
            (click)="restart()"
          >
            Restart
          </button>
        </div>
      </div>
      <div
        #terminalHost
        class="terminal-host"
        aria-label="Workspace terminal"
      ></div>
      @if (error()) {
        <p class="terminal-error">{{ error() }}</p>
      }
    </section>
  `,
})
export class TerminalComponent implements AfterViewInit, OnDestroy {
  @ViewChild("terminalHost", { static: true })
  host!: ElementRef<HTMLDivElement>;
  readonly connected = signal(false);
  readonly status = signal("Connecting…");
  readonly error = signal("");
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private socket: WebSocket | null = null;
  private session: TerminalSession | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly api: ApiService) {}

  ngAfterViewInit(): void {
    this.terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#090d0b",
        foreground: "#eef3f0",
        cursor: "#9af6c4",
        selectionBackground: "#305844",
      },
      scrollback: 10_000,
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.host.nativeElement);
    this.terminal.onData((data) => this.send({ type: "input", data }));
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.host.nativeElement);
    queueMicrotask(() => {
      this.fit();
      void this.connect();
    });
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.socket?.close();
    this.terminal?.dispose();
  }

  async restart(): Promise<void> {
    if (!this.session) return;
    try {
      this.status.set("Restarting…");
      this.session = await this.api.post<TerminalSession>(
        `/api/terminal/${this.session.id}/restart`,
      );
      this.socket?.close();
      this.terminal?.clear();
      this.openSocket(this.session);
    } catch (error) {
      this.error.set(errorText(error));
    }
  }

  async reconnect(): Promise<void> {
    this.socket?.close();
    await this.connect();
  }

  async copy(): Promise<void> {
    const selected = this.terminal?.getSelection() ?? "";
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected);
    } catch {
      this.error.set("Clipboard access was denied");
    }
  }

  async paste(): Promise<void> {
    try {
      const value = await navigator.clipboard.readText();
      if (value) this.send({ type: "input", data: value });
    } catch {
      this.error.set("Clipboard access was denied");
    }
  }

  private async connect(): Promise<void> {
    try {
      this.error.set("");
      this.session = await this.api.post<TerminalSession>("/api/terminal");
      this.openSocket(this.session);
    } catch (error) {
      this.status.set("Unavailable");
      this.error.set(errorText(error));
    }
  }

  private openSocket(session: TerminalSession): void {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const path = `/api/terminal/${session.id}?token=${encodeURIComponent(session.websocketToken)}`;
    const socket = new WebSocket(`${protocol}//${location.host}${path}`);
    this.socket = socket;
    socket.onopen = () => {
      this.connected.set(true);
      this.status.set("Connected");
      this.fit();
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type === "ready") {
        const scrollback =
          typeof message.scrollback === "string" ? message.scrollback : "";
        if (scrollback) this.terminal?.write(scrollback);
      } else if (
        message.type === "output" &&
        typeof message.data === "string"
      ) {
        this.terminal?.write(message.data);
      } else if (message.type === "exit") {
        this.connected.set(false);
        this.status.set("Exited");
      } else if (message.type === "error") {
        this.error.set(String(message.message || "Terminal error"));
      }
    };
    socket.onerror = () => this.error.set("Terminal connection failed");
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.connected.set(false);
      if (this.status() === "Connected") this.status.set("Disconnected");
    };
  }

  private fit(): void {
    try {
      this.fitAddon?.fit();
      if (this.terminal) {
        this.send({
          type: "resize",
          cols: this.terminal.cols,
          rows: this.terminal.rows,
        });
      }
    } catch {
      // The tab can briefly have zero dimensions while it is being revealed.
    }
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
