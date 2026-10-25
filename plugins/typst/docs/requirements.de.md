# Voraussetzungen

Das Rendern von Typst nutzt den echten Typst-Compiler, daher benötigt das Plugin
auf deinem Rechner installierte und über `PATH` erreichbare Binaries. Es wird
nichts mitgeliefert, und native Binaries sind nur auf dem Desktop verfügbar – auf
Mobilgeräten haben Typst-Notizen keine Vorschau.

Prüfe nach der Installation eines Binaries unter **Einstellungen → Plugins →
Typst**, ob das Plugin es findet – jedes deklarierte Binary hat eine
Schaltfläche **Prüfen**, die es über deinen `PATH` auflöst und den gefundenen
Pfad anzeigt.

## `typst` – erforderlich für die Vorschau und die meisten Exporte

Installiere das [`typst`](https://github.com/typst/typst)-CLI. Das Plugin
übergibt ihm deinen Quelltext und zeigt das kompilierte PDF als Vorschau.
Dasselbe Binary erzeugt die Exporte als PDF, PNG und SVG.

Ohne es lassen sich Typst-Notizen weiterhin im **Nur-Quelltext**-Modus öffnen.
Es gibt dann keine Vorschau, und exportieren lässt sich nur der
**Typst-Quelltext**, also die `.typ`-Datei selbst.

## `tinymist` – optional, für die Live-Vorschau

Installiere [`tinymist`](https://github.com/Myriad-Dreamin/tinymist) für eine
inkrementelle Live-Vorschau mit **Klick-zur-Quelle**: Ein Klick in die Vorschau
springt im Editor an die passende Stelle im Quelltext.

Es ist optional. Ohne es erhältst du weiterhin eine Vorschau über `typst`, nur
nach kurzer Verzögerung neu kompiliert statt inkrementell aktualisiert.
