#!/usr/bin/env node
// Session-Bot: steuert Claude-Code-Sessions auf dem VPS per Telegram.
// Die aktuelle Version steht als Konstante VERSION im Code, NICHT hier - die
// Changelog-Zeilen unten sind Historie, die unterste ist der aktuelle Stand.
// Beim Start prueft der Bot beides gegeneinander und warnt bei Abweichung.
// Jede normale Nachricht ist ein Auftrag an die aktive Session.
// Hinweis: Der Modus "voll" (bypassPermissions) funktioniert nicht, wenn der Bot als root laeuft - Claude Code verweigert das grundsaetzlich.
// v2: Projektverzeichnis waehlbar. v3: /clear, Web-Zugriff, Freigabe-Buttons. v4: /modus je Session.
// v5: Button-Klick editiert die Anfrage-Nachricht (ERLAUBT/ABGELEHNT sichtbar), realistische Antwortzeit-Ansagen.
// v6: /modell-Befehl - Sprachmodell je Session waehlbar (opus, sonnet, haiku, standard).
// v6.1: stdin sofort geschlossen (spart 3s Wartezeit je Auftrag), Fehlertexte zeigen das Ende der Meldung statt des Kommando-Echos.
// v7: /usage-Befehl - Kontext-Verbrauch der aktiven Session aus dem Transkript, Kontextfenster je Lauf aus modelUsage gemerkt.
// v8: is_error wird geprueft (API-Fehler kamen als Exit 0 durch), Bot-Token nicht mehr an den
//     Claude-Subprozess, Permission-MCP v3 tokenlos ueber Dateien, Modus standard=manual plus auto.
// v9: /neu <name> (ein Wort) legt ein neues Projektverzeichnis unter /root/projekte an und registriert es.
// v10: /remote-control (Kurzform /rc) fuehrt die aktive Session in der Claude-App weiter - tmux + claude --resume --remote-control.
// v11: fuenf Ideen aus Lars Nowaks Fork - Schutzzweig in Git-Verzeichnissen, persistente Warteschlange
//      (/fortsetzen, /verwerfen), Capability-Ping im Leerlauf, Fortschrittsanzeige per editMessageText,
//      Kostenzaehlung je Session aus total_cost_usd.
// v11.1: Sicherheitshaertung - Session-Titel mit fuehrenden -- werden nicht mehr als claude-Flag
//        geparst (Arg-Injection ueber /rc), PERM_DIR beim Start hart auf 0700.
// v11.2: Befehle unabhaengig von Gross-/Kleinschreibung (/Status = /status), angehaengtes
//        @botname wird abgeschnitten. Normalisiert wird nur das erste Wort - Pfade und
//        Auftragstext bleiben buchstabengetreu.
// v11.3: eine Versionsnummer statt zwei - VERSION-Konstante ist die einzige Quelle,
//        Startmeldung und /status leiten ab, Selbstpruefung beim Start meldet Drift
//        zwischen Konstante und hoechster Changelog-Zeile.
// v12: Doppeltipp-Haertung - ein zweiter Button-Tipp erzeugt keine verwaiste Antwortdatei
//      mehr, sondern meldet "Schon beantwortet". Unbekannte Slash-Befehle werden abgefangen
//      statt als CLI-Kommando an Claude durchgereicht.
// v13: Kurzbefehle - feste Alias-Tabelle (ALIAS), die direkt nach der Gross-/Kleinschreibung
//      auf den Langbefehl expandiert wird. Die Befehlskette darunter bleibt unveraendert,
//      deshalb stimmen alle slice()-Offsets weiter: unten kommt immer die Langform an.
// v13.1: Laufzeitmessung im Journal - je Nachricht der Weg von Telegram zum Bot (aus msg.date)
//        und die Zeit bis zur ersten Antwort, dazu die reine Dauer des sendMessage-Aufrufs.
// v14: /neu <name> eroeffnet die Session sofort - ein kurzer Eroeffnungsauftrag erzeugt die
//      Session-ID, statt auf die naechste Nachricht zu warten. Der Sessiontitel ist dabei der
//      Projektname, nicht der Auftragstext.
// v15: Code-Review-Runde. Behoben: SSH-Hinweis in /status kommt aus der HOST-Konstante,
//      send() und pump() koennen den Prozess nicht mehr ueber eine unbehandelte Rejection
//      beenden (try/finally plus Wiederholversuch), Update-Offset ueberlebt den Neustart
//      (keine Doppelausfuehrung), laufender Auftrag geht beim Neustart nicht mehr still
//      verloren, Lost-Update auf der Registry, Prototypen-Treffer bei MODI/MODELLE/projekte,
//      slice()-Offsets durch befehl() ersetzt, /start-Hilfe aus BEFEHLE abgeleitet samt
//      Drift-Selbstpruefung, "/ befehl" mit Leerzeichen wird abgefangen.
// v15.1: /s zeigt die Hilfe, wie /h. Bewusst auf /start gelegt und nicht auf /status oder
//        /sessions: /s wird intuitiv getippt, und wer sich vertippt, landet lieber in der
//        Hilfe als in einer Ausgabe, die er nicht gemeint hat. Dazu: Die Versions-Selbstpruefung
//        liest den Kopf bis zur ersten import-Zeile statt bis Zeile 40 - der Changelog war
//        ueber das feste Fenster hinausgewachsen und die Pruefung meldete eine Scheindrift.
// Befehle: siehe BEFEHLE-Tabelle - /start leitet die Hilfe daraus ab
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, chmodSync } from "node:fs";
import { execFile } from "node:child_process";

// Einzige Stelle mit der aktuellen Versionsnummer. Startmeldung, /status und die
// Selbstpruefung leiten sich daraus ab. Bei einer neuen Version: hier hochzaehlen
// UND unten eine Changelog-Zeile ergaenzen - die Pruefung beim Start meldet, wenn
// nur eines von beidem passiert ist.
const VERSION = "15.1";

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = Number(process.env.CHAT_ID);
const API = `https://api.telegram.org/bot${TOKEN}`;
const REG = "/root/.claude-sessions.json";
const PROJ = "/root/.config/claude-projekte.json";
const PROJEKTE_DIR = "/root/projekte"; // v9: Ablage fuer per /neu angelegte Projekte

// v13: Kurzbefehle. Schluessel ohne Slash, Wert ist der Langbefehl. Expandiert wird an genau
// einer Stelle (Normalisierung des ersten Wortes, siehe unten) - die Befehlskette kennt nur
// die Langform. Neue Kurzform: hier eintragen, der Hilfetext von /start zieht automatisch nach.
const ALIAS = {
  n: "neu", p: "projekte", m: "modus", ml: "modell", ss: "sessions", w: "wechsel",
  st: "status", u: "usage", c: "clear", e: "ende", f: "fortsetzen", v: "verwerfen",
  rc: "remote-control", h: "start", s: "start",
};
const ALIAS_HILFE = Object.entries(ALIAS).map(([k, v]) => `/${k} = /${v}`).join(", ");

