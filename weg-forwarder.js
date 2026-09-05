#!/usr/bin/env node
const crypto = require("node:crypto");
const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

const WEG_USER = process.env.WEG_USER;
const WEG_PASS = process.env.WEG_PASS;
const APP_URL = process.env.APP_URL;
const APP_SECRET = process.env.APP_SECRET;
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 300000);
const WEG_BASE = "https://weg.pv-hub.cloud";

if (!WEG_USER || !WEG_PASS || !APP_URL || !APP_SECRET) {
  console.error("Configure WEG_USER, WEG_PASS, APP_URL e APP_SECRET.");
  process.exit(1);
}

let _e = null, _mem = null;
const _enc = new TextEncoder(), _dec = new TextDecoder();
async function ensureWasm() {
  if (_e) return;
  const wb = await fetch(WEG_BASE + "/v2/js/signature.wasm", { headers: { "user-agent": "Mozilla/5.0" } });
  const bytes = new Uint8Array(await wb.arrayBuffer());
  const env = {
    emscripten_memcpy_big: (d, s, n) => { if (_mem) new Uint8Array(_mem.buffer).copyWithin(d, s, s + n); return d; },
    emscripten_resize_heap: () => 0,
    setTempRet0: () => {},
  };
  const { instance } = await WebAssembly.instantiate(bytes, { env });
  _e = instance.exports; _mem = _e.memory; _e.__wasm_call_ctors();
}
function writeStr(s) { const d = _enc.encode(s + "\0"); const p = _e.stackAlloc(d.length); new Uint8Array(_mem.buffer).set(d, p); return p; }
function readStr(p) { const b = new Uint8Array(_mem.buffer); let i = p; while (b[i] !== 0) i++; return _dec.decode(b.subarray(p, i)); }
function sign(path, token, lang, ts) {
  const sp = _e.stackSave();
  const r = _e.begin_signature(writeStr(path), writeStr(token || ""), writeStr(lang), writeStr(ts + ""));
  const v = readStr(r); _e.stackRestore(sp); return v;
}

async function wegRequest(method, path, token, body, query) {
  const ts = Date.now().toString();
  const sig = sign(path, token, "pt", ts);
  let url = WEG_BASE + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
    url += "?" + qs.toString();
  }
  const res = await fetch(url, {
    method,
    headers: {
      Token: token || "", Lang: "pt", "User-Agent": "Mozilla/5.0",
      Timezone: "America/Sao_Paulo", Timestamp: ts,
      "Content-Type": "application/json;charset=UTF-8", Signature: sig,
      platform: "web", category: "3", Accept: "application/json, text/plain, */*",
      Origin: WEG_BASE, Referer: WEG_BASE + "/v2/",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(`WEG ${path} HTTP ${res.status}`);
  return data;
}

async function login() {
  const data = await wegRequest("POST", "/basic/v0/user/login", "", {
    user: WEG_USER, password: md5(WEG_PASS), type: 1, verification: 1,
  });
  if (data?.errno && data.errno !== 0) throw new Error(`Login falhou: ${data.msg || data.errno}`);
  const token = data?.result?.token;
  if (typeof token !== "string" || !token) throw new Error("Token inválido");
  return token;
}

async function plantList(token) {
  const data = await wegRequest("POST", "/dew/w/v0/plant/list", token, {
    page: 1, size: 100, total: 0, status: 0,
    condition: { contentType: 2, content: "" },
  });
  if (data?.errno && data.errno !== 0) throw new Error(`plant/list: ${data.msg || data.errno}`);
  return data?.result?.data ?? data?.result?.plants ?? [];
}

async function workMode(token, plantId) {
  try {
    const data = await wegRequest("GET", "/dew/w/plant/work/mode", token, undefined, { plantID: plantId });
    if (data?.errno && data.errno !== 0) return null;
    return data?.result ?? null;
  } catch { return null; }
}

function statusFromPlant(plant, mode) {
  const wm = String(mode?.workMode || "").toLowerCase();
  if (/(backup|offgrid|off_grid|off-grid|eps|island|bess)/.test(wm)) return "bess";
  if (wm) return "on_grid";
  const blob = JSON.stringify(plant).toLowerCase();
  if (/(offgrid|off-grid|off_grid|eps|island)/.test(blob)) return "bess";
  return "on_grid";
}

async function tick() {
  try {
    console.log(`[${new Date().toISOString()}] Sincronizando...`);
    await ensureWasm();
    const token = await login();
    const plants = await plantList(token);
    const payload = [];
    for (const p of plants) {
      const pid = p.plantId ?? p.id ?? p.plant_id;
      const name = p.plantName ?? p.name ?? ("Planta " + pid);
      const mode = await workMode(token, pid);
      payload.push({
        weg_plant_id: pid,
        name,
        status: statusFromPlant(p, mode),
        summary: JSON.stringify({ plant: p, mode }).slice(0, 2000),
      });
    }
    const res = await fetch(APP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: APP_SECRET, plants: payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.error("App rejeitou:", data?.error || res.status);
    else console.log(`OK: ${data.plants} plantas, ${data.events} mudanças, ${data.notified} notificações.`);
  } catch (e) {
    console.error("Erro:", e.message);
  }
}

tick();
setInterval(tick, INTERVAL_MS);
console.log(`Forwarder PV Guard rodando a cada ${INTERVAL_MS / 1000}s. Ctrl+C para parar.`);