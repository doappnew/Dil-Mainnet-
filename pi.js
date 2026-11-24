// Routes Pi Network de DIL : connexion, paiements en Pi (abonnement Premium) et reprise des paiements inachevés.
// Aucune dépendance. Variables : PI_API_KEY (paiements), SESSION_SECRET (signature des sessions), PI_API_BASE (tests).
const crypto = require("crypto");
const premium = require("./premium");
const store = require("./store");

const PI_API = (process.env.PI_API_BASE || "https://api.minepi.com").replace(/\/$/, "");
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"); // sans variable, les sessions tombent à chaque redémarrage
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET absent : les sessions seront invalidées à chaque redémarrage");
const TTL = 7 * 24 * 3600 * 1000;

// Administrateurs : décidés par le serveur (variables ADMIN_UIDS et ADMIN_USERNAMES, séparées par des virgules).
// Par défaut, le nom d'utilisateur Pi ADONASGO est administrateur ; l'identifiant (uid) est plus sûr : à renseigner dans ADMIN_UIDS.
const list = (v) => String(v || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const ADMIN_UIDS = list(process.env.ADMIN_UIDS);
const ADMIN_NAMES = list(process.env.ADMIN_USERNAMES === undefined ? "ADONASGO" : process.env.ADMIN_USERNAMES);
const isAdmin = (u) => !!u && (ADMIN_UIDS.includes(String(u.uid).toLowerCase()) || (!!u.username && ADMIN_NAMES.includes(String(u.username).toLowerCase())));
// Compteurs en mémoire (remis à zéro à chaque redémarrage). Aucun nom ni identifiant n'est conservé : seulement un nombre.
const STATS = { since: Date.now(), logins: 0, uids: new Set(), payments: 0 };

const b64 = (b) => Buffer.from(b).toString("base64url");
const mac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function makeSession(u) { const p = b64(JSON.stringify({ uid: u.uid, username: u.username, exp: Date.now() + TTL })); return p + "." + mac(p); }
function readSession(h) {
  const m = /^Bearer\s+(\S+)$/.exec(h || ""); if (!m) return null;
  const [p, s] = m[1].split("."); if (!p || !s) return null;
  const a = Buffer.from(mac(p)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(p, "base64url").toString()); return d.exp > Date.now() && d.uid ? d : null; } catch { return null; }
}

// Catalogue des produits : le prix est fixé ICI, par le serveur, jamais par le navigateur.
// Abonnement Premium : accès de 30 jours payé en Pi, renouvelable à la main (aucun prélèvement automatique).
// Le prix est fixé par le formateur dans la variable PREMIUM_PRICE_PI (Render). Sans prix, l'abonnement reste fermé.
const SUB_DAYS = 30, DAY = 24 * 3600 * 1000;
const subPrice = () => { const n = Number(String(process.env.PREMIUM_PRICE_PI || "").replace(",", ".")); return Number.isFinite(n) && n > 0 && n <= 10000 ? Math.round(n * 1e7) / 1e7 : 0; };
const productFor = (key) => (key === "premium_month" && subPrice() > 0 ? { amount: subPrice(), memo: "DIL - Premium " + SUB_DAYS + " jours", days: SUB_DAYS } : null);
const sameAmt = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;
function makeReceipt(o) { const p = b64(JSON.stringify(Object.assign({ t: "receipt", at: Date.now() }, o))); return p + "." + mac(p); }

