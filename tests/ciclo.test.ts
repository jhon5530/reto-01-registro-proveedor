import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ejecutarTurno, type DependenciasCiclo } from "../src/agent/ciclo.ts"
import { esConfirmacion } from "../src/agent/confirmacion.ts"
import type { Sesion } from "../src/agent/sesiones.ts"
import { ErrorLLM, type ProveedorLLM, type RespuestaLLM } from "../src/llm/adapter.ts"
import { MockLLM } from "../src/llm/mock.ts"

let dir: string
const nueva = (id: string): Sesion => ({ id, creada: "", mensajes: [], historial: [], esperandoConfirmacion: false, tokens: 0, turnos: 0 })
const deps = (llm: ProveedorLLM, extra: Partial<DependenciasCiclo> = {}): DependenciasCiclo => ({
  llm, sistema: "prueba", directory: dir, maxIteraciones: 25, maxTokensSesion: 1_000_000, ...extra,
})

beforeAll(async () => {
  process.env.FECHA_EJECUCION = "2026-10-20"
  dir = await mkdtemp(join(tmpdir(), "reto01-ciclo-"))
  await cp("fixtures", join(dir, "fixtures"), { recursive: true })
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe("confirmación explícita", () => {
  test.each([["envía", true], ["Sí, confirmo", true], ["ok", true], ["No envíes nada todavía", false], ["procesa el caso", false], ["no", false]])(
    "%p → %p", (t, esperado) => expect(esConfirmacion(t)).toBe(esperado),
  )
})

describe("ciclo del agente (con proveedor simulado)", () => {
  test("flujo de la sección 11: procesa, pregunta y solo envía tras confirmar", async () => {
    const s = nueva("sesion-prueba-01")
    const llm = new MockLLM()
    const t1 = await ejecutarTurno(s, 'Procesa el caso "ec-corp-andina". No envíes nada todavía.', deps(llm))
    expect(t1.toolCalls.map((t) => t.nombre)).toEqual([
      "proveedor_leer_solicitud", "proveedor_mapear_campos", "proveedor_generar_formulario", "proveedor_armar_paquete",
    ])
    expect(t1.needsConfirmation).toBe(true)
    expect(t1.reply.trim().endsWith("?")).toBe(true)
    expect(existsSync(join(dir, "out/ec-corp-andina/ENVIO-SIMULADO.md"))).toBe(false)
    const t2 = await ejecutarTurno(s, "envía", deps(llm))
    expect(t2.toolCalls[0]?.ok).toBe(true)
    expect(existsSync(join(dir, "out/ec-corp-andina/ENVIO-SIMULADO.md"))).toBe(true)
  })

  test("RN4: el ciclo bloquea el envío si no hubo pregunta previa", async () => {
    const s = nueva("sesion-prueba-02")
    const t = await ejecutarTurno(s, "envía el caso co-industrias-delta", deps(new MockLLM()))
    expect(t.toolCalls[0]).toMatchObject({ nombre: "proveedor_simular_envio", bloqueada: true, ok: false })
    expect(t.needsConfirmation).toBe(false)
    expect(existsSync(join(dir, "out/co-industrias-delta/ENVIO-SIMULADO.md"))).toBe(false)
  })

  test("CA1: respeta el tope de iteraciones", async () => {
    const bucle: ProveedorLLM = {
      proveedor: "bucle", modelo: "x",
      enviar: async (): Promise<RespuestaLLM> => ({ texto: "", llamadas: [{ id: "1", nombre: "proveedor_leer_solicitud", argumentos: { caso: "co-industrias-delta" } }], uso: { entrada: 1, salida: 1 } }),
    }
    const t = await ejecutarTurno(nueva("sesion-prueba-03"), "hola", deps(bucle, { maxIteraciones: 3 }))
    expect(t.toolCalls).toHaveLength(3)
    expect(t.reply).toContain("tope de 3 iteraciones")
  })

  test("CA5: un error del proveedor se muestra claro y la sesión sigue viva", async () => {
    const caido: ProveedorLLM = { proveedor: "caido", modelo: "x", enviar: async () => { throw new ErrorLLM("timeout") } }
    const s = nueva("sesion-prueba-04")
    const t = await ejecutarTurno(s, "hola", deps(caido))
    expect(t.error).toBe(true)
    expect(t.reply).toContain("no respondió a tiempo")
    const t2 = await ejecutarTurno(s, "hola", deps(new MockLLM()))
    expect(t2.error).toBe(false)
  })

  test("argumentos inválidos se devuelven al modelo sin ejecutar", async () => {
    let llamadas = 0
    const malo: ProveedorLLM = {
      proveedor: "malo", modelo: "x",
      enviar: async (): Promise<RespuestaLLM> => (++llamadas === 1
        ? { texto: "", llamadas: [{ id: "1", nombre: "proveedor_mapear_campos", argumentos: { caso: 5 } }], uso: { entrada: 0, salida: 0 } }
        : { texto: "listo", llamadas: [], uso: { entrada: 0, salida: 0 } }),
    }
    const t = await ejecutarTurno(nueva("sesion-prueba-05"), "x", deps(malo))
    expect(t.toolCalls[0]?.resumen).toContain("Argumentos inválidos")
  })

  test("tope de tokens por sesión", async () => {
    const s = { ...nueva("sesion-prueba-06"), tokens: 999 }
    const t = await ejecutarTurno(s, "hola", deps(new MockLLM(), { maxTokensSesion: 500 }))
    expect(t.reply).toContain("tope de 500 tokens")
  })
})
