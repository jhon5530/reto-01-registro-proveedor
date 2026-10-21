import { existsSync } from "node:fs"
import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type { Maestro, Solicitud, SoporteIndice } from "./fixtures.ts"
import type { Mapeo } from "./mapeo.ts"
import { nombreSoporte, reglas } from "./reglas.ts"

export type EstadoSoporte = "presente" | "vencido" | "ausente"

export interface ItemSoporte {
  tipo: string
  nombre: string
  estado: EstadoSoporte
  archivo?: string
  vigencia_hasta?: string | null
  pais_emisor?: string
}

/** Clasifica cada soporte exigido como presente, vencido (vigencia < fecha) o ausente. */
export function evaluarSoportes(exigidos: string[], indice: SoporteIndice[], dirSoportes: string, fecha: string): ItemSoporte[] {
  return exigidos.map((tipo) => {
    const s = indice.find((x) => x.tipo === tipo)
    const nombre = nombreSoporte(tipo)
    if (!s || !existsSync(join(dirSoportes, basename(s.archivo)))) return { tipo, nombre, estado: "ausente" }
    const vencido = s.vigencia_hasta !== null && s.vigencia_hasta < fecha
    return {
      tipo, nombre, estado: vencido ? "vencido" : "presente",
      archivo: basename(s.archivo), vigencia_hasta: s.vigencia_hasta, pais_emisor: s.pais_emisor,
    }
  })
}

/** RN3: vencidos y ausentes bloquean; los campos faltantes no. */
export function bloqueos(soportes: ItemSoporte[], formulario: string | null): string[] {
  const lista = soportes
    .filter((s) => s.estado !== "presente")
    .map((s) => (s.estado === "vencido" ? `Soporte vencido: ${s.nombre} (vigencia ${s.vigencia_hasta})` : `Soporte ausente: ${s.nombre}`))
  if (formulario === null) lista.push("No hay formulario generado para firmar.")
  else if (formulario.endsWith(".md")) lista.push("Formato portal: el formulario se diligencia en línea (humano); no hay documento para firmar.")
  return lista
}

export async function copiarSoportes(soportes: ItemSoporte[], dirSoportes: string, destino: string): Promise<string[]> {
  await mkdir(join(destino, "soportes"), { recursive: true })
  const copiados: string[] = []
  for (const s of soportes) {
    if (!s.archivo) continue
    await copyFile(join(dirSoportes, s.archivo), join(destino, "soportes", s.archivo))
    copiados.push(`soportes/${s.archivo}`)
  }
  return copiados
}

const ICONO: Record<EstadoSoporte, string> = { presente: "✅ presente", vencido: "⛔ vencido", ausente: "❌ ausente" }

export function checklistMd(caso: string, sol: Solicitud, soportes: ItemSoporte[], mapeo: Mapeo, formulario: string | null, bloq: string[], fecha: string): string {
  const filas = soportes.map((s) => `| ${s.nombre} | ${ICONO[s.estado]} | ${s.vigencia_hasta ?? (s.estado === "ausente" ? "—" : "no vence")} | ${s.archivo ?? "—"} |`)
  const listar = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`) : ["- (ninguno)"])
  return [
    `# Checklist — ${caso}`,
    "",
    `Cliente: **${sol.cliente}** (${sol.pais}) · Formato: **${sol.formato}** · Fecha de evaluación: **${fecha}**`,
    "",
    `## Estado: ${bloq.length ? "⛔ NO listo para firma" : "✅ listo para firma"}`,
    ...(bloq.length ? ["", ...listar(bloq)] : []),
    "",
    "## Formulario",
    `- ${formulario ? `\`${formulario}\`` : "no generado"}`,
    "",
    "## Soportes exigidos",
    "| Soporte | Estado | Vigencia hasta | Archivo |",
    "|---|---|---|---|",
    ...filas,
    "",
    `## Campos faltantes (${mapeo.faltantes.length}) — no bloquean, completar a mano`,
    ...listar(mapeo.faltantes.map((f) => `${f.etiqueta}: ${f.motivo}`)),
    "",
    `## Campos por confirmar (${mapeo.requiere_confirmacion.length})`,
    ...listar(mapeo.requiere_confirmacion.map((c) => `${c.etiqueta}: ${c.motivo}`)),
    "",
    `## Campos llenos (${mapeo.llenos.length})`,
    ...listar(mapeo.llenos.map((c) => `${c.etiqueta} ← \`${c.ruta}\``)),
    "",
    "---",
    "Firma y envío: decisión humana. El agente no firma ni envía.",
    "",
  ].join("\n")
}

/** Borrador de respuesta al cliente. RN2: nunca incluye datos bancarios. */
export function borradorCorreoMd(sol: Solicitud, maestro: Maestro, adjuntos: string[], bloq: string[]): string {
  const rep = (maestro.representante_legal ?? {}) as Record<string, unknown>
  const razon = typeof maestro.razon_social === "string" ? maestro.razon_social : "Periferia IT Group"
  return [
    `**Para:** ${sol.de}`,
    `**Asunto:** RE: ${sol.asunto}`,
    "",
    "---",
    "",
    `Buen día, equipo de ${sol.cliente}:`,
    "",
    `En respuesta a su solicitud del ${sol.fecha}, adjuntamos el formulario de registro de proveedor`,
    `diligenciado y firmado por el representante legal de ${razon}, junto con los soportes solicitados:`,
    "",
    ...adjuntos.map((a) => `- ${a}`),
    "",
    "Quedamos atentos a cualquier información adicional.",
    "",
    "Cordialmente,",
    "",
    `${typeof rep.nombre === "string" ? rep.nombre : "[Representante legal]"}`,
    `${typeof rep.cargo === "string" ? rep.cargo : ""} — ${razon}`,
    "",
    ...(bloq.length
      ? ["---", "> **Nota interna (borrar antes de enviar):** el paquete aún tiene bloqueos:", ...bloq.map((b) => `> - ${b}`), ""]
      : []),
  ].join("\n")
}

/** Verificación defensiva de RN2: ningún valor bancario del maestro aparece en el texto. */
export function contieneDatosBancarios(texto: string, maestro: Maestro): boolean {
  const banco = maestro[reglas.prefijo_datos_bancarios.replace(/\.$/, "")]
  if (!banco || typeof banco !== "object") return false
  const sensibles = ["numero_cuenta", "swift"].map((k) => (banco as Record<string, unknown>)[k]).filter((v): v is string => typeof v === "string")
  return sensibles.some((v) => texto.includes(v))
}

export async function escribirArchivo(ruta: string, contenido: string): Promise<void> {
  await mkdir(join(ruta, ".."), { recursive: true })
  await writeFile(ruta, contenido, "utf8")
}
