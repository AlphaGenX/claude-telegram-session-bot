#!/usr/bin/env bash
# Installer: Claude Code Telegram Session-Bot
# Fragt die noetigen Werte ab, installiert Scripts, env und systemd-Dienst.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Bitte als root ausfuehren (sudo bash install.sh)."; exit 1; }
command -v node >/dev/null || { echo "Node.js 22+ wird benoetigt."; exit 1; }

CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
if [ ! -x "$CLAUDE_BIN" ]; then
  echo "Claude Code nicht gefunden unter $CLAUDE_BIN"
  echo "Installieren: curl -fsSL https://claude.ai/install.sh | bash  (danach 'claude' starten und anmelden)"
  exit 1
fi

echo "== Claude Code Telegram Session-Bot: Installation =="
read -rp "Bot-Token (von @BotFather): " BOT_TOKEN
read -rp "Deine Telegram-Chat-ID: " CHAT_ID
read -rp "Server-Hostname (fuer den SSH-Hinweis in /status): " HOSTN
read -rp "Standard-Arbeitsverzeichnis [/root/vault]: " DEFCWD
DEFCWD=${DEFCWD:-/root/vault}
[ -d "$DEFCWD" ] || { echo "Hinweis: $DEFCWD existiert noch nicht — bitte anlegen, bevor der erste Auftrag kommt."; }

mkdir -p /root/bin /root/.config

install -m 755 telegram-session.mjs /root/bin/telegram-session.mjs
install -m 755 permission-mcp.mjs /root/bin/permission-mcp.mjs
install -m 644 perm-mcp.json /root/bin/perm-mcp.json

sed -i "s|<DEIN-SERVER>|$HOSTN|" /root/bin/telegram-session.mjs
sed -i "s|/root/vault|$DEFCWD|g" /root/bin/telegram-session.mjs

printf 'BOT_TOKEN=%s\nCHAT_ID=%s\n' "$BOT_TOKEN" "$CHAT_ID" > /root/.config/telegram-session.env
chmod 600 /root/.config/telegram-session.env

if [ ! -f /root/.config/claude-projekte.json ]; then
  printf '{"standard": "%s"}\n' "$DEFCWD" > /root/.config/claude-projekte.json
fi

install -m 644 telegram-session.service /etc/systemd/system/telegram-session.service
systemctl daemon-reload
systemctl enable --now telegram-session
sleep 2

if systemctl is-active --quiet telegram-session; then
  echo ""
  echo "Fertig. Der Bot laeuft — schick ihm in Telegram /start."
  echo "Logs: journalctl -u telegram-session -f"
  echo "Hinweis: Der Modus 'voll' funktioniert nicht unter root — Claude Code verweigert bypassPermissions mit root-Rechten. Dafuer den Bot als eigenen Benutzer betreiben."
else
  echo "Dienst laeuft nicht — Log pruefen: journalctl -u telegram-session -n 20"
  exit 1
fi
