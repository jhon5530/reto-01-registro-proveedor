import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { ContextoHerramienta } from "./resultado.ts"
import { rutas } from "./rutas.ts"

export interface EntradaLog {
  ts: string
  herramienta: string
  ok: boolean
  resumen: string
  sessionId?: string
  caso?: string
}

/**
 * RN5 / CA4: deja registro en out/log.jsonl y, si hay caso, en out/<caso>/log.jsonl.
 * El resumen nunca contiene valores de campos (solo conteos y estados), así que no filtra
 * datos bancarios ni claves. Un fallo al escribir el log no rompe la herramienta.
 */
export async function registrar(ctx: ContextoHerramienta, entrada: Omit<EntradaLog, "ts">): Promise<void> {
  const linea = JSON.stringify({ ts: new Date().toISOString(), ...entrada }) + "\n"
  const r = rutas(ctx)
  try {
    await mkdir(r.out, { recursive: true })
    await appendFile(join(r.out, "log.jsonl"), linea, "utf8")
    if (entrada.caso) {
      await mkdir(r.outCaso(entrada.caso), { recursive: true })
      await appendFile(join(r.outCaso(entrada.caso), "log.jsonl"), linea, "utf8")
    }
  } catch {
    // El log es best-effort: nunca debe tumbar una herramienta.
  }
}
