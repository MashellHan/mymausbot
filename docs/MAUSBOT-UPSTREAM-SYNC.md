# Upstream synchronization

The user's assistant owns the existing daily 09:00 Asia/Shanghai schedule.
The upstream developer checks the personal repository when that schedule runs; no
second scheduler is needed.

After Root explicitly releases the repository cutover, new writes target
`MashellHan/mymausbot`. Root alone verifies and switches shared `origin`, config,
QA and Actions. The old `MashellHan/openmausbot` PR, review and CI links remain
historical; use Root's mapping for new PR and issue numbers. Upstream remains
read-only. While the migration freeze is active, do not fetch or publish.

1. Verify the personal GitHub identity and canonical `origin`, then inspect
   existing sync branches and PRs. Fetch `origin/main` and the upstream default
   branch. Record their exact SHAs and the upstream commits absent from
   `origin/main`.
2. If there are no new upstream commits and no pending integration changes,
   record the check without creating an empty commit or PR. A feature stack
   behind `origin/main` is a real integration change even when both remotes
   already point to the same upstream commit.
3. Integrate in an isolated worktree with normal commits that preserve the
   accepted feature history. Read both contracts at every conflict. Preserve
   Agent Team, Usage, sections, quoted replies, user data, pairing, and access
   boundaries.
4. Run required hooks and meaningful affected tests on the integrated tree.
   Give Reviewer the exact commit, tree, source range, resolutions, and test
   evidence. Address findings and request a delta review of corrections.
5. Lead decides the merge order and merges into the personal repository only when
   Reviewer has no unresolved findings and required checks pass.
   Escalate uncertain product choices through Lead. Never push to upstream.

Daily synchronization does not automatically replace the running desktop App.
