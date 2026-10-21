import { ErrorLLM, type DefinicionHerramienta, type LlamadaHerramienta, type ProveedorLLM, type ResultadoHerramienta } from "../llm/adapter.ts"
import { registrar } from "../tools/lib/log.ts"
import { mensajeDeError } from "../tools/lib/resultado.ts"
import { REQUIEREN_CONFIRMACION, buscarHerramienta, herramientas } from "../tools/registro.ts"
import { esConfirmacion } from "./confirmacion.ts"
import type { EventoHerramienta, Sesion } from "./sesiones.ts"

/**
 * Ciclo del agente (PRD 6.3): prompt → modelo → herramientas → modelo … → respuesta.
 * - CA1: tope de iteraciones por turno y de tokens por sesión.
 * - CA2: las herramientas son la única fuente de valores (re-verificación en generar_formulario).
 * - CA3/RN4: las herramientas con efecto externo solo corren si el turno anterior pidió
 *   confirmación y el mensaje actual del usuario la da explícitamente. Lo hace cumplir el código.
 * - CA4: cada llamada queda en el historial visible y en out/log.jsonl.
 * - CA5: un error del proveedor se convierte en mensaje claro; la sesión sigue viva.
 */

export interface DependenciasCiclo {
  llm: ProveedorLLM
  sistema: string
  directory: string
  maxIteraciones: number
  maxTokensSesion: number
}

export interface RespuestaTurno {
  reply: string
  toolCalls: EventoHerramienta[]
  needsConfirmation: boolean
  error: boolean
}

const DEFINICIONES: DefinicionHerramienta[] = herramientas.map((h) => ({ nombre: h.nombre, descripcion: h.descripcion, parametros: h.parametros }))

const ERROR_CONFIRMACION = JSON.stringify({
  ok: false,
  error: "requiere confirmación explícita: pregunta al usuario y espera su respuesta afirmativa en el siguiente mensaje.",
})

interface EstadoTurno {
  /** Se consume en la primera acción externa: una confirmación vale para una sola acción. */
  confirmacionDisponible: boolean
  eventos: EventoHerramienta[]
}

function resumir(contenido: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(contenido) as { ok: boolean; error?: string; data?: Record<string, unknown> }
    if (!r.ok) return { ok: false, resumen: r.error ?? "error" }
    const d = r.data ?? {}
    const partes = ["ruta", "formato", "listo_para_firma", "cliente", "pais", "resumen"]
      .filter((k) => d[k] !== undefined)
      .map((k) => `${k}: ${typeof d[k] === "object" ? JSON.stringify(d[k]) : String(d[k])}`)
    return { ok: true, resumen: partes.join(" · ") || "ok" }
  } catch {
    return { ok: false, resumen: "respuesta no interpretable" }
  }
}

