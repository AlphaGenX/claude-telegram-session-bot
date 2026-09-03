#!/usr/bin/env node
// Session-Bot v5: steuert Claude-Code-Sessions auf dem VPS per Telegram.
// Jede normale Nachricht ist ein Auftrag an die aktive Session.
// v2: Projektverzeichnis waehlbar. v3: /clear, Web-Zugriff, Freigabe-Buttons. v4: /modus je Session.
// v5: Button-Klick editiert die Anfrage-Nachricht (ERLAUBT/ABGELEHNT sichtbar), realistische Antwortzeit-Ansagen.
// Befehle: /neu [projekt|/pfad] [Auftrag], /projekte [add name /pfad], /modus [name], /sessions, /wechsel N, /status, /clear, /ende
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = Number(process.env.CHAT_ID);
const API = `https://api.telegram.org/bot${TOKEN}`;
const REG = "/root/.claude-sessions.json";
const PROJ = "/root/.config/claude-projekte.json";
const PERM_DIR = "/root/.perm";
const DEFAULT_CWD = "/root/vault";
const DEFAULT_MODE = "acceptEdits";
const CLAUDE = "/root/.local/bin/claude";
const HOST = "<DEIN-SERVER>";
const ENV = { ...process.env, HOME: "/root", MCP_TOOL_TIMEOUT: "360000", PATH: "/root/.local/bin:" + (process.env.PATH || "/usr/bin:/bin") };

// Telegram-Name -> claude --permission-mode
const MODI = { standard: "default", edits: "acceptEdits", plan: "plan", voll: "bypassPermissions" };
const modusName = (wert) => (Object.entries(MODI).find(([, v]) => v === (wert || DEFAULT_MODE)) || ["edits"])[0];

const load = () => { try { return JSON.parse(readFileSync(REG, "utf8")); } catch { return { sessions: [], aktiv: null, naechstesCwd: null, naechsterModus: null }; } };
const save = (r) => writeFileSync(REG, JSON.stringify(r, null, 2));
const loadProj = () => { try { return JSON.parse(readFileSync(PROJ, "utf8")); } catch { return { vault: DEFAULT_CWD }; } };
const saveProj = (p) => writeFileSync(PROJ, JSON.stringify(p, null, 2));
const kurz = (cwd) => {
  const c = cwd || DEFAULT_CWD;
  const hit = Object.entries(loadProj()).find(([, v]) => v === c);
  return hit ? hit[0] : c.split("/").filter(Boolean).pop();
};
const wann = (t) => new Date(t).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const DAUER = "Antwort kommt meist unter einer Minute, groessere Auftraege brauchen laenger.";

