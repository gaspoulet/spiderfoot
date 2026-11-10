/**
 * Fonction serverless Vercel — GET /api/devoirs — renvoie les devoirs à rendre, normalisés :
 *   { source, sourceLabel, fetchedAt, devoirs: [{ id, title, subject, due, url }] }
 *
 * Les identifiants restent côté serveur (variables d'environnement Vercel).
 * Sources possibles (DEVOIRS_SOURCE, sinon choisie selon les variables présentes) :
 *   - "blubee"              : ton site Blubee (sa base Supabase, avec ton compte Blubee)
 *   - "classroom"           : Google Classroom directement (OAuth refresh token)
 *   - "ical"                : n'importe quel flux .ics privé
 */

/** @typedef {{ id: string, title: string, subject: string, due: string | null, url: string | null }} Devoir */

const env = (k) => (process.env[k] ?? "").trim()
const UA = "Bureau-Dashboard/1.0"
const KEEP_LATE_DAYS = 14 // on garde les devoirs en retard jusqu'à 14 jours

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

function pickSource() {
  const forced = env("DEVOIRS_SOURCE").toLowerCase()
  if (forced) return forced
  if (env("BLUBEE_EMAIL")) return "blubee"
  if (env("GOOGLE_REFRESH_TOKEN")) return "classroom"
  if (env("ICAL_URL")) return "ical"
  return ""
}

export async function GET(req) {
  // Clé facultative : empêche n'importe qui de lire tes devoirs via l'URL publique
  const key = env("DASHBOARD_KEY")
  if (key && req.headers.get("x-dashboard-key") !== key) {
    return json({ error: "unauthorized", message: "Clé d'accès invalide" }, 401)
  }

  const source = pickSource()
  if (!source) {
    return json({ error: "not_configured", message: "Aucune source de devoirs configurée" }, 501)
  }
  try {
    let devoirs, label
    if (source === "classroom") { devoirs = await fromClassroom(); label = "Classroom" }
    else if (source === "ical") { devoirs = await fromIcal(); label = "Calendrier" }
    else { devoirs = await fromBlubee(); label = "Blubee" }

    const minDue = Date.now() - KEEP_LATE_DAYS * 864e5
    devoirs = dedupe(devoirs).filter((d) => !d.due || new Date(d.due).getTime() >= minDue)
    devoirs.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))

    return json({ source, sourceLabel: label, fetchedAt: new Date().toISOString(), devoirs }, 200, {
      "cache-control": "private, no-store",
    })
  } catch (e) {
    const err = e instanceof HttpError ? e : new HttpError(502, "upstream", e?.message || "Erreur")
    console.error(`[devoirs] ${source}: ${err.code} ${err.message}`)
    return json({ error: err.code, message: err.message }, err.status)
  }
}


/* ───────────────────────── Blubee ───────────────────────── */
// Blubee (https://blubee-gaspard.vercel.app) range ses devoirs dans Supabase (table « items »).
// La fonction se connecte avec ton compte Blubee et lit cette table, exactement comme l'app Blubee.
//
// BLUBEE_EMAIL, BLUBEE_PASSWORD   tes identifiants Blubee (variables secrètes Vercel)
// BLUBEE_SUPABASE_URL / BLUBEE_SUPABASE_KEY   à changer seulement si Blubee change de base
//   (la clé « publishable » est publique : elle est déjà dans le code de la page Blubee)
const SB_URL_DEFAULT = "https://vbmxngbmvqrgycmhokbj.supabase.co"
const SB_KEY_DEFAULT = "sb_publishable_QAWdqeiR8nDcGsWbvi-jEA_OvTUBnwl"
const BLUBEE_SUBJECTS = {
  biology: "Biologie", chemistry: "Chimie", physics: "Physique", maths: "Maths",
  english: "Anglais", geography: "Géographie", french: "Français", other: "Autre",
}
const BLUBEE_KINDS = { controle: "Contrôle", kognity: "Kognity", classroom: "Classroom", century: "Century" }
let sbSession = null // { access, refresh, exp } réutilisé tant que la fonction reste « chaude »

