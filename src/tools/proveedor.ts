/**
 * Herramientas del agente "Registro como Proveedor".
 * Contrato (PRD 6.2): cada export es { description, args (zod), execute(args, ctx) → string JSON }.
 * El nombre que ve el modelo es proveedor_<export>. Ninguna herramienta lanza excepciones.
 */
import { existsSync } from "node:fs"
import { copyFile, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
  NOMBRE_CASO, camposDePlantilla, cargarGlosario, cargarIndiceSoportes, cargarMaestro, cargarPlantilla,
  cargarSoportesExigidos, cargarSolicitud, existeCaso, listarCasos,
  type CampoSolicitado, type Glosario, type Maestro, type Plantilla, type Solicitud,
} from "./lib/fixtures.ts"
import { escribirPdf, escribirValoresPortal, escribirXlsx } from "./lib/formularios.ts"
import { registrar } from "./lib/log.ts"
import { mapearCampos, normalizar, type Mapeo } from "./lib/mapeo.ts"
import {
  bloqueos, borradorCorreoMd, checklistMd, contieneDatosBancarios, copiarSoportes, escribirArchivo, evaluarSoportes,
} from "./lib/paquete.ts"
import { nombreSoporte, reglas } from "./lib/reglas.ts"
import { exito, fallo, mensajeDeError, type ContextoHerramienta, type Resultado } from "./lib/resultado.ts"
import { fechaEjecucion, relativa, rutas } from "./lib/rutas.ts"

export type { ContextoHerramienta } from "./lib/resultado.ts"

// ======================================================================
// Infraestructura común
// ======================================================================

const argCaso = z.string().min(1).describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/ (ej. ec-corp-andina)")

/** Envuelve una herramienta: nunca lanza, siempre registra en el log (RN5/CA4) y serializa. */
async function ejecutar<T>(
  ctx: ContextoHerramienta, herramienta: string, caso: string,
  fn: () => Promise<Resultado<T>>, resumir: (d: T) => string,
): Promise<string> {
  let r: Resultado<T>
  try {
    r = await fn()
  } catch (e) {
    r = fallo(`Error interno en ${herramienta}: ${mensajeDeError(e)}`)
  }
  const resumen = r.ok ? resumir(r.data) : r.error
  const casoLog = existeCaso(ctx, caso) ? caso : undefined
  await registrar(ctx, { herramienta, ok: r.ok, resumen, sessionId: ctx.sessionId, ...(casoLog ? { caso: casoLog } : {}) })
  return JSON.stringify(r)
}

async function validarCaso(ctx: ContextoHerramienta, caso: string): Promise<Resultado<string>> {
  if (!NOMBRE_CASO.test(caso)) return fallo(`Nombre de caso inválido: "${caso}". Usa solo minúsculas, números y guiones.`)
  if (existeCaso(ctx, caso)) return exito(caso)
  const disponibles = await listarCasos(ctx)
  return fallo(`El caso "${caso}" no existe. Casos disponibles: ${disponibles.join(", ") || "ninguno"}.`)
}

interface DatosCaso {
  solicitud: Solicitud
  plantilla: Resultado<Plantilla>
  maestro: Maestro
  glosario: Glosario
}

/** Carga todo lo necesario para un caso. Una plantilla corrupta no impide continuar. */
async function cargarCaso(ctx: ContextoHerramienta, caso: string): Promise<Resultado<DatosCaso>> {
  const v = await validarCaso(ctx, caso)
  if (!v.ok) return v
  const solicitud = await cargarSolicitud(ctx, caso)
  if (!solicitud.ok) return solicitud
  const maestro = await cargarMaestro(ctx)
  if (!maestro.ok) return maestro
  const glosario = await cargarGlosario(ctx)
  if (!glosario.ok) return glosario
  return exito({ solicitud: solicitud.data, plantilla: await cargarPlantilla(ctx, caso), maestro: maestro.data, glosario: glosario.data })
}

function camposSolicitados(d: DatosCaso): CampoSolicitado[] {
  return d.plantilla.ok ? camposDePlantilla(d.plantilla.data) : []
}

