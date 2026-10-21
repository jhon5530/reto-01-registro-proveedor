/**
 * Herramientas del agente, importables sin el servidor HTTP.
 * Re-exporta las MISMAS herramientas que usa la aplicación (no es una copia divergente).
 * Cada export cumple { description, args (zod), execute(args, ctx) → string JSON }.
 * Generado por scripts/build-modulo.ts.
 */
export { leer_solicitud, mapear_campos, generar_formulario, armar_paquete, simular_envio } from "../../src/tools/proveedor.ts"
export type { ContextoHerramienta } from "../../src/tools/proveedor.ts"
