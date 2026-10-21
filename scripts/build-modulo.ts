/**
 * Genera modulo/ (bonus 9.4) a partir de las MISMAS fuentes que usa la aplicación:
 * - modulo/agent.md                         ← agent/prompt.md
 * - modulo/skill/registro-proveedor/SKILL.md ← src/knowledge/registro-proveedor.md + reglas.json
 * - modulo/tools/proveedor.ts               ← re-exporta src/tools/proveedor.ts (no es una copia)
 * Uso: bun run build:modulo. La prueba tests/modulo.test.ts falla si modulo/ queda desincronizado.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

const AVISO = "<!-- Archivo generado por scripts/build-modulo.ts. No editar a mano. -->"

export async function generarModulo(directory: string): Promise<Record<string, string>> {
  const prompt = (await readFile(join(directory, "agent/prompt.md"), "utf8")).trim()
  const conocimiento = (await readFile(join(directory, "src/knowledge/registro-proveedor.md"), "utf8")).trim()
  const reglas = (await readFile(join(directory, "src/knowledge/reglas.json"), "utf8")).trim()

  const agente = [
    "---",
    "description: Automatiza el registro de Periferia como proveedor ante clientes (lee la solicitud, mapea campos al maestro, genera el formulario y arma el paquete para firma; nunca envía sin confirmación).",
    "mode: primary",
    "permission:",
    "  edit: deny",
    "  bash: deny",
    "---",
    "",
    AVISO,
    "",
    prompt,
    "",
  ].join("\n")

  const skill = [
    "---",
    "name: registro-proveedor",
    "description: Conocimiento del proceso de registro como proveedor de Periferia IT Group - reglas por país (NIT/RUC/RTN), estados de campo, soportes, vigencias y cuándo un paquete está listo para firma.",
    "---",
    "",
    AVISO,
    "",
    conocimiento,
    "",
    "## Reglas en formato máquina (src/knowledge/reglas.json)",
    "",
    "```json",
    reglas,
    "```",
    "",
  ].join("\n")

  const herramientas = [
    "/**",
    " * Herramientas del agente, importables sin el servidor HTTP.",
    " * Re-exporta las MISMAS herramientas que usa la aplicación (no es una copia divergente).",
    " * Cada export cumple { description, args (zod), execute(args, ctx) → string JSON }.",
    " * Generado por scripts/build-modulo.ts.",
    " */",
    'export { leer_solicitud, mapear_campos, generar_formulario, armar_paquete, simular_envio } from "../../src/tools/proveedor.ts"',
    'export type { ContextoHerramienta } from "../../src/tools/proveedor.ts"',
    "",
  ].join("\n")

  return {
    "modulo/agent.md": agente,
    "modulo/skill/registro-proveedor/SKILL.md": skill,
    "modulo/tools/proveedor.ts": herramientas,
  }
}

if (import.meta.main) {
  const archivos = await generarModulo(process.cwd())
  for (const [ruta, contenido] of Object.entries(archivos)) {
    await mkdir(dirname(ruta), { recursive: true })
    await writeFile(ruta, contenido, "utf8")
    console.log(`✔ ${ruta}`)
  }
}
