import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos, simular_envio } from "../src/tools/proveedor.ts"
import { mapearCampos, resolverClave, similitud } from "../src/tools/lib/mapeo.ts"
import type { ContextoHerramienta } from "../src/tools/lib/resultado.ts"

/** Forma de los `data` que inspeccionan las pruebas (cast de prueba, no de producción). */
interface Datos {
  campos: unknown[]
  soportes: unknown[]
  llenos: { etiqueta: string; valor: unknown }[]
  discrepancias: string[]
  listo_para_firma: boolean
  checklist: { soportes: { tipo: string; estado: string }[] }
  ruta: string
}
const p = (s: string) => JSON.parse(s) as { ok: boolean; error?: string; data: Datos }

let ctx: ContextoHerramienta
const glosario = JSON.parse(await readFile("fixtures/reto-01/glosario-campos.json", "utf8")) as Record<string, string>
const maestro = JSON.parse(await readFile("fixtures/reto-01/repositorio/maestro.json", "utf8")) as Record<string, unknown>

beforeAll(async () => {
  process.env.FECHA_EJECUCION = "2026-10-20"
  const dir = await mkdtemp(join(tmpdir(), "reto01-test-"))
  await cp("fixtures", join(dir, "fixtures"), { recursive: true })
  ctx = { directory: dir, sessionId: "test" }
})
afterAll(async () => { await rm(ctx.directory, { recursive: true, force: true }) })

describe("mapeo (HU-2)", () => {
  const base = { maestro, glosario, paisCliente: "CO", etiquetasPlantilla: new Set<string>() }

  test("sinónimos exactos y normalizados del glosario", () => {
    expect(resolverClave("Domicilio fiscal", glosario).clave).toBe("direccion")
    expect(resolverClave("RAZON SOCIAL", glosario)).toMatchObject({ clave: "razon_social", confianza: 0.95 })
  })

  test("nunca inventa: sin fuente → faltante", () => {
    const m = mapearCampos(["Referencias comerciales", "Número de contribuyente especial"], base)
    expect(m.llenos).toHaveLength(0)
    expect(m.faltantes.map((f) => f.etiqueta)).toEqual(["Referencias comerciales", "Número de contribuyente especial"])
  })

  test("confianza < 0.8 → requiere_confirmacion sin valor", () => {
    expect(similitud("Nombre del representante legal", "Representante legal")).toBeLessThan(0.8)
    const m = mapearCampos(["Nombre del representante legal"], base)
    expect(m.requiere_confirmacion[0]).toMatchObject({ ruta: "representante_legal.nombre" })
    expect(m.requiere_confirmacion[0]?.valor).toBeUndefined()
  })

  test("RN1: NIT en CO se llena; RUC/RTN extranjero se llena y se marca", () => {
    expect(mapearCampos(["NIT"], base).llenos[0]?.valor).toBe("900123456")
    const ec = mapearCampos(["RUC"], { ...base, paisCliente: "EC" })
    expect(ec.requiere_confirmacion[0]).toMatchObject({ valor: "900123456", propuesta: "RUC" })
    expect(ec.requiere_confirmacion[0]?.motivo).toContain("identificador extranjero")
    expect(mapearCampos(["RTN"], { ...base, paisCliente: "HN" }).requiere_confirmacion[0]?.propuesta).toBe("RTN")
  })

  test("HU-1: etiqueta ambigua propone el equivalente del país", () => {
    const m = mapearCampos(["Identificación tributaria"], { ...base, paisCliente: "PE" })
    expect(m.requiere_confirmacion[0]).toMatchObject({ propuesta: "RUC" })
  })

  test("RN2: datos bancarios solo si la plantilla los pide", () => {
    const sin = mapearCampos(["Número de cuenta"], base)
    expect(sin.llenos).toHaveLength(0)
    const con = mapearCampos(["Número de cuenta"], { ...base, etiquetasPlantilla: new Set(["numero de cuenta"]) })
    expect(con.llenos[0]?.ruta).toBe("banco.numero_cuenta")
  })
})

