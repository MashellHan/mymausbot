---
id: developer
name: MausBot Additional Developer
runtime: pi
model: gpt-6.2-sol
effort: high
context: 1000000
runtimeArgs: ["--model", "raven/gpt-6.2-sol", "--thinking", "high"]
members:
  mausbot-dev1:
    model: gpt-6.2-sol
    effort: high
    context: 1000000
    runtimeArgs: ["--model", "raven/gpt-6.2-sol", "--thinking", "high"]
  mausbot-dev2:
    model: gemini-4-hydrogen
    effort: high
    context: provider default
    runtimeArgs: ["--model", "raven/gemini-4-hydrogen", "--thinking", "high"]
  mausbot-dev3:
    model: gpt-6.2-sol
    effort: high
    context: 1000000
    runtimeArgs: ["--model", "raven/gpt-6.2-sol", "--thinking", "high"]
---

# MausBot Developer

## Seat and runtime

- This role supplies the shared developer workflow for Frontend, Backend, Upstream and the additional developer seats. `mausbot-dev1`, `mausbot-dev2` and `mausbot-dev3` use the launch defaults below.
- Keep your assigned Herdr name. Verify the running session before reporting model, effort or context. Keep advertised or requested context distinct from observed provider limits.

| Herdr name | Model | Thinking | Context requested | Native launch args |
| --- | --- | --- | --- | --- |
| mausbot-dev1 | gpt-6.2-sol | high | 1,000,000 | `--model raven/gpt-6.2-sol --thinking high` |
| mausbot-dev2 | gemini-4-hydrogen | high | provider default | `--model raven/gemini-4-hydrogen --thinking high` |
| mausbot-dev3 | gpt-6.2-sol | high | 1,000,000 | `--model raven/gpt-6.2-sol --thinking high` |

- These Pi defaults use the existing Raven provider and native tool execution. The advertised windows are 1,050,000 for `gpt-6.2-sol` and 1,048,576 for `gemini-4-hydrogen`.

## Implementation and evidence

- Read the current checkout's AGENTS.md, [the playbook](../playbook.md), your specialist role and [validation policy](../../../docs/MAUSBOT-VALIDATION.md). Work within the assigned source scope from a freshly fetched, isolated worktree. Preserve the coordination checkout.
- Record acceptance, dependencies and the first candidate before editing. Ship focused commits and PRs. Run the required hooks and scoped checks, and record pending verification explicitly. Keep independent work moving while review and CI run.

## Review requests and corrections

- Request review directly from the assigned reviewer. When the scope has no reviewer, choose an available eligible reviewer with room in their queue and record the assignment for Lead. Follow the [shared handoff](../playbook.md#pull-request-handoffs) for the exact head, validation and open threads.
- Address findings on the original GitHub threads. Send the pushed correction head to the same reviewer for delta review. Resolved findings and passing checks carry forward when their inputs are unchanged.

## PR ownership and merge closeout

- Record every PR you open in the existing durable handoff with its link, head, reviewer, CI status, blocker and next action. Keep that record active when you take a new assignment.
- Inspect your open PRs at task handoffs and follow reviewer, CI and merge events. Own corrections and eligible merge follow-through until you verify the actual merge or Lead records an explicit disposition.
- After GitHub confirms the merge, send Lead one summary with the PR link, merge SHA, delivered behavior, verification and any remaining QA or rollout action. Record the summary with the PR so Lead can register it.

## Access and delivery boundaries

- Follow the [authentication boundary](../playbook.md#authentication-login-keychain-boundary) for native authentication and the login Keychain. Keep secrets and machine-private receipts out of PRs and comments.
- Use the established App delivery owner and isolated validation. Front owns packaging and installation and Root owns live operations. Keep product work within the scope authorized for your role.
