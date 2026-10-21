import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Mensaje } from "../llm/adapter.ts"

/** Llamada a herramienta tal como se muestra en el chat (CA4). */
export interface EventoHerramienta {
  id: string
  nombre: string
  argumentos: Record<string, unknown>
  ok: boolean
  resumen: string
  /** true si el ciclo la bloqueó por falta de confirmación humana. */
  bloqueada: boolean
  duracionMs: number
}

export type EntradaHistorial =
  | { rol: "usuario"; texto: string; ts: string }
  | { rol: "asistente"; texto: string; ts: string; toolCalls: EventoHerramienta[]; needsConfirmation: boolean; error?: boolean }

export interface Sesion {
  id: string
  creada: string
  /** Conversación en formato neutral para el proveedor LLM. */
  mensajes: Mensaje[]
  /** Historial visible para el front. */
  historial: EntradaHistorial[]
  /** El turno anterior terminó pidiendo confirmación (CA3). */
  esperandoConfirmacion: boolean
  tokens: number
  turnos: number
}

export const ID_SESION = /^[A-Za-z0-9_-]{8,64}$/

/** Sesiones en memoria con respaldo en archivo (out/sessions/). Sin base de datos. */
export class AlmacenSesiones {
  private readonly memoria = new Map<string, Sesion>()
  private readonly ocupadas = new Set<string>()

  constructor(private readonly dir: string) {}

  async obtener(id: string): Promise<Sesion | null> {
    if (!ID_SESION.test(id)) return null
    const enMemoria = this.memoria.get(id)
    if (enMemoria) return enMemoria
    const ruta = join(this.dir, `${id}.json`)
    if (!existsSync(ruta)) return null
    try {
      const s = JSON.parse(await readFile(ruta, "utf8")) as Sesion
      this.memoria.set(id, s)
      return s
    } catch {
      return null
    }
  }

  async obtenerOCrear(id: string): Promise<Sesion> {
    const existente = await this.obtener(id)
    if (existente) return existente
    const nueva: Sesion = { id, creada: new Date().toISOString(), mensajes: [], historial: [], esperandoConfirmacion: false, tokens: 0, turnos: 0 }
    this.memoria.set(id, nueva)
    return nueva
  }

  async guardar(s: Sesion): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(join(this.dir, `${s.id}.json`), JSON.stringify(s), "utf8")
    } catch {
      // Persistencia best-effort: la sesión sigue viva en memoria.
    }
  }

  /** Evita dos turnos simultáneos sobre la misma sesión. */
  tomar(id: string): boolean {
    if (this.ocupadas.has(id)) return false
    this.ocupadas.add(id)
    return true
  }

  soltar(id: string): void {
    this.ocupadas.delete(id)
  }
}
