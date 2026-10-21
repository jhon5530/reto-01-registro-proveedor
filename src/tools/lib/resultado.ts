/** Contrato de salida de toda herramienta: nunca se lanza una excepción hacia el agente. */
export type Exito<T> = { ok: true; data: T }
export type Fallo = { ok: false; error: string; data?: unknown }
export type Resultado<T> = Exito<T> | Fallo

export interface ContextoHerramienta {
  /** Raíz del proyecto. Todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
}

export const exito = <T>(data: T): Exito<T> => ({ ok: true, data })

export const fallo = (error: string, data?: unknown): Fallo =>
  data === undefined ? { ok: false, error } : { ok: false, error, data }

/** Convierte cualquier error en un mensaje legible, sin trazas. */
export function mensajeDeError(e: unknown): string {
  if (e instanceof Error) return e.message.split("\n")[0] ?? "error desconocido"
  return typeof e === "string" ? e : "error desconocido"
}
