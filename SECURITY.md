# Security

Orkestr Lite controls a coding agent and can execute commands in its mounted workspace. Treat access to the web application as equivalent to shell access to that workspace.

## Supported deployment

- Bind port 3000 to loopback by default.
- Put any hosted instance behind authenticated HTTPS and set `ORKESTR_COOKIE_SECURE=true`.
- Mount only the intended workspace at `/workspace`.
- Never mount the Docker socket or broad host directories.
- Use a disposable workspace and synthetic data for public demonstrations.

The default Compose service runs as an unprivileged `orkestr` user, drops Linux capabilities, and enables `no-new-privileges`. Codex credentials are stored under `/data/codex`; API keys are never stored in Orkestr's SQLite database or returned by its API. Data directories use owner-only permissions and API responses are marked `no-store`.

Explicit administrator passwords must contain 12–512 characters. If none is supplied, Orkestr generates a high-entropy password on first boot and prints it once to the local container logs.

Orkestr stores mission prompts, activity, command output, diffs, and final responses in SQLite. Do not use secrets in prompts, and treat both persistent volumes as sensitive. Signing out revokes all outstanding Orkestr Lite sessions for this single-user instance.

## Reporting

Do not open public issues containing credentials, Codex authentication data, WhatsApp session data, or workspace contents. Report security concerns privately to the repository owner.
