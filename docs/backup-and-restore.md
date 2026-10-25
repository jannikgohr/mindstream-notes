# Backup and restore

A backup is a ZIP file with one vault in it, plus the device settings you need
to use that vault on another device. Both actions live in **Settings → Data &
Backup**. **Back up now** asks where to save the file. **Restore from backup**
opens one and either replaces the vault with it or merges the missing items in.

## What a backup holds

- The vault's notes, folders, attachments, custom dictionary words and plugin
  settings.
- The vault's settings.
- Shared device preferences and your custom theme presets.
- Files plugins have written for the vault, and the installed versions of
  plugin packages. Built-in plugins come with the app, so the backup leaves
  them out.

Some things never leave the device. That covers account sessions, the keys in
the system keystore, signing private keys, window positions and the list of
vaults. Approvals you gave third-party plugins to run stay behind as well.
Downloaded plugin artifacts and dictionaries are caches, and the app downloads
them again on the new device.

Plugins can keep private values in their settings and files, the same way notes
can. Store a backup with the same care as the notes in it.

If a file changes while the app writes the backup, the backup stops and asks
you to try again.

## Restoring a backup

The restore dialog puts the backup next to the current vault. It shows how many
notes, folders and attachments each has, which account each belongs to, and how
much plugin data and how many plugin packages the backup brings.

### Restore this vault

Restore replaces the vault's notes, settings and plugin data with the backup's.
The app restarts to swap the backup in, and keeps the current data as a
timestamped pre-restore copy in the data folder. The database copy is
named `mindstream-pre-restore-<time>-<id>.db`, and the vault's files go to
`backups/pre-restore-files-<hash>/`. The app never deletes these copies.
You can delete them once the restored vault looks right.

You stay signed in on this device. A backup from the account you are signed in
with keeps its sync state. A backup from another account, or from a vault with
no account, drops its sync state, and the restored notes upload to your
current account from scratch.

Every third-party plugin in the restored vault needs your approval again before
it runs, even when this device already has the same version installed. Other
vaults keep their approvals.

The option **Also import shared device preferences, custom themes and plugin
packages** starts unchecked. When you tick it, the restore adds the shared
entries this device does not have yet. Where both sides have a value, the
device keeps its own setting, theme or package. A plugin you removed here stays
removed, and a plugin setting you reset stays reset. Every vault on this device
sees these shared entries, but the restore changes no other vault's notes.

### Merge missing items

Merge adds the notes, folders and attachments the vault does not have yet, and
nothing else. Settings, plugin data, plugin packages and device preferences stay
as they are, and the shared-device option does not apply. A merged note whose
folder is missing ends up at the root of the vault.

### Older backups

Backups from earlier versions of the app hold only the database. Restoring one
replaces the notes and clears third-party plugin approvals, and leaves vault
files and device preferences alone. An older app refuses a backup made by a
newer one rather than restoring part of it.

## When a restore fails

The app checks the whole backup before it changes anything. It refuses a damaged
file, a backup from a newer app version, and a backup that holds unsafe paths,
links or invalid settings.

If the app closes or crashes during the restart that applies a restore, it
finishes the restore the next time it starts, before it opens the vault. If the
app stops earlier, while it is still preparing the backup, the vault stays as it
was. Run the restore again.

How the app stages, checks and resumes a restore is in the internal
[backup portability notes](internal/backup-restore-portability.md).
