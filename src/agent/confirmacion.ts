import { normalizar } from "../tools/lib/mapeo.ts"
import { reglas } from "../tools/lib/reglas.ts"

const NEGACIONES = /\b(no|todavia no|aun no|cancela|cancelar|espera|detente|nunca)\b/

/**
 * ¿El mensaje del usuario es una confirmación explícita? (RN4 / CA3)
 * Debe ser corto, contener una palabra de confirmación y ninguna negación.
 * "envía" → sí · "sí, confirmo" → sí · "No envíes nada todavía" → no.
 */
export function esConfirmacion(texto: string): boolean {
  const t = normalizar(texto)
  if (!t || t.split(" ").length > 15 || NEGACIONES.test(t)) return false
  return reglas.palabras_confirmacion.some((p) => new RegExp(`(^| )${normalizar(p)}( |$)`).test(t))
}
