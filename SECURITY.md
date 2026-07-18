# Security

Orkestr Lite controls a coding agent and can execute commands in its mounted workspace. Treat access to the web application as equivalent to shell access to that workspace.

## Supported deployment

- Bind port 3000 to loopback by default.
- Put any hosted instance behind authenticated HTTPS.
- Mount only the intended workspace at `/workspace`.
- Never mount the Docker socket or broad host directories.
- Use a disposable workspace and synthetic data for public demonstrations.

The container runs as an unprivileged `orkestr` user. Codex credentials are stored under `/data/codex`; API keys are never stored in Orkestr's SQLite database or returned by its API.

## Reporting

Do not open public issues containing credentials, Codex authentication data, WhatsApp session data, or workspace contents. Report security concerns privately to the repository owner.
