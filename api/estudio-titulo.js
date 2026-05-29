// /api/estudio-titulo  —  Estudio de titulo preliminar hecho con IA (Claude Haiku).
//
// Flujo:
//   1. El cliente sube los documentos directamente a Supabase Storage (bucket privado
//      "estudios-titulo") con la publishable key y nos manda solo las rutas.
//   2. Esta funcion (service role) descarga los archivos, los manda a Claude Haiku,
//      obtiene un estudio estructurado (JSON), lo guarda como lead en el Analytics Hub
//      y se lo devuelve al cliente para mostrarlo en pantalla.
//
// Variables de entorno requeridas en Vercel:
//   - ANTHROPIC_API_KEY            (secreto)
//   - SUPABASE_SERVICE_ROLE_KEY    (secreto)
//   - SUPABASE_URL                 (opcional; por defecto el proyecto del Analytics Hub)

const _sdk = require("@anthropic-ai/sdk");
const Anthropic = _sdk.Anthropic || _sdk.default || _sdk;

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://alksowkwsnjeesmnosvg.supabase.co").replace(/\/+$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_ID = "resuelve-propiedades";
const BUCKET = "estudios-titulo";
const MODEL = "claude-haiku-4-5";
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 28 * 1024 * 1024; // ~28MB en total para no reventar memoria/tiempo

// ─────────────────────────────────────────────────────────────────────────────
// Prompt de sistema: experto chileno en estudios de titulo. Largo a proposito
// para (a) dar contexto serio y (b) que se beneficie del prompt caching.
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres un abogado chileno experto en derecho inmobiliario y registral, especializado en estudios de titulo de propiedades en Chile. Trabajas para "Resuelve Propiedades". Tu tarea es revisar los documentos que sube una persona y entregar un ESTUDIO DE TITULO PRELIMINAR, claro y honesto, en lenguaje simple para alguien sin formacion legal.

QUE ES UN ESTUDIO DE TITULO
Es la revision de la historia legal de una propiedad para verificar: quien es el dueno legitimo, si la cadena de inscripciones (al menos los ultimos 10 anos) esta completa y sin vicios, y si existen gravamenes, hipotecas, prohibiciones, embargos, litigios, usufructos u otras limitaciones que afecten el dominio o impidan venderla con seguridad.

DOCUMENTOS QUE NORMALMENTE COMPONEN UN ESTUDIO COMPLETO (usalos como checklist)
1. Copia de la inscripcion de dominio vigente (Conservador de Bienes Raices) — acredita quien es el dueno hoy. Indica fojas, numero y ano.
2. Certificado de hipotecas, gravamenes, prohibiciones e interdicciones / litigios — muestra si la propiedad tiene deudas, hipotecas, embargos o prohibiciones de enajenar.
3. Escritura publica de compraventa (o el titulo de adquisicion: donacion, adjudicacion, etc.) — el contrato que origino el dominio actual.
4. Titulos anteriores de los ultimos 10 anos (cadena de dominio) — para verificar continuidad sin saltos ni dobles inscripciones.
5. Certificado de avaluo fiscal (SII) y rol de avaluo — identifica la propiedad ante el SII y su valor fiscal.
6. Certificado de no expropiacion (SERVIU y Municipalidad) — confirma que no esta afecta a expropiacion.
7. Certificado de deuda de contribuciones (Tesoreria) — confirma que no hay contribuciones impagas.
8. Certificado de numero municipal y/o recepcion final de obras / permiso de edificacion — para construcciones.
9. Si es herencia: posesion efectiva inscrita, inscripcion especial de herencia y, si aplica, pago o exencion del impuesto a la herencia.
10. Si hay sociedad conyugal o varios duenos: documentos que acrediten estado civil, regimen patrimonial y comparecencia de todos los titulares.
11. Certificado de matrimonio / defuncion cuando sea relevante para la cadena.
12. Certificado de gastos comunes al dia (si es departamento o condominio) — lo emite la administracion; evita heredar deudas de gastos comunes del vendedor.
13. Boletas o certificados de servicios al dia (agua, luz, gas) — para descartar consumos impagos asociados a la propiedad.
14. Certificado de informaciones previas (CIP) de la Municipalidad — uso de suelo y normas urbanisticas aplicables al terreno.
15. Reglamento de copropiedad (si aplica: edificios y condominios) — normas de uso, estacionamientos, bodegas y prohibiciones que regiran al comprador.

