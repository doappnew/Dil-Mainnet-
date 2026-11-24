// Test de bout en bout : abonnement enregistré dans Supabase (faux Supabase et faux Pi en mémoire). Usage : node scripts/test-supabase.js
const http = require("http"), path = require("path"), { spawn } = require("child_process"), crypto = require("crypto");
const pays = {}, subs = {}, payRows = {}; let dbDown = false;
const jr = (res, c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const pi = http.createServer((req, res) => { let b = ""; req.on("data", c => b += c); req.on("end", () => {
  const u = req.url;
  if (u === "/v2/me") { const t = (req.headers.authorization || "").replace("Bearer ", ""); return t.startsWith("tok-") ? jr(res, 200, { uid: t.slice(4), username: "u_" + t.slice(4) }) : jr(res, 401, {}); }
  const m = /^\/v2\/payments\/([^/]+)(?:\/(approve|complete))?$/.exec(u); const p = m && pays[m[1]]; if (!p) return jr(res, 404, {});
  if (m[2] === "approve") p.status.developer_approved = true; if (m[2] === "complete") p.status.developer_completed = true; jr(res, 200, p); }); }).listen(4997);
const sb = http.createServer((req, res) => { let b = ""; req.on("data", c => b += c); req.on("end", () => {
  if (req.headers.apikey !== "svc-key" || req.headers.authorization !== "Bearer svc-key") return jr(res, 401, { message: "bad key" });
  if (dbDown) return jr(res, 503, { message: "down" });
  if (req.url === "/rest/v1/rpc/dil_grant") { const a = JSON.parse(b); if (!payRows[a.p_payment_id]) { payRows[a.p_payment_id] = a; const old = subs[a.p_uid] || 0; const start = Math.max(old, Date.parse(a.p_paid_at)); subs[a.p_uid] = start + a.p_days * 864e5; } return jr(res, 200, new Date(subs[a.p_uid]).toISOString()); }
  if (req.url.startsWith("/rest/v1/dil_subscriptions")) { const uid = decodeURIComponent(/pi_uid=eq\.([^&]+)/.exec(req.url)[1]); return jr(res, 200, subs[uid] ? [{ expires_at: new Date(subs[uid]).toISOString() }] : []); }
  if (req.url === "/rest/v1/rpc/dil_admin_summary") return jr(res, 200, { active: Object.keys(subs).length, payments_total: Object.keys(payRows).length, recent_payments: [] });
  jr(res, 404, {}); }); }).listen(4996);
const mk = (id, uid, amt) => pays[id] = { identifier: id, user_uid: uid, amount: amt, metadata: { product: "premium_month" }, network: "Pi Network", created_at: new Date().toISOString(), status: { developer_approved: false, developer_completed: false }, transaction: { txid: "tx" + id.replace(/_/g, "") } };
const srv = spawn("node", [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: "4002", PI_API_BASE: "http://localhost:4997", PI_API_KEY: "k", SESSION_SECRET: "s".repeat(40), PREMIUM_PRICE_PI: "2", ADMIN_USERNAMES: "u_boss", PREMIUM_KEY: crypto.randomBytes(32).toString("base64"), SUPABASE_URL: "http://localhost:4996", SUPABASE_SERVICE_KEY: "svc-key" }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", d => log += d); srv.stderr.on("data", d => log += d);
const call = (p, o = {}) => fetch("http://localhost:4002" + p, o).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }));
const J = (t, e, body) => ({ method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}), ...(e ? { "x-entitlement": e } : {}) }, body: JSON.stringify(body) });
const G = (t, e) => ({ headers: { ...(t ? { authorization: "Bearer " + t } : {}), ...(e ? { "x-entitlement": e } : {}) } });
let fails = 0; const ok = (n, c, x) => { console.log((c ? "OK   " : "ECHEC") + " " + n + (c ? "" : " -> " + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  await new Promise(r => setTimeout(r, 800));
  const A = (await call("/api/auth/verify", J(null, null, { accessToken: "tok-alice" }))).d.session;
  const BOSS = (await call("/api/auth/verify", J(null, null, { accessToken: "tok-boss" }))).d.session;
  mk("pay_s00001", "alice", 2);
  await call("/api/payments/approve", J(A, null, { paymentId: "pay_s00001" }));
  let r = await call("/api/payments/complete", J(A, null, { paymentId: "pay_s00001", txid: "txpays00001" }));
  ok("paiement enregistré dans la base", r.s === 200 && payRows.pay_s00001 && payRows.pay_s00001.p_amount === 2 && subs.alice > Date.now() + 29 * 864e5, r);
  const E = r.d.entitlement;
  r = await call("/api/premium/P1", G(A, null)); ok("nouvel appareil, sans jeton : accès par la base (404 = contenu absent, pas 403)", r.s === 404, r);
  r = await call("/api/payments/complete", J(A, E, { paymentId: "pay_s00001", txid: "txpays00001" })); const before = subs.alice; ok("2e complete : pas de doublon en base", r.s === 200 && subs.alice === before && Object.keys(payRows).length === 1, r);
  dbDown = true;
  r = await call("/api/premium/P1", G(A, E)); ok("base indisponible : le jeton de secours ouvre l'accès", r.s === 404, r);
  r = await call("/api/premium/P1", G(A, null)); ok("base indisponible sans jeton : fermé", r.s === 403, r);
  dbDown = false;
  r = await call("/api/admin/dashboard", G(A)); ok("tableau de bord refusé à un non-administrateur", r.s === 403, r);
  r = await call("/api/admin/dashboard", G(BOSS)); ok("tableau de bord administrateur", r.s === 200 && r.d.configured && r.d.active === 1 && r.d.payments_total === 1, r);
  r = await call("/api/admin/dashboard", G(null)); ok("tableau de bord sans session : 401", r.s === 401, r);
  srv.kill(); pi.close(); sb.close(); console.log(fails ? fails + " échec(s)" : "TOUS LES TESTS OK"); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e, log); srv.kill(); process.exit(1); });
