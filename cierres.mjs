// Cierre Diario — guarda las planillas de cierre de cada negocio de Andrés
// Usa los mismos enlaces (?n=código) y la misma clave de administrador de Precios al Día.
import { getStore } from "@netlify/blobs";
import { createHmac } from "node:crypto";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-pin",
  "access-control-max-age": "86400"
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" } });

const VENCE = () => process.env.VENCE || "2027-05-08";
const expired = () => Date.now() > new Date(VENCE() + "T23:59:59-05:00").getTime();
const secret = () => process.env.LINK_SECRET || process.env.OWNER_PIN || "";
const token = name => createHmac("sha256", secret()).update(String(name)).digest("base64url").slice(0, 12);
const isOwner = req => !!process.env.OWNER_PIN && (req.headers.get("x-pin") || "") === process.env.OWNER_PIN;

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const FECHA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ID = /^[A-Za-z0-9_-]{6,40}$/;

// Lista de meses AAAA-MM entre dos meses (máximo 36)
const months = (from, to) => {
  const out = []; let [y, m] = from.split("-").map(Number); const [ty, tm] = to.split("-").map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 36) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++ } }
  return out;
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (expired()) return json({ expired: true, vence: VENCE() }, req.method === "GET" ? 200 : 403);

  const store = getStore("cierres");
  const owner = isOwner(req);

  // Negocios: los de la lista de precios más los que el administrador agregue aquí
  const lista = await getStore("precios").get("lista", { type: "json" });
  const extra = (await store.get("negocios", { type: "json" })) || [];
  const names = [...new Set([...(lista?.order || []), ...extra])];
  const negocios = names.map(name => ({ name, tok: token(name) }));
  const valid = tok => negocios.some(n => n.tok === tok);
  const key = (tok, ym) => `m/${tok}/${ym}`;

  if (req.method === "GET") {
    const q = new URL(req.url).searchParams;
    const n = q.get("n") || "";
    if (!owner) {
      if (!n) return json({ needLink: true });
      if (!valid(n)) return json({ badLink: true });
    }
    const from = q.get("from") || "", to = q.get("to") || "";
    if (!YM.test(from) || !YM.test(to) || from > to) return json({ error: "Rango inválido" }, 400);
    const toks = owner ? (n && valid(n) ? [n] : negocios.map(x => x.tok)) : [n];
    const planillas = [];
    await Promise.all(toks.flatMap(tok => months(from, to).map(async ym => {
      const mes = await store.get(key(tok, ym), { type: "json" });
      if (mes) for (const p of Object.values(mes)) planillas.push({ ...p, neg: tok });
    })));
    return json({ negocios: owner ? negocios : negocios.filter(x => x.tok === n), planillas, from, to, toks, owner, vence: VENCE() });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "Datos inválidos" }, 400); }
    if (!body || typeof body !== "object") return json({ error: "Datos inválidos" }, 400);

    if (body.check) return owner ? json({ ok: true, vence: VENCE() }) : json({ error: "Clave incorrecta" }, 401);

    if (body.addNegocio !== undefined) {
      if (!owner) return json({ error: "Clave incorrecta" }, 401);
      const name = String(body.addNegocio).trim().slice(0, 40);
      if (!name) return json({ error: "Datos inválidos" }, 400);
      if (!names.includes(name)) await store.setJSON("negocios", [...extra, name]);
      return json({ ok: true, negocios: [...new Set([...names, name])].map(x => ({ name: x, tok: token(x) })) });
    }

    const tok = String(body.n || "");
    if (!valid(tok)) return json(owner ? { error: "Negocio inválido" } : { badLink: true }, owner ? 400 : 401);

    // Eliminar una planilla: solo el administrador
    if (body.del) {
      if (!owner) return json({ error: "Solo el administrador puede eliminar" }, 401);
      if (!ID.test(String(body.del)) || !FECHA.test(String(body.fecha))) return json({ error: "Datos inválidos" }, 400);
      const k = key(tok, body.fecha.slice(0, 7));
      const mes = (await store.get(k, { type: "json" })) || {};
      delete mes[body.del];
      await store.setJSON(k, mes);
      return json({ ok: true });
    }

    // Guardar (crear o editar) una planilla
    const p = body.planilla;
    if (!p || typeof p !== "object" || !ID.test(String(p.id)) || !FECHA.test(String(p.fecha))) return json({ error: "Datos inválidos" }, 400);
    if (JSON.stringify(p).length > 60000) return json({ error: "Planilla demasiado grande" }, 413);
    const clean = { ...p, updatedAt: Date.now() };
    for (const f of Object.keys(clean)) if (f.startsWith("_") || f === "neg") delete clean[f];

    const ym = p.fecha.slice(0, 7);
    const prev = FECHA.test(String(body.prevFecha || "")) ? body.prevFecha.slice(0, 7) : ym;
    if (prev !== ym) { // cambió de mes al editar la fecha
      const old = await store.get(key(tok, prev), { type: "json" });
      if (old && old[p.id]) { delete old[p.id]; await store.setJSON(key(tok, prev), old); }
    }
    const mes = (await store.get(key(tok, ym), { type: "json" })) || {};
    if (!clean.createdAt) clean.createdAt = mes[p.id]?.createdAt || clean.updatedAt;
    mes[p.id] = clean;
    await store.setJSON(key(tok, ym), mes);
    return json({ ok: true, updatedAt: clean.updatedAt });
  }

  return json({ error: "Método no permitido" }, 405);
};

export const config = { path: "/api/cierres" };
