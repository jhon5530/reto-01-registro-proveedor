import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { exito, fallo, mensajeDeError, type ContextoHerramienta, type Resultado } from "./resultado.ts"
import { rutas } from "./rutas.ts"

// ---------- Esquemas de los archivos de entrada (sección 7.1 y 7.2 del PRD) ----------

export const esquemaSolicitud = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string().length(2),
  cliente: z.string(),
  cuerpo: z.string(),
  formato: z.string(),
  adjuntos: z.array(z.string()),
})

export const esquemaCeldas = z
  .array(
    z.object({
      hoja: z.string().min(1),
      celda_etiqueta: z.string().regex(/^[A-Z]+\d+$/),
      etiqueta: z.string().min(1),
      celda_valor: z.string().regex(/^[A-Z]+\d+$/),
    }),
  )
  .min(1)

export const esquemaCampos = z
  .array(z.object({ etiqueta: z.string().min(1), obligatorio: z.boolean() }))
  .min(1)

export const esquemaSoportesExigidos = z.array(z.string())

export const esquemaIndiceSoportes = z.array(
  z.object({
    tipo: z.string(),
    archivo: z.string(),
    vigencia_hasta: z.string().nullable(),
    pais_emisor: z.string(),
    descripcion: z.string().optional(),
  }),
)

export type Solicitud = z.infer<typeof esquemaSolicitud>
export type Celda = z.infer<typeof esquemaCeldas>[number]
export type CampoPdf = z.infer<typeof esquemaCampos>[number]
export type SoporteIndice = z.infer<typeof esquemaIndiceSoportes>[number]
export type Maestro = Record<string, unknown>
export type Glosario = Record<string, string>

/** Campo solicitado por la plantilla, independiente del formato. */
export interface CampoSolicitado {
  etiqueta: string
  obligatorio: boolean
  hoja?: string
  celda_etiqueta?: string
  celda_valor?: string
}

export type Plantilla =
  | { tipo: "celdas"; archivo: string; celdas: Celda[] }
  | { tipo: "campos"; archivo: string; campos: CampoPdf[] }
  | { tipo: "ninguna" }

// ---------- Lectura genérica ----------

async function leerJson<T>(ruta: string, esquema: z.ZodType<T>, nombre: string): Promise<Resultado<T>> {
  if (!existsSync(ruta)) return fallo(`No existe el archivo ${nombre}.`)
  let crudo: unknown
  try {
    crudo = JSON.parse(await readFile(ruta, "utf8"))
  } catch (e) {
    return fallo(`El archivo ${nombre} está corrupto (JSON inválido): ${mensajeDeError(e)}`)
  }
  const r = esquema.safeParse(crudo)
  if (!r.success) {
    const detalle = r.error.issues[0]
    const donde = detalle?.path.join(".") || "raíz"
    return fallo(`El archivo ${nombre} no tiene la estructura esperada (${donde}: ${detalle?.message}).`)
  }
  return exito(r.data)
}

export const NOMBRE_CASO = /^[a-z0-9][a-z0-9-]{0,80}$/

export function existeCaso(ctx: ContextoHerramienta, caso: string): boolean {
  return NOMBRE_CASO.test(caso) && existsSync(rutas(ctx).caso(caso))
}

export async function listarCasos(ctx: ContextoHerramienta): Promise<string[]> {
  const { readdir } = await import("node:fs/promises")
  try {
    const entradas = await readdir(rutas(ctx).casos, { withFileTypes: true })
    return entradas.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

// ---------- Cargadores específicos ----------

export const cargarSolicitud = (ctx: ContextoHerramienta, caso: string) =>
  leerJson(join(rutas(ctx).caso(caso), "solicitud.json"), esquemaSolicitud, "solicitud.json")

export const cargarSoportesExigidos = (ctx: ContextoHerramienta, caso: string) =>
  leerJson(join(rutas(ctx).caso(caso), "soportes-exigidos.json"), esquemaSoportesExigidos, "soportes-exigidos.json")

export const cargarMaestro = (ctx: ContextoHerramienta) =>
  leerJson(rutas(ctx).maestro, z.record(z.string(), z.unknown()), "maestro.json")

export const cargarGlosario = (ctx: ContextoHerramienta) =>
  leerJson(rutas(ctx).glosario, z.record(z.string(), z.string()), "glosario-campos.json")

export const cargarIndiceSoportes = (ctx: ContextoHerramienta) =>
  leerJson(join(rutas(ctx).soportes, "index.json"), esquemaIndiceSoportes, "soportes/index.json")

/** Carga la plantilla que corresponde al formato (celdas para xlsx, campos para pdf/portal). */
export async function cargarPlantilla(ctx: ContextoHerramienta, caso: string): Promise<Resultado<Plantilla>> {
  const dir = rutas(ctx).caso(caso)
  if (existsSync(join(dir, "plantilla-celdas.json"))) {
    const r = await leerJson(join(dir, "plantilla-celdas.json"), esquemaCeldas, "plantilla-celdas.json")
    return r.ok ? exito({ tipo: "celdas", archivo: "plantilla-celdas.json", celdas: r.data }) : r
  }
  if (existsSync(join(dir, "plantilla-campos.json"))) {
    const r = await leerJson(join(dir, "plantilla-campos.json"), esquemaCampos, "plantilla-campos.json")
    return r.ok ? exito({ tipo: "campos", archivo: "plantilla-campos.json", campos: r.data }) : r
  }
  return exito({ tipo: "ninguna" })
}

/** Lista uniforme de campos solicitados a partir de cualquier plantilla. */
export function camposDePlantilla(p: Plantilla): CampoSolicitado[] {
  if (p.tipo === "celdas") {
    return p.celdas.map((c) => ({
      etiqueta: c.etiqueta,
      obligatorio: true,
      hoja: c.hoja,
      celda_etiqueta: c.celda_etiqueta,
      celda_valor: c.celda_valor,
    }))
  }
  if (p.tipo === "campos") return p.campos.map((c) => ({ etiqueta: c.etiqueta, obligatorio: c.obligatorio }))
  return []
}
