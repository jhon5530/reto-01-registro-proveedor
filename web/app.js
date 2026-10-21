// Front de chat en JS plano. Nunca maneja la clave del modelo: solo habla con /api del backend.
"use strict"

const $ = (id) => document.getElementById(id)
const PROMPT_DEMO = 'Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles faltan, si el paquete está listo para firma y qué soportes debo actualizar. No envíes nada todavía.'

// ---------- Almacenamiento local (solo conveniencias: id de sesión y clave de acceso) ----------
const local = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* modo privado */ } },
  del: (k) => { try { localStorage.removeItem(k) } catch { /* modo privado */ } },
}

const estado = {
  sessionId: local.get("rp.sessionId") || nuevoId(),
  clave: local.get("rp.clave") || "",
  ocupado: false,
  ultimoCaso: null,
}
local.set("rp.sessionId", estado.sessionId)

function nuevoId() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, "")
}

// ---------- API ----------
async function api(ruta, opciones = {}) {
  const res = await fetch(ruta, {
    ...opciones,
    headers: { "content-type": "application/json", "x-access-key": estado.clave, ...(opciones.headers || {}) },
  })
  if (res.status === 401) {
    pedirClave()
    throw new Error("Se requiere la clave de acceso.")
  }
  const datos = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(datos.error || `Error HTTP ${res.status}`)
  return datos
}

// ---------- Markdown mínimo y seguro (se escapa todo antes de formatear) ----------
function escapar(t) {
  return String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}
function enLinea(t) {
  return t
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
}
function markdown(texto) {
  const lineas = escapar(texto).split("\n")
  let html = ""
  let enLista = false
  for (const l of lineas) {
    const item = /^\s*[-*]\s+(.*)$/.exec(l)
    if (item) {
      if (!enLista) { html += "<ul>"; enLista = true }
      html += `<li>${enLinea(item[1])}</li>`
      continue
    }
    if (enLista) { html += "</ul>"; enLista = false }
    const titulo = /^#{1,4}\s+(.*)$/.exec(l)
    if (titulo) html += `<p><strong>${enLinea(titulo[1])}</strong></p>`
    else if (l.trim()) html += `<p>${enLinea(l)}</p>`
  }
  return html + (enLista ? "</ul>" : "")
}

// ---------- Render ----------
function limpiarBienvenida() {
  document.querySelector(".bienvenida")?.remove()
}
function bajar() {
  const m = $("mensajes")
  m.scrollTop = m.scrollHeight
}

function pintarUsuario(texto) {
  limpiarBienvenida()
  const div = document.createElement("div")
  div.className = "msg usuario"
  div.textContent = texto
  $("mensajes").appendChild(div)
  bajar()
}

function tarjetaHerramienta(t) {
  const d = document.createElement("details")
  d.className = "herramienta"
  const clase = t.bloqueada ? "bloq" : t.ok ? "ok" : "err"
  const etiqueta = t.bloqueada ? "BLOQUEADA" : t.ok ? "OK" : "ERROR"
  d.innerHTML = `
    <summary>
      <span class="estado ${clase}">${etiqueta}</span>
      <span class="nombre">🔧 ${escapar(t.nombre)}</span>
      <span class="resumen">${escapar(t.resumen)}</span>
    </summary>
    <pre>argumentos: ${escapar(JSON.stringify(t.argumentos, null, 2))}\n\nresultado: ${escapar(t.resumen)}\nduración: ${t.duracionMs} ms</pre>`
  return d
}

function pintarAsistente(r) {
  limpiarBienvenida()
  const div = document.createElement("div")
  div.className = "msg asistente" + (r.needsConfirmation ? " confirmacion" : "") + (r.error ? " error" : "")
  if (r.toolCalls && r.toolCalls.length) {
    const cont = document.createElement("div")
    cont.className = "herramientas"
    r.toolCalls.forEach((t) => cont.appendChild(tarjetaHerramienta(t)))
    div.appendChild(cont)
  }
  const cuerpo = document.createElement("div")
  cuerpo.innerHTML = markdown(r.reply || r.texto || "")
  div.appendChild(cuerpo)
  if (r.needsConfirmation) {
    const marca = document.createElement("span")
    marca.className = "etiqueta-confirmacion"
    marca.textContent = "⚠️ Requiere tu confirmación"
    div.appendChild(marca)
  }
  $("mensajes").appendChild(div)
  bajar()
}

function pintarError(texto) {
  pintarAsistente({ reply: `⚠️ ${texto}`, error: true, toolCalls: [] })
}

function mostrarPensando(si) {
  document.querySelector(".pensando")?.remove()
  if (!si) return
  const div = document.createElement("div")
  div.className = "pensando"
  div.textContent = "El agente está pensando"
  $("mensajes").appendChild(div)
  bajar()
}

