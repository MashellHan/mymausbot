# Previewing and saving generated files

Launch the isolated server, chat file links and real Computer panel:

```sh
node --experimental-strip-types scripts/verify-computer-files.ts
```

Open the printed `previewUrl`. The fixture creates four synthetic files and
the fake engine's persisted reply links to three by absolute file URL, without
a change digest. The temporary project is the conversation's pinned working
folder. Those three links use the real, unchanged server's message-scoped file
endpoint. A separate routine-origin attachment and two older history pages are
renderer-only synthetic rows for listing and pagination; they do not prove
download authorization. No real engine, account, or application data is used.
Ctrl-C closes both fixture servers and removes only their temporary data.

Check the following in the browser:

1. Click `report #1.md` in the chat. The right panel opens directly to Files,
   showing the Markdown heading, list, table and code block. It must not open a
   modal or download the file. The document's private link stays inert and its
   raw HTML must not execute. Focus moves to **Back to files**.
2. Save `report #1.md` with the separate download button. It reports **Downloaded**, and the saved
   text contains the synthetic review. Its encoded file URL is sent with the
   stored reply's message ID through the existing file endpoint.
3. Click `metrics.csv` in chat, or use **Back to files** and click its name
   in the Files list. The same right pane shows Alpha / 12 and Beta / 7,
   leading-zero codes, a quoted comma and a multiline cell. Search and column
   sorting remain available; the download action stays separate.
4. **Back to files**, or Escape while focus is in the preview, restores the
   file list and its scroll position, keeping focus in the visible list.
   Closing the panel returns focus to the chat opener. Changing panel tabs or closing the panel
   clears the preview. A generic **Open panel** still starts on Mini Apps.
5. `missing.md` is intentionally absent. Its preview shows a retryable load
   error with Download still available. Saving it reports the server's error.
6. Files lists the persisted links and a routine-origin attachment despite
   having no digest. Dates run newest first and include the year. Click **Load
   older files**: the first page has no file, but the control remains. Click it
   again for the older dated archive row and the end-of-history message. The
   routine and archive rows are synthetic display evidence only. A digest-only
   file remains **Not shared** in the component tests and has no file grant.
7. Repeat at 400 and 360 px and with `?skin=atelier` for the light theme.
   Header actions stay reachable; prose wraps and tables/code scroll locally.
8. With `?defer-panel=1`, click the report, **Close panel**, **Open panel**,
   then **Finish loading panel**. The cancelled file request must not run:
   the panel stays on Mini Apps and makes no file read.

Focused checks:

```sh
pnpm check:edit --test src/components/ComputerFilesPane.test.ts --test src/state/store.test.ts
pnpm check:ready --test src/components/MessageFilePreview.test.ts
pnpm typecheck --project ui
```

The component tests cover preview routing under StrictMode, cancellation and
late responses, bot/thread/branch changes, safe Markdown, bounded UTF-8 reads,
empty/error states, separate downloads, the visible branch, exact thread/message scope,
encoded file URLs, Windows paths, explicit null pins, changed bot defaults,
deleted-file filtering, workspace refusal, and state reset on thread changes.
Authorization and containment remain the server's responsibility on every
click. Only existing Markdown file links and stored file attachments are
used; there is no new path-reading API or expanded root. Unmatched spelling
variants remain unavailable rather than guessing by basename. Markdown is
limited to 1 MB; CSV/TSV retain the existing worker/parser limits and table.
Contexts without the bot's Computer panel use the existing dialog. HTML keeps
its sandboxed preview and other formats keep their save behavior. This is
not a full directory browser, a checkpoint test, or a packaged desktop/phone verification.
