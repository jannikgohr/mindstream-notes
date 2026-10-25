# Sync and sharing

Mindstream Notes works without an account. Connect a vault to a Mindstream
server and you can sync it between your devices, share folders with other
people and edit notes together live.

The app encrypts your notes with a key made from your password before they
leave the device. The server stores them without being able to read them, and
it cannot reset your password.

Hosted sync is not available yet, so you need a server: your own, set up with
the [self-hosting quick start](self-hosting.md), or one someone runs for you.

## Connecting a vault

Open **Settings → Account & Sync**, or the first step of setup, and choose
**Self-hosted**. Enter the server's address and use **Check URL** to see that it
answers. Then sign in, or choose **Create an account**.

A new account needs a username, an email address and a password, entered
twice. A server that takes new accounts by invitation also asks for a signup
code, which its administrator gives you. An invite link to a shared folder
works in that field too, if the person who made it allowed new accounts.

The connection belongs to the vault you set it up in. Another vault on the
same device can use another account, another server, or none.

## Your recovery key

After you create an account, the app shows your recovery key once. Copy it,
save it as a file or write it down, and keep it where only you can reach it. It
is the only way back into the account if you forget your password.

To use it, choose **Forgot your password?** on the sign-in form and enter the
key. You set a new password, every device is signed out, and you get a new
recovery key.

Under **Settings → Account & Sync → Security** you can make a new recovery key
at any time. The new key replaces the old one, which stops working. Without a
recovery key and without a device that is still signed in, a forgotten
password means nobody can read the notes on the server again.

## Two-factor sign-in

Under **Security**, choose **Set up an authenticator**. Enter your password,
scan the QR code with an authenticator app (or type in the secret), and enter
the code the app shows. Turning it on signs every other device out.

You also get single-use backup codes for when your authenticator is out of
reach. Keep them somewhere other than your phone. **New backup codes** replaces
them, and the old ones stop working.

If you lose both the authenticator and the backup codes and no device is
signed in any more, ask the server's administrator to reset two-factor sign-in
for your account.

## Devices

**Security** also lists every device signed in to the account, with when it
signed in and was last used. Sign out one of them, or all others at once. A
device you sign out keeps its notes and has to sign in again to sync.

Changing your password, or turning on an authenticator, signs every other
device out. A device that has not been used for a long time is signed out by
the server, after 90 days unless its administrator changed that.

## How sync works

Sync runs on its own while **Enable sync** is on. **Sync frequency** sets how
often the app checks with the server: **Live** (every 30 seconds, the default),
every minute, every 5 or 15 minutes, or **Manual only**. While sync runs on a
schedule, the server also tells the app when something changed on another
device, and the app syncs straight away. **Sync now** syncs at any time.

You can keep writing without a connection. Changes wait on the device and go
out at the next sync, and a notification says when the server cannot be
reached or has signed the device out.

When two devices change the same note:

- Edits to the content are merged, so both sets of changes survive.
- A new title, a move to another folder or a move to the trash is not merged.
  The change synced last wins.
- A note deleted on one device while another device edits it comes back, with
  those edits. Sync never throws away work that has not been sent.

Version history stays on each device. Restoring a version changes the note
everywhere, but the list of earlier versions, and the **Undo** after a restore,
belong to the device that has them.

A server can set storage limits for an account. Changes that would go past a
limit stay on the device, a notification names the limit, and the app sends
them once there is room.

## Editing together live

When a note is open on more than one device, or by more than one person, each
edit appears on the other screens as it is made, and the editor shows **Live**.
This works for Markdown notes, drawings, handwritten notes, PDFs and Kanban
boards, once the note has synced. Plugin documents such as Typst sync like any
other note but are not edited live.

Restoring an earlier version replaces the note for everyone editing it. For
Markdown notes and PDFs the app asks first when other people are in the note.
For the other kinds it does not ask yet, see
[known limitations](known-limitations.md#collab-confirmation-prompt-before-restore--partially-implemented).

## Sharing a folder

Right-click a folder and choose **Sharing → Share folder…**. Enter one or more
usernames, separated by commas, and choose what they may do:

| Access   | Lets them                                                          |
| -------- | ------------------------------------------------------------------ |
| Can view | Read the folder's notes                                            |
| Can edit | Read, change and add notes                                         |
| Admin    | Edit, and invite people, change their access and make invite links |

Each person gets a notification and can accept or decline. A folder they
accept appears under **Shared** on their devices. A note inside a shared folder
syncs to everyone in it, attachments included.

**Sharing → Manage access…** lists everyone with access. Change someone's access
there, or remove them, which takes the folder off their devices. **Stop
sharing…** does that for everyone at once, and you keep the folder. Someone you
shared with can choose **Leave shared folder…**.

The welcome notes setup adds cannot go into a shared folder. Copy their text
into a new note instead.

### Invite links

To invite people without knowing their usernames, open **Manage access…** and
create an invite link. Choose whether it gives **Can view** or **Can edit**, how
many people may use it (1, 5 or 25) and how long it lasts (1, 7 or 30 days).
Copy the link straight away, because the app cannot show it again. The list
shows how often each link was used, until when it works, and lets you remove
it.

On a server that takes new accounts by invitation, a link can also let someone
without an account create one on that server. Tick the box for that before you
create the link.

Whoever gets the link joins by right-clicking an empty spot in the file tree,
for example under **Shared**, and choosing **Join shared folder…**. Opened in a
browser, the link shows a page that says to paste it into the app. The part of
the link that opens the folder never reaches the server.

### Checking who you share with

Your account has a key, shown as digits under **Security**. People you share
with can compare those digits with what their app shows for you. If they match,
the folder is shared with you and nobody else.

An account's key only changes when the account is created again. If someone's
key is not the one you shared with before, the app warns you and sends nothing.
Compare the digits with that person, then choose **Share with the new key** if
they match.
