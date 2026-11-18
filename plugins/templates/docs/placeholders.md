# Placeholders

The title and body are run through the placeholder engine, so you can write
things like:

- `{{date}}`, `{{time}}`, `{{datetime}}`
- date math and formats: `{{date+7d}}`, `{{date:dddd}}`
- `{{uuid}}`, `{{title}}`
- filters: `{{title|slug}}`

In a daily note from the Journal calendar, date placeholders count from the
note's day, so `{{date+1d}}` in Monday's note is Tuesday.