async function send(text) {
  let s = String(text ?? "").trim() || "(leere Antwort)";
  if (s.length > 15200) s = s.slice(0, 15200) + "\n[gekuerzt]";
  for (let i = 0; i < s.length; i += 3800) {
    await fetch(`${API}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT_ID, text: s.slice(i, i + 3800) }) });
  }
}

function runClaude(auftrag, resumeId, cwd, modus) {
  return new Promise((resolve) => {
    const args = ["-p", auftrag, "--output-format", "json", "--permission-mode", modus || DEFAULT_MODE,
      "--allowedTools", "WebSearch,WebFetch",
      "--permission-prompt-tool", "mcp__perm__approve",
      "--mcp-config", "/root/bin/perm-mcp.json"];
    if (resumeId) args.push("--resume", resumeId);
    execFile(CLAUDE, args, { cwd: cwd || DEFAULT_CWD, env: ENV, timeout: 1800000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
      if (e && !out) return resolve({ ok: false, error: String((e && e.message) || e).slice(0, 400) });
      try {
        const j = JSON.parse(out);
        resolve({ ok: true, result: j.result || "(kein Ergebnis)", sid: j.session_id || resumeId || null });
      } catch {
        resolve({ ok: false, error: "Antwort nicht lesbar: " + String(out).slice(0, 300) });
      }
    });
  });
}

const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const item = queue.shift();
    const reg = load();
    const cur = reg.sessions.find((s) => s.id === reg.aktiv) || null;
    const cwd = cur ? (cur.cwd || DEFAULT_CWD) : (item.cwd || reg.naechstesCwd || DEFAULT_CWD);
    const modus = cur ? (cur.modus || DEFAULT_MODE) : (reg.naechsterModus || DEFAULT_MODE);
    const r = await runClaude(item.text, cur ? cur.id : null, cwd, modus);
    if (!r.ok) { await send("Fehlgeschlagen: " + r.error); continue; }
    const reg2 = load();
    if (cur) {
      // resume liefert eine neue Session-ID: uebernehmen, sonst setzt der naechste Auftrag am alten Punkt an
      const s = reg2.sessions.find((x) => x.id === cur.id);
      if (s) { s.id = r.sid || s.id; s.zuletzt = Date.now(); }
      if (reg2.aktiv === cur.id) reg2.aktiv = r.sid || cur.id;
    } else if (r.sid && !reg2.sessions.some((x) => x.id === r.sid)) {
      reg2.sessions.push({ id: r.sid, titel: item.text.slice(0, 48), cwd, modus, erstellt: Date.now(), zuletzt: Date.now() });
      if (reg2.sessions.length > 15) reg2.sessions = reg2.sessions.slice(-15);
      if (!reg2.aktiv) reg2.aktiv = r.sid;
      reg2.naechstesCwd = null;
      reg2.naechsterModus = null;
    }
    save(reg2);
    await send(r.result);
  }
  busy = false;
}

let offset = 0;
console.log(new Date().toISOString(), "Session-Bot v5 gestartet");
while (true) {
  try {
    const res = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`);
    const data = await res.json();
    for (const u of data.result ?? []) {
      offset = u.update_id + 1;

      if (u.callback_query) {
        const cq = u.callback_query;
        let note = "Unbekannte Aktion";
        if (cq.from.id === CHAT_ID && cq.data && cq.data.startsWith("perm:")) {
          const teile = cq.data.split(":");
          const id = teile[1] || "", antwort = teile[2] === "ja" ? "ja" : "nein";
          if (/^[a-z0-9]+$/i.test(id)) {
            try {
              mkdirSync(PERM_DIR, { recursive: true });
              writeFileSync(`${PERM_DIR}/${id}`, antwort);
              note = antwort === "ja" ? "Erlaubt" : "Abgelehnt";
              // Sichtbares Feedback: Anfrage-Nachricht kennzeichnen, Buttons entfernen
              if (cq.message) {
                const orig = cq.message.text || "Berechtigungsanfrage";
                await fetch(`${API}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ chat_id: CHAT_ID, message_id: cq.message.message_id,
                    text: ((antwort === "ja" ? "ERLAUBT - Claude fuehrt aus:\n" : "ABGELEHNT - Claude ueberspringt:\n") + orig).slice(0, 4000) }) }).catch(() => {});
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
      const text = msg.text.trim();
      const reg = load();
      const cur = reg.sessions.find((s) => s.id === reg.aktiv) || null;

      if (text === "/start") {
        await send("Session-Bot bereit. Jede Nachricht ist ein Auftrag an die aktive Claude-Session. Befehle:\n/neu [projekt] [Auftrag] - neue Session, Verzeichnis waehlbar\n/projekte - Verzeichnisse zeigen, mit add registrieren\n/modus [standard|edits|plan|voll] - Berechtigungsmodus je Session\n/sessions - alle Sessions\n/wechsel N - Session wechseln\n/status - Stand plus SSH-Befehl zum Fortsetzen am Rechner\n/clear - Kontext leeren, frisch im selben Verzeichnis\n/ende - aktive Session ablegen\nWeb-Suche ist erlaubt. Braucht Claude weitere Rechte, kommt eine Freigabe-Anfrage mit Buttons (5 Minuten Zeit, dein Klick wird direkt in der Nachricht bestaetigt). " + DAUER);
        continue;
      }
      if (text === "/modus" || text.startsWith("/modus ")) {
        const arg = text.slice(6).trim().toLowerCase();
        if (!arg) {
          await send(`Aktueller Modus${cur ? ` der Session "${cur.titel}"` : " fuer die naechste Session"}: ${cur ? modusName(cur.modus) : modusName(reg.naechsterModus)}\n\nVerfuegbar:\nstandard - alles ausser Lesen fragt per Button an, auch Dateiaenderungen\nedits - Dateiaenderungen automatisch, Rest per Button (Standard)\nplan - nur lesen und planen, aendert nichts\nvoll - keine Nachfragen (Vorsicht)`);
        } else if (!MODI[arg]) {
          await send("Unbekannter Modus. Verfuegbar: standard, edits, plan, voll");
        } else {
          if (cur) {
            const s = reg.sessions.find((x) => x.id === cur.id);
            if (s) s.modus = MODI[arg];
            save(reg);
            await send(`Modus fuer "${cur.titel}": ${arg}${arg === "voll" ? "\nVorsicht: Claude fragt in dieser Session nichts mehr an." : ""}`);
          } else {
            reg.naechsterModus = MODI[arg]; save(reg);
            await send(`Modus fuer die naechste Session: ${arg}${arg === "voll" ? "\nVorsicht: Claude fragt in dieser Session nichts mehr an." : ""}`);
          }
        }
        continue;
      }
      if (text === "/projekte" || text.startsWith("/projekte ")) {
        const teile = text.split(/\s+/);
        if (teile[1] === "add" && teile[2] && teile[3]) {
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
      if (text === "/sessions") {
        if (!reg.sessions.length) { await send("Keine Sessions. Schick einfach einen Auftrag oder /neu."); continue; }
        const zeilen = reg.sessions.map((s, i) => `${i + 1}. ${s.titel} [${kurz(s.cwd)}, ${modusName(s.modus)}] - zuletzt ${wann(s.zuletzt)}${s.id === reg.aktiv ? " (aktiv)" : ""}`);
        await send(zeilen.join("\n") + "\nWechseln mit /wechsel N");
        continue;
      }
      if (text.startsWith("/wechsel")) {
        const n = parseInt(text.split(/\s+/)[1], 10);
        const ziel = reg.sessions[n - 1];
        if (!ziel) { await send("Unbekannte Nummer. /sessions zeigt die Liste."); continue; }
        reg.aktiv = ziel.id; save(reg);
        await send(`Aktiv: ${ziel.titel} [${kurz(ziel.cwd)}, ${modusName(ziel.modus)}]`);
        continue;
      }
      if (text === "/status") {
        const lage = busy ? `Ein Auftrag laeuft gerade${queue.length ? `, ${queue.length} in Warteschlange` : ""}.` : "Bereit.";
        if (cur) {
          await send(`Aktive Session: ${cur.titel}\nVerzeichnis: ${cur.cwd || DEFAULT_CWD}\nModus: ${modusName(cur.modus)}\nZuletzt: ${wann(cur.zuletzt)}\n${lage}\n\nAm Rechner fortsetzen:\nssh root@${HOST}\ncd "${cur.cwd || DEFAULT_CWD}" && claude --resume ${cur.id}`);
        } else {
          await send(`Keine aktive Session. ${lage}`);
        }
        continue;
      }
      if (text === "/clear") {
        if (!cur) { await send("Keine aktive Session. /neu startet frisch."); continue; }
        reg.sessions = reg.sessions.filter((s) => s.id !== cur.id);
        reg.aktiv = null; reg.naechstesCwd = cur.cwd || DEFAULT_CWD; reg.naechsterModus = cur.modus || null; save(reg);
        await send(`Kontext geleert. Deine naechste Nachricht startet frisch in ${kurz(cur.cwd)} (Modus ${modusName(cur.modus)}).`);
        continue;
      }
      if (text === "/ende") {
        if (!cur) { await send("Keine aktive Session."); continue; }
        reg.sessions = reg.sessions.filter((s) => s.id !== cur.id);
        reg.aktiv = null; save(reg);
        await send(`Abgelegt: ${cur.titel}. Das Transkript bleibt auf dem Server erhalten.`);
        continue;
      }
      if (text === "/neu" || text.startsWith("/neu ")) {
        const rest = text.slice(4).trim();
        const projekte = loadProj();
        let cwd = null, auftrag = rest;
        const erst = rest.split(/\s+/)[0] || "";
        if (projekte[erst.toLowerCase()]) { cwd = projekte[erst.toLowerCase()]; auftrag = rest.slice(erst.length).trim(); }
        else if (erst.startsWith("/") && existsSync(erst)) { cwd = erst; auftrag = rest.slice(erst.length).trim(); }
        if (cwd && !existsSync(cwd)) { await send(`Verzeichnis ${cwd} existiert nicht mehr. /projekte zeigt die Liste.`); continue; }
        reg.aktiv = null; reg.naechstesCwd = cwd; save(reg);
        if (auftrag) { queue.push({ text: auftrag, cwd }); await send(`Neue Session in ${kurz(cwd)} wird eroeffnet, Auftrag laeuft. ${DAUER}`); pump(); }
        else await send(`Alles klar, deine naechste Nachricht eroeffnet eine neue Session in ${kurz(cwd)} (Modus ${modusName(reg.naechsterModus)}).`);
        continue;
      }
      queue.push({ text, cwd: null });
      await send(busy ? `Eingereiht, Position ${queue.length}.` : cur ? `Auftrag laeuft in "${cur.titel}" [${kurz(cur.cwd)}, ${modusName(cur.modus)}]. ${DAUER}` : `Neue Session in ${kurz(reg.naechstesCwd)} wird eroeffnet (Modus ${modusName(reg.naechsterModus)}), Auftrag laeuft. ${DAUER}`);
      pump();
    }
  } catch (e) { console.error(new Date().toISOString(), "Loop:", (e && e.message) || e); await new Promise((r) => setTimeout(r, 5000)); }
}
