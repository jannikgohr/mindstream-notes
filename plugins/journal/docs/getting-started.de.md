# Journal

**Journal** in der Seitenleiste zeigt einen Monatskalender. Ein Punkt markiert
einen Tag mit Tagesnotiz; graue Punkte zählen die anderen Notizen, die an dem
Tag erstellt oder zuletzt bearbeitet wurden. Für den gewählten Tag stehen sie
unter dem Kalender: bis zu 100, die zuletzt bearbeiteten zuerst. Eine Notiz, die an
einem Tag bearbeitet, aber nicht erstellt wurde, ist als **Bearbeitet**
markiert. Bekannt ist nur die letzte Bearbeitung, daher verschwindet eine Notiz
vom Tag einer früheren Bearbeitung.

Eine Tagesnotiz erscheint nur an ihrem eigenen Tag, auch wenn sie an einem
anderen geschrieben wurde. Der Kalender erkennt Tagesnotizen für die Tage, die
er zeigt; eine für einen weiter entfernten Tag erscheint als gewöhnliche Notiz
am Tag, an dem sie geschrieben wurde.

Ein Klick auf einen Tag oder auf **Heute** öffnet die Tagesnotiz dieses Tages.
Gibt es sie noch nicht, wird sie angelegt. **Heutige Notiz öffnen** tut dasselbe
aus der Befehlspalette und lässt sich auf ein Tastenkürzel legen.

## Einstellungen

- **Ordner für Tagesnotizen**: Hier werden Tagesnotizen angelegt und gesucht.
  Ohne Ordner landen sie in der obersten Ebene des Tresors.
- **Titelformat**: Wie eine Tagesnotiz heißt, etwa `YYYY-MM-DD` oder
  `dddd, D MMMM YYYY`. Eine Tagesnotiz wird über diesen Titel in diesem Ordner
  gefunden. Notizen mit einem früheren Format, umbenannte oder verschobene
  zählen daher nicht mehr.
- **Vorlage**: Eine Notiz, die in jede neue Tagesnotiz kopiert wird. Ihre
  Platzhalter füllt das Vorlagen-Plugin, und Datumsplatzhalter wie `{{date}}`
  verwenden den Tag der Tagesnotiz.

## Entfernen

Deaktiviere dieses Plugin, um Journal aus der Seitenleiste zu entfernen. Deine
Tagesnotizen bleiben erhalten.
