import { afterEach, describe, expect, test } from "bun:test"
import { ErrorLLM } from "../src/llm/adapter.ts"
import { GeminiLLM } from "../src/llm/gemini.ts"

const original = globalThis.fetch
afterEach(() => { globalThis.fetch = original })

function simular(estado: number, cuerpo: unknown, capturar?: (init: RequestInit, url: string) => void) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    capturar?.(init, url)
    return new Response(JSON.stringify(cuerpo), { status: estado })
  }) as unknown as typeof fetch
}

const defs = [{ nombre: "proveedor_leer_solicitud", descripcion: "lee", parametros: { type: "object" } }]

describe("adaptador Gemini", () => {
  test("traduce llamadas, conserva partes (thoughtSignature) y no pone la clave en la URL", async () => {
    let url = ""
    let headers: Record<string, string> = {}
    simular(200, {
      candidates: [{ content: { parts: [{ functionCall: { name: "proveedor_leer_solicitud", args: { caso: "x" } }, thoughtSignature: "abc" }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }, (init, u) => { url = u; headers = init.headers as Record<string, string> })
    const llm = new GeminiLLM("gemini-2.5-flash", "CLAVE-SECRETA", 1000)
    const r = await llm.enviar([{ rol: "sistema", texto: "s" }, { rol: "usuario", texto: "hola" }], defs)
    expect(r.llamadas[0]).toMatchObject({ nombre: "proveedor_leer_solicitud", argumentos: { caso: "x" } })
    expect(r.uso).toEqual({ entrada: 10, salida: 5 })
    expect(url).not.toContain("CLAVE-SECRETA")
    expect(headers["x-goog-api-key"]).toBe("CLAVE-SECRETA")

    let enviado: { contents: { role: string; parts: unknown[] }[] } = { contents: [] }
    simular(200, { candidates: [{ content: { parts: [{ text: "listo" }] } }] }, (init) => { enviado = JSON.parse(String(init.body)) })
    await llm.enviar([
      { rol: "usuario", texto: "hola" },
      { rol: "asistente", texto: "", llamadas: r.llamadas, meta: r.meta },
      { rol: "herramienta", resultados: [{ id: r.llamadas[0]?.id ?? "", nombre: "proveedor_leer_solicitud", contenido: '{"ok":true,"data":{}}' }] },
    ], defs)
    expect(JSON.stringify(enviado.contents[1])).toContain("thoughtSignature")
    expect(enviado.contents[2]?.parts[0]).toMatchObject({ functionResponse: { name: "proveedor_leer_solicitud", response: { ok: true } } })
  })

  test.each([[429, "cuota"], [403, "autenticacion"], [503, "proveedor"]])("HTTP %p → ErrorLLM %p", async (estado, tipo) => {
    simular(estado, { error: { message: "x" } })
    const e = await new GeminiLLM("m", "k", 1000).enviar([{ rol: "usuario", texto: "h" }], defs).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ErrorLLM)
    expect((e as ErrorLLM).tipo).toBe(tipo as ErrorLLM["tipo"])
  })
})