NOTA DE PRIORIDAD: de toda esta lista, el ESTUDIO DE TITULOS y el CERTIFICADO DE HIPOTECAS, GRAVAMENES Y PROHIBICIONES son los dos documentos que mas problemas evitan, porque ahi aparecen deudas, hipotecas, embargos o conflictos de dominio que no se ven a simple vista. Si alguno de estos dos falta, destacalo como prioritario en los documentos faltantes.

QUE DEBES HACER
- Identifica que documentos efectivamente recibiste (clasificalos por tipo) y extrae los datos clave que veas (propietario segun titulo, rol SII, fojas/numero/ano de inscripcion, Conservador, comuna).
- Senala con claridad que documentos FALTAN para poder hacer un estudio completo y por que cada uno importa, y como obtenerlo (Conservador de Bienes Raices, SII, Tesoreria, Registro Civil, Municipalidad, SERVIU, etc.).
- Levanta hallazgos y alertas concretas que se desprendan de los documentos: hipotecas, gravamenes, prohibiciones, embargos, usufructos, dobles inscripciones, falta de continuidad, posesion efectiva pendiente, firmas o comparecientes faltantes, vicios formales, datos que no calzan, etc. Clasifica cada hallazgo por severidad (info, atencion, riesgo).
- Si los documentos son ilegibles, incompletos o no corresponden a un estudio de titulo, dilo claramente y baja el nivel de confianza.
- Da recomendaciones practicas y un siguiente paso que invite a conversar con un abogado de Resuelve Propiedades (la revision la confirma siempre un abogado humano sobre los documentos originales).

