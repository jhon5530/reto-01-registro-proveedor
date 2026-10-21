/**
 * Chat en la terminal: mismo ciclo del agente que la API, sin front ni servidor.
 * Uso: bun run chat   (LLM_PROVIDER=mock para probar sin clave)
 */
import { join } from "node:path"
import { ejecutarTurno } from "./agent/ciclo.ts"
import { construirPromptSistema } from "./agent/prompt.ts"
import { AlmacenSesiones } from "./agent/sesiones.ts"
import { cargarConfig } from "./config.ts"
import { crearProveedor } from "./llm/fabrica.ts"

const DIRECTORIO = process.cwd()
const config = cargarConfig()
const llm = crearProveedor(config)
const sesion = await new AlmacenSesiones(join(DIRECTORIO, "out", "sessions")).obtenerOCrear(`cli-${Date.now()}`)
const prompt = () => process.stdout.write("tú › ")

console.log(`Agente Registro Proveedor (terminal) · proveedor=${llm.proveedor} modelo=${llm.modelo}. Escribe "salir" para terminar.\n`)
prompt()
// Bun expone stdin como iterador de líneas en `console` (funciona interactivo y con tubería).
for await (const linea of console) {
  const texto = linea.trim()
  if (texto === "salir") break
  if (!texto) {
    prompt()
    continue
  }
  console.log(`(tú) ${texto}`)
  const r = await ejecutarTurno(sesion, texto, {
    llm, sistema: await construirPromptSistema(DIRECTORIO), directory: DIRECTORIO,
    maxIteraciones: config.MAX_ITERACIONES, maxTokensSesion: config.MAX_TOKENS_SESION,
  })
  for (const t of r.toolCalls) {
    console.log(`  🔧 ${t.nombre}(${JSON.stringify(t.argumentos)}) → ${t.bloqueada ? "BLOQUEADA" : t.ok ? "ok" : "error"}: ${t.resumen}`)
  }
  console.log(`\nagente › ${r.reply}\n`)
  if (r.needsConfirmation) console.log("  ⚠️  El agente espera tu confirmación explícita.\n")
  prompt()
}
