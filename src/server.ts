import { timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { Hono } from "hono"
import { z } from "zod"
import { ejecutarTurno } from "./agent/ciclo.ts"
import { construirPromptSistema } from "./agent/prompt.ts"
import { AlmacenSesiones, ID_SESION } from "./agent/sesiones.ts"
import { cargarConfig } from "./config.ts"
import { crearProveedor } from "./llm/fabrica.ts"
import { listarCasos } from "./tools/lib/fixtures.ts"
import { mensajeDeError } from "./tools/lib/resultado.ts"

const DIRECTORIO = process.cwd()
const config = cargarConfig()
const llm = crearProveedor(config)
const sesiones = new AlmacenSesiones(join(DIRECTORIO, "out", "sessions"))
const app = new Hono()

// ---------- Protección opcional del link (APP_ACCESS_KEY) ----------

function claveValida(recibida: string | undefined): boolean {
  if (!config.APP_ACCESS_KEY) return true
  const a = Buffer.from(recibida ?? "")
  const b = Buffer.from(config.APP_ACCESS_KEY)
  return a.length === b.length && timingSafeEqual(a, b)
}

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next()
  const clave = c.req.header("x-access-key") ?? c.req.query("key")
  if (!claveValida(clave)) return c.json({ error: "Clave de acceso inválida o ausente." }, 401)
  return next()
})

// ---------- API ----------

app.get("/api/health", (c) =>
  c.json({ ok: true, provider: llm.proveedor, model: llm.modelo, protegido: Boolean(config.APP_ACCESS_KEY) }),
)

app.get("/api/casos", async (c) => c.json({ casos: await listarCasos({ directory: DIRECTORIO, sessionId: "api" }) }))

const esquemaChat = z.object({
  sessionId: z.string().regex(ID_SESION, "sessionId inválido"),
  message: z.string().trim().min(1, "mensaje vacío").max(config.MAX_LARGO_MENSAJE, "mensaje demasiado largo"),
})

app.post("/api/chat", async (c) => {
  const cuerpo = esquemaChat.safeParse(await c.req.json().catch(() => null))
  if (!cuerpo.success) return c.json({ error: cuerpo.error.issues[0]?.message ?? "solicitud inválida" }, 400)
  const { sessionId, message } = cuerpo.data
  const sesion = await sesiones.obtenerOCrear(sessionId)
  if (sesion.turnos >= config.MAX_TURNOS_SESION) {
    return c.json({ error: `La sesión alcanzó el máximo de ${config.MAX_TURNOS_SESION} mensajes. Abre una sesión nueva.` }, 429)
  }
  if (!sesiones.tomar(sessionId)) return c.json({ error: "Ya hay un mensaje en proceso en esta sesión." }, 409)
  try {
    const sistema = await construirPromptSistema(DIRECTORIO)
    const r = await ejecutarTurno(sesion, message, {
      llm, sistema, directory: DIRECTORIO, maxIteraciones: config.MAX_ITERACIONES, maxTokensSesion: config.MAX_TOKENS_SESION,
    })
    await sesiones.guardar(sesion)
    return c.json({ ...r, tokensSesion: sesion.tokens })
  } catch (e) {
    return c.json({ error: `Error interno: ${mensajeDeError(e)}` }, 500)
  } finally {
    sesiones.soltar(sessionId)
  }
})

app.get("/api/sessions/:id", async (c) => {
  const s = await sesiones.obtener(c.req.param("id"))
  if (!s) return c.json({ error: "Sesión no encontrada." }, 404)
  return c.json({ id: s.id, creada: s.creada, historial: s.historial, esperandoConfirmacion: s.esperandoConfirmacion, tokens: s.tokens })
})

// ---------- Archivos generados (solo dentro de out/<caso>/) ----------

async function listarArchivos(dir: string, base = ""): Promise<string[]> {
  if (!existsSync(dir)) return []
  const entradas = await readdir(dir, { withFileTypes: true })
  const anidados = await Promise.all(entradas.map((e) =>
    e.isDirectory() ? listarArchivos(join(dir, e.name), `${base}${e.name}/`) : Promise.resolve([`${base}${e.name}`]),
  ))
  return anidados.flat().sort()
}

const CASO = /^[a-z0-9][a-z0-9-]{0,80}$/
/** out/sessions guarda conversaciones completas: nunca se expone por la API de archivos. */
const casoPermitido = (caso: string) => CASO.test(caso) && caso !== "sessions"

app.get("/api/archivos/:caso", async (c) => {
  const caso = c.req.param("caso")
  if (!casoPermitido(caso)) return c.json({ error: "caso inválido" }, 400)
  return c.json({ caso, archivos: await listarArchivos(join(DIRECTORIO, "out", caso)) })
})

const TIPOS: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8", ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
}

/** Sirve un archivo solo si queda dentro de la raíz indicada (sin path traversal). */
async function servir(raiz: string, relativo: string, descarga: boolean): Promise<Response> {
  const ruta = normalize(join(raiz, relativo))
  if (!ruta.startsWith(raiz + "/") || !existsSync(ruta)) return new Response("No encontrado", { status: 404 })
  const tipo = TIPOS[extname(ruta)] ?? "application/octet-stream"
  const cabeceras: Record<string, string> = { "content-type": tipo, "x-content-type-options": "nosniff" }
  if (descarga) cabeceras["content-disposition"] = `attachment; filename="${relativo.split("/").pop() ?? "archivo"}"`
  return new Response(await readFile(ruta), { headers: cabeceras })
}

app.get("/api/archivos/:caso/*", async (c) => {
  const caso = c.req.param("caso")
  if (!casoPermitido(caso)) return c.json({ error: "caso inválido" }, 400)
  const relativo = decodeURIComponent(c.req.path.replace(`/api/archivos/${caso}/`, ""))
  return servir(join(DIRECTORIO, "out", caso), relativo, true)
})

// ---------- Front estático ----------

app.get("*", async (c) => {
  const relativo = c.req.path === "/" ? "index.html" : c.req.path.slice(1)
  return servir(join(DIRECTORIO, "web"), relativo, false)
})

app.onError((e, c) => c.json({ error: `Error interno: ${mensajeDeError(e)}` }, 500))

console.log(`Agente Registro Proveedor · http://localhost:${config.PORT} · proveedor=${llm.proveedor} modelo=${llm.modelo} · protegido=${Boolean(config.APP_ACCESS_KEY)}`)

export default { port: config.PORT, fetch: app.fetch, idleTimeout: 255 }
