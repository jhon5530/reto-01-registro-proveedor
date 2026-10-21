import { z } from "zod"
import * as proveedor from "./proveedor.ts"
import type { ContextoHerramienta } from "./lib/resultado.ts"

/** Forma de una herramienta según el contrato del PRD (6.2). */
export interface Herramienta {
  description: string
  args: Record<string, z.ZodType>
  // Los argumentos ya llegan validados por zod antes de ejecutar.
  execute: (args: never, ctx: ContextoHerramienta) => Promise<string>
}

export interface HerramientaRegistrada {
  nombre: string
  descripcion: string
  esquema: z.ZodObject<Record<string, z.ZodType>>
  /** JSON Schema de los argumentos, para el proveedor LLM. */
  parametros: Record<string, unknown>
  ejecutar: (args: unknown, ctx: ContextoHerramienta) => Promise<string>
}

/** Herramientas que ejecutan una acción externa y requieren confirmación humana (RN4/CA3). */
export const REQUIEREN_CONFIRMACION = new Set(["proveedor_simular_envio"])

function registrarModulo(prefijo: string, modulo: Record<string, Herramienta>): HerramientaRegistrada[] {
  return Object.entries(modulo).map(([exportado, h]) => {
    const esquema = z.object(h.args).strict()
    const parametros = z.toJSONSchema(esquema) as Record<string, unknown>
    delete parametros.$schema
    return {
      nombre: `${prefijo}_${exportado}`,
      descripcion: h.description,
      esquema,
      parametros,
      ejecutar: (args, ctx) => (h.execute as (a: unknown, c: ContextoHerramienta) => Promise<string>)(args, ctx),
    }
  })
}

export const herramientas: HerramientaRegistrada[] = registrarModulo("proveedor", proveedor as unknown as Record<string, Herramienta>)

export function buscarHerramienta(nombre: string): HerramientaRegistrada | undefined {
  return herramientas.find((h) => h.nombre === nombre)
}