// v15: Eine Tabelle als Quelle fuer den Hilfetext. Vorher war die /start-Ausgabe eine von Hand
// gepflegte Kopie der Befehlskette - dieselbe Sorte doppelte Wahrheit, die v11.3 bei der
// Versionsnummer beseitigt hat. Die Selbstpruefung beim Start haelt Tabelle und Handler gegeneinander.
const BEFEHLE = [
  { name: "neu", arg: "[projekt|/pfad] [Auftrag]", hilfe: "neue Session; ein einzelnes neues Wort legt das Projekt an und eroeffnet sofort" },
  { name: "projekte", arg: "[add name /pfad]", hilfe: "Verzeichnisse zeigen, mit add registrieren" },
  { name: "modus", arg: "[standard|edits|plan|auto|voll]", hilfe: "Berechtigungsmodus je Session" },
  { name: "modell", arg: "[opus|sonnet|haiku|standard]", hilfe: "Sprachmodell je Session" },
  { name: "sessions", arg: "", hilfe: "alle Sessions" },
  { name: "wechsel", arg: "N", hilfe: "Session wechseln" },
  { name: "status", arg: "", hilfe: "Stand plus SSH-Befehl zum Fortsetzen am Rechner" },
  { name: "usage", arg: "", hilfe: "Kontext-Verbrauch der aktiven Session" },
  { name: "clear", arg: "", hilfe: "Kontext leeren, frisch im selben Verzeichnis" },
  { name: "ende", arg: "", hilfe: "aktive Session ablegen" },
  { name: "remote-control", arg: "[aus]", hilfe: "Session in der Claude-App weiterfuehren" },
  { name: "fortsetzen", arg: "", hilfe: "nach einem Neustart wartende Auftraege starten" },
  { name: "verwerfen", arg: "", hilfe: "wartende Auftraege loeschen" },
  { name: "start", arg: "", hilfe: "diese Hilfe" },
];
const HILFE_LISTE = BEFEHLE.map((b) => `/${b.name}${b.arg ? " " + b.arg : ""} - ${b.hilfe}`).join("\n");

// v15: Loest die slice()-Offsets ab. Vorher stand an jeder Aufrufstelle eine gezaehlte Zahl
// (text.slice(6) fuer /modus, slice(15) fuer /remote-control) - eine Umbenennung haette das
// Argument-Parsing still zerschossen. Rueckgabe: das Argument, "" ohne Argument, null wenn
// der Text diesen Befehl nicht meint.
function befehl(text, name) {
  const pre = "/" + name;
  if (text === pre) return "";
  if (text.startsWith(pre + " ")) return text.slice(pre.length + 1).trim();
  return null;
}
// v15: Lookup ohne Treffer aus der Prototypenkette. Vorher lief "/modus constructor" in den
// Erfolgszweig, weil MODI["constructor"] die Object-Funktion lieferte.
const ausTabelle = (obj, schluessel) => (Object.hasOwn(obj, schluessel) ? obj[schluessel] : undefined);
const PERM_DIR = "/root/.perm";
const DEFAULT_CWD = "/root/vault";
const DEFAULT_MODE = "acceptEdits";
const PROJECTS = "/root/.claude/projects";
const FENSTER_FALLBACK = 200000; // solange kein Lauf das echte Kontextfenster gemeldet hat
const CLAUDE = "/root/.local/bin/claude";
// Eigene Serveradresse eintragen - sie erscheint im SSH-Hinweis von /status.
const HOST = "<DEIN-SERVER>";
// v8-Fix 3: BOT_TOKEN und CHAT_ID NICHT an den Claude-Subprozess weiterreichen. Sonst kann ein
// per Prompt Injection gekaperter Lauf (siehe Sicherheitshinweis in der Projektnotiz) den Token
// lesen und ueber api.telegram.org an eine beliebige chat_id senden - also Vault-Inhalte
// exfiltrieren, ueber genau den Kanal, der offen sein muss, damit der Bot funktioniert.
// Mit Firewall-Regeln nicht zu schliessen, deshalb hier.
const { BOT_TOKEN: _t, CHAT_ID: _c, ...SAFE_ENV } = process.env;
const ENV = { ...SAFE_ENV, HOME: "/root", PERM_DIR, MCP_TOOL_TIMEOUT: "360000", PATH: "/root/.local/bin:" + (SAFE_ENV.PATH || "/usr/bin:/bin") };

// Telegram-Name -> claude --permission-mode
// v8-Fix 1: "default" ist als permission-mode nicht mehr gueltig, /modus standard brach damit ab.
// Gueltig auf 2.1.260: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan (claude --help).
const MODI = { standard: "manual", edits: "acceptEdits", plan: "plan", auto: "auto", voll: "bypassPermissions" };
const modusName = (wert) => (Object.entries(MODI).find(([, v]) => v === (wert || DEFAULT_MODE)) || ["edits"])[0];

// Telegram-Name -> claude --model. null bedeutet: kein Flag, Claude Code entscheidet
const MODELLE = { opus: "claude-opus-5", sonnet: "claude-sonnet-5", haiku: "claude-haiku-4-5" };
const modellName = (wert) => (Object.entries(MODELLE).find(([, v]) => v === wert) || ["standard"])[0];

const load = () => { try { return JSON.parse(readFileSync(REG, "utf8")); } catch { return { sessions: [], aktiv: null, naechstesCwd: null, naechsterModus: null, naechstesModell: null }; } };
const save = (r) => writeFileSync(REG, JSON.stringify(r, null, 2));
const loadProj = () => { try { return JSON.parse(readFileSync(PROJ, "utf8")); } catch { return { vault: DEFAULT_CWD }; } };
const saveProj = (p) => writeFileSync(PROJ, JSON.stringify(p, null, 2));
const kurz = (cwd) => {
  const c = cwd || DEFAULT_CWD;
  const hit = Object.entries(loadProj()).find(([, v]) => v === c);
  return hit ? hit[0] : c.split("/").filter(Boolean).pop();
};
const wann = (t) => new Date(t).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const tsd = (n) => n.toLocaleString("de-DE");

// Kontext-Verbrauch aus dem Session-Transkript: letzte assistant-Zeile (ohne Subagenten) zaehlt.
// input + cache_read + cache_creation = Kontextgroesse beim letzten API-Call. Kostenlos, kein Claude-Lauf.
function kontextStand(sessionId) {
  let pfad = null;
  try {
    for (const dir of readdirSync(PROJECTS)) {
      const p = `${PROJECTS}/${dir}/${sessionId}.jsonl`;
      if (existsSync(p)) { pfad = p; break; }
    }
  } catch {}
  if (!pfad) return null;
  let zeilen;
  try { zeilen = readFileSync(pfad, "utf8").split("\n"); } catch { return null; }
  for (let i = zeilen.length - 1; i >= 0; i--) {
    if (!zeilen[i].includes('"assistant"')) continue;
    try {
      const j = JSON.parse(zeilen[i]);
      if (j.type !== "assistant" || j.isSidechain || !j.message?.usage) continue;
      const u = j.message.usage;
      const kontext = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (kontext > 0) return { kontext, modell: j.message.model || null };
    } catch {}
  }
  return null;
}
const DAUER = "Antwort kommt meist unter einer Minute, groessere Auftraege brauchen laenger.";

// v13.1: Laufzeitmessung. antwortMessung haelt den Eingangszeitpunkt der zuletzt empfangenen
// Nachricht, die erste Antwort danach protokolliert die Spanne. Zusammen mit dem Weg-Wert im
// Eingangslog zeigt das, ob Sekunden vor dem Bot entstehen (Handy, Telegram, Netz) oder in ihm.
let antwortMessung = null;

