# Claude Code per Telegram fernsteuern

Ein Telegram-Bot, der Claude-Code-Sessions auf einem Linux-Server steuert — Sessions vom Handy eröffnen, Aufträge geben, Berechtigungen per Button freigeben. Zwei Node-Scripts, null Dependencies, kein offener Port.

**Ausführliche Anleitung als Website:** https://alphagenx.github.io/claude-telegram-session-bot/

## Features

- Jede Telegram-Nachricht ist ein Auftrag an die aktive Claude-Session — mit vollem Gesprächsgedächtnis
- Sessions eröffnen, wechseln, auflisten, beenden: `/neu`, `/sessions`, `/wechsel`, `/clear`, `/ende`
- Projektverzeichnis je Session wählbar: `/projekte`, `/neu <projekt> [Auftrag]`
- Berechtigungsmodus je Session: `/modus standard|edits|plan|voll` (wie das Shift+Tab-Menü in Claude Code)
- Sprachmodell je Session: `/modell opus|sonnet|haiku|standard` — Bauaufträge auf Opus, schnelle Handgriffe auf Haiku
- Braucht Claude eine Berechtigung (z. B. Shell), kommt eine Telegram-Anfrage mit **Erlauben/Ablehnen-Buttons**; die Nachricht zeigt danach sichtbar ERLAUBT / ABGELEHNT / ABGELAUFEN
- `/status` liefert den fertigen SSH-Befehl, um jede Session am Rechner als volle interaktive Claude-Code-Sitzung fortzusetzen
- `/usage` zeigt den Kontext-Verbrauch der aktiven Session — direkt aus dem Transkript, kostenlos ohne Claude-Lauf
- Web-Suche (`WebSearch`/`WebFetch`) ist fest erlaubt
- Nur die eigene Telegram-Chat-ID wird akzeptiert; Long Polling, keine offenen Ports

## Wie es funktioniert

Der Bot nutzt die dokumentierte Headless-Schnittstelle von Claude Code:

```bash
claude -p "Auftrag" --output-format json          # liefert session_id
claude -p "Folgeauftrag" --resume <session_id>    # setzt fort
```

Wichtig: `--resume` liefert je Aufruf eine **neue** Session-ID (Fork) — der Bot übernimmt sie automatisch ins Register (`/root/.claude-sessions.json`).

Berechtigungen delegiert Claude Code per `--permission-prompt-tool` an einen Mini-MCP-Server (`permission-mcp.mjs`), der die Anfrage als Telegram-Buttons stellt und bis zu 5 Minuten auf den Klick wartet. **Stolperfalle:** Claude Code bricht MCP-Aufrufe standardmäßig nach ~30 s ab — deshalb setzt der Bot `MCP_TOOL_TIMEOUT=360000`. Ohne diesen Wert läuft jede Freigabe ins Leere.

Zwei Eigenheiten, die man kennen sollte:
- Harmlose read-only-Befehle (`uptime`, `ls` …) führt Claude Code ohne Anfrage aus — gewollt, keine Button-Flut
- Im Modus `edits` (Standard) sind Dateiänderungen bewusst freigegeben; wer jede Änderung bestätigen will, nimmt `/modus standard`

## Installation