function mapeoDelCaso(d: DatosCaso, etiquetas: string[]): Mapeo {
  return mapearCampos(etiquetas, {
    maestro: d.maestro,
    glosario: d.glosario,
    paisCliente: d.solicitud.pais,
    etiquetasPlantilla: new Set(camposSolicitados(d).map((c) => normalizar(c.etiqueta))),
  })
}

/** El modelo no necesita ver números de cuenta completos: se enmascaran en su respuesta. */
function enmascarar(m: Mapeo): Mapeo {
  const ocultar = (ruta: string | undefined, v: unknown) =>
    ruta && reglas.campos_enmascarados.includes(ruta) && v !== undefined ? `•••${String(v).slice(-4)}` : v
  return {
    llenos: m.llenos.map((c) => ({ ...c, valor: ocultar(c.ruta, c.valor) as typeof c.valor })),
    faltantes: m.faltantes,
    requiere_confirmacion: m.requiere_confirmacion.map((c) => (c.valor === undefined ? c : { ...c, valor: ocultar(c.ruta, c.valor) as typeof c.valor })),
  }
}

// ======================================================================
// 1. Leer la solicitud (HU-1)
// ======================================================================

async function leerSolicitud(ctx: ContextoHerramienta, caso: string) {
  const d = await cargarCaso(ctx, caso)
  if (!d.ok) return d
  const sol = d.data.solicitud
  const exigidos = await cargarSoportesExigidos(ctx, caso)
  const identificador = reglas.identificador_tributario_por_pais[sol.pais] ?? "desconocido"
  const campos = camposSolicitados(d.data)
  const observaciones = campos
    .filter((c) => reglas.etiquetas_ambiguas.some((a) => normalizar(a) === normalizar(c.etiqueta)))
    .map((c) => ({ etiqueta: c.etiqueta, estado: "requiere_confirmacion", propuesta: identificador, motivo: `Etiqueta ambigua; en ${sol.pais} corresponde a ${identificador}.` }))
  const data = {
    caso, cliente: sol.cliente, pais: sol.pais, formato: sol.formato,
    formato_soportado: reglas.formatos_generables.includes(sol.formato),
    identificador_tributario_pais: identificador,
    de: sol.de, asunto: sol.asunto, fecha: sol.fecha, adjuntos: sol.adjuntos,
    campos,
    soportes: exigidos.ok ? exigidos.data.map((t) => ({ tipo: t, nombre: nombreSoporte(t) })) : [],
    observaciones,
  }
  if (!d.data.plantilla.ok) return fallo(`Plantilla corrupta: ${d.data.plantilla.error}. Se devuelven los datos del correo y los soportes.`, data)
  if (!exigidos.ok) return fallo(exigidos.error, data)
  return exito(data)
}

export const leer_solicitud = {
  description: "Lee el correo y la plantilla de un caso y devuelve país, cliente, formato de salida, campos solicitados y soportes exigidos.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    return ejecutar(ctx, "proveedor_leer_solicitud", args.caso, () => leerSolicitud(ctx, args.caso),
      (d) => `${d.cliente} (${d.pais}) formato=${d.formato} campos=${d.campos.length} soportes=${d.soportes.length}`)
  },
}

// ======================================================================
// 2. Mapear campos al maestro (HU-2)
// ======================================================================

async function mapear(ctx: ContextoHerramienta, caso: string, campos: string[]) {
  const d = await cargarCaso(ctx, caso)
  if (!d.ok) return d
  const mapeo = mapeoDelCaso(d.data, campos)
  await escribirArchivo(join(rutas(ctx).outCaso(caso), "mapeo.json"), JSON.stringify(mapeo, null, 2))
  const aviso = d.data.plantilla.ok ? undefined : `Plantilla no legible (${d.data.plantilla.error}); los datos bancarios quedan por confirmar.`
  return exito({
    ...enmascarar(mapeo),
    resumen: { llenos: mapeo.llenos.length, faltantes: mapeo.faltantes.length, requiere_confirmacion: mapeo.requiere_confirmacion.length },
    ruta: relativa(ctx, join(rutas(ctx).outCaso(caso), "mapeo.json")),
    ...(aviso ? { aviso } : {}),
  })
}