// v15: Ein Teilstueck senden, mit Wiederholung und ohne je zu werfen. Das fetch hier scheitert
// im Betrieb gelegentlich (im Journal als "Loop: fetch failed" sichtbar). Ungeschuetzt aus
// pump() heraus haette diese Rejection den Prozess beendet - Node beendet seit v15 bei einer
// unbehandelten Rejection -, der laufende Auftrag waere still verloren und die Antwort nie
// angekommen. Deshalb faengt send() alles selbst ab und meldet den Fehlschlag nur ins Journal.
async function sendeTeil(text, versuche = 3) {
  for (let v = 1; v <= versuche; v++) {
    try {
      const r = await fetch(`${API}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text }) });
      if (r.ok) return true;
      // Nur Ueberlast und Serverfehler sind einen zweiten Versuch wert. Ein 400 bleibt ein 400.
      if (r.status !== 429 && r.status < 500) {
        console.error(new Date().toISOString(), "sendMessage abgelehnt, HTTP", r.status);
        return false;
      }
      console.error(new Date().toISOString(), `sendMessage HTTP ${r.status}, Versuch ${v} von ${versuche}`);
    } catch (e) {
      console.error(new Date().toISOString(), `sendMessage Versuch ${v} von ${versuche}:`, (e && e.message) || e);
    }
    if (v < versuche) await new Promise((r) => setTimeout(r, 1000 * v));
  }
  return false;
}

async function send(text) {
  let s = String(text ?? "").trim() || "(leere Antwort)";
  if (s.length > 15200) s = s.slice(0, 15200) + "\n[gekuerzt]";
  const tSend = Date.now();
  for (let i = 0; i < s.length; i += 3800) {
    if (!(await sendeTeil(s.slice(i, i + 3800)))) break;
  }
  const api = ((Date.now() - tSend) / 1000).toFixed(2);
  if (antwortMessung !== null) {
    console.log(new Date().toISOString(), `Antwort nach ${((Date.now() - antwortMessung) / 1000).toFixed(2)}s (davon Telegram-API ${api}s)`);
    antwortMessung = null;
  } else if (Number(api) > 2) {
    console.log(new Date().toISOString(), `sendMessage langsam: ${api}s`);
  }
}

// v11: Nachricht senden und die message_id behalten (fuer die Fortschrittsanzeige)
async function sendMitId(text) {
  try {
    const r = await fetch(`${API}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: String(text).slice(0, 3900) }) });
    return (await r.json())?.result?.message_id ?? null;
  } catch { return null; }
}
// v11: Nachricht still umschreiben - ein Edit loest am Handy keine Benachrichtigung aus
async function edit(mid, text) {
  try {
    await fetch(`${API}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, message_id: mid, text: String(text).slice(0, 3900) }) });
  } catch {}
}
// v11: juengstes Transkript im Projektverzeichnis, das seit Auftragsstart gewachsen ist
function neuestesTranskript(cwd, seit) {
  try {
    const dir = PROJECTS + "/" + String(cwd || DEFAULT_CWD).replace(/\//g, "-");
    let best = null, bt = seit;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const m = statSync(`${dir}/${f}`).mtimeMs;
      if (m > bt) { bt = m; best = `${dir}/${f}`; }
    }
    return best;
  } catch { return null; }
}
// v11: letzte Aktivitaet aus dem Live-Transkript ziehen
function fortschrittText(pfad) {
  try {
    const zeilen = readFileSync(pfad, "utf8").trim().split("\n");
    for (let i = zeilen.length - 1; i >= 0; i--) {
      if (!zeilen[i].includes('"assistant"')) continue;
      let j; try { j = JSON.parse(zeilen[i]); } catch { continue; }
      if (j.type !== "assistant" || j.isSidechain) continue;
      for (const b of [...(j.message?.content || [])].reverse()) {
        if (b.type === "tool_use") { const d = b.input && (b.input.file_path || b.input.path || b.input.command); return "Werkzeug " + b.name + (d ? ": " + String(d).slice(-60) : ""); }
        if (b.type === "text" && b.text && b.text.trim()) return "Schreibt: " + b.text.trim().slice(0, 70);
      }
    }
  } catch {}
  return null;
}
// v11: Schutzzweig - nur in Git-Verzeichnissen, ein Zweig je Session. Der Bot legt ihn VOR dem
// Lauf an, damit die Sicherung im Bot liegt und nicht in der Bitte an das Modell.
async function schutzzweig(cwd, sess) {
  try {
    const g = await execP("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
    if (g.e || !/true/.test(g.out)) return null;
    if (sess && sess.zweig) return sess.zweig;
    const name = "bot/" + Date.now().toString(36);
    const b = await execP("git", ["-C", cwd, "checkout", "-b", name]);
    return b.e ? null : name;
  } catch { return null; }
}
async function zweigCommit(cwd, msg) {
  try {
    await execP("git", ["-C", cwd, "add", "-A"]);
    const c = await execP("git", ["-C", cwd, "-c", "user.name=Session-Bot", "-c", "user.email=bot@localhost", "commit", "-m", ("Bot: " + msg).slice(0, 72)]);
    if (c.e) return null;
    const st = await execP("git", ["-C", cwd, "show", "--stat", "--format=", "HEAD"]);
    const letzte = st.out.trim().split("\n").pop() || "";
    return letzte.trim() || "Commit erstellt";
  } catch { return null; }
}

// v8-Fix 3: Gegenstueck zum tokenlosen Permission-MCP. Der MCP legt die Anfrage als
// PERM_DIR/<id>.req ab, dieser Watcher verschickt sie und schreibt die Antwort als
// PERM_DIR/<id> zurueck (siehe Button-Handler in der Hauptschleife weiter unten).
const permMsg = new Map(); // id -> message_id der Anfrage-Nachricht
async function permWatch() {
  try {
    mkdirSync(PERM_DIR, { recursive: true, mode: 0o700 });
    for (const f of readdirSync(PERM_DIR)) {
      if (f.endsWith(".req.expired")) {
        const id = f.slice(0, -".req.expired".length);
        const mid = permMsg.get(id);
        if (mid) {
          await fetch(`${API}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: CHAT_ID, message_id: mid,
              text: "ABGELAUFEN - keine Antwort in 5 Minuten, automatisch abgelehnt." }) }).catch(() => {});
        }
        permMsg.delete(id);
        try { unlinkSync(`${PERM_DIR}/${f}`); } catch {}
        try { unlinkSync(`${PERM_DIR}/${id}.req`); } catch {}
        continue;
      }
      if (!f.endsWith(".req")) continue;
      const id = f.slice(0, -4);
      if (permMsg.has(id)) continue;
      let req; try { req = JSON.parse(readFileSync(`${PERM_DIR}/${f}`, "utf8")); } catch { continue; }
      // Platzhalter VOR dem await setzen: dieser Watcher laeuft im Sekundentakt, und ein
      // langsamer Telegram-Aufruf wuerde sonst zwei Durchlaeufe dieselbe Anfrage senden.
      permMsg.set(id, null);
      let mid = null;
      try {
        const resp = await fetch(`${API}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: CHAT_ID, text: `Claude bittet um Erlaubnis:\n${req.tool}\n${req.detail}`,
            reply_markup: { inline_keyboard: [[
              { text: "Erlauben", callback_data: `perm:${id}:ja` },
              { text: "Ablehnen", callback_data: `perm:${id}:nein` }
            ]] } }) });
        mid = (await resp.json())?.result?.message_id ?? null;
      } catch (e) { console.error(new Date().toISOString(), "PermWatch senden:", (e && e.message) || e); }
      // Kam die Nachricht nicht durch, den Platzhalter wieder freigeben - sonst bleibt die
      // Anfrage bis zum Ablauf unbeantwortet liegen, ohne dass sie je jemand gesehen hat.
      if (mid === null) permMsg.delete(id); else permMsg.set(id, mid);
    }
  } catch (e) { console.error(new Date().toISOString(), "PermWatch:", (e && e.message) || e); }
}
// Sicherheit: PERM_DIR hart auf 0700 - mkdirSync(mode) greift nicht auf ein vorhandenes Verzeichnis
try { mkdirSync(PERM_DIR, { recursive: true, mode: 0o700 }); chmodSync(PERM_DIR, 0o700); } catch {}
setInterval(permWatch, 1000);

// v10: Remote Control - die aktive Session laeuft interaktiv in tmux weiter und ist
// im Code-Tab der Claude-App bzw. unter claude.ai/code steuerbar. tmux-Argumente als
// argv-Array, nie als Shell-String (Quoting-Kante aus dem Fork-Review).
const execP = (cmd, args) => new Promise((res) => execFile(cmd, args, { env: ENV }, (e, out, err) => res({ e, out: String(out || ""), err: String(err || "") })));
const rcName = (sid) => "rc-" + String(sid).replace(/[^a-z0-9]/gi, "").slice(0, 12);
function vertrauen(cwd) {
  // Workspace-Trust vorab setzen - der interaktive Start verweigert sonst mit "Workspace not trusted"
  try {
    const cfgPfad = "/root/.claude.json";
    const cfg = JSON.parse(readFileSync(cfgPfad, "utf8"));
    cfg.projects = cfg.projects || {};
    const pr = (cfg.projects[cwd] = cfg.projects[cwd] || {});
    if (pr.hasTrustDialogAccepted && pr.hasCompletedProjectOnboarding) return;
    pr.hasTrustDialogAccepted = true; pr.hasCompletedProjectOnboarding = true;
    writeFileSync(cfgPfad, JSON.stringify(cfg, null, 2));
  } catch (e) { console.error(new Date().toISOString(), "Trust:", (e && e.message) || e); }
}

function runClaude(auftrag, resumeId, cwd, modus, modell) {
  return new Promise((resolve) => {
    const args = ["-p", auftrag, "--output-format", "json", "--permission-mode", modus || DEFAULT_MODE,
      "--allowedTools", "WebSearch,WebFetch",
      "--permission-prompt-tool", "mcp__perm__approve",
      "--mcp-config", "/root/bin/perm-mcp.json"];
    if (modell) args.push("--model", modell);
    if (resumeId) args.push("--resume", resumeId);
    const kind = execFile(CLAUDE, args, { cwd: cwd || DEFAULT_CWD, env: ENV, timeout: 1800000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
      // Fehlertexte: das Ende der Meldung zeigen, nicht das Kommando-Echo am Anfang
      if (e && !out) return resolve({ ok: false, error: String((e && e.message) || e).slice(-400) });
      try {
        const j = JSON.parse(out);
        // v8-Fix 2: claude -p meldet API-Fehler mit Exit 0 UND subtype "success" - der Fehlertext
        // steht in result. Ohne diese Pruefung landet z.B. "OAuth session expired" als vermeintliche
        // Claude-Antwort im Chat, und der Dienst wirkt dabei monatelang gesund. Nur is_error traegt.
        if (j.is_error === true) {
          const grund = j.result || j.api_error_status || j.terminal_reason || "unbekannter API-Fehler";
          return resolve({ ok: false, error: `Claude meldet einen Fehler: ${String(grund).slice(0, 400)}`, sid: j.session_id || resumeId || null });
        }
        // Kontextfenster des Hauptmodells merken (Eintrag mit den meisten Input-Tokens in modelUsage)
        let fenster = null, meiste = -1;
        for (const mu of Object.values(j.modelUsage || {})) {
          const inp = (mu.inputTokens || 0) + (mu.cacheReadInputTokens || 0) + (mu.cacheCreationInputTokens || 0);
          if (mu.contextWindow && inp > meiste) { meiste = inp; fenster = mu.contextWindow; }
        }
        resolve({ ok: true, result: j.result || "(kein Ergebnis)", sid: j.session_id || resumeId || null, fenster, kosten: j.total_cost_usd || 0 });
      } catch {
        resolve({ ok: false, error: "Antwort nicht lesbar: " + String(out).slice(0, 300) });
      }
    });
    // v15: Optional Chaining - scheitert execFile frueh (fehlende Binary, Fork-Fehler), ist
    // kind.stdin null. Der TypeError flog dann, bevor die Promise je aufgeloest wurde, und
    // pump() haette ewig gewartet.
    kind.stdin?.end(); // sonst wartet Claude 3 Sekunden auf stdin
  });
}

const queue = [];
let busy = false;
// v11: Warteschlange ueberlebt Neustarts. Uebrige Auftraege werden beim Start gemeldet,
// /fortsetzen fuehrt sie aus, /verwerfen loescht sie - nie stillschweigend weiterlaufen.
const QDATEI = "/root/.claude-queue.json";
let wartend = [];
// v15: Der Auftrag in Arbeit wird mitgeschrieben. Vorher nahm queue.shift() ihn aus der Liste
// und saveQueue() strich ihn damit aus der Datei - stirbt der Prozess waehrend des Laufs,
// war der Auftrag spurlos weg, obwohl die Warteschlange ausdruecklich dafuer gebaut wurde,
// dass nichts stillschweigend verschwindet.
let laufend = null;
const saveQueue = () => {
  try {
    const alles = [...(laufend ? [{ ...laufend, warInArbeit: true }] : []), ...queue, ...wartend];
    writeFileSync(QDATEI, JSON.stringify(alles), { mode: 0o600 });
  } catch {}
};
try { if (existsSync(QDATEI)) { wartend = JSON.parse(readFileSync(QDATEI, "utf8")) || []; } } catch {}
async function pump() {
  if (busy) return;
  busy = true;
  try {
  while (queue.length) {
    const item = queue.shift();
    laufend = item;
    saveQueue();
    const reg = load();
    const cur = reg.sessions.find((s) => s.id === reg.aktiv) || null;
    const cwd = cur ? (cur.cwd || DEFAULT_CWD) : (item.cwd || reg.naechstesCwd || DEFAULT_CWD);
    const modus = cur ? (cur.modus || DEFAULT_MODE) : (reg.naechsterModus || DEFAULT_MODE);
    const modell = cur ? (cur.modell || null) : (reg.naechstesModell || null);
    // v11: Schutzzweig (nur Git), Fortschrittsanzeige ab 20 s, dann der eigentliche Lauf
    const zweig = await schutzzweig(cwd, cur);
    const startZeit = Date.now();
    let fortMid = null;
    const ticker = setInterval(async () => {
      const sek = Math.round((Date.now() - startZeit) / 1000);
      if (sek < 20) return;
      const tp = neuestesTranskript(cwd, startZeit);
      const f = tp ? fortschrittText(tp) : null;
      const t = `Auftrag laeuft seit ${sek} s...` + (f ? "\n" + f : "");
      if (fortMid === null) { fortMid = -1; const m = await sendMitId(t); fortMid = m || -1; }
      else if (fortMid > 0) await edit(fortMid, t);
    }, 10000);
    const r = await runClaude(item.text, cur ? cur.id : null, cwd, modus, modell);
    clearInterval(ticker);
    if (fortMid > 0) await edit(fortMid, `Fertig nach ${Math.round((Date.now() - startZeit) / 1000)} s.`);
    if (!r.ok) { await send("Fehlgeschlagen: " + r.error); continue; }
    let zweigInfo = "";
    if (zweig) {
      const stat = await zweigCommit(cwd, item.text);
      zweigInfo = `\n\n(Arbeitszweig ${zweig}${stat ? ": " + stat : ", keine Dateiaenderungen"} - uebernehmen am Rechner per git merge)`;
    }
    const reg2 = load();
    if (cur) {
      // resume liefert eine neue Session-ID: uebernehmen, sonst setzt der naechste Auftrag am alten Punkt an
      const s = reg2.sessions.find((x) => x.id === cur.id);
      if (s) { s.id = r.sid || s.id; s.zuletzt = Date.now(); if (r.fenster) s.fenster = r.fenster; s.kosten = (s.kosten || 0) + (r.kosten || 0); if (zweig) s.zweig = zweig; }
      if (reg2.aktiv === cur.id) reg2.aktiv = r.sid || cur.id;
    } else if (r.sid && !reg2.sessions.some((x) => x.id === r.sid)) {
      reg2.sessions.push({ id: r.sid, titel: item.titel || item.text.slice(0, 48), cwd, modus, modell, fenster: r.fenster || null, kosten: r.kosten || 0, zweig: zweig || null, erstellt: Date.now(), zuletzt: Date.now() });
      if (reg2.sessions.length > 15) reg2.sessions = reg2.sessions.slice(-15);
      if (!reg2.aktiv) reg2.aktiv = r.sid;
      reg2.naechstesCwd = null;
      reg2.naechsterModus = null;
      reg2.naechstesModell = null;
    }
    save(reg2);
    await send(r.result + zweigInfo);
  }
  } catch (e) {
    // v15: Ein Fehler hier darf weder den Prozess beenden noch busy verklemmen. Ohne das
    // finally blieb busy auf true und der Bot nahm nie wieder einen Auftrag an.
    console.error(new Date().toISOString(), "pump:", (e && e.stack) || e);
    await send("Interner Fehler bei der Auftragsverarbeitung: " + String((e && e.message) || e).slice(0, 300));
  } finally {
    laufend = null;
    busy = false;
    saveQueue();
  }
}

// v11: Capability-Ping - im Leerlauf beweist ein Mini-Lauf, dass Claude wirklich antworten
// kann. Ein Prozess-Check haette "Dienst laeuft, Login tot" nie bemerkt (Lars, 04.09.).
let letzterPing = 0;
const PING_ALLE = 6 * 3600 * 1000;
function pingClaude() {
  if (busy || queue.length || Date.now() - letzterPing < PING_ALLE) return;
  letzterPing = Date.now();
  execFile(CLAUDE, ["-p", "Antworte nur mit OK", "--output-format", "json", "--model", "claude-haiku-4-5"],
    { cwd: DEFAULT_CWD, env: ENV, timeout: 240000, maxBuffer: 1024 * 1024 }, async (e, out) => {
    try {
      const j = JSON.parse(String(out));
      if (j.is_error === true) await send("Selbsttest fehlgeschlagen - Claude meldet: " + String(j.result || j.api_error_status || "unbekannt").slice(0, 200));
    } catch {
      await send("Selbsttest fehlgeschlagen - keine lesbare Antwort von Claude" + (e ? " (" + String((e && e.message) || e).slice(-150) + ")" : ""));
    }
  });
}
setInterval(pingClaude, 15 * 60 * 1000);

// v15: Der Update-Offset ueberlebt jetzt den Neustart. Vorher stand hier fest 0 - Telegram
// liefert dann alle unbestaetigten Updates der letzten 24 Stunden erneut, und bestaetigt wird
// immer erst mit dem naechsten getUpdates. Starb der Bot zwischen Verarbeitung und Bestaetigung,
// lief derselbe Auftrag ein zweites Mal. Bei einem Schreibauftrag im Modus edits waere das
// nichts, was man zweimal haben moechte.
const ODATEI = "/root/.claude-offset.json";
let offset = 0;
try { offset = Number(JSON.parse(readFileSync(ODATEI, "utf8")).offset) || 0; } catch {}
const saveOffset = () => { try { writeFileSync(ODATEI, JSON.stringify({ offset }), { mode: 0o600 }); } catch {} };
// Zweite Schranke fuer den Fall, dass die Offset-Datei fehlt: Auftraege, die deutlich vor dem
// Start liegen, laufen nicht ungefragt los. Die Kulanz von fuenf Minuten deckt den normalen
// Neustart ab, bei dem eine gerade abgeschickte Nachricht noch ankommen soll.
const START_ZEIT = Math.floor(Date.now() / 1000);
const ALT_KULANZ = 300;

// Selbstpruefung: hoechste Changelog-Zeile im eigenen Kopf gegen VERSION halten.
// Genau diese Drift ist am 07.09. dreimal passiert - Kopfzeile gepflegt, String vergessen.
// Kostet einen Dateizugriff pro Start und meldet den Fehler, statt ihn im Journal zu verstecken.
function versionsPruefung() {
  try {
    // v15.1: Das Lesefenster endet an der ersten import-Zeile statt nach festen 40 Zeilen.
    // Der Changelog-Kopf waechst mit jeder Version - mit v15 lief er ueber die 40 hinaus, und
    // die Pruefung meldete daraufhin eine Drift, die keine war. Eine Grenze, die mitwaechst,
    // kann das nicht wieder passieren.
    const alle = readFileSync(new URL(import.meta.url).pathname, "utf8").split("\n");
    const ende = alle.findIndex((z) => z.startsWith("import "));
    const kopf = alle.slice(0, ende > 0 ? ende : 60);
    const nummern = kopf.map((z) => (z.match(/^\/\/\s*v(\d+(?:\.\d+)?):/) || [])[1]).filter(Boolean);
    if (!nummern.length) return "keine Changelog-Zeile gefunden";
    const hoechste = nummern.sort((a, b) => {
      const [am, an] = String(a).split("."), [bm, bn] = String(b).split(".");
      return Number(am) - Number(bm) || Number(an || 0) - Number(bn || 0);
    }).pop();
    return hoechste === VERSION ? null : `VERSION=${VERSION}, hoechste Changelog-Zeile v${hoechste}`;
  } catch (e) { return `nicht pruefbar (${(e && e.message) || e})`; }
}
// v15: Dieselbe Idee fuer die Befehlstabelle. Der Bot liest seinen eigenen Quelltext und haelt
// die befehl()-Aufrufe gegen BEFEHLE: ein Handler ohne Tabelleneintrag fehlt in der Hilfe,
// ein Eintrag ohne Handler ist eine Luege im Hilfetext. Beides faellt sonst erst am Handy auf.
function befehlsPruefung() {
  try {
    const src = readFileSync(new URL(import.meta.url).pathname, "utf8");
    const gefunden = new Set();
    for (const m of src.matchAll(/befehl\(text, "([a-z-]+)"\)/g)) gefunden.add(m[1]);
    const tabelle = new Set(BEFEHLE.map((b) => b.name));
    const ohneEintrag = [...gefunden].filter((n) => !tabelle.has(n));
    const ohneHandler = [...tabelle].filter((n) => !gefunden.has(n));
    if (!ohneEintrag.length && !ohneHandler.length) return null;
    return [ohneEintrag.length ? "Handler ohne Tabelleneintrag: " + ohneEintrag.join(", ") : "",
      ohneHandler.length ? "Tabelleneintrag ohne Handler: " + ohneHandler.join(", ") : ""].filter(Boolean).join("; ");
  } catch (e) { return `nicht pruefbar (${(e && e.message) || e})`; }
}

const drift = versionsPruefung();
if (drift) console.error(new Date().toISOString(), "WARNUNG Versions-Drift:", drift);
const befehlsDrift = befehlsPruefung();
if (befehlsDrift) console.error(new Date().toISOString(), "WARNUNG Befehls-Drift:", befehlsDrift);
console.log(new Date().toISOString(), `Session-Bot v${VERSION} gestartet${drift ? " (Versions-Drift, siehe Warnung)" : ""}${befehlsDrift ? " (Befehls-Drift, siehe Warnung)" : ""}`);
if (wartend.length) {
  // v15: Ein Auftrag, der beim Abbruch gerade lief, wird als solcher benannt - er ist
  // moeglicherweise schon ausgefuehrt worden, und das muss man wissen, bevor man ihn wiederholt.
  const zeilen = wartend.map((w, i) => `${i + 1}. ${String(w.text).slice(0, 60)}${w.warInArbeit ? "  (lief gerade, Ausgang unbekannt)" : ""}`);
  const warLaufend = wartend.some((w) => w.warInArbeit);
  await send(`Vom letzten Neustart uebrig: ${wartend.length} wartende(r) Auftrag/Auftraege:\n` + zeilen.join("\n")
    + (warLaufend ? "\n\nAchtung: Der markierte Auftrag war beim Abbruch in Arbeit. Ob er durchlief, steht nicht fest - pruef das Ergebnis, bevor du ihn wiederholst." : "")
    + "\n\n/fortsetzen fuehrt sie aus, /verwerfen loescht sie.");
}
while (true) {
  try {
    const res = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`);
    const data = await res.json();
    for (const u of data.result ?? []) {
      offset = u.update_id + 1;
      saveOffset();

      if (u.callback_query) {
        const cq = u.callback_query;
        let note = "Unbekannte Aktion";
        if (cq.from.id === CHAT_ID && cq.data && cq.data.startsWith("perm:")) {
          const teile = cq.data.split(":");
          const id = teile[1] || "", antwort = teile[2] === "ja" ? "ja" : "nein";
          if (/^[a-z0-9]+$/i.test(id)) {
            try {
              mkdirSync(PERM_DIR, { recursive: true, mode: 0o700 });
              // v12: Antwort nur schreiben, wenn die Anfrage noch offen ist. Telegram-Lag laesst
              // die Buttons nach dem ersten Tipp kurz stehen - ein zweiter Tipp erzeugte sonst
              // eine verwaiste Antwortdatei (die Doppeltipp-Waisen vom 07.09.).
              const offen = existsSync(`${PERM_DIR}/${id}.req`) && !existsSync(`${PERM_DIR}/${id}.req.expired`);
              if (!offen) { note = "Schon beantwortet oder abgelaufen"; }
              else {
              writeFileSync(`${PERM_DIR}/${id}`, antwort, { mode: 0o600 });
              note = antwort === "ja" ? "Erlaubt" : "Abgelehnt";
              permMsg.delete(id); // der MCP raeumt .req selbst weg, sobald er die Antwort liest
              // Sichtbares Feedback: Anfrage-Nachricht kennzeichnen, Buttons entfernen
              if (cq.message) {
                const orig = cq.message.text || "Berechtigungsanfrage";
                await fetch(`${API}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ chat_id: CHAT_ID, message_id: cq.message.message_id,
                    text: ((antwort === "ja" ? "ERLAUBT - Claude fuehrt aus:\n" : "ABGELEHNT - Claude ueberspringt:\n") + orig).slice(0, 4000) }) }).catch(() => {});
              }
              }
            }
            catch (e) { console.error(new Date().toISOString(), "Perm:", (e && e.message) || e); note = "Fehler"; }
          }
        }
        await fetch(`${API}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callback_query_id: cq.id, text: note }) });
        continue;
      }

      const msg = u.message;
      if (!msg?.text || msg.chat.id !== CHAT_ID) continue;
      // v15: Nachzuegler aus der Zeit vor dem Start nicht stillschweigend ausfuehren.
      if (msg.date && msg.date < START_ZEIT - ALT_KULANZ) {
        console.log(new Date().toISOString(), "Altes Update uebersprungen, Alter", Math.round((START_ZEIT - msg.date) / 60), "min");
        await send(`Uebersprungen: eine Nachricht von ${wann(msg.date * 1000)} lag noch vor dem letzten Neustart. Wenn sie noch gilt, schick sie einfach neu.`);
        continue;
      }
      // Befehle unabhaengig von Gross- und Kleinschreibung erkennen: /Status, /STATUS und
      // /status sind dasselbe. Normalisiert wird NUR das erste Wort - der Rest der Nachricht
      // (Auftrag, Projektname, Pfad) bleibt unangetastet, denn Linux-Pfade sind case-sensitiv
      // und ein pauschales toLowerCase() wuerde /neu /root/Vault zerschiessen.
      // Ein angehaengtes @botname wird mit abgeschnitten (kommt beim Kopieren aus Gruppen vor).
      // Das Kommandowort wird anschliessend ueber ALIAS auf die Langform expandiert (v13):
      // /w wird zu /wechsel, bevor die Befehlskette laeuft. Unten kommt also immer die Langform
      // an, deshalb stimmen alle slice()-Offsets weiter.
      const roh = msg.text.trim();
      const text = roh.startsWith("/") ? roh.replace(/^\/(\S+)/, (m, w) => {
        const kopf = w.split("@")[0].toLowerCase();
        // Object.hasOwn statt ALIAS[kopf]: sonst traefe /constructor oder /__proto__ die
        // Prototypenkette und das Kommandowort wuerde zu Unsinn expandieren.
        return "/" + (Object.hasOwn(ALIAS, kopf) ? ALIAS[kopf] : kopf);
      }) : roh;
      // v13.1: Eingang protokollieren. msg.date ist die Telegram-Sendezeit in Sekunden, die
      // Differenz zeigt den Weg Handy -> Telegram -> Bot. Geloggt wird nur das erste Wort,
      // der Nachrichtentext hat im Journal nichts verloren.
      const tEin = Date.now();
      const weg = msg.date ? ((tEin - msg.date * 1000) / 1000).toFixed(1) : "?";
      antwortMessung = tEin;
      console.log(new Date().toISOString(), `Eingang ${text.split(" ")[0].slice(0, 40)} Weg ${weg}s`);
      const reg = load();
      const cur = reg.sessions.find((s) => s.id === reg.aktiv) || null;

      if (befehl(text, "start") !== null) {
        await send("Session-Bot bereit. Jede Nachricht ist ein Auftrag an die aktive Claude-Session.\n\nBefehle:\n"
          + HILFE_LISTE
          + "\n\nKurzbefehle: " + ALIAS_HILFE
          + "\n\nWeb-Suche ist erlaubt. Braucht Claude weitere Rechte, kommt eine Freigabe-Anfrage mit Buttons (5 Minuten Zeit, dein Klick wird direkt in der Nachricht bestaetigt).\n" + DAUER);
        continue;
      }
      if (befehl(text, "modus") !== null) {
        const arg = befehl(text, "modus").toLowerCase();
        if (!arg) {
          await send(`Aktueller Modus${cur ? ` der Session "${cur.titel}"` : " fuer die naechste Session"}: ${cur ? modusName(cur.modus) : modusName(reg.naechsterModus)}\n\nVerfuegbar:\nstandard - alles ausser Lesen fragt per Button an, auch Dateiaenderungen\nedits - Dateiaenderungen automatisch, Rest per Button (Standard)\nplan - nur lesen und planen, aendert nichts\nauto - Claude entscheidet selbst, wann es fragt\nvoll - keine Nachfragen (Vorsicht; funktioniert nicht, wenn der Bot als root laeuft)`);
        } else if (!ausTabelle(MODI, arg)) {
          await send("Unbekannter Modus. Verfuegbar: " + Object.keys(MODI).join(", "));
        } else {
          if (cur) {
            // v15: Frisch laden statt auf dem reg von oben zu arbeiten - ein parallel laufender
            // Auftrag speichert die Registry sonst nach uns und die Einstellung ist still weg.
            const frisch = load();
            const s = frisch.sessions.find((x) => x.id === cur.id);
            if (s) s.modus = ausTabelle(MODI, arg);
            save(frisch);
            await send(`Modus fuer "${cur.titel}": ${arg}${arg === "voll" ? "\nVorsicht: Claude fragt in dieser Session nichts mehr an. Laeuft der Bot als root, verweigert Claude Code diesen Modus komplett." : ""}`);
          } else {
            const frisch = load();
            frisch.naechsterModus = ausTabelle(MODI, arg); save(frisch);
            await send(`Modus fuer die naechste Session: ${arg}${arg === "voll" ? "\nVorsicht: Claude fragt in dieser Session nichts mehr an. Laeuft der Bot als root, verweigert Claude Code diesen Modus komplett." : ""}`);
          }
        }
        continue;
      }
      if (befehl(text, "modell") !== null) {
        const arg = befehl(text, "modell").toLowerCase();
        if (!arg) {
          await send(`Aktuelles Modell${cur ? ` der Session "${cur.titel}"` : " fuer die naechste Session"}: ${cur ? modellName(cur.modell) : modellName(reg.naechstesModell)}\n\nVerfuegbar:\nopus - staerkstes Modell, fuer Bauauftraege\nsonnet - schnell und guenstig, fuer Erfassung\nhaiku - am schnellsten, fuer kurze Handgriffe\nstandard - keine Vorgabe`);
        } else if (arg !== "standard" && !ausTabelle(MODELLE, arg)) {
          await send("Unbekanntes Modell. Verfuegbar: " + Object.keys(MODELLE).join(", ") + ", standard");
        } else {
          const wert = arg === "standard" ? null : ausTabelle(MODELLE, arg);
          if (cur) {
            const frisch = load();
            const s = frisch.sessions.find((x) => x.id === cur.id);
            if (s) s.modell = wert;
            save(frisch);
            await send(`Modell fuer "${cur.titel}": ${arg}`);
          } else {
            const frisch = load();
            frisch.naechstesModell = wert; save(frisch);
            await send(`Modell fuer die naechste Session: ${arg}`);
          }
        }
        continue;
      }
      if (befehl(text, "projekte") !== null) {
        const teile = text.split(/\s+/);
        if ((teile[1] || "").toLowerCase() === "add" && teile[2] && teile[3]) {
          const name = teile[2].toLowerCase(); const pfad = teile[3];
          if (!existsSync(pfad)) { await send(`Verzeichnis ${pfad} existiert nicht auf dem Server.`); continue; }
          const p = loadProj(); p[name] = pfad; saveProj(p);
          await send(`Registriert: ${name} -> ${pfad}\nNutzen mit /neu ${name} [Auftrag]`);
        } else {
          const p = loadProj();
          await send("Projekte:\n" + Object.entries(p).map(([k, v]) => `${k} -> ${v}`).join("\n") + "\n\nNeues registrieren: /projekte add name /absoluter/pfad");
        }
        continue;
      }
      if (befehl(text, "sessions") !== null) {
        if (!reg.sessions.length) { await send("Keine Sessions. Schick einfach einen Auftrag oder /neu."); continue; }
        const zeilen = reg.sessions.map((s, i) => `${i + 1}. ${s.titel} [${kurz(s.cwd)}, ${modusName(s.modus)}, ${modellName(s.modell)}] - zuletzt ${wann(s.zuletzt)}${s.id === reg.aktiv ? " (aktiv)" : ""}`);
        await send(zeilen.join("\n") + "\nWechseln mit /wechsel N");
        continue;
      }
      if (befehl(text, "wechsel") !== null) {
        // v15: Vorher fing startsWith("/wechsel") auch /wechselirgendwas ab. befehl() verlangt
        // den Befehl exakt oder mit folgendem Leerzeichen.
        const n = parseInt(befehl(text, "wechsel"), 10);
        const ziel = reg.sessions[n - 1];
        if (!ziel) { await send("Unbekannte Nummer. /sessions zeigt die Liste."); continue; }
        const frisch = load();
        frisch.aktiv = ziel.id; save(frisch);
        await send(`Aktiv: ${ziel.titel} [${kurz(ziel.cwd)}, ${modusName(ziel.modus)}, ${modellName(ziel.modell)}]`);
        continue;
      }
      if (befehl(text, "status") !== null) {
        const lage = busy ? `Ein Auftrag laeuft gerade${queue.length ? `, ${queue.length} in Warteschlange` : ""}.` : "Bereit.";
        const kopfV = `Session-Bot v${VERSION}` + (versionsPruefung() ? " (ACHTUNG Versions-Drift, siehe Journal)" : "");
        if (cur) {
          await send(`${kopfV}\nAktive Session: ${cur.titel}\nVerzeichnis: ${cur.cwd || DEFAULT_CWD}\nModus: ${modusName(cur.modus)}\nModell: ${modellName(cur.modell)}\nZuletzt: ${wann(cur.zuletzt)}${cur.kosten ? ` - Kosten ueber den Bot: $${Number(cur.kosten).toFixed(2)}` : ""}\n${lage}\n\nAm Rechner fortsetzen:\nssh root@${HOST}\ncd "${cur.cwd || DEFAULT_CWD}" && claude --resume ${cur.id}`);
        } else {
          await send(`${kopfV}\nKeine aktive Session. ${lage}`);
        }
        continue;
      }
      if (befehl(text, "usage") !== null) {
        if (!cur) { await send("Keine aktive Session. Schick einen Auftrag oder /neu."); continue; }
        const k = kontextStand(cur.id);
        if (!k) { await send(`Kein Transkript zur Session "${cur.titel}" gefunden - vermutlich lief noch kein Auftrag durch.`); continue; }
        const fenster = cur.fenster || FENSTER_FALLBACK;
        const prozent = Math.min(100, Math.round((k.kontext / fenster) * 100));
        const balken = "#".repeat(Math.round(prozent / 10)).padEnd(10, "-");
        await send(`Kontext der Session "${cur.titel}":\n[${balken}] ${prozent} %\n${tsd(k.kontext)} von ${tsd(fenster)} Token${cur.fenster ? "" : " (Fenster geschaetzt, nach dem naechsten Auftrag exakt)"}\nModell: ${k.modell || modellName(cur.modell)}${cur.kosten ? `\nKosten ueber den Bot: $${Number(cur.kosten).toFixed(2)}` : ""}${prozent >= 70 ? "\n\nWird es eng: /clear leert den Kontext, das Verzeichnis bleibt." : ""}`);
        continue;
      }
      if (befehl(text, "clear") !== null) {
        if (!cur) { await send("Keine aktive Session. /neu startet frisch."); continue; }
        const frisch = load();
        frisch.sessions = frisch.sessions.filter((s) => s.id !== cur.id);
        frisch.aktiv = null; frisch.naechstesCwd = cur.cwd || DEFAULT_CWD; frisch.naechsterModus = cur.modus || null; frisch.naechstesModell = cur.modell || null; save(frisch);
        await send(`Kontext geleert. Deine naechste Nachricht startet frisch in ${kurz(cur.cwd)} (Modus ${modusName(cur.modus)}).`);
        continue;
      }
      if (befehl(text, "ende") !== null) {
        if (!cur) { await send("Keine aktive Session."); continue; }
        const frisch = load();
        frisch.sessions = frisch.sessions.filter((s) => s.id !== cur.id);
        frisch.aktiv = null; save(frisch);
        await send(`Abgelegt: ${cur.titel}. Das Transkript bleibt auf dem Server erhalten.`);
        continue;
      }
      if (befehl(text, "fortsetzen") !== null) {
        if (!wartend.length) { await send("Keine wartenden Auftraege."); continue; }
        queue.push(...wartend); wartend = []; saveQueue();
        await send(`${queue.length} Auftrag/Auftraege wieder eingereiht. ${DAUER}`); pump();
        continue;
      }
      if (befehl(text, "verwerfen") !== null) {
        if (!wartend.length) { await send("Keine wartenden Auftraege."); continue; }
        const n = wartend.length; wartend = []; saveQueue();
        await send(`${n} wartende(r) Auftrag/Auftraege verworfen.`);
        continue;
      }
      if (befehl(text, "remote-control") !== null) {
        // v13: /rc kommt hier bereits als /remote-control an (ALIAS), Sonderzweig entfaellt.
        const arg = befehl(text, "remote-control").toLowerCase();
        if (!cur) { await send("Keine aktive Session. Erst /neu oder /wechsel."); continue; }
        const tn = rcName(cur.id);
        if (arg === "aus" || arg === "stop") {
          const k = await execP("tmux", ["kill-session", "-t", tn]);
          await send(k.e ? "Kein Remote Control aktiv fuer diese Session." : `Remote Control beendet: "${cur.titel}". Die Session bleibt erhalten.`);
          continue;
        }
        const da = await execP("tmux", ["has-session", "-t", tn]);
        if (!da.e) { await send("Remote Control laeuft schon fuer diese Session. Beenden mit /remote-control aus"); continue; }
        vertrauen(cur.cwd || DEFAULT_CWD);
        const start = await execP("tmux", ["new-session", "-d", "-s", tn, "-c", cur.cwd || DEFAULT_CWD,
          CLAUDE, "--resume", cur.id, "--remote-control", ((cur.titel || "Session").replace(/^[-\s]+/, "").slice(0, 30) || "Session")]);
        if (start.e) { await send("tmux-Start fehlgeschlagen: " + String(start.err || (start.e && start.e.message) || "").slice(-200)); continue; }
        await send("Remote Control startet, ein paar Sekunden...");
        await new Promise((r) => setTimeout(r, 9000));
        let pane = await execP("tmux", ["capture-pane", "-t", tn, "-p", "-J"]);
        // Falls die einmalige Rueckfrage erscheint, bestaetigen - aber nur dann, sonst wuerde
        // das y als Nachricht in der Session landen
        if (!/https:\/\/claude\.ai\/code\//.test(pane.out) && /Enable Remote Control\?/.test(pane.out)) {
          await execP("tmux", ["send-keys", "-t", tn, "y", "Enter"]);
          await new Promise((r) => setTimeout(r, 6000));
          pane = await execP("tmux", ["capture-pane", "-t", tn, "-p", "-J"]);
        }
        const url = (pane.out.match(/https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]+/) || [])[0];
        if (url) {
          await send(`"${cur.titel}" ist jetzt in der Claude-App: Code-Tab am Handy oder\n${url}\n\nWichtig: Solange Remote Control laeuft, diese Session nicht parallel hier im Bot weiterfuehren. Beenden mit /remote-control aus`);
        } else {
          const letzte = pane.out.split("\n").filter((z) => z.trim()).slice(-5).join("\n");
          await send("Keine App-URL gefunden. Letzte Ausgabe:\n" + letzte.slice(0, 600));
        }
        continue;
      }
      if (befehl(text, "neu") !== null) {
        const rest = befehl(text, "neu");
        const projekte = loadProj();
        let cwd = null, auftrag = rest, neuerTitel = null; // v14: neuerTitel nur bei Projektanlage
        const erst = rest.split(/\s+/)[0] || "";
        if (ausTabelle(projekte, erst.toLowerCase())) { cwd = projekte[erst.toLowerCase()]; auftrag = rest.slice(erst.length).trim(); }
        else if (erst.startsWith("/") && existsSync(erst)) { cwd = erst; auftrag = rest.slice(erst.length).trim(); }
        // v9: genau ein unbekanntes, namensartiges Wort -> Projektordner anlegen und registrieren.
        // Bewusst nur bei einem einzelnen Wort: /neu <freier Auftrag> beginnt mit einem Verb und
        // wuerde sonst bei jedem Tippfehler ein Muellverzeichnis erzeugen.
        else if (rest === erst && /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,31}$/.test(erst)) {
          const nm = erst.toLowerCase();
          const pf = `${PROJEKTE_DIR}/${nm}`;
          mkdirSync(pf, { recursive: true });
          projekte[nm] = pf;
          writeFileSync(PROJ, JSON.stringify(projekte, null, 2));
          cwd = pf;
          neuerTitel = nm;
          // v14: Session sofort eroeffnen statt auf die naechste Nachricht zu warten. Eine
          // Claude-Session entsteht erst durch einen Lauf, also setzt der Bot selbst einen
          // kurzen ab. "Lege nichts an" ist nicht schmueckend: im Modus acceptEdits wuerde
          // Claude sonst ungefragt Dateien im frischen Verzeichnis erzeugen.
          auftrag = `Neues, noch leeres Projektverzeichnis "${nm}". Antworte mit genau einem kurzen Satz, dass du bereit bist. Lege jetzt nichts an und aendere nichts.`;
          await send(`Neues Projekt angelegt und registriert: ${nm} -> ${pf}`);
        }
        if (cwd && !existsSync(cwd)) { await send(`Verzeichnis ${cwd} existiert nicht mehr. /projekte zeigt die Liste.`); continue; }
        const frisch = load();
        frisch.aktiv = null; frisch.naechstesCwd = cwd; save(frisch);
        if (auftrag) { queue.push({ text: auftrag, cwd, titel: neuerTitel }); saveQueue(); await send(`Neue Session in ${kurz(cwd)} wird eroeffnet, Auftrag laeuft. ${DAUER}`); pump(); }
        else await send(`Alles klar, deine naechste Nachricht eroeffnet eine neue Session in ${kurz(cwd)} (Modus ${modusName(reg.naechsterModus)}).`);
        continue;
      }
      // v12: Unbekannte Slash-Befehle abfangen statt an die CLI durchzureichen - die fuehrt sie
      // sonst als eigene Kommandos aus (Fund 07.09.: "/model haiku" lief als CLI-Befehl). Pfade wie
      // /etc/fstab haben einen zweiten Schraegstrich im ersten Wort und laufen weiter als Auftrag.
      // v15: Auch "/ status" mit Leerzeichen nach dem Schraegstrich abfangen. Genau dieser
      // Vertipper hat die Session "/ wechseln 2" erzeugt - er rutschte als Auftrag durch.
      if (/^\/\s?[a-zA-Z][a-zA-Z0-9_-]*(\s|$)/.test(text)) {
        await send(`Unbekannter Befehl: ${text.slice(0, 40)}` + "\n/start zeigt alle Befehle. Nichts wurde an Claude weitergereicht.");
        continue;
      }
      queue.push({ text, cwd: null });
      saveQueue();
      await send(busy ? `Eingereiht, Position ${queue.length}.` : cur ? `Auftrag laeuft in "${cur.titel}" [${kurz(cur.cwd)}, ${modusName(cur.modus)}]. ${DAUER}` : `Neue Session in ${kurz(reg.naechstesCwd)} wird eroeffnet (Modus ${modusName(reg.naechsterModus)}), Auftrag laeuft. ${DAUER}`);
      pump();
    }
  } catch (e) { console.error(new Date().toISOString(), "Loop:", (e && e.message) || e); await new Promise((r) => setTimeout(r, 5000)); }
}
