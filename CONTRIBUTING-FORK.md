# Personal fork workflow

This fork preserves upstream licensing and history. `upstream` tracks
milind-soni/OpenMausBot; `origin` is MashellHan/openmausbot. Never push to upstream.

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
- Request Reviewer as soon as checks pass; independent next work proceeds in
  parallel. Batch actionable findings; fix once, rerun affected checks and review
  the delta. Avoid serial reviews of unchanged commits or style-only ping-pong.
- Lead resolves routine scope decisions, verifies acceptance and reports PR
  links. A review is complete only with actual findings/approval, not a submitted
  prompt. No skipped checks, invented passes or automatic approval by timeout.
- Merge requires user authorization or an applicable established project policy.
  PR creation and feature-branch pushes were explicitly requested for this work.
- Keep credentials, raw conversations, machine-private data and build products
  out of version control. Preserve the user's untracked research files.
