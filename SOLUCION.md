# SOLUCIÓN — Agente "Registro como Proveedor"

## 1. Problema en una frase

**La analista administrativa de Periferia transcribe a mano, de 8 a 12 veces al mes, los mismos datos
(NIT, cuenta bancaria, representante legal…) y busca los mismos soportes para registrarse como proveedor
ante cada cliente.** Esto le duele a ella (retrabajo y riesgo de error en datos sensibles), a la empresa
(dependencia de una sola persona) y a facturación (registros que tardan días retrasan el cobro).

## 2. Arquitectura

```
┌───────────────────────┐   HTTP JSON    ┌──────────────────────────────────────────────────────┐
│ web/ (HTML + JS)      │ ─────────────▶ │ src/server.ts (Hono sobre Bun)                       │
│ · historial           │ ◀───────────── │  /api/chat · /api/sessions/:id · /api/health         │
│ · tarjetas de tools   │                │  clave de acceso opcional · topes de costo           │
│ · banner confirmación │                │        │                                             │
└───────────────────────┘                │        ▼                                             │
                                         │ src/agent/ciclo.ts  ── ciclo del agente              │
   src/cli.ts (terminal) ──────────────▶ │   · tope de iteraciones/tokens                       │
                                         │   · validación zod de argumentos                     │
                                         │   · guardia de confirmación humana (RN4)             │
                                         │        │                  │                          │
                                         │        ▼                  ▼                          │
                                         │ src/llm/adapter.ts   src/tools/registro.ts           │
                                         │  ├ gemini.ts          └ src/tools/proveedor.ts       │
                                         │  └ mock.ts               └ lib/ (mapeo, xlsx, pdf,   │
                                         │                               paquete, log)          │
                                         └──────────────────────────┬───────────────┬───────────┘
                                                                    │               │
                                                fixtures/ (solo lectura)      out/ (escritura)
                                                maestro, glosario,            <caso>/formulario.*
                                                casos, soportes               <caso>/paquete/…
                                                                              log.jsonl, sessions/
```

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, orden de herramientas, reglas inquebrantables, formato del resumen, pregunta final. |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` + `src/knowledge/reglas.json` | Proceso, reglas por país, soportes. `reglas.json` es la versión que leen las herramientas: identificador por país, umbrales, campos bancarios, palabras de confirmación. |
| **Ejecución** | `src/tools/proveedor.ts` (+ `lib/`) | Las 5 herramientas del contrato. Son la única fuente de valores. |

Cambiar una regla de negocio (por ejemplo, agregar Perú → "RUC" o subir el umbral de confianza) se hace
en `reglas.json` y no toca el servidor ni el ciclo. El system prompt se arma en tiempo de ejecución
concatenando `agent/prompt.md` + `registro-proveedor.md` + la fecha y los casos disponibles
(`src/agent/prompt.ts`).

**Flujo de un caso:** `leer_solicitud` → `mapear_campos` → `generar_formulario` → `armar_paquete` →
resumen + pregunta → (confirmación) → `simular_envio`.

## 3. Ciclo del agente

Implementado a mano en `src/agent/ciclo.ts`, sin framework de agentes, para poder explicar y controlar
cada paso:

1. Se agrega el mensaje del usuario a la sesión y se calcula **una sola vez**
   `confirmacionDisponible = turnoAnteriorPidioConfirmacion && esConfirmacion(mensaje)`.
2. Se llama a `llm.enviar([sistema, ...historial], herramientas)`. Si el modelo pide herramientas:
   - se busca la herramienta y se **validan los argumentos con zod**. Si no cumplen, el error vuelve
     al modelo sin ejecutar nada;
   - si la herramienta tiene efecto externo (`REQUIEREN_CONFIRMACION`, hoy `proveedor_simular_envio`) y
     no hay confirmación disponible, **el ciclo la bloquea** y devuelve al modelo
     `requiere confirmación explícita`. La confirmación se consume con la primera acción externa, así que
     el modelo no puede encadenar dos envíos ni forzar bloqueos en el mismo turno;
   - el resultado (`{ ok, data } | { ok:false, error }`) vuelve al modelo y se repite.
3. **Tope de iteraciones (CA1):** `MAX_ITERACIONES` (25). Al alcanzarlo, el agente responde con lo que
   hizo y lo que falta. También hay tope de **tokens por sesión** y de **mensajes por sesión**.
4. **Confirmación humana (CA3/RN4):** el turno se marca `needsConfirmation` si se armó un paquete o si el
   envío fue rechazado por bloqueos. El front resalta el mensaje y muestra el banner "Sí, confirmo / No".
   Solo un mensaje afirmativo, corto y sin negaciones ("envía", "sí, confirmo"; no "No envíes nada todavía")
   en el **turno inmediatamente siguiente** habilita la acción. Si el paquete tiene bloqueos (soportes
   vencidos o ausentes), `simular_envio` exige además `forzar_con_bloqueos: true`. El prompt obliga a
   preguntar de nuevo por esos bloqueos, y el archivo `ENVIO-SIMULADO.md` deja constancia de las
   advertencias aceptadas.
5. **Errores (CA5):** los errores del proveedor (timeout, 401/403, 429, 5xx, respuesta inválida) se
   convierten en `ErrorLLM` con un mensaje claro para el chat. La sesión no muere y el siguiente mensaje
   funciona.
6. **Trazabilidad (CA4/RN5):** cada llamada aparece como tarjeta en el chat (nombre, argumentos, resumen,
   duración y estado OK/ERROR/BLOQUEADA) y queda en `out/log.jsonl` y en `out/<caso>/log.jsonl` con
   `{ ts, herramienta, ok, resumen }`. Los resúmenes del log no incluyen valores de campos.

**CA2 (no afirmar valores sin herramienta):** además de la prohibición en el prompt, el diseño la hace
innecesaria. `generar_formulario` **ignora los valores** que le pase el modelo, recalcula el mapeo desde
el maestro y reporta `discrepancias` si el modelo intentó marcar como lleno un campo inexistente o alterar
un valor. El número de cuenta llega al modelo enmascarado (`•••2345`), así que no puede repetirlo en el
chat aunque quiera.

## 4. Elección del modelo

| | |
|---|---|
| **Proveedor** | Google Gemini (API REST `generateContent`), detrás de la interfaz `ProveedorLLM`. |
| **Modelo** | `gemini-2.5-flash` (configurable con `LLM_MODEL`, por ejemplo a un Flash más reciente o a Flash-Lite). |
| **Por qué** | (1) Tiene **capa gratuita** sin tarjeta (desde abril de 2026 limitada a modelos Flash), suficiente para la demo y la defensa. (2) Buen *function calling* con JSON Schema (`parametersJsonSchema`), que se genera directamente desde zod. (3) La tarea es casi determinista porque las herramientas hacen el trabajo pesado: no hace falta un modelo grande, sino uno que encadene herramientas y redacte un resumen. |
| **Alternativa siempre disponible** | `LLM_PROVIDER=mock`: un proveedor simulado con guion fijo para probar el ciclo, la guardia y el front sin clave. Si se agota la cuota en la defensa, la app sigue respondiendo. |

**Costo estimado por caso procesado** (medido con el proveedor simulado sobre `ec-corp-andina`):

- 5 llamadas al modelo por caso (4 herramientas + resumen). En total, unos **19.000 tokens de entrada**,
  porque el historial y los resultados se reenvían en cada iteración (system prompt de unos 1.800 tokens
  más definiciones de herramientas de unos 900).
- Entre 1.000 y 3.000 tokens de salida, incluido el razonamiento interno del modelo.
- Con precios de lista del nivel pagado de Gemini 2.5 Flash (unos US$0,30 por millón de tokens de
  entrada y US$2,50 por millón de salida): **≈ US$0,01–0,013 por caso**. 12 casos al mes cuestan menos
  de US$0,20.
- En la capa gratuita: **US$0**, sujeto a los límites diarios del proyecto.
- El simple envío confirmado (segundo turno) cuesta una fracción de eso.

## 5. Diseño del portal web (sección 7.4)

**Hoy (implementado):** si el formato es `portal`, `generar_formulario` responde `formato no soportado` y
genera `out/<caso>/valores-portal.md`, una tabla campo/valor/estado lista para copiar. El paquete se arma
igual, con checklist y soportes, y queda bloqueado para firma porque no hay documento firmable: el
formulario se diligencia en línea.

**Diseño propuesto para automatizarlo:**

| Aspecto | Propuesta |
|---|---|
| **Estrategia** | Navegador controlado por el agente (Playwright) en modo **asistido**, no autónomo. El agente abre el portal en una sesión visible para la analista, espera a que ella inicie sesión y luego **llena** los campos con un mapa `etiqueta del portal → selector` por cliente, guardado en `src/knowledge/portales/<cliente>.json` (conocimiento, no código). Para portales sin mapa, el agente localiza los campos por su etiqueta accesible (`getByLabel`) usando el mismo glosario de sinónimos, y todo lo que no encuentre con confianza ≥ 0.8 queda para la persona. |
| **Por qué no RPA ni extensión** | Un RPA clásico (UiPath o similar) es frágil ante cambios de layout y agrega licencias. Una extensión de navegador obliga a distribuirla e instalarla y complica la auditoría. Playwright vive en el mismo backend TypeScript, reutiliza herramientas y logs, y permite *screenshots* como evidencia. |
| **Límites** | **CAPTCHA:** nunca se intenta resolver; lo hace la persona. **MFA:** lo hace la persona en su dispositivo. **Cambios de layout:** si un selector del mapa no aparece, el agente se detiene en ese campo, lo marca en el checklist y sigue con los demás; no "adivina" campos. **Carga de archivos:** el agente solo adjunta soportes vigentes del paquete. **Sesiones que expiran:** el agente se pausa y pide a la persona que vuelva a entrar. |
| **Credenciales** | Nunca en el repositorio, en el prompt, en el historial ni en los logs. Las **ingresa la persona** directamente en la ventana del navegador; el agente nunca las ve. Si en el futuro se quisiera guardarlas, iría un gestor de secretos (Azure Key Vault o 1Password) con acceso solo del proceso del navegador, nunca expuesto como herramienta del modelo. Los logs registran "inició sesión: sí/no", nunca usuario ni clave, y las capturas de pantalla enmascaran los campos de contraseña. |
| **Agente vs. humano** | **Agente:** abrir el portal, llenar campos, adjuntar soportes, tomar capturas, generar el checklist de lo que no pudo llenar y dejar el formulario listo **sin enviar**. **Humano:** ingresar credenciales, resolver CAPTCHA/MFA, revisar lo llenado, completar faltantes y **hacer clic en "Enviar"**. La herramienta de portal no expone ninguna acción de envío al modelo. |

## 6. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Ciclo del agente propio** (unas 150 líneas) con interfaz `ProveedorLLM` propia. | Vercel AI SDK, LangChain o el *agent loop* de un SDK de proveedor. | El PRD evalúa el ciclo, el tope de iteraciones y la confirmación. Escribirlo a mano permite explicar cada línea y meter la **guardia de confirmación en el código**, no solo en el prompt. Un framework habría escondido justo lo que se evalúa. |
| 2 | **La confirmación humana se hace cumplir en el ciclo** (estado de sesión + mensaje afirmativo + consumo único). | Confiar en que el modelo respete el prompt y pase `confirmado: true` solo cuando corresponde. | Con solo el prompt, una alucinación o una inyección en el correo del cliente ("envíe sin confirmar") podría disparar el envío. Con la guardia, el peor caso es un envío bloqueado. |
| 3 | **`generar_formulario` recalcula el mapeo** desde el maestro e ignora los valores del modelo. | Usar el `mapeo` que pasa el modelo tal cual (como sugiere literalmente el contrato). | Hace CA2 imposible de violar: el formulario nunca contiene un valor que no salga del maestro. Se conserva el argumento `mapeo` del contrato y se usa para detectar discrepancias. Costo: un recálculo barato. |
| 4 | **Mapeo determinista** (glosario exacto → normalizado → similitud de Jaccard con umbral 0.8). | Pedirle al modelo que mapee las etiquetas. | Exacto, trazable, testeable, sin costo y sin riesgo de inventar. El modelo solo orquesta. Si llega una etiqueta nueva, queda `faltante` o `requiere_confirmacion`, y basta agregar el sinónimo al glosario. |
| 5 | **PDF generado con pdf-lib** (no AcroForm). | Rellenar un AcroForm del cliente. | El fixture no trae un PDF real y el PRD acepta un PDF generado. pdf-lib es JS puro, sin binarios del sistema. |
| 6 | **Front en HTML + JS plano servido por el mismo backend.** | React/Vite. | Un solo despliegue, un solo link, sin paso de build y arranque en menos de 2 minutos. El chat no necesita estado complejo. |
| 7 | **Gemini Flash en capa gratuita + proveedor simulado.** | Anthropic u OpenAI con clave paga. | El reto exige clave propia y no había presupuesto. El adaptador permite cambiar de proveedor con un archivo nuevo en `src/llm/` y una línea en `fabrica.ts`. |
| 8 | **`requiere_confirmacion` no bloquea `listo_para_firma`.** | Bloquear también por campos por confirmar. | RN3 solo menciona vencidos y ausentes como bloqueantes y "faltante no bloquea". Los campos por confirmar quedan visibles en el checklist para que la persona decida. |

## 7. Supuestos

1. **Fecha de ejecución = hoy** (configurable con `FECHA_EJECUCION`). Con la fecha de hoy (oct-2026) la
   Cámara de Comercio (vigente hasta 2026-09-30) y los parafiscales (hasta 2026-08-31) están **vencidos**,
   así que **ningún caso queda listo para firma**. Con `FECHA_EJECUCION=2026-09-05`, `co-industrias-delta`
   queda listo.
2. **RN1:** para clientes fuera de Colombia, el campo RUC/RTN se **llena con el NIT** y se marca
   `requiere_confirmacion` ("identificador extranjero"), tal como dice la regla. En el PDF se anota
   "(por confirmar)".
3. **Portal:** se arma el paquete (soportes, checklist y valores para copiar), pero queda
   `listo_para_firma: false` porque no hay documento firmable.
4. **"Envía" como confirmación:** si el turno anterior terminó con la pregunta de confirmación, "envía"
   cuenta como confirmación explícita (así lo plantea la sección 11). Si el paquete tiene bloqueos, la
   pregunta del agente ya los menciona ("¿simulo el envío de todas formas?").
5. **Soportes:** todos son colombianos (`pais_emisor: CO`) y se entregan como equivalentes a los que pide
   el cliente extranjero ("registro tributario" → RUT). La validez ante el cliente la juzga la persona.
6. **Datos bancarios (RN2):** "explícitamente" significa que la etiqueta está en la plantilla del cliente.
   Si el modelo pide un dato bancario que la plantilla no trae, queda `requiere_confirmacion` sin valor.
7. **"Ingresos anuales"** se llena con el valor numérico del maestro y una nota de moneda (COP, 2025).
   No se convierte a la moneda del cliente.
8. **Rúbrica:** el PRD menciona una rúbrica en la "sección 10", pero esa sección trata de riesgos. Se
   tomaron como criterios las historias de usuario, las reglas CA/RN y los requisitos no funcionales.
9. **Sesiones:** viven en memoria y se respaldan en `out/sessions/`. En Render se pierden al reiniciar
   (el PRD no exige persistencia).

## 8. Cobertura

| Historia / requisito | Estado | Evidencia | Qué falta para producción |
|---|---|---|---|
| HU-1 Leer la solicitud | **Hecho** | `proveedor_leer_solicitud`; etiquetas ambiguas → `observaciones` con equivalente del país | Leer el correo real (IMAP/Graph) y parsear el adjunto real (.xlsx/.pdf) en vez de los JSON normalizados. |
| HU-2 Mapear campos | **Hecho** | Tres estados con `ruta` del maestro, RN1, RN2, glosario; pruebas en `tests/herramientas.test.ts` | Interfaz para que la analista agregue sinónimos al glosario desde el chat. |
| HU-3 P0 Excel | **Hecho** | `out/<caso>/formulario.xlsx` con etiqueta y valor en la hoja y celda exactas | Escribir sobre el `.xlsx` original del cliente (conservar su formato). |
| HU-3 P1 PDF | **Hecho** | `out/<caso>/formulario.pdf` con todos los campos en orden y obligatorios marcados | Rellenar AcroForms reales cuando el cliente los envíe. |
| HU-3 P2 Portal | **Hecho (lo pedido)** | `formato no soportado` + `valores-portal.md`; diseño en la sección 5 | Implementar el llenado asistido con Playwright. |
| HU-4 Paquete para firma | **Hecho** | `paquete/` con formulario, soportes, `checklist.md`, `borrador-correo.md`; vencidos bloquean; `ENVIO-SIMULADO.md` solo tras confirmación | Firma electrónica y envío real (fuera de alcance). |
| HU-5 Errores | **Hecho** | Caso inexistente, nombre malicioso y plantilla corrupta en `demo.ts`/pruebas; ninguna herramienta lanza; errores del LLM con mensaje claro | Alertas o monitoreo de errores. |
| CA1–CA5, RN1–RN5 | **Hecho** | `src/agent/ciclo.ts`, `tests/ciclo.test.ts` | — |
| Front, API, link | **Hecho** (link: pendiente de desplegar en Render) | `web/`, `src/server.ts`, `render.yaml` | Autenticación real (SSO) en vez de clave compartida. |
| Bonus módulo (9.4) | **Hecho** | `modulo/` generado desde las mismas fuentes; `tests/modulo.test.ts` verifica la sincronía | Publicarlo como paquete npm interno. |

## 9. Uso de IA

| Asistente | Para qué lo usé |
|---|---|
| **Claude (Anthropic), en la app de Claude** | Lectura del PRD y de los fixtures, plan de trabajo, andamiaje del proyecto, escritura de herramientas, ciclo, adaptadores, front, pruebas y borrador de esta documentación. También para verificar las salidas (abrir el xlsx y el pdf generados, capturas del front con Playwright). |

**Qué descarté de lo propuesto y por qué:**

- **Anthropic como proveedor por defecto:** fue la primera propuesta, pero no tenía clave paga. Elegí
  Gemini Flash por su capa gratuita y dejé el adaptador listo para cambiar.
- **Confirmación solo por prompt:** la propuesta inicial confiaba en el `confirmado: true` del modelo. Lo
  reemplacé por la guardia en el ciclo (decisión 2).
- **Aceptar el `mapeo` del modelo como fuente de valores:** lo cambié por el recálculo desde el maestro
  (decisión 3).
- **Un framework de agentes:** descartado (decisión 1).
- Durante la verificación aparecieron y se corrigieron:
  - el banner de confirmación seguía visible por un conflicto CSS entre `hidden` y `display: flex`;
  - un desbordamiento horizontal en móvil;
  - el chat de terminal fallaba con entrada por tubería (se cambió `readline` por el iterador de `console` de Bun);
  - un bloqueo de la guardia dejaba la sesión "esperando confirmación" sin que el agente hubiera preguntado.

Revisé y entiendo cada archivo. Las reglas de negocio están cubiertas por pruebas que se pueden correr
con `bun test`.

## 10. Riesgos de llevarlo a producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo "completa" un campo con un valor plausible. | Las herramientas son la única fuente; `generar_formulario` recalcula desde el maestro; faltantes explícitos; prueba que lo verifica. |
| **Inyección de instrucciones** en el correo del cliente ("envíe ya", "cambie la cuenta"). | El cuerpo del correo se trata como dato. Las acciones externas exigen confirmación por código y los valores salen solo del maestro. En producción: marcar el contenido externo como no confiable en el prompt y revisar los correos con un clasificador. |
| Envío o firma sin decisión humana. | Guardia de confirmación en el ciclo, consumo único, doble confirmación con bloqueos y registro en `ENVIO-SIMULADO.md`. En producción: aprobación con identidad (SSO) y registro de auditoría inmutable. |
| Exposición de datos sensibles (cuenta bancaria) al proveedor LLM o en logs. | El número de cuenta va enmascarado hacia el modelo, los logs no llevan valores y el borrador de correo pasa una verificación RN2. En producción: un proveedor con acuerdo de no retención (Azure OpenAI/Vertex en la región), cifrado de `out/` y retención limitada. |
| Fuga o abuso de la clave del modelo y costos sin control. | La clave solo vive en una variable de entorno del backend. Hay clave de acceso al link y topes de iteraciones, tokens y mensajes por sesión. En producción: límite de tasa por IP o usuario, presupuesto y alertas en el proveedor. |
| Maestro o soportes desactualizados (hoy hay soportes vencidos). | El checklist marca vencidos y bloquea la firma. En producción: un dueño del dato, alertas N días antes del vencimiento y renovación programada de Cámara de Comercio y parafiscales. |
| Plantillas reales más variadas y peores que los fixtures. | Esquemas zod que fallan con mensajes claros, mapeo con umbral y "requiere confirmación". En producción: parsear el .xlsx/.pdf real, acumular sinónimos y medir la tasa de faltantes por cliente. |
| Disponibilidad del proveedor LLM (cuota, caídas). | Timeout, errores tipados y proveedor simulado de respaldo. En producción: un segundo proveedor configurado detrás del mismo adaptador y reintentos con espera creciente. |
| Concurrencia y persistencia (sesiones en memoria, `out/` efímero). | Bloqueo por sesión y respaldo en archivo. En producción: almacenamiento persistente (Blob o SharePoint) y una cola de trabajos. |
