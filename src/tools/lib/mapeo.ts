import type { Glosario, Maestro } from "./fixtures.ts"
import { reglas } from "./reglas.ts"

export type ValorCampo = string | number | boolean

export interface CampoLleno {
  etiqueta: string
  /** Ruta del dato dentro de maestro.json (ej. "banco.swift"). */
  ruta: string
  valor: ValorCampo
  confianza: number
  nota?: string
}

export interface CampoFaltante {
  etiqueta: string
  motivo: string
}

export interface CampoPorConfirmar {
  etiqueta: string
  motivo: string
  confianza: number
  ruta?: string
  /** Solo presente cuando hay un valor de origen en el maestro (ej. NIT para RUC/RTN). */
  valor?: ValorCampo
  /** Equivalente propuesto (ej. "RUC" para Ecuador). */
  propuesta?: string
}

export interface Mapeo {
  llenos: CampoLleno[]
  faltantes: CampoFaltante[]
  requiere_confirmacion: CampoPorConfirmar[]
}

export interface ContextoMapeo {
  maestro: Maestro
  glosario: Glosario
  paisCliente: string
  /** Etiquetas que la plantilla del cliente pide explícitamente (normalizadas). */
  etiquetasPlantilla: Set<string>
}

type Estado =
  | { estado: "lleno"; campo: CampoLleno }
  | { estado: "faltante"; campo: CampoFaltante }
  | { estado: "requiere_confirmacion"; campo: CampoPorConfirmar }

// ---------- Normalización y similitud ----------

export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function raiz(palabra: string): string {
  if (palabra.length > 4 && palabra.endsWith("es")) return palabra.slice(0, -2)
  if (palabra.length > 3 && palabra.endsWith("s")) return palabra.slice(0, -1)
  return palabra
}

function fichas(texto: string): Set<string> {
  const vacias = new Set(reglas.palabras_vacias)
  return new Set(normalizar(texto).split(" ").filter((p) => p && !vacias.has(p)).map(raiz))
}

/** Similitud de Jaccard entre las palabras significativas de dos etiquetas (0..1). */
export function similitud(a: string, b: string): number {
  const fa = fichas(a)
  const fb = fichas(b)
  if (fa.size === 0 || fb.size === 0) return 0
  const comunes = [...fa].filter((f) => fb.has(f)).length
  return comunes / (fa.size + fb.size - comunes)
}

// ---------- Resolución etiqueta → clave del maestro ----------

export interface Resolucion {
  clave: string | null
  confianza: number
  sinonimo: string | null
}

export function resolverClave(etiqueta: string, glosario: Glosario): Resolucion {
  const exacta = glosario[etiqueta]
  if (exacta) return { clave: exacta, confianza: 1, sinonimo: etiqueta }
  const norm = normalizar(etiqueta)
  for (const [sinonimo, clave] of Object.entries(glosario)) {
    if (normalizar(sinonimo) === norm) return { clave, confianza: 0.95, sinonimo }
  }
  let mejor: Resolucion = { clave: null, confianza: 0, sinonimo: null }
  for (const [sinonimo, clave] of Object.entries(glosario)) {
    const s = similitud(etiqueta, sinonimo)
    if (s > mejor.confianza) mejor = { clave, confianza: Number(s.toFixed(2)), sinonimo }
  }
  return mejor.confianza >= reglas.umbral_candidato ? mejor : { ...mejor, clave: null }
}

/** Lee un valor del maestro por ruta con puntos. Solo devuelve valores escalares. */
export function valorEnMaestro(maestro: Maestro, ruta: string): ValorCampo | null {
  let actual: unknown = maestro
  for (const parte of ruta.split(".")) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return null
    actual = (actual as Record<string, unknown>)[parte]
  }
  if (typeof actual === "string" || typeof actual === "number" || typeof actual === "boolean") return actual
  if (Array.isArray(actual) && actual.every((x) => typeof x === "string")) return actual.join(", ")
  return null
}

/** Nota de contexto para valores con moneda (ej. ingresos en COP). */
function notaDeContexto(maestro: Maestro, ruta: string): string | undefined {
  if (!ruta.endsWith(".valor")) return undefined
  const base = ruta.slice(0, -".valor".length)
  const moneda = valorEnMaestro(maestro, `${base}.moneda`)
  const ano = valorEnMaestro(maestro, `${base}.ano`)
  if (moneda === null) return undefined
  return ano === null ? `Moneda: ${moneda}` : `Moneda: ${moneda}, año ${ano}`
}