// Droit d'accès Premium : jeton signé par le serveur {uid, date de fin, derniers paiements}. Aucune base de données :
// l'appareil le conserve et le renvoie à chaque ouverture d'un parcours ; le serveur le revérifie à chaque fois.
const entMac = (p) => crypto.createHmac("sha256", SECRET).update("ent." + p).digest("base64url");
function makeEnt(o) { const p = b64(JSON.stringify({ t: "ent", uid: o.uid, exp: o.exp, pids: o.pids.slice(-12) })); return p + "." + entMac(p); }
function readEnt(tok, uid) {
  if (typeof tok !== "string" || tok.length > 2000) return null;
  const [p, s] = tok.split("."); if (!p || !s) return null;
  const a = Buffer.from(entMac(p)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(p, "base64url").toString()); return d.t === "ent" && d.uid === uid && Number.isFinite(d.exp) && Array.isArray(d.pids) ? d : null; } catch { return null; }
}
const entActive = (d) => !!d && d.exp > Date.now();
// fresh=true : seulement à la première validation d'un paiement par le serveur (ajoute 30 jours, à la suite des jours restants).
// fresh=false : on ne fait que retrouver un droit déjà acquis (paiement déjà validé) ; aucune prolongation.
function grant(uid, tok, payId, payment, fresh) {
  const old = readEnt(tok, uid);
  if (old && old.pids.includes(payId)) return old;
  if (!fresh) {
    if (old) return old;
    const created = Date.parse(payment && payment.created_at);
    if (!Number.isFinite(created)) return null;
    const exp = created + SUB_DAYS * DAY;
    return exp > Date.now() ? { uid, exp, pids: [payId] } : null;
  }
  const now = Date.now();
  const start = old && old.exp > now ? old.exp : now;
  return { uid, exp: start + SUB_DAYS * DAY, pids: ((old && old.pids) || []).concat(payId) };
}
const entOut = (e) => (e ? { entitlement: makeEnt(e), exp: e.exp } : {});
// Accès Premium : la base Supabase fait foi ; le droit signé conservé sur l'appareil sert de secours (base indisponible ou non configurée).
async function access(s, tok) {
  const e = readEnt(tok, s.uid);
  let exp = entActive(e) ? e.exp : 0;
  const d = await store.expiry(s.uid);
  if (d && d > exp) exp = d;
  return { active: exp > Date.now(), exp: exp || null };
}
// Enregistre le paiement (base) et met à jour le droit signé (appareil). fresh=true : première validation du paiement.
async function award(s, tok, id, p, fresh) {
  const tokE = grant(s.uid, tok, id, p, fresh);
  const created = Date.parse(p && p.created_at);
  const dbExp = await store.grant({ uid: s.uid, username: s.username, paymentId: id, product: "premium_month", amount: p.amount, txid: p.transaction && p.transaction.txid, days: SUB_DAYS, paidAt: Number.isFinite(created) ? created : Date.now() });
  const exp = Math.max(tokE ? tokE.exp : 0, dbExp || 0);
  return Object.assign(entOut(tokE), exp ? { exp } : {});
}
const isSubPay = (p) => !!(p && p.metadata && p.metadata.product === "premium_month");

async function piFetch(path, opts) {
  const r = await fetch(PI_API + path, Object.assign({ signal: AbortSignal.timeout(15000) }, opts));
  const d = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data: d };
}
const keyHeaders = () => ({ Authorization: "Key " + process.env.PI_API_KEY, "Content-Type": "application/json" });

async function readBody(req, send, res) {
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 4096) { send(res, 413, { error: "too_large" }); return null; } }
  try { return JSON.parse(raw || "{}"); } catch { send(res, 400, { error: "bad_json" }); return null; }
}