export const mapear_campos = {
  description: "Cruza cada campo solicitado con el repositorio maestro y lo clasifica como lleno (con ruta del dato), faltante o requiere_confirmacion.",
  args: {
    caso: argCaso,
    campos: z.array(z.string().min(1)).min(1).max(200).describe("Etiquetas de los campos tal como aparecen en la plantilla del cliente"),
  },
  async execute(args: { caso: string; campos: string[] }, ctx: ContextoHerramienta): Promise<string> {
    return ejecutar(ctx, "proveedor_mapear_campos", args.caso, () => mapear(ctx, args.caso, args.campos),
      (d) => `llenos=${d.resumen.llenos} faltantes=${d.resumen.faltantes} requiere_confirmacion=${d.resumen.requiere_confirmacion}`)
  },
}

// ======================================================================
// 3. Generar formulario en el formato pedido (HU-3)
// ======================================================================

const esquemaMapeoEntrada = z.object({
  llenos: z.array(z.object({ etiqueta: z.string(), valor: z.union([z.string(), z.number(), z.boolean()]).optional() })).optional(),
  faltantes: z.array(z.object({ etiqueta: z.string() })).optional(),
  requiere_confirmacion: z.array(z.object({ etiqueta: z.string() })).optional(),
})
type MapeoEntrada = z.infer<typeof esquemaMapeoEntrada>

/**
 * CA2 por diseño: el mapeo que envía el modelo NO es fuente de valores. Se recalcula desde el
 * maestro y se reportan discrepancias (un "lleno" inventado o un valor alterado).
 */
function discrepancias(propuesto: MapeoEntrada | undefined, real: Mapeo): string[] {
  if (!propuesto?.llenos) return []
  const salida: string[] = []
  for (const p of propuesto.llenos) {
    const r = real.llenos.find((c) => c.etiqueta === p.etiqueta)
    if (!r) salida.push(`"${p.etiqueta}" no está lleno según el maestro; se ignoró.`)
    else if (p.valor !== undefined && !String(p.valor).includes("•") && String(p.valor) !== String(r.valor)) {
      salida.push(`"${p.etiqueta}" traía un valor distinto al del maestro; se usó el del maestro.`)
    }
  }
  return salida
}

interface FormularioGenerado { ruta: string; formato: string; soportado: boolean; discrepancias: string[] }

async function generarInterno(ctx: ContextoHerramienta, caso: string, propuesto?: MapeoEntrada): Promise<Resultado<FormularioGenerado>> {
  const d = await cargarCaso(ctx, caso)
  if (!d.ok) return d
  if (!d.data.plantilla.ok) return fallo(`No se puede generar el formulario: ${d.data.plantilla.error}`)
  const plantilla = d.data.plantilla.data
  const campos = camposDePlantilla(plantilla)
  const mapeo = mapeoDelCaso(d.data, campos.map((c) => c.etiqueta))
  const dir = rutas(ctx).outCaso(caso)
  const formato = d.data.solicitud.formato
  const disc = discrepancias(propuesto, mapeo)
  if (formato === "xlsx" && plantilla.tipo === "celdas") {
    return exito({ ruta: relativa(ctx, await escribirXlsx(dir, plantilla.celdas, mapeo)), formato, soportado: true, discrepancias: disc })
  }
  if (formato === "pdf" && plantilla.tipo === "campos") {
    const ruta = await escribirPdf(dir, d.data.solicitud, campos, mapeo, fechaEjecucion())
    return exito({ ruta: relativa(ctx, ruta), formato, soportado: true, discrepancias: disc })
  }
  const ruta = relativa(ctx, await escribirValoresPortal(dir, d.data.solicitud, campos, mapeo))
  return fallo(
    `formato no soportado: "${formato}". No se llena automáticamente; se generaron los valores listos para copiar en ${ruta}.`,
    { ruta, formato, soportado: false, discrepancias: disc },
  )
}

