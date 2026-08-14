# LanguageTool

Grammar and style checking, alongside the built-in spellchecker.

This plugin adds what a dictionary cannot judge: agreement, punctuation, word
order and style.

It can also take over **spelling**, and by default it does. LanguageTool weighs
the whole sentence rather than comparing strings, so its suggestions are usually
better ordered than the built-in dictionary's — and it knows German
abbreviations natively. Turn _Check spelling too_ off to keep spelling local.

Only ever one checker marks a given word. When LanguageTool is checking
spelling, the built-in dictionary's spelling findings are suppressed
paragraph by paragraph — and only for paragraphs LanguageTool actually
answered. If the server is slow, unreachable or switched off, the local
dictionary silently covers those paragraphs instead, so you are never left
without spellchecking.

Words in your personal dictionary are honoured either way. LanguageTool's API
has no per-request word list, so accepted words are filtered out of its
spelling results on your machine.

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

| Setting            | Needed for                                    |
| ------------------ | --------------------------------------------- |
| Server URL         | Always. Empty means the checker does nothing. |
| Check spelling too | Optional. On by default.                      |
| Account e-mail     | Hosted API only                               |
| API key            | Hosted API only                               |

The server URL may include `/v2` or a trailing slash — both are accepted.

The e-mail and key are stored on this device and are never synced with your
notes.

## What you will see

Grammar findings are underlined in a calmer colour than spelling, and style
suggestions in a lighter dotted line — advice reads differently from an error.
Right-click any of them for LanguageTool's own suggestions, in its own ranking.

If the server is unreachable, that checker simply stops contributing. Spelling
keeps working, and the failure is not repeated as an error on every paragraph.
