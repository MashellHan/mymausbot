# Desktop credential modes

The desktop app normally keeps its credentials in the operating system's secure store. To use credentials only during one App run, quit the App and set the nonsecret preference below in its Electron `userData/desktop-prefs.json`:

```json
{ "credentialMode": "session" }
```

The App reads this preference before loading credentials or opening its browser session. An absent or invalid value selects the normal `system` mode. Changing modes takes effect on the next App launch. Other desktop preferences in the same file must be retained.

In session mode, newly entered desktop credentials, Cloud and company grants, and supported provider keys are kept in App memory. The embedded server receives its current keys again after recovery of the same local environment. A different local environment receives only its own keys. Closing the App forgets these values; sign in or enter keys again after the next launch. The App does not read, overwrite, migrate, or delete its older encrypted credential files in this mode. Returning to `system` mode makes those earlier saved records available again.

The App's main browser uses a nonpersistent Electron session in this mode, so its cookies and browser storage do not survive a fresh App process. It does not use a mock keychain, plaintext fallback, or a fixed encryption key. Provider config writes keep new secrets out of `config.json` while preserving any pre-existing values there. Existing independent CLI sign-ins and their files remain under those tools' own control.

Some server features require a persistent credential file and are unavailable in session mode: saved website logins and 1Password connections, MCP OAuth sign-ins, ChatGPT plan sign-in, and secret-card file delivery. Their existing files are left untouched. A secret card can still provide a one-use in-memory reference; that reference expires if the embedded server restarts. The UI reports an unavailable operation rather than claiming that it was saved.

Use the isolated fixture in [Verification](verification/README.md) to check config writes and embedded-server recovery. A packaged App smoke in a disposable profile is required before claiming that the native runtime makes no Keychain request.

## Explicit private-file mode

For credentials and sign-ins that survive an App restart without the macOS login
Keychain, quit the App and set `"credentialMode": "private-file"` in the same
`desktop-prefs.json`, preserving its other preferences. The new mode keeps App
workspace/provider keys, Cloud account grants and company connection records
in separate JSON files under `userData/private-credentials/`. These files are
**not encrypted**: their protection is the signed-in OS account, an owner-only
`0700` directory, `0600` files, atomic replacement and symlink/ownership checks.
They are outside repositories and separate from earlier `credentials.bin`,
Cloud and company ciphertext. The App never reads or converts those earlier
encrypted records in this mode. Sign in or enter a key once in the new mode to
save it there. A previously created record that is missing, corrupt or unsafe
stays unavailable;
the App does not treat it as an empty sign-in or switch to `system` storage.

The App also places its persistent browser session in
`userData/private-credentials/browser-session/` before opening a page and uses
a `077` process umask. It does not import cookies from the earlier browser
profile. Electron 43.7.9 has cookie encryption disabled in this build; the
isolated native platform probe showed cookie persistence without the login
Keychain. A two-process packaged App check in a disposable profile must confirm
this build and its sign-in flow before the live preference is changed.

The embedded server is no longer in session-only mode, so its existing
workspace-scoped OAuth, saved login, Vault and ChatGPT plan files can persist
under their existing private file rules. Automatic Claude CLI auth-status and
plan-usage Keychain fallback are suppressed; an explicitly selected credential
file or environment value may still be read. Other external CLI sign-ins need
their own verified non-login-Keychain path and are not certified by this mode.

The preference is read at every launch. Once private storage has been prepared,
an absent or invalid preference is refused before `safeStorage` or a persistent
browser session is opened. **Before every launch of an older App, including a
recovery launch, restore the compatible `"credentialMode": "session"` value**:
older versions interpret `private-file` as `system`. Keep all private files and
the old encrypted records in place during that preference change. Only the
designated App operator changes the live preference, installs a build or opens
the live App.