async function fromBlubee() {
  const sb = env("BLUBEE_SUPABASE_URL") || SB_URL_DEFAULT
  const key = env("BLUBEE_SUPABASE_KEY") || SB_KEY_DEFAULT
  const token = await blubeeToken(sb, key)
  const res = await fetch(`${sb}/rest/v1/items?select=*&status=neq.done&order=due_date.asc.nullslast`, {
    headers: { apikey: key, authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  })
  if (res.status === 401) { sbSession = null; throw new HttpError(502, "upstream_auth", "Session Blubee expirée, nouvel essai au prochain rafraîchissement") }
  if (!res.ok) throw new HttpError(502, "upstream", `Blubee indisponible : HTTP ${res.status}`)
  const rows = await res.json()
  return rows
    .filter((r) => r && r.status !== "done" && r.title)
    .map((r) => {
      const kind = BLUBEE_KINDS[r.kind]
      return {
        id: `blubee-${r.id}`,
        title: stripHtml(String(r.title)).slice(0, 200),
        subject: [BLUBEE_SUBJECTS[r.subject] ?? r.subject ?? "", kind].filter(Boolean).join(" · "),
        due: toIso(r.due_date, r.due_time),
        url: r.url ?? r.link ?? null,
      }
    })
}

async function blubeeToken(sb, key) {
  if (sbSession && sbSession.exp > Date.now() + 60_000) return sbSession.access
  const email = env("BLUBEE_EMAIL"), password = env("BLUBEE_PASSWORD")
  if (!email || !password) throw new HttpError(501, "not_configured", "BLUBEE_EMAIL et BLUBEE_PASSWORD manquants")
  const auth = (grant, body) => fetch(`${sb}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  let res = sbSession?.refresh ? await auth("refresh_token", { refresh_token: sbSession.refresh }) : null
  if (!res || !res.ok) res = await auth("password", { email: email.toLowerCase(), password })
  if (res.status === 400 || res.status === 401) throw new HttpError(502, "upstream_auth", "Blubee refuse la connexion (e-mail ou mot de passe ?)")
  if (!res.ok) throw new HttpError(502, "upstream", `Connexion Blubee impossible : HTTP ${res.status}`)
  const j = await res.json()
  sbSession = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 }
  return sbSession.access
}

/** Date → "YYYY-MM-DD" (date seule) ou ISO complet (avec heure). */
function toIso(v, time) {
  if (v == null || v === "") return null
  if (typeof v === "object" && "year" in v) {               // format Google { year, month, day }
    if (time && typeof time === "object") {
      return new Date(Date.UTC(v.year, v.month - 1, v.day, time.hours ?? 0, time.minutes ?? 0)).toISOString()
    }
    return `${v.year}-${String(v.month).padStart(2, "0")}-${String(v.day).padStart(2, "0")}`
  }
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString()
  const s = String(v).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const fr = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)                       // 12/11/2026
  if (fr) return `${fr[3]}-${fr[2].padStart(2, "0")}-${fr[1].padStart(2, "0")}`
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

/* ───────────────────────── Google Classroom ───────────────────────── */
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// Portées : classroom.courses.readonly, classroom.coursework.me.readonly
async function fromClassroom() {
  const id = env("GOOGLE_CLIENT_ID"), secret = env("GOOGLE_CLIENT_SECRET"), refresh = env("GOOGLE_REFRESH_TOKEN")
  if (!id || !secret || !refresh) throw new HttpError(501, "not_configured", "Identifiants Google manquants")

  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
  })
  if (!tok.ok) throw new HttpError(502, "upstream_auth", "Google refuse le refresh token (à régénérer)")
  const { access_token } = await tok.json()
  const g = async (path) => {
    const r = await fetch(`https://classroom.googleapis.com/v1/${path}`, { headers: { authorization: `Bearer ${access_token}` } })
    if (!r.ok) throw new HttpError(502, "upstream", `Classroom : HTTP ${r.status}`)
    return r.json()
  }

  const { courses = [] } = await g("courses?studentId=me&courseStates=ACTIVE&pageSize=50")
  const perCourse = await Promise.all(courses.map(async (c) => {
    const [work, subs] = await Promise.all([
      g(`courses/${c.id}/courseWork?courseWorkStates=PUBLISHED&orderBy=dueDate%20desc&pageSize=40`),
      g(`courses/${c.id}/courseWork/-/studentSubmissions?userId=me&pageSize=200`),
    ])
    const turnedIn = new Set(
      (subs.studentSubmissions ?? [])
        .filter((s) => s.state === "TURNED_IN" || s.state === "RETURNED")
        .map((s) => s.courseWorkId),
    )
    return (work.courseWork ?? [])
      .filter((w) => w.dueDate && !turnedIn.has(w.id))
      .map((w) => ({
        id: `gc-${w.id}`,
        title: w.title || "Devoir",
        subject: c.name || "",
        due: toIso(w.dueDate, w.dueTime),
        url: w.alternateLink ?? null,
      }))
  }))
  return perCourse.flat()
}

/* ───────────────────────── Flux iCal ───────────────────────── */
// ICAL_URL : lien .ics privé (webcal:// accepté)
async function fromIcal() {
  const src = env("ICAL_URL").replace(/^webcal:/i, "https:")
  if (!src) throw new HttpError(501, "not_configured", "ICAL_URL manquant")
  const res = await fetch(src, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new HttpError(502, "upstream", `Calendrier : HTTP ${res.status}`)
  const text = (await res.text()).replace(/\r?\n[ \t]/g, "")      // dépliage des lignes
  const out = []
  for (const block of text.split(/BEGIN:(?:VEVENT|VTODO)/).slice(1)) {
    const body = block.split(/END:(?:VEVENT|VTODO)/)[0]
    const get = (k) => body.match(new RegExp(`^${k}(?:;[^:\\n]*)?:(.*)$`, "m"))?.[1]?.trim()
    if (/^STATUS:(COMPLETED|CANCELLED)/m.test(body)) continue
    const raw = get("DUE") ?? get("DTEND") ?? get("DTSTART")
    const summary = unescapeIcs(get("SUMMARY") ?? "Devoir")
    const cat = unescapeIcs(get("CATEGORIES") ?? "")
    const m = summary.match(/^\[?([^\]:\-–]{2,30})[\]:\-–]\s*(.+)$/)        // « Maths : Exercice 3 »
    out.push({
      id: `ics-${get("UID") ?? hash(summary + raw)}`,
      title: m ? m[2] : summary,
      subject: cat || (m ? m[1].trim() : ""),
      due: icsDate(raw),
      url: get("URL") ?? null,
    })
  }
  return out
}
function icsDate(v) {
  if (!v) return null
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/)
  if (!m) return null
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`
  // Heure flottante : on la considère comme l'heure de Hong Kong (UTC+8)
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - (m[7] ? 0 : 8 * 36e5)
  return new Date(ms).toISOString()
}
const unescapeIcs = (s) => s.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim()

/* ───────────────────────── Utilitaires ───────────────────────── */
function dedupe(list) {
  const seen = new Set()
  return list.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)))
}
function stripHtml(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()
}
function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } })
}
