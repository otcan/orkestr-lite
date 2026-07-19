# Orkestr Lite submission media

This file tracks the Build Week media package and keeps authentic product evidence separate from illustrative artwork.

## Prepared assets

| Asset                                         | Use                           | Disclosure and caption                                                                                                                                                                                                                                               |
| --------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets/submission/devpost-thumbnail.png`     | Devpost 3:2 gallery thumbnail | AI-generated campaign artwork. It represents the persistent mission flow and is not a product screenshot. Alt text: “Orkestr Lite title beside a dark browser workstation showing a three-stage mission flow from intent through code activity to a completed diff.” |
| `assets/submission/setup-ready.png`           | Product gallery               | Authentic capture of the compiled Orkestr Lite setup screen using the deterministic app-server fixture. Caption: “Codex connection and GPT-5.6-family readiness are verified before a mission can start.”                                                            |
| `assets/submission/mission-complete.png`      | Product gallery               | Authentic capture of the compiled mission detail screen using the deterministic app-server fixture. Caption: “A completed mission preserves structured activity, model provenance, workspace diff, and the final response.”                                          |
| `assets/submission/live-mission-complete.png` | Live acceptance evidence      | Sanitized authentic capture of mission `8f23b759-7741-4c19-a1c8-b7936de567e3` using the host's ChatGPT-authenticated account. Caption: “The live Build Week mission completed with `gpt-5.6-sol` recorded as both requested and effective model.”                    |

The fixture screenshots demonstrate the tested product interface. The separate
live capture records the authenticated ORK-373 acceptance run without exposing
the account email or credentials.

Regenerate the authentic screenshots after any intentional interface change:

```bash
npm run media:capture
```

## Final video package

Follow [the demo runbook](../DEMO.md) and target 2:40–2:50. The final public YouTube upload must:

- show the live authenticated GPT-5.6 mission, workspace change, and three passing tests;
- include continuous English narration explaining the product, Codex build workflow, and GPT-5.6 runtime role;
- include accurate English captions;
- show recovery behavior without exposing credentials or private account details;
- contain no unlicensed music, marks, or other third-party material;
- remain publicly visible and embeddable through judging; and
- be checked in a signed-out browser before submission.

## Capture safety

- Use a disposable workspace and the bounded prompt from the runbook.
- Hide passwords, device codes, email addresses, tokens, Codex home contents, and private logs.
- Record at a readable browser zoom and at least 1080p.
- Keep the cursor still when a screen is being explained.
- Cut waiting time transparently; preserve chronological order.
- Discard any take that exposes a credential or personal account detail.

## Remaining owner inputs

- narration recording or approval of an AI-assisted English voiceover;
- YouTube account access and final public URL;
- captions reviewed against the final audio; and
- signed-out confirmation that the video and all gallery assets load.
