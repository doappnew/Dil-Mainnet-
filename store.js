// Stockage des abonnements Premium dans Supabase (via l'API REST, aucune dépendance).
// Variables Render : SUPABASE_URL (adresse du projet) et SUPABASE_SERVICE_KEY (clé de service, secrète : jamais dans le navigateur).
// Sans ces variables, DIL fonctionne comme avant, avec le seul droit d'accès signé conservé sur l'appareil.
const BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY || "";
const enabled = () => !!(BASE && KEY);

async function rest(path, opts) {
  const r = await fetch(BASE + "/rest/v1" + path, Object.assign({
    headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000)
  }, opts));
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { /* vide ou non-JSON */ }
  if (!r.ok) { console.error("store: " + (opts && opts.method || "GET") + " " + path.split("?")[0] + " " + r.status + " " + ((data && (data.code || data.message)) || "").toString().slice(0, 120)); return null; }
  return { data };
}

// Enregistre un paiement et prolonge l'abonnement (atomique, sans doublon : clé payment_id). Retourne la date de fin (ms) ou null.
async function grant(o) {
  if (!enabled()) return null;
  try {
    const r = await rest("/rpc/dil_grant", { method: "POST", body: JSON.stringify({ p_uid: o.uid, p_username: o.username || null, p_payment_id: o.paymentId, p_product: o.product, p_amount: o.amount, p_txid: o.txid || null, p_days: o.days, p_paid_at: new Date(o.paidAt).toISOString() }) });
    const t = r && Date.parse(r.data);
    return Number.isFinite(t) ? t : null;
  } catch (e) { console.error("store: grant", String(e.message).slice(0, 120)); return null; }
}

// Date de fin de l'abonnement d'un utilisateur (ms), ou null.
async function expiry(uid) {
  if (!enabled()) return null;
  try {
    const r = await rest("/dil_subscriptions?select=expires_at&pi_uid=eq." + encodeURIComponent(uid) + "&limit=1");
    const t = r && r.data && r.data[0] && Date.parse(r.data[0].expires_at);
    return Number.isFinite(t) ? t : null;
  } catch (e) { console.error("store: expiry", String(e.message).slice(0, 120)); return null; }
}

// Synthèse du tableau de bord administrateur.
async function summary() {
  if (!enabled()) return null;
  try { const r = await rest("/rpc/dil_admin_summary", { method: "POST", body: "{}" }); return r && r.data; }
  catch (e) { console.error("store: summary", String(e.message).slice(0, 120)); return null; }
}

module.exports = { enabled, grant, expiry, summary };
