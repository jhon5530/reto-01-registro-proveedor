import type { Config } from "../config.ts"
import type { ProveedorLLM } from "./adapter.ts"
import { GeminiLLM } from "./gemini.ts"
import { MockLLM } from "./mock.ts"

/** Único lugar que conoce las implementaciones concretas. Agregar un proveedor = un archivo + un caso aquí. */
export function crearProveedor(c: Config): ProveedorLLM {
  if (c.LLM_PROVIDER === "gemini") return new GeminiLLM(c.LLM_MODEL, c.GEMINI_API_KEY, c.LLM_TIMEOUT_MS, c.LLM_REINTENTOS)
  return new MockLLM()
}
