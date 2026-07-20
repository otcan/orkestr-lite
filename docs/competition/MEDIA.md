# v0.2 submission media

All product captures must come from the compiled v0.2 product and the authentic
research run. Sanitize administrator passwords, device codes, QR codes, account
email, phone number, personal inbox data, tokens, and unrelated workspace files.

Required captures under `assets/submission/v0.2/`:

| File                  | Authentic content                                                                 |
| --------------------- | --------------------------------------------------------------------------------- |
| `setup.png`           | Workstation setup with Codex connected and sensitive identity removed             |
| `chat.png`            | One conversation, GPT-5.6/effort/YOLO toolbar, research activity and control code |
| `desk-report.png`     | Generated HTML research report open in the real Ubuntu Desk browser               |
| `files.png`           | Whole-container Files view showing the two report artifacts                       |
| `timers.png`          | Weekly watch, schedule preview, and completed Run-now state                       |
| `whatsapp.png`        | Sanitized linked self-chat follow-up and returned Markdown document               |
| `report-complete.png` | Completed cited report response and GPT-5.6 provenance                            |

`hero-montage.png` may be assembled only from those sanitized authentic
captures. Do not use generated UI, mock data, the deterministic clamp fixture,
or an old mission-centric screenshot in the v0.2 montage.

The video must disclose visible jump cuts for live research latency, show the
official source URLs, and keep chronological execution truthful. Re-record any
take that exposes a credential or private WhatsApp content.

Raw WhatsApp captures and narration belong under ignored `demo/private/` paths.
`npm run demo:capture` requires the phone capture to be cropped, redacted with
black rectangles, or explicitly approved as already sanitized. The derived
`whatsapp.png` still requires human inspection before commit. QR codes, linked
device codes, phone numbers, names, unrelated messages, and notification chrome
must not remain readable.

Build the montage with `npm run demo:montage` and the narrated draft with
`npm run demo:video`. The latter reads `ORKESTR_NARRATION`, adds an authenticity
and jump-cut disclosure to every scene, normalizes audio, and rejects a duration
of 179 seconds or longer.