export const generar_formulario = {
  description: "Genera el formulario lleno en el formato que pidió el cliente (xlsx o pdf); para portal web responde 'formato no soportado' y deja los valores para copiar.",
  args: {
    caso: argCaso,
    mapeo: esquemaMapeoEntrada.optional().describe("Mapeo devuelto por proveedor_mapear_campos; los valores se re-verifican contra el maestro"),
  },
  async execute(args: { caso: string; mapeo?: MapeoEntrada }, ctx: ContextoHerramienta): Promise<string> {
    return ejecutar(ctx, "proveedor_generar_formulario", args.caso, () => generarInterno(ctx, args.caso, args.mapeo),
      (d) => `formato=${d.formato} ruta=${d.ruta} discrepancias=${d.discrepancias.length}`)
  },
}

// ======================================================================
// 4. Armar paquete para firma (HU-4)
// ======================================================================

const ARCHIVOS_FORMULARIO = ["formulario.xlsx", "formulario.pdf", "valores-portal.md"]

async function asegurarFormulario(ctx: ContextoHerramienta, caso: string): Promise<string | null> {
  const dir = rutas(ctx).outCaso(caso)
  const existente = ARCHIVOS_FORMULARIO.find((f) => existsSync(join(dir, f)))
  if (existente) return existente
  const r = await generarInterno(ctx, caso)
  const generado = ARCHIVOS_FORMULARIO.find((f) => existsSync(join(dir, f)))
  return r.ok || generado ? (generado ?? null) : null
}

async function armarPaquete(ctx: ContextoHerramienta, caso: string) {
  const d = await cargarCaso(ctx, caso)
  if (!d.ok) return d
  const exigidos = await cargarSoportesExigidos(ctx, caso)
  const indice = await cargarIndiceSoportes(ctx)
  if (!indice.ok) return indice
  const r = rutas(ctx)
  const destino = r.paquete(caso)
  await rm(destino, { recursive: true, force: true })
  const fecha = fechaEjecucion()
  const formulario = await asegurarFormulario(ctx, caso)
  const soportes = evaluarSoportes(exigidos.ok ? exigidos.data : [], indice.data, r.soportes, fecha)
  const bloq = bloqueos(soportes, formulario)
  if (!exigidos.ok) bloq.push(`No se pudieron leer los soportes exigidos: ${exigidos.error}`)
  const mapeo = mapeoDelCaso(d.data, camposSolicitados(d.data).map((c) => c.etiqueta))
  const copiados = await copiarSoportes(soportes, r.soportes, destino)
  if (formulario) await copyFile(join(r.outCaso(caso), formulario), join(destino, formulario))
  const adjuntos = [...(formulario ? [formulario] : []), ...soportes.filter((s) => s.archivo).map((s) => s.nombre)]
  const correo = borradorCorreoMd(d.data.solicitud, d.data.maestro, adjuntos, bloq)
  if (contieneDatosBancarios(correo, d.data.maestro)) return fallo("El borrador de correo contendría datos bancarios (RN2); no se generó.")
  await escribirArchivo(join(destino, "checklist.md"), checklistMd(caso, d.data.solicitud, soportes, mapeo, formulario, bloq, fecha))
  await escribirArchivo(join(destino, "borrador-correo.md"), correo)
  const listo = bloq.length === 0
  const estado = { caso, listo_para_firma: listo, bloqueos: bloq, fecha_evaluacion: fecha, formulario, destinatario: d.data.solicitud.de, asunto: d.data.solicitud.asunto }
  await escribirArchivo(join(r.outCaso(caso), "estado-paquete.json"), JSON.stringify(estado, null, 2))
  return exito({
    ruta: relativa(ctx, destino),
    listo_para_firma: listo,
    bloqueos: bloq,
    fecha_evaluacion: fecha,
    checklist: {
      soportes: soportes.map((s) => ({ tipo: s.tipo, nombre: s.nombre, estado: s.estado, vigencia_hasta: s.vigencia_hasta ?? null })),
      campos_llenos: mapeo.llenos.length,
      campos_faltantes: mapeo.faltantes.map((f) => f.etiqueta),
      campos_por_confirmar: mapeo.requiere_confirmacion.map((c) => c.etiqueta),
    },
    archivos: [...(formulario ? [formulario] : []), ...copiados, "checklist.md", "borrador-correo.md"],
  })
}

