# v0.2 publication evidence

The immutable publication record is created only after the tag workflow,
signed-out image verification, public video, and final Devpost submission all
exist. Until then, the absence of `release-evidence-v0.2.json` is intentional;
the checklist must remain incomplete.

Run `npm run submission:record` with the control and Desk digests, workflow and
release URLs, public video URL, and submission confirmation ID/time. The command
resolves the immutable tag SHA itself, copies the untouched demo source SHA, and
refuses to overwrite an existing record. Then run:

```bash
npm run submission:verify -- --published
```

Never edit the generated JSON to make verification pass. Correct the external
evidence or the recording inputs. A source defect after tagging requires a new
patch release; the published tag is never moved.
