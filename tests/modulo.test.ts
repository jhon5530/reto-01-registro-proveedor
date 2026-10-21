import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { generarModulo } from "../scripts/build-modulo.ts"
import * as moduloTools from "../modulo/tools/proveedor.ts"
import * as appTools from "../src/tools/proveedor.ts"

describe("módulo reutilizable (bonus 9.4)", () => {
  test("agent.md y SKILL.md están sincronizados con las fuentes de la app", async () => {
    const esperados = await generarModulo(process.cwd())
    for (const [ruta, contenido] of Object.entries(esperados)) {
      expect(await readFile(ruta, "utf8")).toBe(contenido)
    }
  })

  test("las herramientas del módulo son exactamente las de la app", () => {
    expect(moduloTools.leer_solicitud).toBe(appTools.leer_solicitud)
    expect(moduloTools.mapear_campos).toBe(appTools.mapear_campos)
    expect(moduloTools.generar_formulario).toBe(appTools.generar_formulario)
    expect(moduloTools.armar_paquete).toBe(appTools.armar_paquete)
    expect(moduloTools.simular_envio).toBe(appTools.simular_envio)
  })
})
