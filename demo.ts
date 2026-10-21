/**
 * demo.ts — Ejecuta las herramientas SIN modelo de lenguaje sobre todos los casos.
 * Uso: bun run demo.ts   (no requiere ninguna clave)
 * Determinista: limpia out/ al inicio. Fecha de vigencias: FECHA_EJECUCION o hoy.
 */
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { armar_paquete, generar_formulario, leer_solicitud, mapear_campos, simular_envio } from "./src/tools/proveedor.ts"
import { listarCasos } from "./src/tools/lib/fixtures.ts"
import { fechaEjecucion } from "./src/tools/lib/rutas.ts"
import type { ContextoHerramienta } from "./src/tools/lib/resultado.ts"

type Json = { ok: boolean; error?: string; data?: Record<string, unknown> }
const parse = (s: string): Json => JSON.parse(s) as Json

async function procesar(ctx: ContextoHerramienta, caso: string) {
  const lectura = parse(await leer_solicitud.execute({ caso }, ctx))
  const campos = ((lectura.data?.campos ?? []) as { etiqueta: string }[]).map((c) => c.etiqueta)
  const mapeo = campos.length ? parse(await mapear_campos.execute({ caso, campos }, ctx)) : { ok: false, error: "sin campos" }
  const form = parse(await generar_formulario.execute({ caso }, ctx))
  const paquete = parse(await armar_paquete.execute({ caso }, ctx))
  const envioSinConfirmar = parse(await simular_envio.execute({ caso, confirmado: false }, ctx))
  return { caso, lectura, mapeo, form, paquete, envioSinConfirmar }
}

function imprimir(r: Awaited<ReturnType<typeof procesar>>) {
  const l = r.lectura.data ?? {}
  const m = (r.mapeo.data ?? {}) as { llenos?: unknown[]; faltantes?: { etiqueta: string }[]; requiere_confirmacion?: { etiqueta: string; motivo: string }[] }
  const p = (r.paquete.data ?? {}) as { listo_para_firma?: boolean; bloqueos?: string[]; ruta?: string; archivos?: string[] }
  console.log(`\n━━━ ${r.caso} ━━━`)
  if (!r.lectura.ok) console.log(`  ⚠ leer_solicitud: ${r.lectura.error}`)
  if (l.cliente) console.log(`  Cliente: ${l.cliente} · País: ${l.pais} · Formato: ${l.formato}`)
  if (r.mapeo.ok) {
    console.log(`  Campos: ${m.llenos?.length ?? 0} llenos · ${m.requiere_confirmacion?.length ?? 0} por confirmar · ${m.faltantes?.length ?? 0} faltantes`)
    m.requiere_confirmacion?.forEach((c) => console.log(`    ? ${c.etiqueta}: ${c.motivo}`))
    m.faltantes?.forEach((f) => console.log(`    ✗ faltante: ${f.etiqueta}`))
  } else console.log(`  ⚠ mapear_campos: ${r.mapeo.error}`)
  console.log(`  Formulario: ${r.form.ok ? (r.form.data?.ruta as string) : `⚠ ${r.form.error}`}`)
  if (r.paquete.ok) {
    console.log(`  Paquete: ${p.ruta} · listo_para_firma=${p.listo_para_firma}`)
    p.bloqueos?.forEach((b) => console.log(`    ⛔ ${b}`))
  } else console.log(`  ⚠ armar_paquete: ${r.paquete.error}`)
  console.log(`  Envío sin confirmar → ${r.envioSinConfirmar.ok ? "¡ERROR: se envió!" : `bloqueado (${r.envioSinConfirmar.error})`}`)
  return { caso: r.caso, formato: String(l.formato ?? "?"), llenos: m.llenos?.length ?? 0, confirmar: m.requiere_confirmacion?.length ?? 0, faltantes: m.faltantes?.length ?? 0, listo: p.listo_para_firma ?? false }
}

/** HU-5: caso con plantilla corrupta, en una copia temporal (los fixtures no se modifican). */
async function casoCorrupto(): Promise<ContextoHerramienta> {
  const dir = await mkdtemp(join(tmpdir(), "reto01-"))
  await cp(join(process.cwd(), "fixtures"), join(dir, "fixtures"), { recursive: true })
  await cp(join(dir, "fixtures/reto-01/casos/co-industrias-delta"), join(dir, "fixtures/reto-01/casos/zz-plantilla-corrupta"), { recursive: true })
  await writeFile(join(dir, "fixtures/reto-01/casos/zz-plantilla-corrupta/plantilla-celdas.json"), "[{ \"hoja\": \"Datos\", roto")
  return { directory: dir, sessionId: "demo-corrupto" }
}

async function main() {
  const ctx: ContextoHerramienta = { directory: process.cwd(), sessionId: "demo" }
  await rm(join(ctx.directory, "out"), { recursive: true, force: true })
  console.log(`Demo sin modelo · fecha de evaluación de vigencias: ${fechaEjecucion()}`)
  const filas = []
  for (const caso of await listarCasos(ctx)) filas.push(imprimir(await procesar(ctx, caso)))

  console.log("\n━━━ Manejo de errores (HU-5) ━━━")
  const inexistente = parse(await leer_solicitud.execute({ caso: "no-existe" }, ctx))
  console.log(`  Caso inexistente → ${inexistente.error}`)
  const ctxRoto = await casoCorrupto()
  imprimir(await procesar(ctxRoto, "zz-plantilla-corrupta"))
  await rm(ctxRoto.directory, { recursive: true, force: true })

  console.log("\n━━━ Resumen ━━━")
  console.table(filas)
  console.log("Salidas en out/<caso>/ · log en out/log.jsonl")
}

await main()
