# Typst

Schreibe und betrachte [Typst](https://typst.app)-Dokumente als Notizen. Eine
Typst-Notiz zeigt Quelltext und live gerenderte Vorschau zusammen, sodass du
Briefe, Berichte oder mathematiklastige Notizen setzen kannst, ohne die App zu
verlassen.

Dieses Plugin ist **standardmäßig deaktiviert** – aktiviere es unter
**Einstellungen → Plugins → Typst**.

## Ein Typst-Dokument erstellen

Öffne das Erstellen-Menü (die Schaltfläche **Neu** in der Dateibaum-Leiste oder
das mobile Erstellen-Menü) und wähle **Typst-Dokument**. Du beginnst mit einem
kleinen Platzhalter-Dokument, das du sofort bearbeiten kannst.

Da Typst eine eigene Notizart mitbringt, bleibt eine Vorlage dieser Art beim
Erstellen ein Typst-Dokument – kombiniere das mit dem **Vorlagen**-Plugin, um
vorgestaltete Dokumente mit bereits eingesetzten `{{title}}`, `{{date}}`, …
zu erzeugen.

## Ansichten

Eine Typst-Notiz kann auf drei Arten angezeigt werden. Wechsle mit dem
Ansichts-Umschalter im Editor oder lege eine Standardansicht unter
**Einstellungen → Plugins → Typst → Editor** fest:

- **Live-Vorschau** – nur das gerenderte Dokument.
- **Quelltext** – nur der Typst-Quelltext.
- **Geteilt** (Standard) – Quelltext und Vorschau nebeneinander.

## Formatierungs-Kürzel

Die Editor-Symbolleiste bietet Kürzel für häufige Typst-Syntax:

- **Überschrift** fügt `= ` ein
- **Fett** umschließt die Auswahl mit `*…*`
- **Kursiv** umschließt sie mit `_…_`
- **Mathematik** umschließt sie mit `$ … $`
- **Liste** fügt `- ` ein

## Als PDF exportieren

Wenn das `typst`-Binary installiert ist (siehe **Voraussetzungen**), exportiere
die Notiz über ihr Export-Menü als PDF – derselbe Compiler, der die Vorschau
zeichnet, erzeugt die Datei.