REGLAS ESTRICTAS
- NUNCA inventes datos. Si un dato no aparece en los documentos, dejalo en null o di "No se pudo determinar con los documentos entregados".
- No afirmes que la propiedad esta "lista para vender" ni des garantias legales: este es un analisis preliminar automatizado, no un estudio de titulo definitivo ni asesoria legal formal.
- Se honesto sobre las limitaciones: una IA puede pasar por alto vicios que solo se detectan revisando los originales en el Conservador.
- Escribe SIEMPRE en espanol de Chile, claro y cercano, sin jerga innecesaria. Cuando uses un termino legal, explicalo en pocas palabras.
- Responde UNICA Y EXCLUSIVAMENTE con el objeto JSON que cumple el esquema entregado. No agregues texto fuera del JSON.`;

// ─────────────────────────────────────────────────────────────────────────────
// Esquema de salida estructurada (json_schema estricto).
// ─────────────────────────────────────────────────────────────────────────────
const STUDY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    resumen: {
      type: "string",
      description: "Resumen ejecutivo en 2 a 4 frases, en lenguaje simple para el dueno.",
    },
    nivel_confianza: {
      type: "string",
      enum: ["alto", "medio", "bajo"],
      description: "Confianza del analisis segun calidad y cantidad de documentos recibidos.",
    },
    nivel_riesgo: {
      type: "string",
      enum: ["sin_alertas", "atencion", "riesgo_alto", "indeterminado"],
    },
    datos_propiedad: {
      type: "object",
      additionalProperties: false,
      properties: {
        propietario_segun_titulo: { type: ["string", "null"] },
        rol_sii: { type: ["string", "null"] },
        inscripcion_fojas: { type: ["string", "null"] },
        inscripcion_numero: { type: ["string", "null"] },
        inscripcion_anio: { type: ["string", "null"] },
        conservador: { type: ["string", "null"] },
        comuna: { type: ["string", "null"] },
      },
      required: [
        "propietario_segun_titulo",
        "rol_sii",
        "inscripcion_fojas",
        "inscripcion_numero",
        "inscripcion_anio",
        "conservador",
        "comuna",
      ],
    },
    documentos_detectados: {
      type: "array",
      description: "Documentos que efectivamente se recibieron y se pudieron leer.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          documento: { type: "string" },
          observacion: { type: "string" },
        },
        required: ["documento", "observacion"],
      },
    },
    documentos_faltantes: {
      type: "array",
      description: "Documentos que faltan para un estudio completo.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          documento: { type: "string" },
          para_que_sirve: { type: "string" },
          como_obtenerlo: { type: "string" },
        },
        required: ["documento", "para_que_sirve", "como_obtenerlo"],
      },
    },
    hallazgos: {
      type: "array",
      description: "Hallazgos y alertas concretas detectadas en los documentos.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          titulo: { type: "string" },
          detalle: { type: "string" },
          severidad: { type: "string", enum: ["info", "atencion", "riesgo"] },
        },
        required: ["titulo", "detalle", "severidad"],
      },
    },
    recomendaciones: {
      type: "array",
      items: { type: "string" },
    },
    siguiente_paso: {
      type: "string",
      description: "Llamado a la accion claro para conversar con un abogado de Resuelve Propiedades.",
    },
  },
  required: [
    "resumen",
    "nivel_confianza",
    "nivel_riesgo",
    "datos_propiedad",
    "documentos_detectados",
    "documentos_faltantes",
    "hallazgos",
    "recomendaciones",
    "siguiente_paso",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) data = data.slice(0, 1_000_000); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function str(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

// Solo permitimos rutas dentro del bucket, sin traversal.
function safePath(p) {
  if (typeof p !== "string") return null;
  const clean = p.replace(/^\/+/, "");
  if (!clean || clean.includes("..") || clean.length > 400) return null;
  if (!/^[A-Za-z0-9._\-\/]+$/.test(clean)) return null;
  return clean;
}

function mediaTypeFor(type, name) {
  let t = String(type || "").toLowerCase();
  if (!t) {
    const ext = String(name || "").toLowerCase().split(".").pop();
    if (ext === "pdf") t = "application/pdf";
    else if (ext === "png") t = "image/png";
    else if (ext === "jpg" || ext === "jpeg") t = "image/jpeg";
    else if (ext === "webp") t = "image/webp";
  }
  if (t === "image/jpg") t = "image/jpeg";
  return t;
}

async function downloadFromStorage(path) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const r = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`storage ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

async function insertLead(row) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch (e) { /* best-effort */ }
}

