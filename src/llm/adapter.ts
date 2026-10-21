/**
 * Interfaz propia del proveedor de lenguaje (PRD 6.1): enviar(mensajes, herramientas) → respuesta.
 * El ciclo del agente solo conoce estos tipos; cambiar de proveedor no lo toca.
 */

export interface LlamadaHerramienta {
  id: string
  nombre: string
  argumentos: Record<string, unknown>
}

export interface ResultadoHerramienta {
  id: string
  nombre: string
  /** JSON serializado { ok, data } | { ok: false, error } tal como lo devolvió la herramienta. */
  contenido: string
}

export type Mensaje =
  | { rol: "sistema"; texto: string }
  | { rol: "usuario"; texto: string }
  /** `meta`: datos opacos del proveedor que deben reenviarse tal cual (ej. firmas de razonamiento). */
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; meta?: unknown }
  | { rol: "herramienta"; resultados: ResultadoHerramienta[] }

export interface DefinicionHerramienta {
  nombre: string
  descripcion: string
  /** JSON Schema de los argumentos (generado desde zod). */
  parametros: Record<string, unknown>
}

export interface RespuestaLLM {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso: { entrada: number; salida: number }
  meta?: unknown
}

export interface ProveedorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM>
}

export type TipoErrorLLM = "timeout" | "autenticacion" | "cuota" | "proveedor" | "respuesta_invalida"

const MENSAJES: Record<TipoErrorLLM, string> = {
  timeout: "El modelo de lenguaje no respondió a tiempo. Intenta de nuevo en unos segundos.",
  autenticacion: "El proveedor del modelo rechazó la credencial configurada en el servidor. Revisa la variable de entorno de la clave.",
  cuota: "Se agotó la cuota o el límite de velocidad del proveedor del modelo. Espera un momento e intenta de nuevo.",
  proveedor: "El proveedor del modelo tuvo un error temporal. Intenta de nuevo.",
  respuesta_invalida: "El modelo devolvió una respuesta que no se pudo interpretar. Intenta reformular el mensaje.",
}

/** Error tipado del proveedor: lleva un mensaje apto para mostrar en el chat (sin trazas ni claves). */
export class ErrorLLM extends Error {
  constructor(readonly tipo: TipoErrorLLM, detalle?: string) {
    super(detalle ? `${MENSAJES[tipo]} (${detalle})` : MENSAJES[tipo])
    this.name = "ErrorLLM"
  }
}
