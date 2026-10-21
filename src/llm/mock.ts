import { esConfirmacion } from "../agent/confirmacion.ts"
import type { DefinicionHerramienta, LlamadaHerramienta, Mensaje, ProveedorLLM, RespuestaLLM } from "./adapter.ts"

/**
 * Proveedor simulado: sigue un guion fijo (leer → mapear → generar → armar → preguntar).
 * Sirve para probar el ciclo, la guardia de confirmación y el front SIN clave ni costo,
 * y demuestra que el ciclo del agente no depende del proveedor.
 */

type Resultado = { ok: boolean; error?: string; data?: Record<string, unknown> }
type Paso = { nombre: string; r: Resultado }

const MARCA_BLOQUEOS = "de todas formas"

function ultimoUsuario(ms: Mensaje[]): { indice: number; texto: string } {
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i]
    if (m?.rol === "usuario") return { indice: i, texto: m.texto }
  }
  return { indice: -1, texto: "" }
}

function pasosDelTurno(ms: Mensaje[], desde: number): Paso[] {
  return ms.slice(desde + 1).flatMap((m) =>
    m.rol === "herramienta" ? m.resultados.map((r) => ({ nombre: r.nombre, r: JSON.parse(r.contenido) as Resultado })) : [],
  )
}

function casoMencionado(ms: Mensaje[], texto: string): string | null {
  const directo = /\b([a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)+)\b/.exec(texto.toLowerCase())?.[1]
  if (directo) return directo
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i]
    const caso = m?.rol === "asistente" ? m.llamadas.find((l) => typeof l.argumentos.caso === "string")?.argumentos.caso : undefined
    if (typeof caso === "string") return caso
  }
  return null
}

function textoAsistenteAnterior(ms: Mensaje[], hasta: number): string {
  for (let i = hasta - 1; i >= 0; i--) {
    const m = ms[i]
    if (m?.rol === "asistente" && m.texto) return m.texto
  }
  return ""
}

const lista = (xs: string[]) => (xs.length ? xs.join(", ") : "ninguno")

function resumenCaso(caso: string, pasos: Paso[]): string {
  const d = (n: string) => pasos.find((p) => p.nombre === n)?.r
  const lectura = d("proveedor_leer_solicitud")
  const mapeo = d("proveedor_mapear_campos")?.data as { llenos?: { etiqueta: string }[]; faltantes?: { etiqueta: string }[]; requiere_confirmacion?: { etiqueta: string; motivo: string }[] } | undefined
  const form = d("proveedor_generar_formulario")
  const paq = d("proveedor_armar_paquete")
  const l = lectura?.data ?? {}
  const p = (paq?.data ?? {}) as { listo_para_firma?: boolean; bloqueos?: string[]; ruta?: string; archivos?: string[] }
  const errores = pasos.filter((x) => !x.r.ok).map((x) => `- ${x.nombre}: ${x.r.error}`)
  return [
    `**Caso:** \`${caso}\` · **Cliente:** ${String(l.cliente ?? "?")} · **País:** ${String(l.pais ?? "?")} · **Formato:** ${String(l.formato ?? "?")}`,
    "",
    `**Campos llenos (${mapeo?.llenos?.length ?? 0}):** ${lista((mapeo?.llenos ?? []).map((c) => c.etiqueta))}`,
    `**Requieren confirmación (${mapeo?.requiere_confirmacion?.length ?? 0}):** ${lista((mapeo?.requiere_confirmacion ?? []).map((c) => `${c.etiqueta} (${c.motivo})`))}`,
    `**Faltantes (${mapeo?.faltantes?.length ?? 0}):** ${lista((mapeo?.faltantes ?? []).map((c) => c.etiqueta))}`,
    `**Estado:** \`listo_para_firma: ${p.listo_para_firma ?? false}\``,
    ...(p.bloqueos ?? []).map((b) => `- ⛔ ${b}`),
    `**Archivos:** \`${p.ruta ?? `out/${caso}/`}\` — ${lista(p.archivos ?? [])}${form?.ok ? "" : " (ver aviso de formulario)"}`,
    ...(errores.length ? ["", "**Avisos:**", ...errores] : []),
    "",
    p.listo_para_firma
      ? "¿Confirmas que simule el envío del paquete al cliente?"
      : "El paquete tiene bloqueos. ¿Quieres que simule el envío de todas formas o prefieres actualizar primero los soportes?",
  ].join("\n")
}

export class MockLLM implements ProveedorLLM {
  readonly proveedor = "mock"
  readonly modelo = "guion-determinista"
  private contador = 0

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
    const { indice, texto } = ultimoUsuario(mensajes)
    const pasos = pasosDelTurno(mensajes, indice)
    const caso = casoMencionado(mensajes, texto)
    const anterior = textoAsistenteAnterior(mensajes, indice)
    const r = esConfirmacion(texto) && caso ? this.envio(caso, pasos, anterior) : caso ? this.procesar(caso, pasos) : this.ayuda()
    return { ...r, uso: { entrada: Math.ceil(JSON.stringify(mensajes).length / 4), salida: Math.ceil(r.texto.length / 4) } }
  }

  private llamar(nombre: string, argumentos: Record<string, unknown>) {
    return { texto: "", llamadas: [{ id: `mock-${++this.contador}`, nombre, argumentos } satisfies LlamadaHerramienta] }
  }

  private procesar(caso: string, pasos: Paso[]) {
    const hecho = (n: string) => pasos.some((p) => p.nombre === n)
    if (!hecho("proveedor_leer_solicitud")) return this.llamar("proveedor_leer_solicitud", { caso })
    const lectura = pasos.find((p) => p.nombre === "proveedor_leer_solicitud")?.r
    const campos = ((lectura?.data?.campos ?? []) as { etiqueta: string }[]).map((c) => c.etiqueta)
    if (!lectura?.data) return { texto: `No pude leer el caso: ${lectura?.error ?? "error desconocido"}`, llamadas: [] }
    if (!hecho("proveedor_mapear_campos") && campos.length) return this.llamar("proveedor_mapear_campos", { caso, campos })
    if (!hecho("proveedor_generar_formulario")) return this.llamar("proveedor_generar_formulario", { caso })
    if (!hecho("proveedor_armar_paquete")) return this.llamar("proveedor_armar_paquete", { caso })
    return { texto: resumenCaso(caso, pasos), llamadas: [] }
  }

  private envio(caso: string, pasos: Paso[], anterior: string) {
    const envio = pasos.find((p) => p.nombre === "proveedor_simular_envio")?.r
    if (!envio) {
      const forzar = anterior.includes(MARCA_BLOQUEOS)
      return this.llamar("proveedor_simular_envio", { caso, confirmado: true, ...(forzar ? { forzar_con_bloqueos: true } : {}) })
    }
    if (envio.ok) return { texto: `Listo. Dejé constancia del envío simulado en \`${String(envio.data?.ruta)}\`. No se envió ningún correo real.`, llamadas: [] }
    if (envio.error?.includes("NO está listo")) {
      return { texto: `No simulé el envío: ${envio.error}\n\n¿Confirmas que simule el envío ${MARCA_BLOQUEOS}, aceptando estos bloqueos?`, llamadas: [] }
    }
    return { texto: `No pude simular el envío: ${envio.error}`, llamadas: [] }
  }

  private ayuda() {
    return {
      texto: "Soy el agente de registro como proveedor (modo simulado). Indícame un caso, por ejemplo: *Procesa el caso \"ec-corp-andina\"*.",
      llamadas: [],
    }
  }
}
