# Known limitations

Some behaviour that looks like a bug is a deliberate trade-off, and some is not
built yet. Check here before you report a problem with history, sync or an
import. Each entry says whether it is **by design**, a **known limitation** or
**planned**.

## History and restoring

### Restoring while others edit keeps their unseen changes — _known limitation_

Restoring an earlier version replaces the note for everyone editing it live.
It only removes what your device had already seen, though. A change someone
made at the same moment, or made offline and synced later, survives the
restore: you get the restored version plus their change. The note never ends up
different on two devices, but you may have stray content to tidy up.

When other people are editing a Markdown note or a PDF, the app asks before it
restores. For Kanban boards, handwritten notes and drawing canvases it does not
ask yet, so check with the others first. Typst documents are not edited live,
so none of this applies to them.

### History stays on the device that made it — _by design_

Each device keeps its own history of a note, and history is never synced. When
you restore a version, the restored content syncs to your other devices, but
the version list, the restore entry and its **Undo** button stay on the device
you restored on. Another device only sees that the note changed, so there is no
shared record of who restored what, or when.

### Undo after a restore is temporary — _by design_

After a restore, **Undo** takes the note back to how it was. The button only
appears on the device that restored, and it is gone once you restart the app.
The version from just before the restore stays in History, so you can still go
back by restoring that.

### Ctrl+Z does not undo a restore — _by design_

Ctrl+Z undoes your own edits: typing, a pen stroke, an annotation. It never
undoes a restore, in any kind of note. Use **Undo** after the restore, or
restore the earlier version from History.

## Sync and sharing

### A deleted note comes back if another device edited it offline — _by design_

If you delete a note while another device has changes to it that have not
synced yet, the note comes back when that device syncs. The app never throws
away edits that have not reached the server, so the edit wins over the delete.
Delete the note again once both devices are in sync.

### Renames and moves don't merge — _by design_

The content of a note merges: if two people edit the same note offline, both
keep their changes. A note's title, its folder and whether it is in the trash
don't merge. If two devices rename or move the same note while offline, the
change that syncs last wins.

### Notes added by setup can't be shared — _by design_

Setup can add a welcome note. That note can't go into a shared folder: moving it
into one, or sharing a folder that holds it, is refused. Copy its text into a
new note to share it. Devices set up with different app versions may each have
their own copy of the welcome note, and an unedited one does not sync until you
change it.

## Import

The importer and what each format maps to are described in
[Importing notes](import.md).

### Evernote links between notes are matched by title — _known limitation_

Most Evernote exports leave out the IDs that links between notes refer to, so
the importer matches each link by its text, which Evernote sets to the title of
the note it points to. If two notes share a title, a link can reach the wrong
one. Exports that do include the IDs link exactly. A link that matches nothing
keeps its text and loses the link.

### Obsidian note embeds become plain links — _by design_

`![[Some note]]` shows one note inside another in Obsidian. Mindstream has no
equivalent, so the embed becomes an ordinary link to the same note. Image and
file embeds such as `![[diagram.png]]` are imported as attachments.

### Canvas and Excalidraw files are not imported as drawing canvases — _planned_

Obsidian `.canvas` files and the Excalidraw plugin's drawings are skipped. They
could become drawing canvases, but that import has not been written.

### Older duplicate attachments are not merged — _by design_

Identical attachments are now stored once, whether they come from an import or
are added by hand. Copies that were already in a vault before that change stay
separate, because merging them would mean rewriting the notes that point at
them.

### Old title links pick the most recently edited note — _deprecated_

Notes written by older versions can contain a bare `[[Title]]` link, which the
app follows by title. If several notes share that title, it opens the one edited
most recently, so the target can change as you rename notes. **Settings → Data &
Backup → Maintenance → Convert legacy links** turns them into links that always
reach the same note. Links whose title matches no note are left as they are.
