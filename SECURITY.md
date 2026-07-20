# Security

## Supported boundary

Orkestr Lite v0.2 is a single-user local workstation. Compose publishes only
`127.0.0.1:3000`; it does not intentionally expose a service online. Do not
forward the port, deploy it as a public site, or treat its local HTTP endpoints
as a public automation API.

The browser uses an HTTP-only same-site session cookie plus CSRF tokens for
writes. Login is rate limited and sign-out revokes all sessions for this local
instance. Responses containing product state are `no-store`. Codex credentials
live under `/codex` and are not copied into SQLite or browser responses.

## Container trust boundaries

The control and Ubuntu Desk containers start as the unprivileged `orkestr` user.
Because Orkestr Lite is a single-user YOLO workstation, that user has explicit
passwordless `sudo` inside both containers. Compose therefore retains Docker's
standard capability set and permits privilege elevation; these containers must
not be treated as sandboxes for hostile code. The Docker socket is not mounted,
only port 3000 is published, and Desk agent, VNC, and Codex app-server traffic
remain private to the Compose network. Control→Desk requests require a secret
file from an owner-only shared volume. A browser VNC upgrade additionally
requires an authenticated Orkestr session, same origin, and a one-use ticket
that expires after 60 seconds.

YOLO/full access is the default inside the isolated workstation. Codex can read
and modify the mounted workspace, use network access, operate the visible Desk,
run installed tools, and elevate to container root. This is the core product
contract, not a security sandbox for hostile prompts. Use a disposable
workspace for untrusted work, review external side effects, and keep secrets out
of prompts and files Codex does not need.

## Stored data

Treat all persistent volumes as sensitive:

- `/data`: SQLite, settings, WhatsApp session/batches/outbox/inbox, attachment
  metadata and media;
- `/codex`: Codex authentication and app-server state;
- `/workspace`: user files, reports, and the private WhatsApp inbox snapshot;
- Desk home: XFCE and Chromium profile/state;
- Desk auth: the private control token.

SQLite and private directories are created with owner-only modes. WhatsApp
inbound filenames are sanitized, decoded sizes are capped at 25 MB, content is
hashed and never executed automatically, and writes are atomic. Unpinned bytes
expire after 30 days while metadata remains. Outbound files are resolved through
real paths, restricted to allowed roots, checked against symlink escape, and
sent as documents to preserve names.

WhatsApp commands work only in the linked account’s self-chat and must match the
entire message. Other direct chats are read-only local inbox data; groups and
status broadcasts are not imported. Delivery is at least once, which can
produce a rare duplicate but avoids silent loss.

## Reporting vulnerabilities

Do not open a public issue for a credential or exploitable vulnerability. Use
GitHub’s private security-advisory channel for `otcan/orkestr-lite` and include
the affected tag, reproduction steps, and impact. Rotate any credential that
may have appeared in logs or captures.
