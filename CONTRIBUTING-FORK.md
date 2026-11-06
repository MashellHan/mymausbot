# Personal repository workflow

This standalone repository (`fork=false`) preserves upstream licensing and history.
The canonical destination for new work is `MashellHan/mymausbot`; `upstream` tracks
read-only `milind-soni/OpenMausBot`. `MashellHan/openmausbot` holds historical PR,
issue, review and CI records. Root alone switches shared `origin`, config, QA and
Actions. Neither repository receives new writes until Root explicitly releases the
cutover; afterward, verify `origin` points to `MashellHan/mymausbot` before pushing.

- Commit each coherent, working slice with a message describing behavior and
  purpose. Keep useful checkpoints; do not split changes just to inflate counts.
- Use one focused feature branch and PR per reviewable outcome. Open drafts
  early for visibility, then mark ready with evidence when the slice works.
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
- The user has authorized reviewed merges into the personal repository after
  Root releases the cutover. Lead decides merge order and merges only after
  Reviewer has no unresolved findings and required checks pass. Create PRs
  and push feature branches only to
  `MashellHan/mymausbot` after that release; never push to upstream or the old repository.
- Old `MashellHan/openmausbot` PR and issue numbers are historical. Use Root's
  migration mapping for new numbers; do not infer them from old links.
- For upstream sync, record exact source SHAs and any new upstream commit range.
  If there are no new commits or pending integration changes, record the check
  without an empty commit or PR. Daily sync does not replace the live App.
- Keep credentials, raw conversations, machine-private data and build products
  out of version control. Use placeholders for local conversation/task paths
  and automation identifiers; keep their actual values in local handoff records.
  Preserve the user's untracked research files.
