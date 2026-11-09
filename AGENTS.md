# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

## Validation and delivery entry point

Read `docs/MAUSBOT-VALIDATION.md` from the task's current checkout before choosing
checks. Start new source tasks from freshly fetched `origin/main` in an isolated
worktree. Preserve an older dirty coordination checkout; if its policy is absent,
read `git show origin/main:docs/MAUSBOT-VALIDATION.md` and the current playbook
before proceeding. A missing file in that checkout is not a missing policy.

- Use `pnpm check:plan`, `pnpm check:edit` and one `pnpm check:ready` for handoff.
  Global typecheck belongs in CI. When a local type check is necessary, use
  `pnpm typecheck --project ui` or `--project server`; it revalidates compiler
  state in this worktree. `pnpm build` includes typecheck, so do not prefix it
  with another identical check. Retain the normal push hook.
- Freeze a coherent source candidate and start review/CI alongside remaining
  isolated UI acceptance. Pending evidence stays pending; only changed inputs,
  findings or a failed check justify another check/review of that scope.
- Run `pnpm check:fixtures` before running a new or edited Electron fixture.
  Reuse its existing async entry, scoped selectors and bounded phase waits.
- One owner builds and updates the App. Follow `docs/MAUSBOT-LOCAL-RUNBOOK.md`:
  run `check:delivery request` before building, retain package/startup checks,
  and reuse `check:delivery routines` / `inventory` for their preservation checks.
  Those read-only checks grant no live mutation or test waiver.
- Route nonblocking corrections through Lead in one batch at a safe boundary.
  Keep cleanup, unrelated QA and new features outside the active delivery.

## Process targets

Timing, PR age and handoff/triage deadlines are advisory process-scan criteria.
They must not fail a quality gate, invalidate a successful check, close a useful
PR or cancel delivery. Record and assign optimization/recovery work through Lead;
retain actual validation failures, source binding and data/security decisions.
Recover useful mistakenly closed PRs or link verified adoption through another
PR, preserving source and review/check history.

## Comments

Write a comment only for what the code cannot say:

- a license or attribution notice;
- a fact forced by something outside this code (a vendor, CLI, OS, browser,
  Electron or protocol behaviour), with its version when it has one;
- the doc comment of a public contract: the wire types in `shared/`, the
  driver interface, the preload bridge, `config.json` fields people edit;
- a link to an upstream issue;
- a security invariant or a known open risk.

Do not narrate what the next line does, restate a name, record history ("used
to", "no longer", PR or issue numbers, plan or slice names: git has it), point
at other files, draw banners or leave commented-out code. When our own code
needs a paragraph to explain a surprise, change the code instead: a better
name, a type, an extracted function, one shared helper. A rule ("never X",
"must match Y") belongs in a type, a test or a lint rule. Never suppress a lint
rule that guards correctness; fix the code.

More specific `AGENTS.md` files override this note within their directories.

## MausBot repository team

Read `.agents/team/playbook.md` and the assigned role in `.agents/team/roles/`.
The dedicated Herdr team owns this repository. Its lead and reviewer use
`gpt-6-astra` with `max`; designer, frontend and backend use `gpt-6-sol`
with `xhigh` and a requested 1,000,000-token context. The upstream integration
developer uses the same Sol settings. Never silently substitute a model or claim
a runtime configuration was verified from a role file alone.
Use small coherent commits and focused PRs as described in `CONTRIBUTING-FORK.md`.
