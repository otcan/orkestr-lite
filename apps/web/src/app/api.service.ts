import { HttpClient, HttpHeaders } from "@angular/common/http";
import { Injectable } from "@angular/core";
import type { CreateMissionInput, MissionRecord } from "@orkestr/shared";
import { firstValueFrom } from "rxjs";

@Injectable({ providedIn: "root" })
export class ApiService {
  private csrfToken: string | null = null;

  constructor(private readonly http: HttpClient) {}

  async session(): Promise<boolean> {
    const result = await firstValueFrom(
      this.http.get<{ authenticated: boolean; csrfToken: string | null }>(
        "/api/auth/session",
      ),
    );
    this.csrfToken = result.csrfToken;
    return result.authenticated;
  }

  async login(password: string): Promise<void> {
    const result = await firstValueFrom(
      this.http.post<{ csrfToken: string }>("/api/auth/login", { password }),
    );
    this.csrfToken = result.csrfToken;
  }

  async logout(): Promise<void> {
    await firstValueFrom(
      this.http.post<void>("/api/auth/logout", {}, this.mutationOptions()),
    );
    this.csrfToken = null;
  }

  get<T>(path: string): Promise<T> {
    return firstValueFrom(this.http.get<T>(path));
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return firstValueFrom(
      this.http.post<T>(path, body, this.mutationOptions()),
    );
  }

  createMission(input: CreateMissionInput): Promise<MissionRecord> {
    return this.post<MissionRecord>("/api/missions", input);
  }

  private mutationOptions(): { headers: HttpHeaders } {
    return {
      headers: this.csrfToken
        ? new HttpHeaders({ "x-orkestr-csrf": this.csrfToken })
        : new HttpHeaders(),
    };
  }
}

export function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as {
      error?: { message?: string | string[] };
      message?: string;
    };
    const message = candidate.error?.message ?? candidate.message;
    if (Array.isArray(message)) return message.join(", ");
    if (typeof message === "string") return message;
  }
  return String(error);
}