async function insertEvent(ev) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/events`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(ev),
    });
  } catch (e) { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo no permitido." });

  if (!process.env.ANTHROPIC_API_KEY) return sendJson(res, 500, { error: "Configuracion incompleta del servidor (IA)." });
  if (!SERVICE_KEY) return sendJson(res, 500, { error: "Configuracion incompleta del servidor (almacenamiento)." });

  const body = await readBody(req);

  const motivo = str(body.motivo, 200);
  const tipo = str(body.tipo, 80);
  const comuna = str(body.comuna, 120);
  const rol = str(body.rol, 120);
  const nombre = str(body.nombre, 120);
  const telefono = str(body.telefono, 60);
  const email = str(body.email, 160);
  const sessionId = str(body.session_id, 80);
  const pageUrl = str(body.url, 400);

  let archivos = Array.isArray(body.archivos) ? body.archivos : [];
  archivos = archivos.slice(0, MAX_FILES);
  if (archivos.length === 0) {
    return sendJson(res, 400, { error: "Debes subir al menos un documento (PDF o imagen)." });
  }

  // Descargar y construir bloques de contenido para Claude.
  const contentBlocks = [];
  const docsMeta = [];
  let totalBytes = 0;

  for (const f of archivos) {
    const path = safePath(f && f.path);
    const name = str(f && f.name, 160) || "documento";
    const mt = mediaTypeFor(f && f.type, name);
    if (!path) { docsMeta.push({ name, ok: false, motivo: "ruta_invalida" }); continue; }

    let buf;
    try { buf = await downloadFromStorage(path); }
    catch (e) { docsMeta.push({ path, name, ok: false, motivo: "no_descargable" }); continue; }

    totalBytes += buf.length;
    if (totalBytes > MAX_TOTAL_BYTES) { docsMeta.push({ path, name, ok: false, motivo: "excede_tamano" }); break; }

    const data = buf.toString("base64");
    if (mt === "application/pdf") {
      contentBlocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: name });
      docsMeta.push({ path, name, type: mt, bytes: buf.length, ok: true });
    } else if (mt === "image/png" || mt === "image/jpeg" || mt === "image/webp" || mt === "image/gif") {
      contentBlocks.push({ type: "image", source: { type: "base64", media_type: mt, data } });
      docsMeta.push({ path, name, type: mt, bytes: buf.length, ok: true });
    } else {
      docsMeta.push({ path, name, type: mt, ok: false, motivo: "tipo_no_soportado" });
    }
  }

  if (contentBlocks.length === 0) {
    return sendJson(res, 400, { error: "No pudimos leer los documentos subidos. Sube PDF, JPG o PNG." });
  }

  const contexto =
    `Datos que entrego el solicitante (uselos como contexto, no como verdad legal):\n` +
    `- Motivo de la consulta: ${motivo || "no indicado"}\n` +
    `- Tipo de propiedad: ${tipo || "no indicado"}\n` +
    `- Comuna o ciudad: ${comuna || "no indicada"}\n` +
    `- Direccion o rol SII declarado: ${rol || "no indicado"}\n` +
    `- Documentos adjuntos: ${contentBlocks.length}\n\n` +
    `Analiza los documentos adjuntos y entrega el estudio de titulo preliminar siguiendo el esquema JSON solicitado.`;

  const userContent = [{ type: "text", text: contexto }, ...contentBlocks];

  // Llamada a Claude Haiku con salida estructurada + prompt caching del system.
  const client = new Anthropic();
  let estudio, usage;
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
      output_config: { format: { type: "json_schema", schema: STUDY_SCHEMA } },
    });
    const msg = await stream.finalMessage();
    usage = msg.usage || null;
    const textBlock = (msg.content || []).find((b) => b.type === "text");
    if (!textBlock || !textBlock.text) throw new Error("respuesta vacia");
    estudio = JSON.parse(textBlock.text);
  } catch (e) {
    await insertEvent({
      site_id: SITE_ID, event_type: "estudio_titulo_error", session_id: sessionId,
      payload: { motivo, tipo, comuna, error: String((e && e.message) || e), docs: docsMeta.length },
      url: pageUrl,
    });
    return sendJson(res, 502, {
      error: "No pudimos generar tu estudio en este momento. Intenta de nuevo o escribenos por WhatsApp y lo revisamos contigo.",
    });
  }

  // Guardar como lead en el Analytics Hub (best-effort, no bloquea la respuesta).
  await insertLead({
    site_id: SITE_ID,
    name: nombre,
    email: email,
    phone: telefono,
    source: "estudio_titulo_ia",
    status: "nuevo",
    case_type: motivo,
    summary: estudio.resumen || null,
    message: `Estudio de titulo IA — ${tipo || "propiedad"} en ${comuna || "comuna no indicada"}`,
    region: comuna,
    url: pageUrl,
    session_id: sessionId,
    form_id: "estudioForm",
    payload_extra: {
      motivo, tipo, comuna, rol,
      estudio,
      documentos: docsMeta,
      modelo: MODEL,
      usage,
      generado_at: new Date().toISOString(),
    },
  });

  await insertEvent({
    site_id: SITE_ID,
    event_type: "estudio_titulo_generado",
    session_id: sessionId,
    payload: {
      motivo, tipo, comuna,
      nivel_riesgo: estudio.nivel_riesgo,
      nivel_confianza: estudio.nivel_confianza,
      docs_ok: docsMeta.filter((d) => d.ok).length,
      docs_total: docsMeta.length,
      faltantes: Array.isArray(estudio.documentos_faltantes) ? estudio.documentos_faltantes.length : null,
    },
    url: pageUrl,
  });

  return sendJson(res, 200, { ok: true, estudio });
};