// ---------- Reglas de negocio por campo ----------

function reglaIdentificador(etiqueta: string, ruta: string, valor: ValorCampo, ctx: ContextoMapeo): Estado {
  const esperado = reglas.identificador_tributario_por_pais[ctx.paisCliente] ?? "identificador tributario"
  const ambigua = reglas.etiquetas_ambiguas.some((a) => normalizar(a) === normalizar(etiqueta))
  if (ambigua) {
    return {
      estado: "requiere_confirmacion",
      campo: {
        etiqueta, ruta, valor, confianza: 0.7, propuesta: esperado,
        motivo: `Etiqueta ambigua: en ${ctx.paisCliente} el equivalente es ${esperado}.`,
      },
    }
  }
  if (ctx.paisCliente !== reglas.pais_maestro) {
    return {
      estado: "requiere_confirmacion",
      campo: {
        etiqueta, ruta, valor, confianza: 1, propuesta: esperado,
        motivo: `identificador extranjero: el cliente (${ctx.paisCliente}) pide ${esperado}; Periferia solo tiene NIT colombiano.`,
      },
    }
  }
  return { estado: "lleno", campo: { etiqueta, ruta, valor, confianza: 1 } }
}

export function mapearCampo(etiqueta: string, ctx: ContextoMapeo): Estado {
  const r = resolverClave(etiqueta, ctx.glosario)
  if (!r.clave) {
    return { estado: "faltante", campo: { etiqueta, motivo: "No hay sinónimo en el glosario ni dato en el maestro." } }
  }
  if (r.confianza < reglas.umbral_confianza) {
    return {
      estado: "requiere_confirmacion",
      campo: {
        etiqueta, ruta: r.clave, confianza: r.confianza,
        motivo: `Mapeo con confianza ${r.confianza} < ${reglas.umbral_confianza} (sinónimo más cercano: "${r.sinonimo}").`,
      },
    }
  }
  const esBancario = r.clave.startsWith(reglas.prefijo_datos_bancarios)
  if (esBancario && !ctx.etiquetasPlantilla.has(normalizar(etiqueta))) {
    return {
      estado: "requiere_confirmacion",
      campo: { etiqueta, ruta: r.clave, confianza: r.confianza, motivo: "Dato bancario no pedido explícitamente por la plantilla." },
    }
  }
  const valor = valorEnMaestro(ctx.maestro, r.clave)
  if (valor === null) {
    return { estado: "faltante", campo: { etiqueta, motivo: `La clave "${r.clave}" no existe en el maestro.` } }
  }
  if (r.clave === reglas.clave_identificador_tributario) return reglaIdentificador(etiqueta, r.clave, valor, ctx)
  const nota = notaDeContexto(ctx.maestro, r.clave)
  return { estado: "lleno", campo: { etiqueta, ruta: r.clave, valor, confianza: r.confianza, ...(nota ? { nota } : {}) } }
}

export function mapearCampos(etiquetas: string[], ctx: ContextoMapeo): Mapeo {
  const mapeo: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  for (const etiqueta of etiquetas) {
    const r = mapearCampo(etiqueta, ctx)
    if (r.estado === "lleno") mapeo.llenos.push(r.campo)
    else if (r.estado === "faltante") mapeo.faltantes.push(r.campo)
    else mapeo.requiere_confirmacion.push(r.campo)
  }
  return mapeo
}

/** Valor que se escribe en el formulario para una etiqueta (vacío si es faltante). */
export function valorParaFormulario(mapeo: Mapeo, etiqueta: string): { valor: ValorCampo | null; estado: Estado["estado"] } {
  const lleno = mapeo.llenos.find((c) => c.etiqueta === etiqueta)
  if (lleno) return { valor: lleno.valor, estado: "lleno" }
  const conf = mapeo.requiere_confirmacion.find((c) => c.etiqueta === etiqueta)
  if (conf) return { valor: conf.valor ?? null, estado: "requiere_confirmacion" }
  return { valor: null, estado: "faltante" }
}
