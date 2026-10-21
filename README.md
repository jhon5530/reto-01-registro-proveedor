# Agente "Registro como Proveedor" — Reto 01

Agente conversacional que automatiza el llenado de formularios de registro como proveedor:
lee la solicitud del cliente, mapea cada campo al repositorio maestro, genera el formulario en el
formato pedido (Excel / PDF / valores para portal), arma el paquete para firma y **solo simula el
envío tras confirmación explícita** del usuario.

- **Link de prueba:** `https://<tu-servicio>.onrender.com` ← *completar tras el despliegue*
- **Clave de acceso al link:** `<APP_ACCESS_KEY>` ← *la que configures en Render*
- Planteamiento de la solución: [`SOLUCION.md`](SOLUCION.md)

## Requisitos

- [Bun](https://bun.sh) ≥ 1.1 (`curl -fsSL https://bun.sh/install | bash`)
- Opcional: una API key gratuita de Google AI Studio (Gemini). **Sin clave, la app arranca en modo simulado.**

## Arranque en local (un comando)

```bash
bun install && bun run dev
# → http://localhost:3000
```

Para usar el modelo real, crea un archivo `.env` (no se versiona) a partir de `.env.example`:

```bash
cp .env.example .env    # y completa GEMINI_API_KEY
bun run dev
```

## Verificación sin modelo

```bash
bun install && bun run demo.ts   # ejecuta las 5 herramientas sobre todos los casos, sin clave
bun test                          # 34 pruebas: reglas de negocio, ciclo, adaptador, módulo
bun run chat                      # chat en la terminal (mismo ciclo que la API)
LLM_PROVIDER=mock bun run chat    # chat en la terminal sin clave ni costo
```

`demo.ts` limpia `out/` al inicio y es determinista para una misma fecha. Las vigencias de los
soportes se evalúan contra la fecha de hoy; para fijarla: `FECHA_EJECUCION=2026-09-05 bun run demo.ts`.

## Variables de entorno

| Variable | Obligatoria | Por defecto | Descripción |
|---|---|---|---|
| `LLM_PROVIDER` | No | `gemini` si hay clave, si no `mock` | `gemini` o `mock` (simulado, sin costo). |
| `LLM_MODEL` | No | `gemini-3.8-flash` | Modelo del proveedor. |
| `GEMINI_API_KEY` | Para `gemini` | — | Clave del modelo. **Solo en el entorno del backend.** |
| `LLM_TIMEOUT_MS` | No | `60000` | Timeout por llamada al modelo. |
| `MAX_ITERACIONES` | No | `25` | Tope de iteraciones herramienta→modelo por turno. |
| `MAX_TOKENS_SESION` | No | `200000` | Tope de tokens por sesión. |
| `MAX_TURNOS_SESION` | No | `40` | Tope de mensajes por sesión. |
| `APP_ACCESS_KEY` | No | vacío | Si se define, la API exige esta clave (header `x-access-key`). |
| `FECHA_EJECUCION` | No | hoy | Fecha (YYYY-MM-DD) para evaluar vencimientos. |
| `PORT` | No | `3000` | Puerto HTTP. |

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, error, tokensSesion }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión (mensajes y llamadas a herramientas). |
| `GET` | `/api/health` | `{ ok, provider, model, protegido }` — nunca expone claves. |
| `GET` | `/api/casos` | Casos disponibles en `fixtures/reto-01/casos/`. |
| `GET` | `/api/archivos/:caso[/ruta]` | Lista / descarga los archivos generados en `out/<caso>/`. |

Si `APP_ACCESS_KEY` está definida, todas las rutas salvo `/api/health` exigen el header
`x-access-key` (o `?key=` para descargas desde el navegador).

## Despliegue en Render (gratis)

1. Sube este repositorio a GitHub.
2. En [render.com](https://render.com) → **New → Blueprint** → elige el repositorio (usa `render.yaml`).
3. Cuando lo pida, ingresa `GEMINI_API_KEY` y `APP_ACCESS_KEY` en el panel (nunca en el repo).
4. Copia la URL pública en la parte superior de este README.

> El plan gratuito se suspende tras ~15 min sin tráfico y tarda ~1 min en despertar: abre el link
> unos minutos antes de la defensa. `out/` es efímero en Render (no se exige persistencia).

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/                  conocimiento: registro-proveedor.md + reglas.json (reglas de negocio)
src/tools/proveedor.ts          ejecución: las 5 herramientas (zod, nunca lanzan)
src/tools/lib/                  mapeo, formularios xlsx/pdf/portal, paquete, log, fixtures
src/agent/                      ciclo del agente, confirmación humana, sesiones, carga del prompt
src/llm/                        adapter.ts (interfaz) + gemini.ts + mock.ts
src/server.ts · src/cli.ts      API HTTP + front estático · chat en terminal
web/                            front de chat (HTML + JS plano)
modulo/                         bonus: agente empaquetado (generado con bun run build:modulo)
demo.ts · tests/                verificación sin modelo · pruebas
```
