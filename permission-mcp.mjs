#!/usr/bin/env node
// Permission-MCP v2: leitet Claudes Berechtigungsanfragen weiter an den Nutzer.
// Wird von claude -p ueber --permission-prompt-tool mcp__perm__approve aufgerufen.
// Antwortdateien schreibt der Session-Bot bei Button-Tipp nach /root/.perm/<id>.
// v2: Bei Ablauf (5 Minuten) editiert der MCP die Anfrage-Nachricht und entfernt die Buttons.
import { readFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";

let TOKEN = process.env.BOT_TOKEN, CHAT = process.env.CHAT_ID;
if (!TOKEN || !CHAT) {
  try {
    const env = readFileSync("/root/.config/telegram-session.env", "utf8");
    TOKEN = TOKEN || (env.match(/^BOT_TOKEN=(.+)$/m) || [])[1];
    CHAT = CHAT || (env.match(/^CHAT_ID=(.+)$/m) || [])[1];
  } catch {}
}
const API = `https://api.telegram.org/bot${TOKEN}`;
const DIR = "/root/.perm";
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const kurzInput = (inp) => {
  try {
    if (inp && typeof inp.command === "string") return inp.command.slice(0, 600);
    const s = JSON.stringify(inp);
    return s.length > 600 ? s.slice(0, 600) + "..." : s;
  } catch { return String(inp); }
};

async function frage(toolName, input) {
  mkdirSync(DIR, { recursive: true });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const file = `${DIR}/${id}`;
  const anfrage = `Claude bittet um Erlaubnis:\n${toolName}\n${kurzInput(input)}`;
  const resp = await fetch(`${API}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(CHAT), text: anfrage,
      reply_markup: { inline_keyboard: [[
        { text: "Erlauben", callback_data: `perm:${id}:ja` },
        { text: "Ablehnen", callback_data: `perm:${id}:nein` }
      ]] } }) });
  let mid = null;
  try { mid = (await resp.json())?.result?.message_id ?? null; } catch {}
  const ende = Date.now() + 300000; // 5 Minuten
  while (Date.now() < ende) {
    await new Promise((r) => setTimeout(r, 2000));
    if (existsSync(file)) {
      const antwort = readFileSync(file, "utf8").trim();
      try { unlinkSync(file); } catch {}
      return antwort === "ja";
    }
  }
  // Abgelaufen: Nachricht kennzeichnen und Buttons entfernen, spaete Klicks laufen so nie ins Leere
  if (mid) {
    await fetch(`${API}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: Number(CHAT), message_id: mid,
        text: ("ABGELAUFEN - keine Antwort in 5 Minuten, automatisch abgelehnt.\n\n" + anfrage).slice(0, 4000) }) }).catch(() => {});
  }
  return false;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  try {
    if (m.method === "initialize") {
      out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "perm", version: "2.0.0" } } });
    } else if (m.method === "tools/list") {
      out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "approve", description: "Fragt per Telegram um Erlaubnis fuer eine Tool-Nutzung", inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" } }, required: ["tool_name", "input"] } }] } });
    } else if (m.method === "tools/call" && m.params && m.params.name === "approve") {
      const a = m.params.arguments || {};
      const ok = await frage(a.tool_name || "unbekannt", a.input || {});
      const ergebnis = ok
        ? { behavior: "allow", updatedInput: a.input || {} }
        : { behavior: "deny", message: "Abgelehnt oder keine Antwort innerhalb von 5 Minuten." };
      out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(ergebnis) }] } });
    } else if (m.id !== undefined) {
      out({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  } catch (e) {
    if (m && m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: String((e && e.message) || e).slice(0, 200) } });
  }
});