async function ejecutarLlamada(ll: LlamadaHerramienta, sesion: Sesion, deps: DependenciasCiclo, turno: EstadoTurno): Promise<ResultadoHerramienta> {
  const inicio = Date.now()
  const ctx = { directory: deps.directory, sessionId: sesion.id }
  const h = buscarHerramienta(ll.nombre)
  let contenido: string
  let bloqueada = false
  if (!h) {
    contenido = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${ll.nombre}` })
  } else {
    const args = h.esquema.safeParse(ll.argumentos)
    if (!args.success) {
      const i = args.error.issues[0]
      contenido = JSON.stringify({ ok: false, error: `Argumentos inválidos (${i?.path.join(".") || "raíz"}: ${i?.message}).` })
    } else if (REQUIEREN_CONFIRMACION.has(h.nombre) && !turno.confirmacionDisponible) {
      contenido = ERROR_CONFIRMACION
      bloqueada = true
      await registrar(ctx, { herramienta: h.nombre, ok: false, resumen: "bloqueada por el ciclo: sin confirmación humana" })
    } else {
      if (REQUIEREN_CONFIRMACION.has(h.nombre)) turno.confirmacionDisponible = false
      try {
        contenido = await h.ejecutar(args.data, ctx)
      } catch (e) {
        contenido = JSON.stringify({ ok: false, error: mensajeDeError(e) })
      }
    }
  }
  const { ok, resumen } = resumir(contenido)
  turno.eventos.push({ id: ll.id, nombre: ll.nombre, argumentos: ll.argumentos, ok, resumen, bloqueada, duracionMs: Date.now() - inicio })
  return { id: ll.id, nombre: ll.nombre, contenido }
}

/** ¿El turno debe terminar pidiendo confirmación? Paquete armado o envío rechazado, sin envío exitoso. */
function requiereConfirmacion(eventos: EventoHerramienta[]): boolean {
  const ok = (n: string) => eventos.some((e) => e.nombre === n && e.ok)
  // Rechazo de la herramienta (p. ej. paquete con bloqueos): hay que volver a preguntar.
  // Un bloqueo de la guardia no cuenta: no hubo pregunta previa que responder.
  const envioRechazado = eventos.some((e) => e.nombre === "proveedor_simular_envio" && !e.ok && !e.bloqueada)
  return (ok("proveedor_armar_paquete") || envioRechazado) && !ok("proveedor_simular_envio")
}

function textoTope(eventos: EventoHerramienta[], max: number): string {
  const hechos = eventos.map((e) => `- ${e.nombre}: ${e.ok ? "ok" : "falló"} — ${e.resumen}`)
  return [`Alcancé el tope de ${max} iteraciones en este turno. Esto es lo que logré:`, ...hechos, "", "Falta completar el resto del flujo. ¿Quieres que continúe?"].join("\n")
}

function cerrar(sesion: Sesion, textoUsuario: string, reply: string, turno: EstadoTurno, error = false): RespuestaTurno {
  const needsConfirmation = !error && requiereConfirmacion(turno.eventos)
  sesion.esperandoConfirmacion = needsConfirmation
  const ts = new Date().toISOString()
  sesion.historial.push({ rol: "usuario", texto: textoUsuario, ts })
  sesion.historial.push({ rol: "asistente", texto: reply, ts, toolCalls: turno.eventos, needsConfirmation, ...(error ? { error } : {}) })
  return { reply, toolCalls: turno.eventos, needsConfirmation, error }
}

export async function ejecutarTurno(sesion: Sesion, texto: string, deps: DependenciasCiclo): Promise<RespuestaTurno> {
  const turno: EstadoTurno = { confirmacionDisponible: sesion.esperandoConfirmacion && esConfirmacion(texto), eventos: [] }
  sesion.esperandoConfirmacion = false
  sesion.turnos += 1
  sesion.mensajes.push({ rol: "usuario", texto })

  for (let i = 0; i < deps.maxIteraciones; i++) {
    if (sesion.tokens >= deps.maxTokensSesion) {
      const msg = `Esta sesión alcanzó el tope de ${deps.maxTokensSesion} tokens. Abre una sesión nueva para continuar.`
      sesion.mensajes.push({ rol: "asistente", texto: msg, llamadas: [] })
      return cerrar(sesion, texto, msg, turno, true)
    }
    let resp
    try {
      resp = await deps.llm.enviar([{ rol: "sistema", texto: deps.sistema }, ...sesion.mensajes], DEFINICIONES)
    } catch (e) {
      const msg = e instanceof ErrorLLM ? e.message : `Error inesperado con el proveedor del modelo: ${mensajeDeError(e)}`
      sesion.mensajes.push({ rol: "asistente", texto: `[error] ${msg}`, llamadas: [] })
      return cerrar(sesion, texto, msg, turno, true)
    }
    sesion.tokens += resp.uso.entrada + resp.uso.salida
    sesion.mensajes.push({ rol: "asistente", texto: resp.texto, llamadas: resp.llamadas, ...(resp.meta ? { meta: resp.meta } : {}) })
    if (resp.llamadas.length === 0) return cerrar(sesion, texto, resp.texto || "(el modelo no devolvió texto)", turno)
    const resultados: ResultadoHerramienta[] = []
    for (const ll of resp.llamadas) resultados.push(await ejecutarLlamada(ll, sesion, deps, turno))
    sesion.mensajes.push({ rol: "herramienta", resultados })
  }
  const msg = textoTope(turno.eventos, deps.maxIteraciones)
  sesion.mensajes.push({ rol: "asistente", texto: msg, llamadas: [] })
  return cerrar(sesion, texto, msg, turno)
}
