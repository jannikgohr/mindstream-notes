# LanguageTool

Grammatik- und Stilprüfung, zusätzlich zur eingebauten Rechtschreibprüfung.

Dieses Plugin prüft, was ein Wörterbuch nicht beurteilen kann: Kongruenz,
Zeichensetzung, Wortstellung und Stil.

Es kann auch die **Rechtschreibung** übernehmen, und das tut es standardmäßig.
LanguageTool bewertet den ganzen Satz, statt Zeichenketten zu vergleichen. Seine
Vorschläge sind deshalb meist besser sortiert als die des eingebauten
Wörterbuchs, und es kennt deutsche Abkürzungen von sich aus. Schalte _Auch
Rechtschreibung prüfen_ aus, wenn die Rechtschreibung lokal bleiben soll.

Ein Wort markiert immer nur ein Prüfer. Prüft LanguageTool die Rechtschreibung,
blendet die App die Rechtschreibfunde des eingebauten Wörterbuchs Absatz für
Absatz aus, und zwar nur für Absätze, die LanguageTool tatsächlich beantwortet
hat. Ist der Server langsam, nicht erreichbar oder ausgeschaltet, übernimmt das
lokale Wörterbuch diese Absätze ohne Meldung. Ohne Rechtschreibprüfung bleibst
du also nie.

Wörter aus deinem persönlichen Wörterbuch werden in beiden Fällen respektiert.
Die API von LanguageTool nimmt keine Wortliste pro Anfrage an, deshalb filtert
die App akzeptierte Wörter auf deinem Gerät aus den Ergebnissen.

## Bevor du es einschaltest

**Bei jeder Prüfung wird dein Notiztext an den eingestellten Server
gesendet.** So arbeitet LanguageTool: Um einen Satz zu beurteilen, braucht es
den Satz. Solange keine Server-URL eingetragen ist, wird nichts gesendet. Die
eingebaute Rechtschreibprüfung sendet nie etwas.

Deshalb ist ein eigener Server die empfohlene Einrichtung.

## Einen eigenen Server betreiben

Das offizielle Image läuft ohne weitere Konfiguration:

```bash
docker run -d --rm -p 8081:8010 erikvl87/languagetool
```

Trage dann `http://localhost:8081` als **Server-URL** ein und lass die
Kontofelder leer. Lokale Server verlangen keine Anmeldung.

Dem Image fehlen die N-Gramm-Daten. Sie treiben die Regeln an, die
Verwechslungen echter Wörter finden (`das` / `dass`). Mit ihnen werden die
Ergebnisse deutlich besser, sie belegen aber mehrere Gigabyte. Wie du sie
hinzufügst, steht in der Dokumentation des Images.

**Prüfen** kontrolliert drei Dinge: dass der Server antwortet, dass es wirklich
LanguageTool ist und dass er die Sprachen anbietet, in denen du schreibst. Die
Qualität der Grammatikprüfung testet es nicht. N-Gramme und Regelsätze pro
Sprache sind optionale Downloads, ein Server ohne sie ist also richtig
eingerichtet, prüft aber weniger gründlich.

## Stattdessen die gehostete API nutzen

Trage `https://api.languagetoolplus.com` als **Server-URL** ein und fülle
Konto-E-Mail und API-Schlüssel aus deinem LanguageTool-Konto aus. Beide werden
zusammen gebraucht.

Zwei Dinge solltest du wissen: Die kostenlose Stufe ist begrenzt, lange Notizen
bekommen daher eventuell nur Teilergebnisse. Und dein Notiztext wird von einem
Drittanbieter nach dessen Datenschutzerklärung verarbeitet, nicht nach deiner.

## Einstellungen

| Einstellung                 | Nötig für                                         |
| --------------------------- | ------------------------------------------------- |
| Server-URL                  | Immer. Leer bedeutet, dass der Prüfer nichts tut. |
| Auch Rechtschreibung prüfen | Optional. Standardmäßig an.                       |
| Konto-E-Mail                | Nur für die gehostete API                         |
| API-Schlüssel               | Nur für die gehostete API                         |

Die Server-URL darf `/v2` oder einen abschließenden Schrägstrich enthalten,
beides wird akzeptiert.

E-Mail und Schlüssel werden auf diesem Gerät gespeichert und nie mit deinen
Notizen synchronisiert.

## Was du siehst

Drei Farben nach LanguageTools eigener Konvention: Rot für Rechtschreibung,
Gelb für Grammatik, Blau für Stil. Stil ist gepunktet statt gewellt, damit ein
Hinweis nicht wie ein Fehler aussieht. Ein Rechtsklick zeigt die Vorschläge von
LanguageTool in seiner eigenen Reihenfolge.

Die Ergebnisse können leicht von der Browser-Erweiterung abweichen. Sie sendet
viel mehr umgebenden Text als ein Notizeditor, und manche Regeln greifen nur mit
diesem Kontext. Ist ein Absatz zu kurz, um seine Sprache verlässlich zu
erkennen, nennt das Plugin die Sprache ausdrücklich, statt zu raten.

Ist der Server nicht erreichbar, trägt dieser Prüfer einfach nichts mehr bei.
Die Rechtschreibprüfung läuft weiter, und der Fehler erscheint nicht an jedem
Absatz erneut.
