import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RUNTIME_CONFIG } from "../config/config.module.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { migrations } from "./migrations.js";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private connection: Database.Database | null = null;

  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig) {}

  get db(): Database.Database {
    if (!this.connection) throw new Error("Database has not been initialized");
    return this.connection;
  }

  onModuleInit(): void {
    mkdirSync(dirname(this.config.databasePath), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(this.config.codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(this.config.workspace, { recursive: true, mode: 0o750 });

    const db = new Database(this.config.databasePath);
    this.connection = db;
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    this.applyMigrations();
    this.logger.log(`SQLite ready at ${this.config.databasePath}`);
  }

  onModuleDestroy(): void {
    this.connection?.close();
    this.connection = null;
  }

  ping(): boolean {
    return this.db.prepare("SELECT 1 AS ok").get() !== undefined;
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  private applyMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      (
        this.db
          .prepare("SELECT version FROM schema_migrations")
          .all() as Array<{ version: number }>
      ).map((row) => row.version),
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, new Date().toISOString());
      })();
      this.logger.log(
        `Applied migration ${migration.version}: ${migration.name}`,
      );
    }
  }
}