export const armar_paquete = {
  description: "Arma la carpeta del paquete para firma con formulario, soportes, checklist (presentes/ausentes/vencidos) y borrador de correo, e indica si está listo para firma.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: ContextoHerramienta): Promise<string> {
    return ejecutar(ctx, "proveedor_armar_paquete", args.caso, () => armarPaquete(ctx, args.caso),
      (d) => `listo_para_firma=${d.listo_para_firma} bloqueos=${d.bloqueos.length} archivos=${d.archivos.length}`)
  },
}

// ======================================================================
// 5. Simular envío (HU-4, RN4) — solo con confirmación explícita
// ======================================================================

const esquemaEstado = z.object({
  listo_para_firma: z.boolean(), bloqueos: z.array(z.string()), formulario: z.string().nullable(),
  destinatario: z.string(), asunto: z.string(),
})

async function simularEnvio(ctx: ContextoHerramienta, caso: string, confirmado: boolean, forzar: boolean) {
  if (!confirmado) return fallo("requiere confirmación explícita")
  const v = await validarCaso(ctx, caso)
  if (!v.ok) return v
  const rutaEstado = join(rutas(ctx).outCaso(caso), "estado-paquete.json")
  if (!existsSync(rutaEstado)) return fallo("No hay paquete armado para este caso. Primero ejecuta proveedor_armar_paquete.")
  const estado = esquemaEstado.safeParse(JSON.parse(await readFile(rutaEstado, "utf8")))
  if (!estado.success) return fallo("El estado del paquete está corrupto. Vuelve a armar el paquete.")
  const e = estado.data
  if (!e.listo_para_firma && !forzar) {
    return fallo(`El paquete NO está listo para firma (${e.bloqueos.join("; ")}). Requiere confirmación explícita del usuario para simular el envío con bloqueos.`, { bloqueos: e.bloqueos })
  }
  const ruta = join(rutas(ctx).outCaso(caso), "ENVIO-SIMULADO.md")
  await escribirArchivo(ruta, [
    "# ENVÍO SIMULADO", "",
    "> No se envió ningún correo real. Este archivo deja constancia de la decisión humana.", "",
    `- **Caso:** ${caso}`,
    `- **Para:** ${e.destinatario}`,
    `- **Asunto:** RE: ${e.asunto}`,
    `- **Paquete:** out/${caso}/paquete/`,
    `- **Fecha:** ${new Date().toISOString()}`,
    `- **Confirmado por el usuario:** sí (sesión ${ctx.sessionId})`,
    `- **Listo para firma al enviar:** ${e.listo_para_firma ? "sí" : "NO"}`,
    ...(e.bloqueos.length ? ["", "## Advertencias aceptadas por el usuario", ...e.bloqueos.map((b) => `- ${b}`)] : []),
    "",
  ].join("\n"))
  return exito({ ruta: relativa(ctx, ruta), con_bloqueos: !e.listo_para_firma })
}

export const simular_envio = {
  description: "Simula el envío del paquete al cliente escribiendo ENVIO-SIMULADO.md; solo usar tras confirmación explícita del usuario en su último mensaje.",
  args: {
    caso: argCaso,
    confirmado: z.boolean().describe("true solo si el usuario confirmó explícitamente el envío en su último mensaje"),
    forzar_con_bloqueos: z.boolean().optional().describe("true solo si el usuario aceptó explícitamente enviar aunque el paquete tenga bloqueos"),
  },
  async execute(args: { caso: string; confirmado: boolean; forzar_con_bloqueos?: boolean }, ctx: ContextoHerramienta): Promise<string> {
    return ejecutar(ctx, "proveedor_simular_envio", args.caso, () => simularEnvio(ctx, args.caso, args.confirmado, args.forzar_con_bloqueos ?? false),
      (d) => `ruta=${d.ruta} con_bloqueos=${d.con_bloqueos}`)
  },
}
