// Test de bout en bout de l'abonnement Premium avec un faux serveur Pi. Usage : node scripts/test-abonnement.js (dure ~1 min : limite de débit).
const http = require("http"), { spawn } = require("child_process"), crypto = require("crypto");
const pays = {}; // mock Pi
const mock = http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    const send = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const u = req.url;
    if (u === "/v2/me") { const t = (req.headers.authorization || "").replace("Bearer ", ""); return t.startsWith("tok-") ? send(200, { uid: t.slice(4), username: "u_" + t.slice(4) }) : send(401, {}); }
    if (!/^Key /.test(req.headers.authorization || "")) return send(401, {});
    let m = /^\/v2\/payments\/([^/]+)(?:\/(approve|complete|cancel))?$/.exec(u); if (!m) return send(404, {});
    const p = pays[m[1]]; if (!p) return send(404, { error: "payment_not_found" });
    if (m[2] === "approve") { p.status.developer_approved = true; return send(200, p); }
    if (m[2] === "complete") { if (p.status.developer_completed) return send(400, { error: "already_completed" }); p.status.developer_completed = true; return send(200, p); }
    send(200, p);
  });
}).listen(4999);
const mk = (id, uid, amount, network = "Pi Network", product = "premium_month") => pays[id] = { identifier: id, user_uid: uid, amount, memo: "x", metadata: { product }, network, created_at: new Date().toISOString(), status: { developer_approved: false, developer_completed: false, cancelled: false, user_cancelled: false }, transaction: { txid: "tx" + id.replace(/_/g, "") } };
const srv = spawn("node", [require("path").join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: "4001", PI_API_BASE: "http://localhost:4999", PI_API_KEY: "k", SESSION_SECRET: "s".repeat(40), PREMIUM_PRICE_PI: "1,5", ADMIN_USERNAMES: "boss", PREMIUM_KEY: crypto.randomBytes(32).toString("base64") }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", d => log += d); srv.stderr.on("data", d => log += d);
const call = (path, o = {}) => fetch("http://localhost:4001" + path, o).then(async r => ({ s: r.status, d: await r.json().catch(() => ({})) }));
const J = (tok, ent, body) => ({ method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}), ...(ent ? { "x-entitlement": ent } : {}) }, body: JSON.stringify(body) });
const G = (tok, ent) => ({ headers: { ...(tok ? { authorization: "Bearer " + tok } : {}), ...(ent ? { "x-entitlement": ent } : {}) } });
let fails = 0; const ok = (n, c, x) => { console.log((c ? "OK   " : "ECHEC") + " " + n + (c ? "" : " -> " + JSON.stringify(x))); if (!c) fails++; };
(async () => {
  await new Promise(r => setTimeout(r, 800));
  let r = await call("/api/subscription/plans"); ok("tarif ouvert à 1,5 Pi", r.d.open && r.d.plans[0].amount === 1.5 && r.d.plans[0].days === 30, r);
  r = await call("/api/auth/verify", J(null, null, { accessToken: "tok-alice" })); const A = r.d.session; ok("connexion alice", r.s === 200 && A, r);
  r = await call("/api/auth/verify", J(null, null, { accessToken: "tok-bob" })); const B = r.d.session;
  r = await call("/api/premium/P1", G(A)); ok("premium fermé sans abonnement (403)", r.s === 403, r);
  mk("pay_000001", "alice", 1.5); mk("pay_bad001", "alice", 0.1); mk("pay_net001", "alice", 1.5, "Pi Testnet"); mk("pay_bobx01", "bob", 1.5); mk("pay_prod01", "alice", 1.5, "Pi Network", "test");
  r = await call("/api/payments/approve", J(A, null, { paymentId: "pay_bad001" })); ok("mauvais montant refusé", r.s === 400, r);
  r = await call("/api/payments/approve", J(A, null, { paymentId: "pay_net001" })); ok("paiement Testnet refusé", r.s === 400 && r.d.error === "wrong_network", r);
  r = await call("/api/payments/approve", J(A, null, { paymentId: "pay_prod01" })); ok("ancien produit test refusé", r.s === 400, r);
  r = await call("/api/payments/approve", J(A, null, { paymentId: "pay_bobx01" })); ok("paiement d'un autre refusé", r.s === 403, r);
  r = await call("/api/payments/complete", J(A, null, { paymentId: "pay_000001", txid: "txpay000001" })); ok("complete avant approve refusé", r.s === 409, r);
  r = await call("/api/payments/approve", J(A, null, { paymentId: "pay_000001" })); ok("approve ok", r.s === 200, r);
  r = await call("/api/payments/complete", J(A, null, { paymentId: "pay_000001", txid: "txpay000001" })); const E1 = r.d.entitlement; const exp1 = r.d.exp;
  ok("complete -> droit 30 jours", r.s === 200 && E1 && Math.abs(exp1 - (Date.now() + 30 * 864e5)) < 60000, r);
  r = await call("/api/payments/complete", J(A, E1, { paymentId: "pay_000001", txid: "txpay000001" })); ok("2e complete idempotent (pas de prolongation)", r.s === 200 && r.d.exp === exp1, r);
  r = await call("/api/payments/complete", J(A, null, { paymentId: "pay_000001", txid: "txpay000001" })); ok("2e complete sans jeton : retrouve sans dépasser", r.s === 200 && r.d.exp <= exp1 + 1000, r);
  r = await call("/api/premium/P1", G(A, E1)); ok("abonné : accès (404 = contenu absent, pas 403)", r.s === 404, r);
  r = await call("/api/premium/P1", G(B, E1)); ok("jeton d'alice inutilisable par bob", r.s === 403, r);
  await new Promise(r => setTimeout(r, 61000));
  r = await call("/api/premium/P1", G(A, E1.slice(0, -3) + "xyz")); ok("jeton falsifié refusé", r.s === 403, r);
  r = await call("/api/subscription/me", G(A, E1)); ok("statut abonnement actif", r.d.active && r.d.daysLeft >= 29, r);
  mk("pay_000002", "alice", 1.5);
  await call("/api/payments/approve", J(A, E1, { paymentId: "pay_000002" }));
  r = await call("/api/payments/complete", J(A, E1, { paymentId: "pay_000002", txid: "txpay000002" })); ok("renouvellement = +30 jours à la suite", r.s === 200 && Math.abs(r.d.exp - (exp1 + 30 * 864e5)) < 2000, r);
  r = await call("/api/premium/P1", G(null, E1)); ok("sans session : 401", r.s === 401, r);
  srv.kill(); mock.close(); console.log(fails ? fails + " échec(s)" : "TOUS LES TESTS OK"); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e, log); srv.kill(); process.exit(1); });
