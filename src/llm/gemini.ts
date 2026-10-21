import { z } from "zod"
import { ErrorLLM, type DefinicionHerramienta, type LlamadaHerramienta, type Mensaje, type ProveedorLLM, type RespuestaLLM } from "./adapter.ts"

/**
 * Implementación para Google Gemini (API REST generateContent).
 * La clave viaja en la cabecera x-goog-api-key (nunca en la URL, para que no quede en logs de proxies).
 */

const parteSchema = z.looseObject({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  functionCall: z.looseObject({ name: z.string(), args: z.record(z.string(), z.unknown()).optional(), id: z.string().optional() }).optional(),
})
type Parte = z.infer<typeof parteSchema>

const respuestaSchema = z.looseObject({
  candidates: z.array(z.looseObject({
    content: z.looseObject({ parts: z.array(parteSchema).optional() }).optional(),
    finishReason: z.string().optional(),
  })).optional(),
  usageMetadata: z.looseObject({
    promptTokenCount: z.number().optional(),
    candidatesTokenCount: z.number().optional(),
    thoughtsTokenCount: z.number().optional(),
  }).optional(),
})

/** Prefijo de ids generados localmente cuando el proveedor no envía id de llamada. */
const ID_LOCAL = "llamada-"

type Contenido = { role: "user" | "model"; parts: unknown[] }

function aContenido(m: Exclude<Mensaje, { rol: "sistema" }>): Contenido {
  if (m.rol === "usuario") return { role: "user", parts: [{ text: m.texto }] }
  if (m.rol === "asistente") {
    // Se reenvían las partes originales (incluyen thoughtSignature, obligatorio en modelos recientes).
    if (Array.isArray(m.meta)) return { role: "model", parts: m.meta }
    const partes: unknown[] = m.texto ? [{ text: m.texto }] : []
    m.llamadas.forEach((l) => partes.push({ functionCall: { name: l.nombre, args: l.argumentos } }))
    return { role: "model", parts: partes }
  }
  return {
    role: "user",
    parts: m.resultados.map((r) => ({
      functionResponse: { name: r.nombre, response: aObjeto(r.contenido), ...(r.id.startsWith(ID_LOCAL) ? {} : { id: r.id }) },
    })),
  }
}

function aObjeto(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { resultado: v }
  } catch {
    return { resultado: json }
  }
}

function errorPorEstado(estado: number, cuerpo: string): ErrorLLM {
  if (estado === 401 || estado === 403) return new ErrorLLM("autenticacion")
  if (estado === 429) return new ErrorLLM("cuota")
  if (estado >= 500) return new ErrorLLM("proveedor", `HTTP ${estado}`)
  const msg = /"message":\s*"([^"]{0,200})/.exec(cuerpo)?.[1]
  const detalle = `HTTP ${estado}${msg ? `: ${msg}` : ""}`
  return new ErrorLLM(estado === 404 ? "modelo_no_disponible" : "solicitud_invalida", detalle)
}

export class GeminiLLM implements ProveedorLLM {
  readonly proveedor = "gemini"

  constructor(readonly modelo: string, private readonly clave: string, private readonly timeoutMs: number) {
    if (!clave) throw new Error("Falta GEMINI_API_KEY en el entorno del backend.")
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
    const sistema = mensajes.filter((m) => m.rol === "sistema").map((m) => m.texto).join("\n\n")
    const cuerpo = {
      systemInstruction: { parts: [{ text: sistema }] },
      contents: mensajes.filter((m): m is Exclude<Mensaje, { rol: "sistema" }> => m.rol !== "sistema").map(aContenido),
      tools: [{ functionDeclarations: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parametersJsonSchema: h.parametros })) }],
      generationConfig: { temperature: 0.2 },
    }
    const datos = await this.post(cuerpo)
    return this.interpretar(datos)
  }

  private async post(cuerpo: unknown): Promise<unknown> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelo)}:generateContent`
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.clave },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (e) {
      const nombre = e instanceof Error ? e.name : ""
      throw nombre === "TimeoutError" || nombre === "AbortError" ? new ErrorLLM("timeout") : new ErrorLLM("proveedor", "sin conexión")
    }
    const texto = await res.text()
    if (!res.ok) throw errorPorEstado(res.status, texto)
    try {
      return JSON.parse(texto)
    } catch {
      throw new ErrorLLM("respuesta_invalida")
    }
  }

  private interpretar(datos: unknown): RespuestaLLM {
    const r = respuestaSchema.safeParse(datos)
    if (!r.success) throw new ErrorLLM("respuesta_invalida")
    const candidato = r.data.candidates?.[0]
    const partes: Parte[] = candidato?.content?.parts ?? []
    if (partes.length === 0) throw new ErrorLLM("respuesta_invalida", `sin contenido, motivo: ${candidato?.finishReason ?? "desconocido"}`)
    const texto = partes.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim()
    const llamadas: LlamadaHerramienta[] = partes
      .filter((p) => p.functionCall)
      .map((p, i) => ({ id: p.functionCall?.id ?? `${ID_LOCAL}${Date.now()}-${i}`, nombre: p.functionCall?.name ?? "", argumentos: p.functionCall?.args ?? {} }))
    const u = r.data.usageMetadata
    return {
      texto,
      llamadas,
      uso: { entrada: u?.promptTokenCount ?? 0, salida: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) },
      meta: partes,
    }
  }
}
