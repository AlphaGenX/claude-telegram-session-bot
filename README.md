# Claude Code per Telegram fernsteuern

Ein Telegram-Bot, der Claude-Code-Sessions auf einem Linux-Server steuert — Sessions vom Handy eröffnen, Aufträge geben, Berechtigungen per Button freigeben. Zwei Node-Scripts, null Dependencies, kein offener Port.

**Ausführliche Anleitung als Website:** https://alphagenx.github.io/claude-telegram-session-bot/

## Features

- Jede Telegram-Nachricht ist ein Auftrag an die aktive Claude-Session — mit vollem Gesprächsgedächtnis
- Sessions eröffnen, wechseln, auflisten, beenden: `/neu`, `/sessions`, `/wechsel`, `/clear`, `/ende`
- Projektverzeichnis je Session wählbar: `/projekte`, `/neu <projekt> [Auftrag]`
- Berechtigungsmodus je Session: `/modus standard|edits|plan|voll` (wie das Shift+Tab-Menü in Claude Code)
- Braucht Claude eine Berechtigung (z. B. Shell), kommt eine Telegram-Anfrage mit **Erlauben/Ablehnen-Buttons**; die Nachricht zeigt danach sichtbar ERLAUBT / ABGELEHNT / ABGELAUFEN
- `/status` liefert den fertigen SSH-Befehl, um jede Session am Rechner als volle interaktive Claude-Code-Sitzung fortzusetzen
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
| `/modus [standard\|edits\|plan\|voll]` | Berechtigungsmodus anzeigen bzw. setzen |
| `/sessions` | Alle Sessions mit Verzeichnis und Modus |
| `/wechsel N` | Aktive Session wechseln |
| `/status` | Stand + SSH-Befehl zum Fortsetzen am Rechner |
| `/clear` | Kontext leeren, frisch im selben Verzeichnis |
| `/ende` | Session ablegen (Transkript bleibt unter `~/.claude/projects/`) |

## Stellschrauben

| Wo | Was | Bedeutung |
|---|---|---|
| `telegram-session.env` | `BOT_TOKEN`, `CHAT_ID` | Zugang; die Chat-ID ist die einzige Schranke |
| `telegram-session.mjs` | `DEFAULT_CWD`, `HOST` | Standard-Verzeichnis, Servername für `/status` |
| `telegram-session.mjs` | `MCP_TOOL_TIMEOUT: "360000"` | Muss größer sein als die Button-Wartezeit |
| `permission-mcp.mjs` | `300000` in `frage()` | Wartezeit auf den Button (5 Min), danach abgelehnt |
| `claude-projekte.json` | Name → Pfad | Projekt-Kurznamen für `/neu` |

## Sicherheit

- Die **Chat-ID-Whitelist ist die einzige Schranke** — Token geheim halten, Bot-Namen nicht öffentlich teilen. Bei Verdacht: `/revoke` bei @BotFather, neuen Token in die env, Dienst neu starten
- Keine offenen Ports nötig: Long Polling nutzt nur ausgehende HTTPS-Verbindungen
- Wer dem Bot schreiben darf, gibt Claude Aufträge mit Schreibzugriff auf den Server — entsprechend behandeln

## Lizenz

MIT — siehe [LICENSE](LICENSE).
