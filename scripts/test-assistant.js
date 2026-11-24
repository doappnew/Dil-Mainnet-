// Test : l'assistant IA est réservé aux abonnés Premium (faux serveur Pi). Usage : node scripts/test-assistant.js
const http = require("http"), path = require("path"), { spawn } = require("child_process"), crypto = require("crypto");
const pays = {};
const jr = (res, c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const pi = http.createServer((req, res) => { let b = ""; req.on("data", c => b += c); req.on("end", () => {
  const u = req.url;
  if (u === "/v2/me") { const t = (req.headers.authorization || "").replace("Bearer ", ""); return t.startsWith("tok-") ? jr(res, 200, { uid: t.slice(4), username: "u_" + t.slice(4) }) : jr(res, 401, {}); }
  const m = /^\/v2\/payments\/([^/]+)(?:\/(approve|complete))?$/.exec(u); const p = m && pays[m[1]]; if (!p) return jr(res, 404, {});
  if (m[2] === "approve") p.status.developer_approved = true; if (m[2] === "complete") p.status.developer_completed = true; jr(res, 200, p); }); }).listen(4995);
pays.pay_a00001 = { identifier: "pay_a00001", user_uid: "alice", amount: 2, metadata: { product: "premium_month" }, network: "Pi Network", created_at: new Date().toISOString(), status: { developer_approved: false, developer_completed: false }, transaction: { txid: "txpaya00001" } };
const srv = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: "4003", PI_API_BASE: "http://localhost:4995", PI_API_KEY: "k", SESSION_SECRET: "s".repeat(40), PREMIUM_PRICE_PI: "2", ADMIN_USERNAMES: "u_boss", SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
const call = (p, o = {}) => fetch("http://localhost:4003" + p, o).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }));
const J = (t, e, body) => ({ method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}), ...(e ? { "x-entitlement": e } : {}) }, body: JSON.stringify(body) });
let fails = 0; const ok = (n, c, x) => { console.log((c ? "OK   " : "ECHEC") + " " + n + (c ? "" : " -> " + JSON.stringify(x))); if (!c) fails++; };
const chat = { messages: [{ role: "user", content: "Qu'est-ce qu'un stablecoin ?" }] };
(async () => {
  await new Promise(r => setTimeout(r, 800));
  const A = (await call("/api/auth/verify", J(null, null, { accessToken: "tok-alice" }))).d.session;
  const BOSS = (await call("/api/auth/verify", J(null, null, { accessToken: "tok-boss" }))).d.session;
  let r = await call("/api/chat", J(null, null, chat)); ok("assistant fermé sans session (401)", r.s === 401, r);
  r = await call("/api/chat", J(A, null, chat)); ok("assistant fermé sans abonnement (403 premium_required)", r.s === 403 && r.d.error === "premium_required", r);
  r = await call("/api/chat", J(BOSS, null, chat)); ok("administrateur : porte ouverte (503 = clé IA absente, pas 403)", r.s === 503, r);
  await call("/api/payments/approve", J(A, null, { paymentId: "pay_a00001" }));
  const c = await call("/api/payments/complete", J(A, null, { paymentId: "pay_a00001", txid: "txpaya00001" }));
  r = await call("/api/chat", J(A, c.d.entitlement, chat)); ok("abonné : porte ouverte (503 = clé IA absente, pas 403)", r.s === 503, r);
  srv.kill(); pi.close(); console.log(fails ? fails + " échec(s)" : "TOUS LES TESTS OK"); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
