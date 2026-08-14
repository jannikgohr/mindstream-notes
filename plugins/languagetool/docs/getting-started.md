# LanguageTool

Grammar and style checking, alongside the built-in spellchecker.

Spelling stays with the app's own dictionaries. This plugin adds the things a
dictionary cannot judge: agreement, punctuation, word order, and style. The two
never mark the same word — the plugin switches LanguageTool's spelling rules
off, so each finding comes from exactly one checker.

## Before you turn it on

**Your note text is sent to the server you configure, on every check.** That is
how LanguageTool works: it needs the sentence to judge the sentence. Nothing is
sent until you set a server URL, and nothing is sent by the built-in
spellchecker at any point.

For that reason, running your own server is the recommended setup.

## Running your own server

The official image needs no configuration to get started:

```bash
docker run -d --rm -p 8081:8010 erikvl87/languagetool
```

Then set **Server URL** to `http://localhost:8081` and leave the account fields
empty. Local servers do not authenticate.

The image ships without n-gram data, which powers the rules that catch confusions
between real words (`there` / `their`). Adding it improves results considerably
at the cost of several gigabytes on disk — see the image's documentation.

## Using the hosted API instead

Set **Server URL** to `https://api.languagetoolplus.com`, and fill in the account
e-mail and API key from your LanguageTool account. Both are required together.

Two things to know: the free tier is rate-limited, so long notes may return
partial results; and your note text is processed by a third party under their
privacy policy rather than yours.

## Configuration

| Setting        | Needed for                                    |
| -------------- | --------------------------------------------- |
| Server URL     | Always. Empty means the checker does nothing. |
| Account e-mail | Hosted API only                               |
| API key        | Hosted API only                               |

The e-mail and key are stored on this device and are never synced with your
notes.

## What you will see

Grammar findings are underlined in a calmer colour than spelling, and style
suggestions in a lighter dotted line — advice reads differently from an error.
Right-click any of them for LanguageTool's own suggestions, in its own ranking.

If the server is unreachable, that checker simply stops contributing. Spelling
keeps working, and the failure is not repeated as an error on every paragraph.