function mostrarBanner(si) {
  $("banner-confirmacion").hidden = !si
}

function casoDe(toolCalls) {
  for (const t of [...(toolCalls || [])].reverse()) {
    if (t.argumentos && typeof t.argumentos.caso === "string") return t.argumentos.caso
  }
  return null
}

async function refrescarArchivos(caso) {
  if (!caso) return
  estado.ultimoCaso = caso
  try {
    const { archivos } = await api(`/api/archivos/${encodeURIComponent(caso)}`)
    const cont = $("archivos")
    if (!archivos.length) { cont.textContent = "Sin archivos aún."; return }
    cont.innerHTML = `<div class="sutil"><code>out/${escapar(caso)}/</code></div>` + archivos
      .map((a) => `<a href="/api/archivos/${encodeURIComponent(caso)}/${a.split("/").map(encodeURIComponent).join("/")}?key=${encodeURIComponent(estado.clave)}" target="_blank" rel="noopener">${escapar(a)}</a>`)
      .join("")
  } catch { /* no crítico */ }
}

// ---------- Acciones ----------
async function enviar(texto) {
  if (estado.ocupado || !texto.trim()) return
  estado.ocupado = true
  $("enviar").disabled = true
  mostrarBanner(false)
  pintarUsuario(texto)
  mostrarPensando(true)
  try {
    const r = await api("/api/chat", { method: "POST", body: JSON.stringify({ sessionId: estado.sessionId, message: texto }) })
    mostrarPensando(false)
    pintarAsistente(r)
    mostrarBanner(r.needsConfirmation)
    refrescarArchivos(casoDe(r.toolCalls) || estado.ultimoCaso)
  } catch (e) {
    mostrarPensando(false)
    pintarError(e.message || "No se pudo contactar al servidor.")
  } finally {
    estado.ocupado = false
    $("enviar").disabled = false
    $("texto").focus()
  }
}

async function cargarHistorial() {
  try {
    const s = await api(`/api/sessions/${estado.sessionId}`)
    for (const h of s.historial) {
      if (h.rol === "usuario") pintarUsuario(h.texto)
      else pintarAsistente({ reply: h.texto, toolCalls: h.toolCalls, needsConfirmation: h.needsConfirmation, error: h.error })
    }
    mostrarBanner(s.esperandoConfirmacion)
    const ultimo = [...s.historial].reverse().find((h) => h.toolCalls && casoDe(h.toolCalls))
    if (ultimo) refrescarArchivos(casoDe(ultimo.toolCalls))
  } catch { /* sesión nueva */ }
}

async function cargarCasos() {
  try {
    const { casos } = await api("/api/casos")
    $("casos").innerHTML = ""
    for (const c of casos) {
      const b = document.createElement("button")
      b.type = "button"
      b.className = "chip"
      b.textContent = c
      b.onclick = () => { $("texto").value = `Procesa el caso "${c}"`; $("texto").focus() }
      $("casos").appendChild(b)
    }
  } catch { /* requiere clave */ }
}

async function cargarSalud() {
  try {
    const s = await (await fetch("/api/health")).json()
    $("estado-modelo").textContent = `Proveedor: ${s.provider} · Modelo: ${s.model}${s.provider === "mock" ? " (simulado, sin costo)" : ""}`
    return s
  } catch {
    $("estado-modelo").textContent = "Servidor no disponible"
    return null
  }
}

function pedirClave() {
  if (!$("dialogo-clave").open) $("dialogo-clave").showModal()
}

async function iniciar() {
  const salud = await cargarSalud()
  if (salud && salud.protegido && !estado.clave) { pedirClave(); return }
  await cargarCasos()
  await cargarHistorial()
}

$("form-clave").addEventListener("submit", () => {
  estado.clave = $("input-clave").value.trim()
  local.set("rp.clave", estado.clave)
  iniciar()
})
$("formulario").addEventListener("submit", (e) => {
  e.preventDefault()
  const t = $("texto").value
  $("texto").value = ""
  enviar(t)
})
$("texto").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("formulario").requestSubmit() }
})
$("prompt-demo").addEventListener("click", () => { $("texto").value = PROMPT_DEMO; $("texto").focus() })
$("confirmar").addEventListener("click", () => enviar("Sí, confirmo"))
$("cancelar").addEventListener("click", () => enviar("No, cancela. No envíes nada."))
$("nueva-sesion").addEventListener("click", () => {
  estado.sessionId = nuevoId()
  local.set("rp.sessionId", estado.sessionId)
  $("mensajes").innerHTML = '<div class="bienvenida"><h2>Nueva sesión</h2><p>Indica un caso para comenzar.</p></div>'
  $("archivos").textContent = "Procesa un caso para ver sus archivos."
  mostrarBanner(false)
})

iniciar()
