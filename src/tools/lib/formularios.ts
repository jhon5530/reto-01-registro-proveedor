import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import type { CampoSolicitado, Celda, Solicitud } from "./fixtures.ts"
import { valorParaFormulario, type Mapeo, type ValorCampo } from "./mapeo.ts"

const MARCA_CONFIRMAR = "(por confirmar)"

// ---------- Excel (P0) ----------

/** Escribe cada etiqueta y su valor exactamente en la hoja/celda de la plantilla. */
export async function escribirXlsx(dir: string, celdas: Celda[], mapeo: Mapeo): Promise<string> {
  const libro = new ExcelJS.Workbook()
  libro.creator = "Agente Registro Proveedor"
  for (const c of celdas) {
    const hoja = libro.getWorksheet(c.hoja) ?? libro.addWorksheet(c.hoja)
    hoja.getCell(c.celda_etiqueta).value = c.etiqueta
    hoja.getCell(c.celda_etiqueta).font = { bold: true }
    const { valor } = valorParaFormulario(mapeo, c.etiqueta)
    hoja.getCell(c.celda_valor).value = valor ?? null
  }
  libro.worksheets.forEach((h) => h.columns.forEach((col) => (col.width = 38)))
  await mkdir(dir, { recursive: true })
  const ruta = join(dir, "formulario.xlsx")
  await libro.xlsx.writeFile(ruta)
  return ruta
}

// ---------- PDF (P1) ----------

/** Helvetica estándar usa WinAnsi: se reemplazan caracteres que no puede dibujar. */
function seguro(texto: string): string {
  return texto.replace(/[^\x20-\x7E -ÿ–—‘’“”•]/g, "?")
}

function partirLinea(texto: string, fuente: PDFFont, tamano: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of seguro(texto).split(" ")) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tamano) > ancho && actual) {
      lineas.push(actual)
      actual = palabra
    } else actual = prueba
  }
  if (actual) lineas.push(actual)
  return lineas.length ? lineas : [""]
}

interface Lienzo { doc: PDFDocument; pagina: PDFPage; y: number; normal: PDFFont; negrita: PDFFont }

function asegurarEspacio(l: Lienzo, alto: number): void {
  if (l.y - alto > 60) return
  l.pagina = l.doc.addPage([595, 842])
  l.y = 790
}

function texto(l: Lienzo, t: string, x: number, tamano: number, fuente: PDFFont, color = rgb(0, 0, 0)): void {
  l.pagina.drawText(seguro(t), { x, y: l.y, size: tamano, font: fuente, color })
}

function filaCampo(l: Lienzo, campo: CampoSolicitado, mapeo: Mapeo): void {
  const { valor, estado } = valorParaFormulario(mapeo, campo.etiqueta)
  const etiqueta = `${campo.etiqueta}${campo.obligatorio ? " *" : ""}`
  const mostrado = valor === null ? "[faltante]" : String(valor)
  const sufijo = estado === "requiere_confirmacion" ? ` ${MARCA_CONFIRMAR}` : ""
  const lineas = partirLinea(mostrado + sufijo, l.normal, 10, 300)
  asegurarEspacio(l, 14 * lineas.length + 8)
  texto(l, etiqueta, 50, 10, l.negrita)
  for (const linea of lineas) {
    texto(l, linea, 250, 10, l.normal, valor === null ? rgb(0.6, 0.6, 0.6) : rgb(0, 0, 0))
    l.y -= 14
  }
  l.pagina.drawLine({ start: { x: 50, y: l.y + 8 }, end: { x: 545, y: l.y + 8 }, thickness: 0.3, color: rgb(0.8, 0.8, 0.8) })
  l.y -= 6
}

/** PDF generado (no AcroForm) con todos los campos, etiqueta y valor, en el orden dado. */
export async function escribirPdf(dir: string, solicitud: Solicitud, campos: CampoSolicitado[], mapeo: Mapeo, fecha: string): Promise<string> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Formulario de proveedor - ${solicitud.cliente}`)
  const l: Lienzo = {
    doc, pagina: doc.addPage([595, 842]), y: 790,
    normal: await doc.embedFont(StandardFonts.Helvetica),
    negrita: await doc.embedFont(StandardFonts.HelveticaBold),
  }
  texto(l, "Formulario de registro de proveedor", 50, 16, l.negrita); l.y -= 20
  texto(l, `Cliente: ${solicitud.cliente} (${solicitud.pais})`, 50, 10, l.normal); l.y -= 14
  texto(l, `Adjunto original: ${solicitud.adjuntos.join(", ") || "N/A"} · Generado: ${fecha}`, 50, 9, l.normal, rgb(0.4, 0.4, 0.4)); l.y -= 26
  campos.forEach((c) => filaCampo(l, c, mapeo))
  asegurarEspacio(l, 90)
  l.y -= 20
  texto(l, "* Campo obligatorio. Campos vacíos: faltantes en el repositorio maestro.", 50, 8, l.normal, rgb(0.4, 0.4, 0.4)); l.y -= 50
  l.pagina.drawLine({ start: { x: 50, y: l.y }, end: { x: 280, y: l.y }, thickness: 0.8 }); l.y -= 14
  texto(l, "Firma del representante legal", 50, 9, l.normal)
  await mkdir(dir, { recursive: true })
  const ruta = join(dir, "formulario.pdf")
  await writeFile(ruta, await doc.save())
  return ruta
}

// ---------- Portal (P2: no soportado, valores para copiar) ----------

function celdaMd(v: ValorCampo | null): string {
  return v === null ? "—" : String(v).replace(/\|/g, "\\|")
}

export async function escribirValoresPortal(dir: string, solicitud: Solicitud, campos: CampoSolicitado[], mapeo: Mapeo): Promise<string> {
  const filas = campos.map((c) => {
    const { valor, estado } = valorParaFormulario(mapeo, c.etiqueta)
    return `| ${c.etiqueta}${c.obligatorio ? " *" : ""} | ${celdaMd(valor)} | ${estado} |`
  })
  const contenido = [
    `# Valores para el portal — ${solicitud.cliente}`,
    "",
    "> **Formato no soportado para llenado automático.** El portal lo opera una persona:",
    "> ingresa las credenciales, copia estos valores y hace clic en \"Enviar\".",
    "",
    "| Campo | Valor para copiar | Estado |",
    "|---|---|---|",
    ...filas,
    "",
    "`*` obligatorio · `requiere_confirmacion`: validar antes de cargar · `faltante`: no existe en el maestro.",
    "",
  ].join("\n")
  await mkdir(dir, { recursive: true })
  const ruta = join(dir, "valores-portal.md")
  await writeFile(ruta, contenido, "utf8")
  return ruta
}
