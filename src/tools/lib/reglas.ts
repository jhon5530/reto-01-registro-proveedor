import { z } from "zod"
import reglasJson from "../../knowledge/reglas.json"

/** Reglas de negocio. Viven en src/knowledge/reglas.json: cambiarlas no toca código. */
const esquemaReglas = z.object({
  pais_maestro: z.string(),
  clave_identificador_tributario: z.string(),
  identificador_tributario_por_pais: z.record(z.string(), z.string()),
  etiquetas_ambiguas: z.array(z.string()),
  prefijo_datos_bancarios: z.string(),
  campos_enmascarados: z.array(z.string()),
  umbral_confianza: z.number(),
  umbral_candidato: z.number(),
  formatos_generables: z.array(z.string()),
  palabras_vacias: z.array(z.string()),
  palabras_confirmacion: z.array(z.string()),
  nombres_soporte: z.record(z.string(), z.string()),
})

export type Reglas = z.infer<typeof esquemaReglas>

export const reglas: Reglas = esquemaReglas.parse(reglasJson)

export function nombreSoporte(tipo: string): string {
  return reglas.nombres_soporte[tipo] ?? tipo
}
