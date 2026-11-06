# Bot-published report Mini Apps

Daily X AI digest and Github Rending are local report templates in Computer →
Mini Apps. They share the existing owner-scoped app registry and retained DuckDB
Data with bookkeeping. Each report has its own ordered edition history. A bot can
produce both reports from one retained store; it does not need another bot,
database or schedule for each app.

## Setup and publication

The owner chooses an existing enabled local bot-target Automation in **Add Mini
App**. The server resolves its current producer, prepares the report table even
when Data is empty, and returns a publication draft. The renderer grants the
resolved producer through the existing owner publication operation. Setup does
not publish a sample edition or change the routine's prompt, cadence or other
outputs. The existing Automation view remains the place to manage that routine.

An installed active report adds a temporary publication reminder to its local
Bot Automation turn only while that Bot still has the publisher grant, the app
is bound to the Bot's current retained report Data, and `mini_app_report` is
allowed. The saved prompt and schedule stay intact. Missing or archived apps,
revoked grants, mismatched bindings and nonlocal or read-only turns keep their
original prompt. The report tool checks authorization again when called; the
reminder never grants access or invents an edition.

Bots use their normal turn capability and tool policy:

1. Call `mini_app_info` and discover the installed app by its stable slug.
2. Call `mini_app_report` with `action: "prepare"` and the report `kind`. It returns
   the retained dataset, a nullable `nominalEditionKey` and the shipped template's
   complete `publication` draft. Preparation creates no edition.
3. If the app is absent, pass that draft to the existing `mini_app_publish` tool.
   Keep its request key and payload unchanged when retrying installation. The
   owner's publisher grants remain governed by the existing registry.
4. Collect and verify source material with the bot's existing authorized tools.
   Call `mini_app_report` with `action: "publish"`, the same `kind`, and the
   complete `edition` payload. Publishing another edition updates Data; it does
   not republish the HTML or change the template version.

| Kind | Stable slug | Edition series |
| --- | --- | --- |
| `x_ai_digest` | `x-ai-digest` | The existing daily X AI digest |
| `github_activity` | `github-activity` | The existing GitHub activity/discovery digest, displayed as Github Rending |

The caller cannot select another bot or dataset for the report tool. Template
editing access does not confer write access to another producer's Data. Removing
a producer preserves the retained archive, but another bot does not silently
inherit its writer identity. Workspace restore keeps the existing explicit owner
regrant requirement for template publishers.

## Edition identity and time

Each kind has at most one immutable edition per nominal Asia/Shanghai date, keyed
as `YYYY-MM-DD`. An active Automation publication derives that date from its
authoritative run's scheduled time. A conflicting caller-supplied key is rejected.
The original date stays stable when execution is delayed or retried across
midnight. An interactive or authorized historical import supplies its date
explicitly; it must not substitute today's date to bypass a conflict.

Identical retries return the original content hash and publication timestamp with
`replayed: true`. Different content under the same key fails visibly. Complete
header and item rows commit together with the existing Data revision, preserving
earlier editions and unrelated tables. Failed publication leaves current unchanged.
Current is the greatest logical edition date, not the most recently received write;
an older late arrival belongs in history.

| Field | Meaning |
| --- | --- |
| `editionKey` / `editionDay` | The logical China-calendar edition date |
| `windowStartAt`, `windowEndAt` | The recorded coverage interval; unknown bounds remain null |
| `sourceAsOfAt` | An optional report-level source snapshot/as-of marker |
| `publishedAt` | The server's first committed publication timestamp |
| Item `sourcePublishedAt` | The recorded source publication time, independently nullable |

An edition-level as-of marker is not proof that every item was observed at exactly
that instant. Source publication, collection/as-of and edition dates are distinct.
The template labels missing dates as unavailable and never fills them from a
different timestamp.

## Coverage and source facts

An edition contains up to 30 selected items and explicit `complete`, `partial` or
`unknown` coverage. Partial or unknown coverage includes a concrete limitation.
An optional `reportSummary` describes the edition; item summaries describe their
own sources. Optional `whyItMatters` and `verificationNote` retain recorded
explanations and checks without inventing either when absent.

Every selected item carries its source label, recorded public HTTP(S) URL,
attribution and nullable source date. Vendor claims remain attributed claims.
A public selected sample is not exhaustive coverage, archive-wide deduplication
or a measured cross-day trend. Empty installation means no edition yet; a
published verified empty edition and unavailable source coverage are different
states. A failed refresh retains the dated previous view with a stale notice;
authorization loss clears it.

GitHub observations keep their original meaning:

- `repoStars` and `repoForks` are observed totals, with unknown values kept null.
- `weeklyStarIncrease` is the weekly Trending signal, accompanied by its source;
  it is not growth over the app's refresh interval.
- `repoPushedAt` records activity, not a release publication date.
- Public advisory counts carry `publicAdvisoryAsOfAt`; a zero count is not a
  safety audit or a conclusion that a repository is safe.
- Without comparable earlier local observations, a cross-period trend is
  unavailable. No official public Trending API is assumed.

Source URLs are selectable text for normal copy. They do not open a browser or
access the clipboard. The existing opaque-frame network and native navigation
guards remain in force.

## Data and rendering contract

Both report kinds use physical `main.omb_report_editions_v1` in the producer's
retained store. The primary key is `(report_kind, edition_key, item_index)`.
Index zero is the edition header; positive indices are selected item rows.
Header `summary` is exposed as `reportSummary`, independently of item `summary`.
The report operation validates and writes this managed table; ordinary Data
replacement is not the edition publication path.

Each app's binding fixes its report kind and exposes four bounded queries:

| Query | Parameters | Result |
| --- | --- | --- |
| `current` | None | The newest logical edition header |
| `history` | Cursor in query options | Earlier headers, newest logical date first |
| `edition` | `editionKey` | One selected historical header |
| `items` | `editionKey` | The selected edition's items in recorded order |

The template pins dependent reads to one Data revision and restarts the group
after a revision conflict. Data refresh keeps a selected historical edition,
filters and reading position; Current can advance to a newly published edition.
Template version history remains separate from report edition history.

Use the [Mini Apps verification recipe](verification/mini-apps.md) with synthetic
records. A local candidate, production authorization, a real routine's first
successful publication, and remote merge are separate delivery results.
