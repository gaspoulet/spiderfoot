/**
 * Fonction serverless Vercel — GET /api/devoirs — renvoie les devoirs à rendre, normalisés :
 *   { source, sourceLabel, fetchedAt, devoirs: [{ id, title, subject, due, url }] }
 *
 * Les identifiants restent côté serveur (variables d'environnement Vercel).
 * Sources possibles (DEVOIRS_SOURCE, sinon choisie selon les variables présentes) :
 *   - "blubee"              : ton site Blubee (connexion e-mail + mot de passe)
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
  if (env("BLUBEE_EMAIL") || env("BLUBEE_COOKIE") || env("BLUBEE_TOKEN") || env("BLUBEE_URL")) return "blubee"
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
    const debug = new URL(req.url).searchParams.has("debug")
    if (debug && source === "blubee") return json(await fromBlubee(true))
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
// Blubee (Next.js) n'a pas d'API publique : la fonction se connecte comme toi dans Safari
// (formulaire e-mail + mot de passe), garde le cookie de session, puis lit la page des devoirs.
//
// BLUBEE_EMAIL, BLUBEE_PASSWORD   tes identifiants Blubee (variables secrètes Vercel)
// BLUBEE_URL     https://blubee-gaspard.vercel.app (défaut)
// BLUBEE_PATHS   pages où chercher les devoirs, séparées par des virgules (défaut "/")
// BLUBEE_TOKEN / BLUBEE_COOKIE    alternative : jeton Bearer ou cookie de session tout prêt
const BLUBEE_DEFAULT = "https://blubee-gaspard.vercel.app"
let blubeeCookie = "" // réutilisé tant que la fonction reste « chaude »

async function fromBlubee(debug) {
  const base = env("BLUBEE_URL") || BLUBEE_DEFAULT
  const paths = (env("BLUBEE_PATHS") || env("BLUBEE_PATH") || "/").split(",").map((p) => p.trim()).filter(Boolean)
  const found = []
  const report = []
  for (const path of paths) {
    let page = await blubeeGet(base, path)
    if (page.login) {                                   // session expirée → on se reconnecte une fois
      blubeeCookie = await blubeeLogin(base)
      page = await blubeeGet(base, path)
      if (page.login) throw new HttpError(502, "upstream_auth", "Blubee refuse la connexion (e-mail ou mot de passe ?)")
    }
    const lists = extractLists(page.body)
    report.push({ path, status: page.status, bytes: page.body.length, lists: lists.map((l) => ({ score: l.score, n: l.items.length, keys: Object.keys(l.items[0] ?? {}).slice(0, 15) })) })
    if (lists.length) found.push(...lists[0].items.map((it, i) => normalize(it, "blubee", i)).filter(Boolean))
  }
  if (debug) return { report, sample: found.slice(0, 3) }
  if (!found.length && report.every((r) => !r.lists.length)) {
    throw new HttpError(502, "upstream_format", "Connecté à Blubee, mais aucun devoir trouvé sur la page (BLUBEE_PATHS ?)")
  }
  return found
}

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""]
  return list.map((c) => c.split(";")[0]).filter((c) => c && !/=$/.test(c)).join("; ")
}
function mergeCookies(a, b) {
  const m = new Map()
  for (const part of `${a}; ${b}`.split(/;\s*/)) { const i = part.indexOf("="); if (i > 0) m.set(part.slice(0, i), part) }
  return [...m.values()].join("; ")
}

