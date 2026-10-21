import { join } from "node:path"
import type { ContextoHerramienta } from "./resultado.ts"

/** Rutas del proyecto, siempre relativas a ctx.directory (nunca absolutas fijas). */
export function rutas(ctx: ContextoHerramienta) {
  const fixtures = join(ctx.directory, "fixtures", "reto-01")
  const out = join(ctx.directory, "out")
  return {
    fixtures,
    casos: join(fixtures, "casos"),
    maestro: join(fixtures, "repositorio", "maestro.json"),
    soportes: join(fixtures, "repositorio", "soportes"),
    glosario: join(fixtures, "glosario-campos.json"),
    out,
    caso: (caso: string) => join(fixtures, "casos", caso),
    outCaso: (caso: string) => join(out, caso),
    paquete: (caso: string) => join(out, caso, "paquete"),
  }
}

/** Ruta relativa a la raíz, para mostrar al usuario (sin exponer rutas del servidor). */
export function relativa(ctx: ContextoHerramienta, ruta: string): string {
  return ruta.startsWith(ctx.directory) ? ruta.slice(ctx.directory.length + 1) : ruta
}

/** Fecha de ejecución (YYYY-MM-DD). Configurable con FECHA_EJECUCION para pruebas deterministas. */
export function fechaEjecucion(): string {
  const fija = process.env.FECHA_EJECUCION?.trim()
  if (fija && /^\d{4}-\d{2}-\d{2}$/.test(fija)) return fija
  const ahora = new Date()
  const local = new Date(ahora.getTime() - ahora.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}
