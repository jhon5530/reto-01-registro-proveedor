import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { listarCasos } from "../tools/lib/fixtures.ts"
import { fechaEjecucion } from "../tools/lib/rutas.ts"

/**
 * System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge/*.md)
 * + contexto dinámico mínimo (fecha y casos disponibles). Nada de esto está embebido en código.
 */
export async function construirPromptSistema(directory: string): Promise<string> {
  const [comportamiento, conocimiento] = await Promise.all([
    readFile(join(directory, "agent", "prompt.md"), "utf8"),
    readFile(join(directory, "src", "knowledge", "registro-proveedor.md"), "utf8"),
  ])
  const casos = await listarCasos({ directory, sessionId: "sistema" })
  return [
    comportamiento.trim(),
    "---",
    conocimiento.trim(),
    "---",
    `Fecha de ejecución: ${fechaEjecucion()}. Casos disponibles: ${casos.join(", ") || "ninguno"}.`,
  ].join("\n\n")
}
