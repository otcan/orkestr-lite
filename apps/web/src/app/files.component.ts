import { Component, OnInit, signal } from "@angular/core";
import { ApiService, errorText } from "./api.service";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("yaml", yaml);

interface BoxNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

interface BoxDirectory {
  path: string;
  parent: string | null;
  data: BoxNode[];
}

interface BoxPreview {
  path: string;
  content: string;
  size: number;
  language: string;
}

@Component({
  standalone: true,
  template: `
    <main class="page box-files-page">
      <header class="page-header">
        <div>
          <p class="eyebrow">Files</p>
          <h1>Workstation filesystem</h1>
          <p class="muted">Browse files across the whole container.</p>
        </div>
        <div class="file-preview-actions">
          <label class="primary button-link" [class.disabled]="uploading()">
            <input
              class="attachment-picker"
              type="file"
              multiple
              [disabled]="uploading()"
              (change)="upload($event)"
            />
            {{ uploading() ? "Uploading…" : "Upload files" }}
          </label>
          <button class="quiet" type="button" (click)="refresh()">
            Refresh
          </button>
        </div>
      </header>

      @if (error()) {
        <div class="callout error" role="alert">{{ error() }}</div>
      }

      <section class="panel box-file-browser">
        <div class="box-file-list">
          <div class="box-pathbar">
            <button
              type="button"
              class="quiet"
              [disabled]="!parent()"
              (click)="openParent()"
            >
              ↑ Parent
            </button>
            <span class="mono">{{ currentPath() }}</span>
          </div>
          @if (loading()) {
            <p class="muted file-preview-empty">Loading directory…</p>
          } @else if (!entries().length) {
            <p class="muted file-preview-empty">This directory is empty.</p>
          } @else {
            <ul class="box-file-entries">
              @for (entry of entries(); track entry.path) {
                <li>
                  <button
                    type="button"
                    class="file-entry"
                    [class.directory]="entry.type === 'directory'"
                    [class.active]="selectedNode()?.path === entry.path"
                    (click)="open(entry)"
                  >
                    <span>{{ entry.type === "directory" ? "▸" : "·" }}</span>
                    <span>{{ entry.name }}</span>
                    @if (entry.type === "file") {
                      <small>{{ size(entry.size || 0) }}</small>
                    }
                  </button>
                </li>
              }
            </ul>
          }
        </div>

        <div class="box-file-preview">
          @if (selectedNode(); as node) {
            <div class="file-preview-header">
              <span class="mono">{{ node.path }}</span>
              <div class="file-preview-actions">
                <button
                  class="primary"
                  type="button"
                  [disabled]="!canSend(node) || sending()"
                  (click)="sendToWhatsApp(node)"
                  [title]="
                    canSend(node)
                      ? 'Send this file as a WhatsApp document'
                      : 'Only workspace and Orkestr attachment files can be sent'
                  "
                >
                  {{ sending() ? "Sending…" : "Send to WhatsApp" }}
                </button>
                <a class="quiet button-link" [href]="downloadUrl(node.path)">
                  Download
                </a>
              </div>
            </div>
            @if (selectedFile(); as file) {
              <pre
                class="file-preview"
              ><code [innerHTML]="highlight(file)"></code></pre>
            } @else {
              <div class="file-preview-empty">
                <strong>Preview unavailable.</strong>
                <p class="muted">
                  Binary files can still be downloaded or sent to WhatsApp.
                </p>
              </div>
            }
          } @else {
            <div class="file-preview-empty">
              <strong>Select a file to preview it.</strong>
              <p class="muted">
                Virtual system directories are hidden; regular container files
                remain available.
              </p>
            </div>
          }
        </div>
      </section>
    </main>
  `,
})
export class FilesComponent implements OnInit {
  readonly currentPath = signal("/");
  readonly parent = signal<string | null>(null);
  readonly entries = signal<BoxNode[]>([]);
  readonly selectedFile = signal<BoxPreview | null>(null);
  readonly selectedNode = signal<BoxNode | null>(null);
  readonly loading = signal(false);
  readonly uploading = signal(false);
  readonly sending = signal(false);
  readonly error = signal("");

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    void this.openDirectory("/");
  }

  async open(entry: BoxNode): Promise<void> {
    if (entry.type === "directory") {
      await this.openDirectory(entry.path);
      return;
    }
    this.selectedNode.set(entry);
    this.selectedFile.set(null);
    try {
      this.error.set("");
      this.selectedFile.set(
        await this.api.get<BoxPreview>(
          `/api/workspace/box/file?path=${encodeURIComponent(entry.path)}`,
        ),
      );
    } catch (error) {
      // Text preview is optional; regular files remain downloadable/sendable.
    }
  }

  canSend(entry: BoxNode): boolean {
    return (
      entry.type === "file" &&
      (entry.path === "/workspace" ||
        entry.path.startsWith("/workspace/") ||
        entry.path === "/data/attachments" ||
        entry.path.startsWith("/data/attachments/"))
    );
  }

  async sendToWhatsApp(entry: BoxNode): Promise<void> {
    if (!this.canSend(entry)) return;
    this.sending.set(true);
    this.error.set("");
    try {
      await this.api.post("/api/whatsapp/files", { path: entry.path });
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.sending.set(false);
    }
  }

  async openParent(): Promise<void> {
    const parent = this.parent();
    if (parent) await this.openDirectory(parent);
  }

  async refresh(): Promise<void> {
    await this.openDirectory(this.currentPath());
  }

  async upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []).slice(0, 5);
    if (!files.length) return;
    this.uploading.set(true);
    this.error.set("");
    try {
      const form = new FormData();
      for (const file of files) form.append("files", file, file.name);
      await this.api.post(
        `/api/workspace/box/upload?path=${encodeURIComponent(this.currentPath())}`,
        form,
      );
      await this.openDirectory(this.currentPath());
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      input.value = "";
      this.uploading.set(false);
    }
  }

  downloadUrl(path: string): string {
    return `/api/workspace/box/download?path=${encodeURIComponent(path)}`;
  }

  highlight(file: BoxPreview): string {
    if (hljs.getLanguage(file.language)) {
      return hljs.highlight(file.content, { language: file.language }).value;
    }
    return escapeHtml(file.content);
  }

  size(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }

  private async openDirectory(path: string): Promise<void> {
    this.loading.set(true);
    this.error.set("");
    try {
      const result = await this.api.get<BoxDirectory>(
        `/api/workspace/box/files?path=${encodeURIComponent(path)}`,
      );
      this.currentPath.set(result.path);
      this.parent.set(result.parent);
      this.entries.set(result.data);
      this.selectedFile.set(null);
      this.selectedNode.set(null);
    } catch (error) {
      this.error.set(errorText(error));
    } finally {
      this.loading.set(false);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
