---
name: registro-proveedor
description: Conocimiento del proceso de registro como proveedor de Periferia IT Group - reglas por país (NIT/RUC/RTN), estados de campo, soportes, vigencias y cuándo un paquete está listo para firma.
---

<!-- Archivo generado por scripts/build-modulo.ts. No editar a mano. -->

# Conocimiento del proceso: registro de Periferia como proveedor

## Para qué existe el proceso
Los clientes de Periferia IT Group (Colombia, Ecuador, Perú, Panamá y Honduras) piden
registrar a Periferia como proveedor antes de poder facturarle. Envían un correo con un
formulario (Excel, PDF o portal web) y una lista de soportes. Los datos casi siempre son
los mismos y viven en el repositorio maestro. El cierre (firma y envío) es humano.

## Flujo estándar (en este orden)
1. **Leer la solicitud** del caso: país, cliente, formato, campos y soportes exigidos.
2. **Mapear los campos** al repositorio maestro usando el glosario de sinónimos.
3. **Generar el formulario** en el mismo formato que envió el cliente.
4. **Armar el paquete para firma**: formulario + soportes + checklist + borrador de correo.
5. **Resumir y preguntar**: el analista decide. Solo con confirmación explícita se simula el envío.

## Estados de un campo
| Estado | Significado | ¿Se escribe en el formulario? |
|---|---|---|
| `lleno` | El dato existe en el maestro; se informa la ruta (ej. `banco.swift`). | Sí |
| `requiere_confirmacion` | Mapeo con confianza < 0.8, etiqueta ambigua o regla de país. | Solo si hay valor de origen (regla de país); se marca "por confirmar". |
| `faltante` | No existe en el maestro. Nunca se inventa. | No, queda vacío y va al checklist. |

## Reglas por país (identificador tributario)
| País del cliente | Identificador que pide | Qué hacemos |
|---|---|---|
| CO Colombia | NIT | Se llena con el NIT del maestro. |
| EC Ecuador | RUC | Se llena con el NIT y se marca `requiere_confirmacion` ("identificador extranjero"). |
| PE Perú | RUC | Igual que Ecuador. |
| PA Panamá | RUC | Igual que Ecuador. |
| HN Honduras | RTN | Igual que Ecuador. |

Periferia **solo** tiene NIT colombiano. Etiquetas genéricas como "Identificación tributaria"
se reportan como `requiere_confirmacion` proponiendo el equivalente del país.

## Datos bancarios
- Solo se llenan si la plantilla del cliente los pide explícitamente.
- **Nunca** se incluyen en el borrador de correo.

## Soportes
| Tipo | Documento | Nota |
|---|---|---|
| `camara_comercio` | Certificado de existencia y representación legal | Los clientes suelen exigir que no tenga más de 30 días. |
| `rut` | Registro Único Tributario | Sin vencimiento. |
| `certificacion_bancaria` | Certificación de la cuenta bancaria | |
| `estados_financieros` | Estados financieros del último año | |
| `parafiscales` | Pago de aportes parafiscales y seguridad social | Mensual. |
| `certificado_cumplimiento_tributario` | Paz y salvo tributario | Hoy **no** existe en el repositorio. |

Un soporte es **vencido** si su `vigencia_hasta` es anterior a la fecha de ejecución.
Todos los soportes de Periferia son emitidos en Colombia; para clientes extranjeros
se entregan los colombianos equivalentes y el analista valida si el cliente los acepta.

## Cuándo un paquete está listo para firma
- Bloquea: un soporte exigido **vencido** o **ausente**.
- No bloquea: campos `faltante` o `requiere_confirmacion` (pero aparecen en el checklist).

## Formatos
- `xlsx`: se escribe cada etiqueta y su valor en la hoja/celda que indica la plantilla.
- `pdf`: se genera un PDF con todos los campos, en el orden de la plantilla.
- `portal`: **no soportado** para llenado automático. Se generan los valores listos para
  copiar (`valores-portal.md`). Credenciales y clic en "Enviar" son siempre humanos.

## Acciones externas
El agente nunca firma, nunca envía y nunca carga nada a un portal. "Enviar" en este
sistema solo escribe `ENVIO-SIMULADO.md`, y únicamente tras una confirmación explícita
del analista en el mensaje inmediatamente anterior.

## Reglas en formato máquina (src/knowledge/reglas.json)

```json
{
  "pais_maestro": "CO",
  "clave_identificador_tributario": "nit",
  "identificador_tributario_por_pais": {
    "CO": "NIT",
    "EC": "RUC",
    "PE": "RUC",
    "PA": "RUC",
    "HN": "RTN"
  },
  "etiquetas_ambiguas": [
    "Identificación tributaria",
    "Número de identificación fiscal"
  ],
  "prefijo_datos_bancarios": "banco.",
  "campos_enmascarados": [
    "banco.numero_cuenta"
  ],
  "umbral_confianza": 0.8,
  "umbral_candidato": 0.5,
  "formatos_generables": [
    "xlsx",
    "pdf"
  ],
  "palabras_vacias": [
    "de",
    "del",
    "la",
    "el",
    "los",
    "las",
    "o",
    "y",
    "en",
    "a"
  ],
  "palabras_confirmacion": [
    "si",
    "sí",
    "confirmo",
    "confirmado",
    "envia",
    "envía",
    "envialo",
    "envíalo",
    "enviar",
    "adelante",
    "procede",
    "dale",
    "ok",
    "de acuerdo",
    "hazlo",
    "aprobado"
  ],
  "nombres_soporte": {
    "camara_comercio": "Certificado de existencia y representación legal (Cámara de Comercio)",
    "rut": "Registro Único Tributario (RUT)",
    "certificacion_bancaria": "Certificación bancaria",
    "estados_financieros": "Estados financieros",
    "parafiscales": "Certificación de pago de parafiscales y seguridad social",
    "certificado_cumplimiento_tributario": "Certificado de cumplimiento tributario",
    "certificado_iso_9001": "Certificado ISO 9001"
  }
}
```