Voraussetzungen: Linux-Server (getestet: Ubuntu 24.04), Node.js 22+, [Claude Code](https://code.claude.com/docs/en/setup) installiert und angemeldet (Pro/Max-Abo). Die Scripts nehmen Betrieb als `root` an — Pfade sonst anpassen.

> **Wichtig:** Unter root verweigert Claude Code den Modus `voll` (`bypassPermissions`) grundsätzlich — die anderen drei Modi laufen normal. Wer `voll` braucht, betreibt Bot und Claude als eigenen unprivilegierten Benutzer (Unit mit `User=`, Pfade von `/root/…` auf das Home des Benutzers umstellen, Claude-Login unter diesem Benutzer). Angenehmer Nebeneffekt: Ein kompromittierter Bot hat keine root-Rechte.

**Vorbereitung (2 Minuten):**
1. In Telegram `@BotFather` anschreiben: `/newbot` → Token notieren
2. Dem neuen Bot einmal `/start` schicken
3. Chat-ID auslesen: `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates"` → Wert `chat.id`

**Schnellweg:**

```bash
git clone https://github.com/AlphaGenX/claude-telegram-session-bot.git
cd claude-telegram-session-bot
sudo bash install.sh          # fragt Token, Chat-ID, Hostname, Arbeitsverzeichnis ab
```

**Manuell:** Die Dateien tun genau das, was der Installer automatisiert:

| Datei | Ziel | Anmerkung |
|---|---|---|
| `telegram-session.mjs` | `/root/bin/` | `HOST`-Konstante auf eigenen Servernamen setzen, `chmod +x` |
| `permission-mcp.mjs` | `/root/bin/` | `chmod +x` |
| `perm-mcp.json` | `/root/bin/` | MCP-Registrierung für den Freigabe-Server |
| `telegram-session.env.example` | `/root/.config/telegram-session.env` | Token und Chat-ID eintragen, `chmod 600` |
| `claude-projekte.json.example` | `/root/.config/claude-projekte.json` | Kurzname → Verzeichnis |
| `telegram-session.service` | `/etc/systemd/system/` | dann `systemctl daemon-reload && systemctl enable --now telegram-session` |

**Testfolge in Telegram:**
1. `/start` → Hilfe
2. „Wie ist das Wetter in Hamburg?" → erste Session, Antwort mit Websuche
3. „Führe uptime aus" → läuft ohne Nachfrage (read-only)
4. „Lege /root/test per touch an" → Freigabe-Button, nach Erlauben wird ausgeführt

## Befehle

| Befehl | Wirkung |
|---|---|
| *(Nachricht)* | Auftrag an die aktive Session; ohne aktive wird eine neue eröffnet |
| `/neu [projekt\|/pfad] [Auftrag]` | Neue Session, Verzeichnis wählbar |
| `/projekte` / `/projekte add name /pfad` | Verzeichnisse anzeigen / registrieren |
| `/modus [standard\|edits\|plan\|auto\|voll]` | Berechtigungsmodus anzeigen bzw. setzen (`voll` braucht einen Nicht-root-Betrieb) |
| `/modell [opus\|sonnet\|haiku\|standard]` | Sprachmodell anzeigen bzw. setzen; gilt ab dem nächsten Auftrag |
| `/sessions` | Alle Sessions mit Verzeichnis, Modus und Modell |
| `/wechsel N` | Aktive Session wechseln |
| `/status` | Stand + SSH-Befehl zum Fortsetzen am Rechner |
| `/usage` | Kontext-Verbrauch der aktiven Session: Balken, Prozent, Token-Stand, Modell |
| `/remote-control` bzw. `/rc` [aus] | Aktive Session in der Claude-App bzw. auf claude.ai/code weiterführen; `aus` beendet |
| `/fortsetzen` / `/verwerfen` | Nach einem Neustart wartende Aufträge ausführen oder löschen |
| `/clear` | Kontext leeren, frisch im selben Verzeichnis |
| `/ende` | Session ablegen (Transkript bleibt unter `~/.claude/projects/`) |

## Stellschrauben

| Wo | Was | Bedeutung |
|---|---|---|
| `telegram-session.env` | `BOT_TOKEN`, `CHAT_ID` | Zugang; die Chat-ID ist die einzige Schranke |
| `telegram-session.mjs` | `DEFAULT_CWD`, `HOST` | Standard-Verzeichnis, Servername für `/status` |
| `telegram-session.mjs` | `MCP_TOOL_TIMEOUT: "360000"` | Muss größer sein als die Button-Wartezeit |
| `telegram-session.mjs` | `MODELLE` | Modell-IDs hinter `/modell` — bei neuen Claude-Versionen anpassen |
| `permission-mcp.mjs` | `PERM_TIMEOUT_MS` (Env, Standard `300000`) | Wartezeit auf den Button (5 Min), danach abgelehnt |
| `telegram-session.mjs` | `PERM_DIR` | Austauschverzeichnis zwischen Bot und Permission-MCP (Standard `/root/.perm`) |
| `claude-projekte.json` | Name → Pfad | Projekt-Kurznamen für `/neu` |
| `telegram-session.mjs` | `PING_ALLE` | Abstand des Capability-Pings (6 h), erster Lauf 15 min nach Start |
| `telegram-session.mjs` | `20` und `10000` im Fortschritts-Ticker | Anzeige ab 20 s Laufzeit, Aktualisierung alle 10 s |

## Sicherheit

- Die **Chat-ID-Whitelist ist die einzige Schranke** — Token geheim halten, Bot-Namen nicht öffentlich teilen. Bei Verdacht: `/revoke` bei @BotFather, neuen Token in die env, Dienst neu starten
- Keine offenen Ports nötig: Long Polling nutzt nur ausgehende HTTPS-Verbindungen
- Wer dem Bot schreiben darf, gibt Claude Aufträge mit Schreibzugriff auf den Server — entsprechend behandeln
- **Der Bot-Token wird dem Claude-Subprozess nicht vererbt** (seit v8). Sonst kann ein über Dateiinhalte gekaperter Lauf ihn auslesen und Daten über `api.telegram.org` an eine fremde `chat_id` senden — ein Weg, den keine Firewall schließt, weil Telegram erreichbar sein muss, damit der Bot überhaupt funktioniert
- **Empfehlung:** Bot und Claude als eigenen unprivilegierten Benutzer betreiben statt als root — begrenzt den Schaden eines missbrauchten Zugangs und schaltet nebenbei den Modus `voll` frei

## Versionen

- **v12** (2026-09-08): Doppeltipp-Härtung — ein zweiter Tipp auf einen Freigabe-Button erzeugt keine verwaiste Antwortdatei mehr, sondern meldet „Schon beantwortet"; die Antwort wird nur bei noch offener Anfrage geschrieben. Unbekannte Slash-Befehle werden abgefangen und nicht mehr an die CLI durchgereicht (Pfade mit zweitem Schrägstrich laufen weiter als Auftrag)
- **v11.3** (2026-09-08): eine einzige Versionsnummer als Quelle (Konstante `VERSION`), Startmeldung und `/status` leiten ab; Selbstprüfung beim Start meldet Drift zwischen Konstante und höchster Changelog-Zeile
- **v11.2** (2026-09-07): Befehle unabhängig von Groß-/Kleinschreibung (`/Status` = `/status`), angehängtes `@botname` wird abgeschnitten — normalisiert wird nur das erste Wort, Pfade und Auftragstext bleiben buchstabengetreu
- **v11.1** (2026-09-07): Sicherheitshärtung nach ausführlichem Test. Session-Titel mit führenden `--` werden nicht mehr als `claude`-Flag geparst (Argument-Injection über `/rc`); das Freigabe-Verzeichnis `PERM_DIR` wird beim Start hart auf `0700` gezogen
- **v11** (2026-09-07): Fünf Verbesserungen aus einem Community-Fork, eigenständig umgesetzt. **Schutzzweig**: In Git-Verzeichnissen legt der Bot vor dem ersten Lauf einer Session einen Zweig `bot/<zeit>` an — der Bot legt ihn an, nicht das Modell, damit die Sicherung nicht per Prompt Injection aushebelbar ist; Änderungen werden auf dem Zweig committet, die Antwort nennt Zweig und Diffstat. **Persistente Warteschlange**: wartende Aufträge überleben Neustarts, der Bot fragt per `/fortsetzen`/`/verwerfen` statt still weiterzumachen. **Capability-Ping**: alle 6 h beweist ein Haiku-Mini-Lauf im Leerlauf, dass Claude wirklich antworten kann — ein Prozess-Check bemerkt „Dienst läuft, Login tot" nicht. **Fortschrittsanzeige**: ab 20 s Laufzeit eine still per `editMessageText` fortgeschriebene Nachricht (Edits lösen keine Benachrichtigung aus), Inhalt aus dem wachsenden Live-Transkript. **Kostenzählung** je Session aus `total_cost_usd` in `/status` und `/usage`
- **v10** (2026-09-07): `/remote-control` (Kurzform `/rc`) führt die aktive Session in der Claude-App bzw. auf claude.ai/code weiter — `claude --resume <id> --remote-control` in tmux, der Bot meldet die App-URL. Einmalig nötig: frischer `claude /login`, der Token braucht den Scope `user:sessions:claude_code`. `/rc aus` beendet, die Session bleibt
- **v9** (2026-09-07): `/neu <name>` (ein einzelnes namensartiges Wort) legt ein neues Projektverzeichnis an und registriert es; frei formulierte Aufträge hinter `/neu` verhalten sich unverändert
- **v8** (2026-09-07): Drei Korrekturen aus einem Fork-Review. `is_error` des Result-JSON wird ausgewertet — `claude -p` meldet API-Fehler mit **Exit-Code 0 und `subtype: "success"`**, der Fehlertext landete dadurch als vermeintliche Claude-Antwort im Chat, während der Dienst gesund aussah. **Der Bot-Token wird nicht mehr an den Claude-Subprozess vererbt**; dazu Permission-MCP v3, der seine Anfragen tokenlos über Dateien stellt statt selbst die Telegram-API zu rufen. `standard` nutzt `manual` statt des nicht mehr gelisteten `default`, neuer Modus `auto`
- **v7** (2026-09-05): `/usage`-Befehl — Kontext-Verbrauch der aktiven Session aus dem Session-Transkript (letzter API-Call, Subagenten ausgefiltert), Kontextfenster wird je Auftrag aus dem Result-JSON gemerkt statt hartcodiert; ab 70 % Hinweis auf `/clear`
- **v6.1** (2026-09-04): stdin des Claude-Prozesses wird sofort geschlossen (spart 3 Sekunden Wartezeit je Auftrag); Fehlermeldungen zeigen das Ende der Meldung statt des Kommando-Echos — da steht die Ursache
- **v6** (2026-09-04): `/modell`-Befehl, Sprachmodell je Session
- **v5** (2026-09-03): Erstveröffentlichung — Session-Verwaltung, Projektverzeichnisse, Freigabe-Buttons mit sichtbarem Feedback, `/modus`

## Lizenz

MIT — siehe [LICENSE](LICENSE).
