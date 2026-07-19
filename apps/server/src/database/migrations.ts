export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('web', 'whatsapp', 'timer', 'demo')),
        workspace TEXT NOT NULL,
        codex_thread_id TEXT,
        codex_turn_id TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'starting', 'running', 'awaiting_approval',
          'completed', 'failed', 'interrupted', 'cancelled'
        )),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        latest_progress_summary TEXT,
        final_response TEXT,
        error TEXT,
        timer_id TEXT,
        requested_model TEXT,
        effective_model TEXT,
        interruption_metadata_json TEXT,
        recovery_metadata_json TEXT
      );

      CREATE INDEX missions_status_created_idx ON missions(status, created_at);
      CREATE INDEX missions_thread_idx ON missions(codex_thread_id);

      CREATE TABLE mission_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX mission_events_mission_id_idx ON mission_events(mission_id, id);

      CREATE TABLE timers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_kind TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        timezone TEXT NOT NULL,
        next_run_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_mission_id TEXT REFERENCES missions(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE whatsapp_outbound_messages (
        message_id TEXT PRIMARY KEY,
        mission_id TEXT REFERENCES missions(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE terminal_sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
    `,
  },
  {
    version: 2,
    name: "connected_workspace_features",
    sql: `
      CREATE TABLE whatsapp_messages (
        message_id TEXT PRIMARY KEY,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        turn_id TEXT REFERENCES missions(id),
        source TEXT,
        body_preview TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX whatsapp_messages_created_idx
        ON whatsapp_messages(created_at DESC);

      CREATE TABLE timer_runs (
        id TEXT PRIMARY KEY,
        timer_id TEXT NOT NULL REFERENCES timers(id) ON DELETE CASCADE,
        scheduled_for TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('claimed', 'queued', 'missed', 'failed')),
        turn_id TEXT REFERENCES missions(id),
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(timer_id, scheduled_for)
      );

      CREATE INDEX timer_runs_timer_idx ON timer_runs(timer_id, scheduled_for DESC);

      ALTER TABLE terminal_sessions ADD COLUMN last_active_at TEXT;
      ALTER TABLE terminal_sessions ADD COLUMN exit_code INTEGER;

      CREATE TABLE terminal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX terminal_events_session_idx
        ON terminal_events(session_id, id);
    `,
  },
  {
    version: 3,
    name: "reliable_conversation_bridge",
    sql: `
      ALTER TABLE missions ADD COLUMN enqueue_sequence INTEGER;
      ALTER TABLE missions ADD COLUMN ingress_key TEXT;
      UPDATE missions SET enqueue_sequence = rowid WHERE enqueue_sequence IS NULL;
      CREATE UNIQUE INDEX missions_enqueue_sequence_idx ON missions(enqueue_sequence);
      CREATE UNIQUE INDEX missions_source_ingress_idx
        ON missions(source, ingress_key) WHERE ingress_key IS NOT NULL;

      ALTER TABLE whatsapp_messages ADD COLUMN batch_id TEXT;
      ALTER TABLE whatsapp_messages ADD COLUMN attachment_id TEXT;
      ALTER TABLE whatsapp_messages ADD COLUMN updated_at TEXT;
      UPDATE whatsapp_messages SET updated_at = created_at WHERE updated_at IS NULL;

      CREATE TABLE whatsapp_callbacks (
        message_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      );

      CREATE TABLE whatsapp_batches (
        id TEXT PRIMARY KEY,
        enqueue_sequence INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('open', 'queued', 'rejected')),
        due_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        turn_id TEXT REFERENCES missions(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX whatsapp_batches_due_idx ON whatsapp_batches(status, due_at);

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        turn_id TEXT REFERENCES missions(id),
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        original_name TEXT NOT NULL,
        storage_path TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX attachments_expiry_idx ON attachments(pinned, expires_at);
      CREATE INDEX attachments_turn_idx ON attachments(turn_id);

      CREATE TABLE whatsapp_outbox (
        id TEXT PRIMARY KEY,
        turn_id TEXT REFERENCES missions(id),
        attachment_id TEXT REFERENCES attachments(id),
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'media')),
        body TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent_unconfirmed', 'acknowledged', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        remote_message_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(turn_id, ordinal, kind)
      );

      CREATE INDEX whatsapp_outbox_due_idx ON whatsapp_outbox(status, next_attempt_at);
      CREATE UNIQUE INDEX whatsapp_outbox_remote_idx
        ON whatsapp_outbox(remote_message_id) WHERE remote_message_id IS NOT NULL;

      CREATE TABLE conversation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX conversation_events_created_idx ON conversation_events(id);
    `,
  },
  {
    version: 4,
    name: "mission_reasoning_effort",
    sql: `
      ALTER TABLE missions ADD COLUMN requested_reasoning_effort TEXT;
    `,
  },
  {
    version: 5,
    name: "whatsapp_inbox_bridge",
    sql: `
      CREATE TABLE whatsapp_inbox_messages (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        body TEXT NOT NULL,
        has_media INTEGER NOT NULL DEFAULT 0,
        message_at TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );

      CREATE INDEX whatsapp_inbox_message_at_idx
        ON whatsapp_inbox_messages(message_at DESC);
      CREATE INDEX whatsapp_inbox_sender_name_idx
        ON whatsapp_inbox_messages(sender_name, message_at DESC);
    `,
  },
];