describe("herramientas (contrato y flujo)", () => {
  test("leer_solicitud devuelve país, formato, campos y soportes", async () => {
    const r = p(await leer_solicitud.execute({ caso: "ec-corp-andina" }, ctx))
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ pais: "EC", formato: "pdf" })
    expect(r.data.campos).toHaveLength(15)
    expect(r.data.soportes).toHaveLength(5)
  })

  test("HU-5: caso inexistente y nombre malicioso → error claro, sin excepción", async () => {
    expect(p(await leer_solicitud.execute({ caso: "nope" }, ctx)).error).toContain("no existe")
    expect(p(await armar_paquete.execute({ caso: "../../etc" }, ctx)).error).toContain("inválido")
  })

  test("mapear_campos enmascara el número de cuenta hacia el modelo", async () => {
    const r = p(await mapear_campos.execute({ caso: "co-industrias-delta", campos: ["Número de cuenta", "Banco"] }, ctx))
    const cuenta = r.data.llenos.find((c) => c.etiqueta === "Número de cuenta")
    expect(cuenta?.valor).toBe("•••2345")
  })

  test("generar_formulario ignora valores inventados por el modelo (CA2)", async () => {
    const r = p(await generar_formulario.execute({ caso: "co-industrias-delta", mapeo: { llenos: [{ etiqueta: "NIT", valor: "111" }] } }, ctx))
    expect(r.ok).toBe(true)
    expect(r.data.discrepancias[0]).toContain("NIT")
    expect(existsSync(join(ctx.directory, "out/co-industrias-delta/formulario.xlsx"))).toBe(true)
  })

  test("portal → formato no soportado + valores-portal.md", async () => {
    const r = p(await generar_formulario.execute({ caso: "pa-logistica-istmo" }, ctx))
    expect(r.ok).toBe(false)
    expect(r.error).toContain("formato no soportado")
    expect(existsSync(join(ctx.directory, "out/pa-logistica-istmo/valores-portal.md"))).toBe(true)
  })

  test("RN3: soportes vencidos/ausentes bloquean listo_para_firma", async () => {
    const r = p(await armar_paquete.execute({ caso: "ec-corp-andina" }, ctx))
    expect(r.data.listo_para_firma).toBe(false)
    const estados = Object.fromEntries(r.data.checklist.soportes.map((s) => [s.tipo, s.estado]))
    expect(estados).toMatchObject({ camara_comercio: "vencido", certificado_cumplimiento_tributario: "ausente", rut: "presente" })
  })

  test("RN3: con soportes vigentes queda listo aunque haya faltantes", async () => {
    process.env.FECHA_EJECUCION = "2026-09-05"
    const r = p(await armar_paquete.execute({ caso: "co-industrias-delta" }, ctx))
    process.env.FECHA_EJECUCION = "2026-10-20"
    expect(r.data.listo_para_firma).toBe(true)
  })

  test("RN2: el borrador de correo no contiene datos bancarios", async () => {
    await armar_paquete.execute({ caso: "co-industrias-delta" }, ctx)
    const correo = await readFile(join(ctx.directory, "out/co-industrias-delta/paquete/borrador-correo.md"), "utf8")
    expect(correo).not.toContain("03100012345")
    expect(correo).not.toContain("COLOCOBM")
  })

  test("RN4: simular_envio exige confirmación y luego aceptación de bloqueos", async () => {
    await armar_paquete.execute({ caso: "hn-agroexport-sula" }, ctx)
    expect(p(await simular_envio.execute({ caso: "hn-agroexport-sula", confirmado: false }, ctx)).error).toBe("requiere confirmación explícita")
    expect(p(await simular_envio.execute({ caso: "hn-agroexport-sula", confirmado: true }, ctx)).error).toContain("NO está listo")
    const ok = p(await simular_envio.execute({ caso: "hn-agroexport-sula", confirmado: true, forzar_con_bloqueos: true }, ctx))
    expect(ok.data.ruta).toBe("out/hn-agroexport-sula/ENVIO-SIMULADO.md")
  })

  test("RN5: cada ejecución queda en out/<caso>/log.jsonl", async () => {
    const log = await readFile(join(ctx.directory, "out/ec-corp-andina/log.jsonl"), "utf8")
    const linea = JSON.parse(log.trim().split("\n")[0] ?? "{}")
    expect(Object.keys(linea)).toEqual(expect.arrayContaining(["ts", "herramienta", "ok", "resumen"]))
  })
})
