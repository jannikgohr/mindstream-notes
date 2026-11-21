# Graph

**Graphansicht öffnen** zeigt deinen ganzen Tresor als Graph in einem Tab:
Notizen sind Punkte, Schlagwörter Ringe, und Linien sind die Verknüpfungen
zwischen Notizen und die Schlagwörter, die Notizen tragen. Je mehr Notizen auf
eine Notiz verweisen oder je mehr sie selbst verweist, desto größer ihr Punkt.
Notizen sind nach ihrem obersten Ordner eingefärbt, solange die Einstellungen
nichts anderes sagen. Starte sie aus der Befehlspalette, wo du ihr ein
Tastenkürzel geben kannst, oder aus der Ansicht **Lokaler Graph** in der
Seitenleiste.

**Lokaler Graph** in der Seitenleiste zeigt die geöffnete Notiz und die Notizen
und Schlagwörter in ihrer Nähe und folgt dir, wenn du die Notiz wechselst. Den
ganzen Tresor gibt es nur im Tab.

- Klicke auf eine Notiz, um sie zu öffnen.
- Klicke auf ein Schlagwort, um nur die Notizen in seiner Nähe zu sehen.
  **Ganzen Tresor zeigen** im Tab oder **Zurück zur offenen Notiz** in der
  Seitenleiste kehrt zurück.
- Ziehe eine Notiz, um sie zu verschieben, und scrolle zum Zoomen. Um die
  Ansicht zu verschieben, ziehe den Hintergrund oder ziehe irgendwo mit der
  mittleren oder rechten Maustaste. Namen erscheinen beim
  Hineinzoomen, die größten Notizen zuerst.
- Zeige auf eine Notiz, um hervorzuheben, womit sie verknüpft ist.
- Der ganze Tresor wächst beim Öffnen an seinen Platz, die älteste Notiz
  zuerst. Der Abspielknopf oben rechts zeigt das noch einmal, in beiden
  Graphen.

Auf dem Handy öffnet der Graph-Knopf über deinen Notizen den ganzen Tresor.
Tippe auf eine Notiz, um hervorzuheben, womit sie verknüpft ist, und dann auf
**Öffnen**, um sie zu öffnen. Ziehe mit einem Finger, um die Ansicht zu
verschieben, und zoome mit zwei Fingern. Um eine Notiz zu verschieben, lass den
Finger einen Moment auf ihr ruhen, bevor du ziehst. Den lokalen Graphen gibt es
auf dem Handy noch nicht.

Eine Verknüpfung ist ein Link auf eine andere Notiz im Text einer Notiz, etwa
einer, der mit `[[` angelegt wurde. Links aus Notizen, die keine
Markdown-Notizen sind, werden nicht gezeigt.

## Einstellungen

Der Knopf oben rechts im Graphen öffnet seine Einstellungen daneben. Es sind
dieselben wie unter **Einstellungen → Plugins**, und beide Graphen teilen sie.

Filter:

- **Nur Notizen zeigen mit**: Text, der im Titel, Ordner oder in den
  Schlagwörtern einer Notiz gesucht wird. Leer zeigt alle Notizen.
- **Schlagwörter zeigen**: ob Schlagwörter gezeichnet werden, verbunden mit
  ihren Notizen.
- **Unverknüpfte Notizen zeigen**: ob Notizen und Schlagwörter ohne
  Verknüpfungen gezeichnet werden.
- **Verknüpfungstiefe um die offene Notiz**: wie weit der lokale Graph oder der
  Graph um ein angeklicktes Schlagwort reicht. 1 zeigt nur, was direkt
  verknüpft ist.

Farben:

- **Notizen einfärben nach**: nach dem obersten Ordner, dem alphabetisch ersten
  Schlagwort oder gar nicht.
- **Verknüpfungen nach Richtung färben**: rund um die Notiz, auf die du zeigst,
  und um die offene Notiz im lokalen Graphen bekommen Notizen, auf die sie
  verweist, Notizen, die auf sie verweisen, und Notizen, die beides tun, je
  eine eigene Farbe. Eine Legende benennt sie.

Kräfte, jeweils in Prozent des Üblichen:

- **Zug zur Mitte**: wie eng der Graph zusammengezogen wird.
- **Abstoßung**: wie stark Notizen einander wegdrücken.
- **Zug der Verknüpfungen**: wie stark eine Verknüpfung ihre beiden Notizen
  zusammenzieht.
- **Länge der Verknüpfungen**: wie lang eine Verknüpfung sein möchte.

**Voreinstellungen** halten einen Satz dieser Einstellungen unter einem Namen
fest. Gib einen Namen ein und drücke **Speichern**, dann wähle die
Voreinstellung aus der Liste, um die Einstellungen zurückzuholen. Speichern
unter einem vorhandenen Namen ersetzt diese Voreinstellung. **Standard** in der
Liste und **Auf Standard zurücksetzen** setzen jede Einstellung zurück.

## Entfernen

Deaktiviere dieses Plugin, um den Graphen aus der Seitenleiste zu entfernen und
seinen Tab zu schließen. Deine Notizen und ihre Verknüpfungen bleiben, wie sie
sind.
