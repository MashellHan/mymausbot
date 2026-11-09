# MausBot backlog

## Active Mini Apps feedback

Keep this list together through the final integrated App delivery. Source review,
merge and local delivery are separate states; a merged PR alone does not mean the
installed App has changed. Lead owns review and merge sequencing. Front owns one
final latest-main build and isolated acceptance after the feedback fixes land.

| Outcome | Owner | Source status | Acceptance |
| --- | --- | --- | --- |
| Compact Mini App controls | Root | In review, [PR #122](https://github.com/MashellHan/mymausbot/pull/122) | Remove the persistent publisher-chat and version-history row. Keep those actions and rollback accessible inside the anchored All apps menu. |
| Main/Computer navigation | Root | In review, PR #122 | Remove the original Agent Team and Usage tabs; preserve both Mini Apps and their data/access boundaries. Old saved tab selections open Mini Apps. |
| Activities name | Root | In review, PR #122 | Replace Work Tracker with Activities for stock English/Chinese titles and existing defaults, preserving app IDs and custom names. |
| Agent Team opening state | Root | In review, PR #122 | Open a working team first, then a blocked or recently active verified team. Polling preserves explicit selection and collapse. |
| Bookkeeping Recent layout | Front | In review, PR #122 | Rename Records to Recent. Put daily trend above records with a Trend/Calendar switch; remove the separate Calendar top tab and make the calendar compact. |
| Bookkeeping space and notices | Front | In review, PR #122 | Put time selection by the title, wrapping beneath it when narrow. Put date coverage in a circled alert disclosure. Remove currency-exclusion notices; retain automatic refresh and existing data. |
| Activities Token comparisons | Root | Ready for review | Restore DoD and WoW for complete observed Token periods even when unrelated Git fetching fails. Label the periods, preserve cache-inclusive accounting, and explain genuinely missing prior history without inventing a comparison. |
| Team Token usage in header | Front | In progress | Show rolling 24-hour and 7-day Tokens alongside the team title and Working state. Attribute only verified team sessions; disclose partial or unavailable observations and never substitute whole-machine usage. |
| Bookkeeping spending layout | Root | Next after compact merge | Order the page as compact summary, trend line, category distribution, then sortable records. Fix the empty trend: week/month show daily spending, with the highest point labeled. Place a donut chart left of sorted category amounts and percentage shares, stacking when narrow. Remove inflow/net from the summary and preserve previous-month comparisons and the compact calendar switch. |
| X AI digest and GitHub Trending presentation | Designer; Front for guarded source opening | In progress | Use the supplied editorial references for clearer summary, item hierarchy, detail and source links. Preserve latest/history selection, automatic publication, authentic report data, narrow/light/dark rendering and custom-template protection. |

Existing default installation, app icons, the single-row launcher and its
anchored All apps menu remain part of acceptance. Applications open with usable
data and without a setup step; removed apps stay removed. Report formatting must
work for both retained historical reports and the next automated publication.

## Following Mini Apps

| Outcome | Owner | Status | Acceptance |
| --- | --- | --- | --- |
| Generated-file preview | Lead | Queued after Mini Apps | Clicking a generated Markdown or CSV file opens a preview in the right panel. Render Markdown and display CSV as a table; retain download. |
