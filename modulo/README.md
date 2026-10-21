# Módulo reutilizable: agente "Registro como Proveedor"

Empaqueta el agente para integrarlo en otras plataformas de agentes, sin depender del servidor HTTP.

| Pieza | Qué es | Fuente única |
|---|---|---|
| `agent.md` | Definición del agente: frontmatter (`description`, `mode: primary`, `permission: {edit: deny, bash: deny}`) + system prompt. | `agent/prompt.md` |
| `tools/proveedor.ts` | Las 5 herramientas tipadas con zod. Re-exporta el código de la app, no lo copia. | `src/tools/proveedor.ts` |
| `skill/registro-proveedor/SKILL.md` | Conocimiento del proceso (frontmatter `name`, `description`). | `src/knowledge/` |

`agent.md` y `SKILL.md` se regeneran con `bun run build:modulo`. La prueba `tests/modulo.test.ts`
falla si alguna pieza diverge de lo que usa la aplicación.

Uso de las herramientas desde otra plataforma:

```ts
import { leer_solicitud } from "./modulo/tools/proveedor.ts"
const r = JSON.parse(await leer_solicitud.execute({ caso: "ec-corp-andina" }, { directory: "/ruta/al/proyecto", sessionId: "x" }))
```

El nombre que ve el modelo es `proveedor_<export>` (por ejemplo `proveedor_leer_solicitud`).