async function blubeeLogin(base) {
  if (env("BLUBEE_COOKIE")) return env("BLUBEE_COOKIE")
  const email = env("BLUBEE_EMAIL"), password = env("BLUBEE_PASSWORD")
  if (!email || !password) throw new HttpError(501, "not_configured", "BLUBEE_EMAIL et BLUBEE_PASSWORD manquants")

  const page = await fetch(new URL("/login", base), { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) })
  if (!page.ok) throw new HttpError(502, "upstream", `Blubee indisponible : HTTP ${page.status}`)
  const html = await page.text()
  let jar = cookieHeader(page)

  // Champs cachés du formulaire Next.js (dont l'identifiant de la server action, qui change à chaque déploiement)
  const form = new FormData()
  const formHtml = html.match(/<form[\s\S]*?<\/form>/i)?.[0] ?? html
  for (const m of formHtml.matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
    const name = m[0].match(/name="([^"]+)"/)?.[1]
    if (name) form.append(name, decodeEntities(m[0].match(/value="([^"]*)"/)?.[1] ?? ""))
  }
  if (![...form.keys()].some((k) => k.startsWith("$ACTION"))) {
    throw new HttpError(502, "upstream_format", "Formulaire de connexion Blubee non reconnu")
  }
  form.append("email", email)
  form.append("password", password)

  const res = await fetch(new URL("/login", base), {
    method: "POST", body: form, redirect: "manual",
    headers: { "user-agent": UA, cookie: jar, origin: new URL(base).origin, referer: new URL("/login", base).href },
    signal: AbortSignal.timeout(15000),
  })
  jar = mergeCookies(jar, cookieHeader(res))
  const loc = res.headers.get("location") ?? ""
  if (!jar || (res.status < 300 && !cookieHeader(res)) || /\/login/.test(loc)) {
    throw new HttpError(502, "upstream_auth", "Blubee refuse la connexion (e-mail ou mot de passe ?)")
  }
  return jar
}

async function blubeeGet(base, path) {
  if (!blubeeCookie && !env("BLUBEE_TOKEN")) return { login: true, status: 0, body: "" }
  const headers = { "user-agent": UA, accept: "text/html,application/json" }
  if (blubeeCookie) headers.cookie = blubeeCookie
  if (env("BLUBEE_TOKEN")) headers.authorization = `Bearer ${env("BLUBEE_TOKEN")}`
  const res = await fetch(new URL(path, base), { headers, redirect: "manual", signal: AbortSignal.timeout(20000) })
  const loc = res.headers.get("location") ?? ""
  if ((res.status >= 300 && res.status < 400 && /login/.test(loc)) || res.status === 401) {
    return { login: true, status: res.status, body: "" }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const hint = body.includes("usage_exceeded") ? " (quota d'hébergement dépassé)" : ""
    throw new HttpError(502, "upstream", `Blubee indisponible : HTTP ${res.status}${hint}`)
  }
  const body = await res.text()
  if (/name="password"/.test(body) && /\$ACTION_ID_/.test(body)) return { login: true, status: res.status, body: "" }
  return { status: res.status, body }
}

/**
 * Récupère tous les tableaux d'objets « devoir » présents dans une page Next.js :
 * JSON brut, ou données React Server Components (self.__next_f.push) intégrées au HTML.
 * Renvoie les listes triées de la plus probable à la moins probable.
 */
function extractLists(body) {
  const texts = []
  const t = body.trim()
  if (t.startsWith("{") || t.startsWith("[")) texts.push(t)
  for (const m of body.matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { texts.push(JSON.parse(m[1])) } catch { /* fragment illisible */ }
  }
  const flight = texts.join("")
  const values = []
  for (const line of flight.split("\n")) {                           // lignes « id:payload »
    const payload = line.replace(/^[0-9a-z]+:(?:[A-Z]{1,2})?/i, "")
    if (payload.startsWith("[") || payload.startsWith("{")) { try { values.push(JSON.parse(payload)) } catch { /* ignoré */ } }
  }
  if (t.startsWith("{") || t.startsWith("[")) { try { values.push(JSON.parse(t)) } catch { /* ignoré */ } }

  const lists = []
  const seen = new Set()
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 40) return
    if (Array.isArray(v)) {
      const objs = v.filter((x) => x && typeof x === "object" && !Array.isArray(x))
      if (objs.length && objs.length >= v.length * 0.8) {
        const score = scoreList(objs)
        const sig = JSON.stringify(objs).slice(0, 400)
        if (score >= 3 && !seen.has(sig)) { seen.add(sig); lists.push({ score: score + Math.min(objs.length, 20) / 10, items: objs }) }
      }
      v.forEach((x) => walk(x, depth + 1))
    } else Object.values(v).forEach((x) => walk(x, depth + 1))
  }
  values.forEach((v) => walk(v, 0))
  return lists.sort((a, b) => b.score - a.score)
}

