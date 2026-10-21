import { z } from "zod"

/** Configuración desde variables de entorno. La clave del modelo nunca sale de este proceso. */
const esquema = z.object({
  LLM_PROVIDER: z.enum(["gemini", "mock"]).optional(),
  LLM_MODEL: z.string().default("gemini-3.5-flash"),
  GEMINI_API_KEY: z.string().default(""),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_REINTENTOS: z.coerce.number().int().min(0).max(5).default(3),
  MAX_ITERACIONES: z.coerce.number().int().min(1).max(100).default(25),
  MAX_TOKENS_SESION: z.coerce.number().int().positive().default(200_000),
  MAX_TURNOS_SESION: z.coerce.number().int().positive().default(40),
  MAX_LARGO_MENSAJE: z.coerce.number().int().positive().default(2_000),
  APP_ACCESS_KEY: z.string().default(""),
  PORT: z.coerce.number().int().positive().default(3000),
})

export type Config = z.infer<typeof esquema> & { LLM_PROVIDER: "gemini" | "mock" }

export function cargarConfig(env: Record<string, string | undefined> = process.env): Config {
  const limpio = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""))
  const c = esquema.parse(limpio)
  // Sin clave, se usa el modo simulado para que la app siempre arranque.
  const proveedor = c.LLM_PROVIDER ?? (c.GEMINI_API_KEY ? "gemini" : "mock")
  return { ...c, LLM_PROVIDER: proveedor }
}