// Retourne true si la route a été traitée.
async function handle(req, res, url, h) {
  if (!url.startsWith("/api/auth/") && url !== "/api/me" && !url.startsWith("/api/payments/") && !url.startsWith("/api/admin/") && !url.startsWith("/api/premium/") && !url.startsWith("/api/subscription/")) return false;
  if (!h.cors(req, res)) { h.send(res, 403, { error: "origin_refused" }); return true; }
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
  if (h.limited(ip)) { h.send(res, 429, { error: "rate_limited" }); return true; }

  // 1) Connexion : le navigateur envoie l'accessToken, le serveur le fait vérifier par Pi (GET /v2/me).
  if (url === "/api/auth/verify" && req.method === "POST") {
    const body = await readBody(req, h.send, res); if (!body) return true;
    const token = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    if (!token || token.length > 4000) { h.send(res, 400, { error: "bad_request" }); return true; }
    try {
      const r = await piFetch("/v2/me", { headers: { Authorization: "Bearer " + token } });
      if (r.status === 401 || r.status === 403) { h.send(res, 401, { error: "invalid_token" }); return true; }
      if (!r.ok || !r.data || !r.data.uid) { console.error("pi /me", r.status); h.send(res, 502, { error: "pi_error" }); return true; }
      const user = { uid: String(r.data.uid), username: String(r.data.username || "") };
      STATS.logins++; if (STATS.uids.size < 100000) STATS.uids.add(crypto.createHash("sha256").update(user.uid).digest("base64url"));
      h.send(res, 200, { session: makeSession(user), user: Object.assign({}, user, { admin: isAdmin(user) }) });
    } catch (e) { console.error("pi /me", String(e.message).slice(0, 200)); h.send(res, 502, { error: "pi_unreachable" }); }
    return true;
  }

  // Session propre : vérifie qu'un jeton de session émis par ce serveur est encore valide.
  if (url === "/api/me" && req.method === "GET") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    h.send(res, 200, { user: { uid: s.uid, username: s.username, admin: isAdmin(s) } });
    return true;
  }

  // Contenu Premium : réservé aux administrateurs et aux abonnés dont le droit d'accès signé est encore valide (vérifié ici, jamais par le navigateur).
  if (url.startsWith("/api/premium/") && req.method === "GET") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    if (!isAdmin(s) && !(await access(s, req.headers["x-entitlement"])).active) { h.send(res, 403, { error: "locked" }); return true; }
    const r = premium.load(url.slice("/api/premium/".length).split("?")[0]);
    if (r.err) { h.send(res, r.err === "not_found" ? 404 : r.err === "bad_id" ? 400 : 503, { error: r.err }); return true; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(r.data); return true;
  }

  // Abonnement : tarif proposé et état de l'accès de l'utilisateur.
  if (url === "/api/subscription/plans" && req.method === "GET") {
    const price = subPrice();
    h.send(res, 200, { open: price > 0 && !!process.env.PI_API_KEY, plans: price > 0 ? [{ code: "premium_month", amount: price, days: SUB_DAYS }] : [] }); return true;
  }
  if (url === "/api/subscription/me" && req.method === "GET") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    const a = await access(s, req.headers["x-entitlement"]);
    h.send(res, 200, { active: a.active, exp: a.exp, daysLeft: a.active ? Math.ceil((a.exp - Date.now()) / DAY) : 0, admin: isAdmin(s) }); return true;
  }

  // Tableau de bord administrateur : abonnés, expirations, historique des paiements, revenus (Supabase). Vérifié par le serveur à chaque appel.
  if (url === "/api/admin/dashboard" && req.method === "GET") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    if (!isAdmin(s)) { h.send(res, 403, { error: "forbidden" }); return true; }
    const memory = { since: STATS.since, logins: STATS.logins, uniqueUsers: STATS.uids.size, paymentsCompleted: STATS.payments };
    if (!store.enabled()) { h.send(res, 200, { configured: false, memory }); return true; }
    const d = await store.summary();
    if (!d) { h.send(res, 502, { error: "store_error" }); return true; }
    h.send(res, 200, Object.assign({ configured: true, memory }, d)); return true;
  }

  // Administration : réservée aux administrateurs, vérifiée à chaque appel par le serveur.
  if (url === "/api/admin/stats" && req.method === "GET") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    if (!isAdmin(s)) { h.send(res, 403, { error: "forbidden" }); return true; }
    h.send(res, 200, { since: STATS.since, logins: STATS.logins, uniqueUsers: STATS.uids.size, paymentsCompleted: STATS.payments, adminUidsConfigured: ADMIN_UIDS.length > 0, yourUid: s.uid });
    return true;
  }

  // 2) Paiement inachevé trouvé à la connexion : on le termine ou on l'annule, après avoir vérifié qu'il est bien à cet utilisateur.
  if (url === "/api/payments/incomplete" && req.method === "POST") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    if (!process.env.PI_API_KEY) { h.send(res, 503, { error: "not_configured" }); return true; }
    const body = await readBody(req, h.send, res); if (!body) return true;
    const id = typeof body.paymentId === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(body.paymentId) ? body.paymentId : "";
    if (!id) { h.send(res, 400, { error: "bad_request" }); return true; }
    try {
      const g = await piFetch("/v2/payments/" + id, { headers: keyHeaders() });
      if (!g.ok) { console.error("payments: GET", g.status, (g.data && g.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
      const p = g.data;
      if (String(p.user_uid) !== s.uid) { h.send(res, 403, { error: "not_your_payment" }); return true; }
      const st = p.status || {};
      if (st.developer_completed) { h.send(res, 200, Object.assign({ result: "already_completed" }, isSubPay(p) ? await award(s, req.headers["x-entitlement"], id, p, false) : {})); return true; }
      if (st.cancelled || st.user_cancelled) { h.send(res, 200, { result: "already_cancelled" }); return true; }
      const txid = p.transaction && p.transaction.txid;
      if (txid) {
        const c = await piFetch("/v2/payments/" + id + "/complete", { method: "POST", headers: keyHeaders(), body: JSON.stringify({ txid }) });
        if (!c.ok) { console.error("payments: complete", c.status, (c.data && c.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
        STATS.payments++;
        h.send(res, 200, Object.assign({ result: "completed" }, isSubPay(p) && st.developer_approved ? await award(s, req.headers["x-entitlement"], id, p, true) : {})); return true;
      }
      const c = await piFetch("/v2/payments/" + id + "/cancel", { method: "POST", headers: keyHeaders(), body: "{}" });
      if (!c.ok) { console.error("payments: cancel", c.status, (c.data && c.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
      h.send(res, 200, { result: "cancelled" });
    } catch (e) { console.error("payments:", String(e.message).slice(0, 200)); h.send(res, 502, { error: "pi_unreachable" }); }
    return true;
  }
  // 3) Paiement : approbation puis complétion, toujours décidées par le serveur après contrôle auprès de Pi.
  if ((url === "/api/payments/approve" || url === "/api/payments/complete") && req.method === "POST") {
    const s = readSession(req.headers.authorization);
    if (!s) { h.send(res, 401, { error: "no_session" }); return true; }
    if (!process.env.PI_API_KEY) { h.send(res, 503, { error: "not_configured" }); return true; }
    const body = await readBody(req, h.send, res); if (!body) return true;
    const id = typeof body.paymentId === "string" && /^[A-Za-z0-9_-]{6,128}$/.test(body.paymentId) ? body.paymentId : "";
    if (!id) { h.send(res, 400, { error: "bad_request" }); return true; }
    try {
      const g = await piFetch("/v2/payments/" + id, { headers: keyHeaders() });
      if (!g.ok) { console.error("payments: GET", g.status, (g.data && g.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
      const p = g.data, st = p.status || {};
      if (String(p.user_uid) !== s.uid) { h.send(res, 403, { error: "not_your_payment" }); return true; }
      const key = p.metadata && p.metadata.product, prod = typeof key === "string" ? productFor(key) : null;
      if (!prod && key === "premium_month") { h.send(res, 503, { error: "closed" }); return true; }
      if (!prod || !sameAmt(p.amount, prod.amount)) { console.error("payments: produit ou montant refusé", key, p.amount); h.send(res, 400, { error: "bad_product" }); return true; }
      if (/testnet/i.test(String(p.network || ""))) { console.error("payments: paiement du réseau de test refusé"); h.send(res, 400, { error: "wrong_network" }); return true; }
      if (st.cancelled || st.user_cancelled) { h.send(res, 409, { error: "cancelled" }); return true; }
      if (url === "/api/payments/approve") {
        if (st.developer_approved) { h.send(res, 200, { result: "already_approved" }); return true; }
        const a = await piFetch("/v2/payments/" + id + "/approve", { method: "POST", headers: keyHeaders(), body: "{}" });
        if (!a.ok) { console.error("payments: approve", a.status, (a.data && a.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
        h.send(res, 200, { result: "approved" }); return true;
      }
      const txid = typeof body.txid === "string" && /^[A-Za-z0-9]{6,128}$/.test(body.txid) ? body.txid : "";
      if (!txid) { h.send(res, 400, { error: "bad_request" }); return true; }
      const ptx = p.transaction && p.transaction.txid;
      if (st.developer_completed) { h.send(res, 200, Object.assign({ result: "already_completed", receipt: makeReceipt({ uid: s.uid, product: key, paymentId: id, txid: ptx || txid }) }, await award(s, req.headers["x-entitlement"], id, p, false))); return true; }
      if (!st.developer_approved) { h.send(res, 409, { error: "not_approved" }); return true; }
      if (ptx !== txid) { console.error("payments: txid différent"); h.send(res, 400, { error: "txid_mismatch" }); return true; }
      const c = await piFetch("/v2/payments/" + id + "/complete", { method: "POST", headers: keyHeaders(), body: JSON.stringify({ txid }) });
      if (!c.ok) { console.error("payments: complete", c.status, (c.data && c.data.error) || ""); h.send(res, 502, { error: "pi_error" }); return true; }
      STATS.payments++;
      h.send(res, 200, Object.assign({ result: "completed", receipt: makeReceipt({ uid: s.uid, product: key, paymentId: id, txid }) }, await award(s, req.headers["x-entitlement"], id, p, true)));
    } catch (e) { console.error("payments:", String(e.message).slice(0, 200)); h.send(res, 502, { error: "pi_unreachable" }); }
    return true;
  }
  h.send(res, 404, { error: "not_found" }); return true;
}
// Porte d'entrée de l'assistant IA : réservé aux administrateurs et aux abonnés Premium (vérifié ici, jamais par le navigateur).
async function premiumGate(req) {
  const s = readSession(req.headers.authorization);
  if (!s) return { ok: false, status: 401, error: "no_session" };
  if (isAdmin(s)) return { ok: true };
  const a = await access(s, req.headers["x-entitlement"]);
  return a.active ? { ok: true } : { ok: false, status: 403, error: "premium_required" };
}
module.exports = { handle, premiumGate };