const TITLE_KEYS = /^(title|titre|name|nom|intitule|summary|label|description|contenu|content)$/i
const DUE_KEYS = /^(due|due_?date|due_?at|deadline|echeance|pour_?le|date|for)$/i
const SUBJ_KEYS = /^(subject|matiere|course|course_?name|cours|discipline|class(_?name)?)$/i
const HW_HINT = /devoir|homework|assignment|task|controle|exam|test|type|kind/i
function scoreList(objs) {
  const keys = new Set(objs.flatMap((o) => Object.keys(o)))
  let s = 0
  if ([...keys].some((k) => TITLE_KEYS.test(k))) s += 2
  if ([...keys].some((k) => DUE_KEYS.test(k))) s += 2
  if ([...keys].some((k) => SUBJ_KEYS.test(k))) s += 1
  if ([...keys].some((k) => HW_HINT.test(k))) s += 0.5
  if ([...keys].some((k) => /^(href|className|children|style)$/.test(k))) s -= 3   // props d'interface, pas des données
  return s
}
const decodeEntities = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")

/** Trouve le tableau de devoirs dans une réponse JSON, quelle que soit sa forme. */
function findList(data, depth = 0) {
  if (Array.isArray(data)) return data.filter((x) => x && typeof x === "object")
  if (!data || typeof data !== "object" || depth > 3) return []
  for (const k of ["devoirs", "homework", "homeworks", "assignments", "courseWork", "tasks", "todos", "items", "results", "data"]) {
    if (k in data) { const l = findList(data[k], depth + 1); if (l.length) return l }
  }
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === "object") return v
  }
  return []
}

const pick = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== "") return o[k]; return undefined }

/** Transforme un objet « devoir » (champs FR ou EN) en Devoir, ou null s'il est déjà rendu. */
function normalize(o, prefix, i) {
  const doneVal = pick(o, ["done", "completed", "fait", "effectue", "isDone", "turnedIn", "rendu"])
  const state = String(pick(o, ["state", "status", "statut"]) ?? "").toUpperCase()
  if (doneVal === true || ["TURNED_IN", "RETURNED", "DONE", "COMPLETED", "FAIT", "RENDU"].includes(state)) return null

  let subject = pick(o, ["subject", "matiere", "matière", "course", "courseName", "cours", "discipline", "class", "className"])
  if (subject && typeof subject === "object") subject = subject.name ?? subject.nom ?? subject.title ?? ""
  let title = pick(o, ["title", "titre", "name", "nom", "summary", "intitule", "label", "description", "contenu", "content"])
  if (typeof title !== "string") title = subject ? `Devoir de ${subject}` : "Devoir"
  title = stripHtml(title).slice(0, 200)

  const due = toIso(pick(o, ["due", "dueDate", "due_date", "dueAt", "deadline", "echeance", "échéance", "pourLe", "pour_le", "date", "for"]), pick(o, ["dueTime", "due_time"]))
  const url = pick(o, ["url", "link", "alternateLink", "href", "lien"]) ?? null
  const rawId = pick(o, ["id", "_id", "uuid", "uid", "courseWorkId"]) ?? hash(`${title}|${subject}|${due}|${i}`)
  return { id: `${prefix}-${rawId}`, title, subject: String(subject ?? ""), due, url: typeof url === "string" ? url : null }
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
