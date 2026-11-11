<!--
Read CONTRIBUTING-FORK.md and docs/MAUSBOT-VALIDATION.md.
Keep one focused outcome per PR; record pending checks without claiming success.
-->

## What changed

## Why

Acceptance scope:
Data/migration dependencies (or not applicable):
Deferred work, owner and next action (or none):

## How it was verified

<!-- commands run, platforms tested on, what you clicked through -->

QA-Handoff: <40-character current head SHA>

Local checks and duration:
Pending UI/package evidence and owner:
Original task start / first coherent candidate / review request (with timezone):
Implementation, check/build and waiting time (note overlap; retain retry time):

## Screenshots (UI changes)

<!-- before/after images; video for anything animated -->

## Checklist

- [ ] `check:ready` receipt or affected correction evidence is recorded for this source
- [ ] Current-head required CI passes before merge; broader pending checks are stated
- [ ] Server behavior changes come with tests (see CONTRIBUTING.md → Tests)
- [ ] No `dist-server/` edits (it's build output)
- [ ] macOS-only code is platform-gated; no `shell: true` / cmd.exe string-building
- [ ] No secrets in logs, responses, events, or argv
