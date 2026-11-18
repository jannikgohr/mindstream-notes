# Platzhalter

Titel und Inhalt werden durch die Platzhalter-Engine geführt, sodass du z. B.
schreiben kannst:

- `{{date}}`, `{{time}}`, `{{datetime}}`
- Datumsrechnung und -formate: `{{date+7d}}`, `{{date:dddd}}`
- `{{uuid}}`, `{{title}}`
- Filter: `{{title|slug}}`

In einer Tagesnotiz aus dem Journal-Kalender zählen Datumsplatzhalter ab dem
Tag der Notiz, sodass `{{date+1d}}` in der Notiz für Montag Dienstag ergibt.
