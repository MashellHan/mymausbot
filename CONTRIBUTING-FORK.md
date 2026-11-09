# Personal repository workflow

This standalone repository (`fork=false`) preserves upstream licensing and history.
`origin` is `MashellHan/mymausbot`; `upstream` tracks read-only
`milind-soni/OpenMausBot`. `legacy-fork` names the former
`MashellHan/openmausbot` repository, whose PR, issue, review and CI links are
historical. Never push to `upstream` or `legacy-fork`.

The product name is exactly lowercase `mymausbot`, including desktop bundles,
window titles and phone installation metadata. Updates come from
`MashellHan/mymausbot`. Keep existing application IDs, data paths, pairing and
protocol identifiers compatible, and preserve upstream attribution during sync.

- Commit each coherent, working slice with a message describing behavior and
  purpose. Keep useful checkpoints; do not split changes just to inflate counts.
- Use one focused feature branch and PR per reviewable outcome. Open drafts
  early for visibility, then mark ready with evidence when the slice works.
- Lead owns every open PR, including drafts. Twelve hours without observed
  activity and twenty-four hours open are advisory process-scan targets. Record
  the blocker, owner and next action; continue required review/checks and retain
  useful work. Never close, cancel, roll back or repeat checks solely for a clock.
- Close a PR only for a substantive disposition, with the successor or product
  decision recorded. If a process rule caused a mistaken closure, record the
  PR, branch/head, evidence, reason and recovery owner. Reopen useful unadopted
  work on the same PR or link verified adoption through another PR. Assign
  pipeline/test improvements at available capacity and keep recovery visible.
- Preserve meaningful commits when integrating. No routine squash, force-push,
  history rewriting or unreviewed direct changes to the default branch.
- Run required hooks and checks. Test the changed contract meaningfully, then
  broaden only for new risk, failures or required repository checks.
- PR descriptions lead with the problem and resulting behavior, then validation
  and material limits. Include UI evidence and the exact reviewed commit.
- Write every PR title, description and comment in English only, with no Chinese
  text. Code comments must also be in English.
- Request Reviewer as soon as checks pass; independent next work proceeds in
  parallel. Batch actionable findings; fix once, rerun affected checks and review
  the delta. Avoid serial reviews of unchanged commits or style-only ping-pong.
- Lead resolves routine scope decisions, verifies acceptance and reports PR
  links. A review is complete only with actual findings/approval, not a submitted
  prompt. No skipped checks, invented passes or automatic approval by timeout.
- The user has authorized reviewed merges into the personal repository. Lead
  decides merge order and merges only after Reviewer has no unresolved findings
  and required checks pass. Create PRs and push feature branches only to
  verified `origin` at `MashellHan/mymausbot`.
- Old `MashellHan/openmausbot` PR and issue numbers are historical. Use the
  authoritative migration mapping for new numbers; do not infer them from old links.
- For upstream sync, record exact source SHAs and any new upstream commit range.
  If there are no new commits or pending integration changes, record the check
  without an empty commit or PR. Daily sync does not replace the live App.
- Keep credentials, raw conversations, machine-private data and build products
  out of version control. Use placeholders for local conversation/task paths
  and automation identifiers; keep their actual values in local handoff records.
  Preserve the user's untracked research files.
