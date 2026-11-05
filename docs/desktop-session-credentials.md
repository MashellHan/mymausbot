# Session-only desktop credentials

The desktop app normally keeps its credentials in the operating system's secure store. To use credentials only during one App run, quit the App and set the nonsecret preference below in its Electron `userData/desktop-prefs.json`:

```json
{ "credentialMode": "session" }
```

The App reads this preference before loading credentials or opening its browser session. An absent or invalid value selects the normal `system` mode. Changing modes takes effect on the next App launch. Other desktop preferences in the same file must be retained.

In session mode, newly entered desktop credentials, Cloud and company grants, and supported provider keys are kept in App memory. The embedded server receives its current keys again after recovery of the same local environment. A different local environment receives only its own keys. Closing the App forgets these values; sign in or enter keys again after the next launch. The App does not read, overwrite, migrate, or delete its older encrypted credential files in this mode. Returning to `system` mode makes those earlier saved records available again.

The App's main browser uses a nonpersistent Electron session in this mode, so its cookies and browser storage do not survive a fresh App process. It does not use a mock keychain, plaintext fallback, or a fixed encryption key. Provider config writes keep new secrets out of `config.json` while preserving any pre-existing values there. Existing independent CLI sign-ins and their files remain under those tools' own control.

Some server features require a persistent credential file and are unavailable in session mode: saved website logins and 1Password connections, MCP OAuth sign-ins, ChatGPT plan sign-in, and secret-card file delivery. Their existing files are left untouched. A secret card can still provide a one-use in-memory reference; that reference expires if the embedded server restarts. The UI reports an unavailable operation rather than claiming that it was saved.

Use the isolated fixture in [Verification](verification/README.md) to check config writes and embedded-server recovery. A packaged App smoke in a disposable profile is required before claiming that the native runtime makes no Keychain request.
