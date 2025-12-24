/* ===============================
   AUTH (Firebase - Google)
   - Requiere firebase.js + config.js (FIREBASE_CONFIG, ALLOWED_EMAILS)
================================ */


import { auth, db } from "./firebase.js";


let CURRENT_USER_EMAIL = null;
let __APP_STARTED = false;

function showAccessOverlay(show, msg = "") {
  const overlay = document.getElementById("accessOverlay");
  const err = document.getElementById("accessError");
  const info = document.getElementById("accessUserInfo");
  if (!overlay) return;

  overlay.style.display = show ? "flex" : "none";
  if (err) err.style.display = msg ? "block" : "none";
  if (err) err.textContent = msg || "";
  if (info) {
    info.style.display = CURRENT_USER_EMAIL ? "block" : "none";
    info.textContent = CURRENT_USER_EMAIL ? `Conectado como: ${CURRENT_USER_EMAIL}` : "";
  }
}

async function startIfReady() {
  if (__APP_STARTED) return;
  __APP_STARTED = true;

  // Carga inicial desde Firestore
  try {
    setText("estadoHistorico", "Cargando datos de la nube...");
    await loadRegistrosFromCloud();
    refrescarFiltros();
    renderHistorico();
    setText("estadoHistorico", "Listo ✅");
  } catch (e) {
    console.error(e);
    setText("estadoHistorico", "⚠️ Error cargando datos de Firebase. Revisá consola.");
  }
}

function bindFirebaseAuth() {
  const btnGoogle = document.getElementById("btnGoogleLogin");
  btnGoogle?.addEventListener("click", async () => {
    try {
      await window.FB.login();
    } catch (e) {
      console.error(e);
      showAccessOverlay(true, "No se pudo iniciar sesión con Google.");
    }
  });

  // Cerrar sesión (si existe el botón)
  document.getElementById("btnLogout")?.addEventListener("click", async () => {
    if (!confirm("¿Cerrar sesión y salir de la aplicación?")) return;
    try {
      await window.FB.logout();
    } catch (e) {
      console.error(e);
    } finally {
      location.reload();
    }
  });

  window.FB.onUser(async (user) => {
    if (!user) {
      CURRENT_USER_EMAIL = null;
      showAccessOverlay(true, "");
      return;
    }

    CURRENT_USER_EMAIL = user.email || null;

    if (!CURRENT_USER_EMAIL || !window.FB.emailAllowed(CURRENT_USER_EMAIL)) {
      showAccessOverlay(true, "No tenés permiso para ingresar con este correo.");
      try { await window.FB.logout(); } catch {}
      return;
    }

    showAccessOverlay(false, "");
    await startIfReady();
  });
}

function waitForFirebase() {
  if (window.FB) return bindFirebaseAuth();
  window.addEventListener("fb-ready", () => bindFirebaseAuth(), { once: true });

  // Si no carga firebase.js, mostramos mensaje
  setTimeout(() => {
    if (!window.FB) showAccessOverlay(true, "⚠️ No cargó Firebase. Revisá que firebase.js esté incluido.");
  }, 1200);
}

waitForFirebase();

// =====================
// CONFIG (resto de tu app)
// =====================

console.log("APP JS (Firebase)");

// Password de borrado ya no se usa como seguridad real.
// Si querés, lo sacamos después.
const DELETE_PASSWORD = "1234";

// Helper $
const $ = (id) => document.getElementById(id);

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizarDni(v) {
  return String(v || "").replace(/\D/g, "");
}

function askDeletePassword(accion) {
  const p = prompt(`Para ${accion}, ingresá la contraseña:`);
  return p === DELETE_PASSWORD;
}

/* ===============================
   DOTACIÓN (Excel + IndexedDB cache)
   - Carga Dotacion.xlsx (solo en tu PC) para autocompletar por DNI
   - Guarda cache local en IndexedDB (por PC/navegador)
================================ */

const DOT_DB_NAME = "art_app_db";
const DOT_STORE = "dotacion";
const DOT_DB_VERSION = 3; // 👈 SUBIMOS versión (antes era 1 o 2)

const DOT_CACHE_KEY = "dotacion_cache_v1";

let indexPorDni = new Map(); // dni -> row excel

// Mapeo EXACTO Dotacion.xlsx -> inputs del formulario
// Ajustalo si tu Excel tiene nombres de columnas distintos
const MAPEO_DOTACION_A_FORM = {
  "DNI": "dni",
  "CUIL": "cuil",
  "Legajo": "legajo",
  "Apellido y Nombre": "nombre",
  "Unidad organizativa": "ubicacion",
  "Posición": "funcion",
  "Area": "area",
  "Provincia": "provincia",
  "Región (Estado federal, \"land\"": "region",
  "RRHH": "personal"
};

function clearDotacionFields() {
  ["cuil","legajo","nombre","ubicacion","funcion","area","provincia","region","personal"].forEach(id => {
    const el = $(id);
    if (el) el.value = "";
  });
}

function autocompletarDesdeDotacion(row) {
  clearDotacionFields();
  for (const [col, inputId] of Object.entries(MAPEO_DOTACION_A_FORM)) {
    const el = $(inputId);
    if (!el) continue;
    if (row[col] !== undefined) el.value = String(row[col] ?? "");
  }
}

function buildIndexFromRows(rows) {
  indexPorDni = new Map();
  if (!Array.isArray(rows)) return { rows: 0, indexed: 0 };

  // Detecta nombre de columna DNI si vino diferente
  const colDni = (rows[0] && ("DNI" in rows[0])) ? "DNI"
               : (rows[0] && ("Dni" in rows[0])) ? "Dni"
               : "DNI";

  for (const r of rows) {
    const dni = normalizarDni(r?.[colDni]);
    if (!dni) continue;
    indexPorDni.set(dni, r);
  }
  return { rows: rows.length, indexed: indexPorDni.size };
}

async function parseExcelToRows(file) {
  if (!window.XLSX) throw new Error("XLSX no disponible (falta SheetJS en el HTML).");
  const data = await file.arrayBuffer();
  const wb = window.XLSX.read(data, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return window.XLSX.utils.sheet_to_json(ws, { defval: "" });
}

/***********************
 * IndexedDB (cache dotación)
 ***********************/
function openDotDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DOT_DB_NAME, DOT_DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DOT_STORE)) {
        db.createObjectStore(DOT_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDotacionCache(payload) {
  const db = await openDotDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOT_STORE, "readwrite");
    tx.objectStore(DOT_STORE).put({ key: DOT_CACHE_KEY, payload });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function loadDotacionCache() {
  const db = await openDotDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOT_STORE, "readonly");
    const req = tx.objectStore(DOT_STORE).get(DOT_CACHE_KEY);
    req.onsuccess = () => resolve(req.result?.payload || null);
    req.onerror = () => reject(req.error);
  });
}

async function clearDotacionCache() {
  const db = await openDotDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DOT_STORE, "readwrite");
    tx.objectStore(DOT_STORE).delete(DOT_CACHE_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/***********************
 * UI handlers Dotación
 ***********************/
let dotacionFileSeleccionado = null;

$("fileDotacion")?.addEventListener("change", (e) => {
  dotacionFileSeleccionado = e.target.files?.[0] || null;
  if (!dotacionFileSeleccionado) return setText("estadoDotacion", "Sin cargar");
  setText("estadoDotacion", `Archivo listo: ${dotacionFileSeleccionado.name}. Tocá "Actualizar dotación".`);
  setText("estadoCache", "");
});

$("btnActualizarDotacion")?.addEventListener("click", async () => {
  const f = dotacionFileSeleccionado || $("fileDotacion")?.files?.[0];
  if (!f) return setText("estadoDotacion", "⚠️ Seleccioná Dotacion.xlsx primero.");

  setText("estadoDotacion", "Leyendo Excel...");
  setText("estadoCache", "");
  $("infoDotacion") && ($("infoDotacion").textContent = "");

  try {
    const rows = await parseExcelToRows(f);
    if (!rows.length) {
      setText("estadoDotacion", "El Excel está vacío.");
      return;
    }

    const stats = buildIndexFromRows(rows);
    setText("estadoDotacion", "Dotación cargada ✅");
    if ($("infoDotacion")) $("infoDotacion").textContent = `Filas: ${stats.rows} | Indexados (DNI): ${stats.indexed}`;

    const versionISO = $("dotVersionDate")?.value || "";
    await saveDotacionCache({ saved_at: new Date().toISOString(), versionISO, rows });

    setText("estadoCache", `Cache guardado ✅ ${versionISO ? "| Versión: " + versionISO : ""}`);
  } catch (err) {
    console.error(err);
    setText("estadoDotacion", "❌ Error al leer el Excel (mirá consola).");
    setText("estadoCache", "No se pudo guardar cache.");
  }
});

$("btnUsarCache")?.addEventListener("click", async () => {
  setText("estadoDotacion", "Cargando dotación desde cache...");
  setText("estadoCache", "");
  $("infoDotacion") && ($("infoDotacion").textContent = "");

  try {
    const payload = await loadDotacionCache();
    if (!payload?.rows?.length) {
      setText("estadoDotacion", "No hay cache en este equipo.");
      setText("estadoCache", "Primero cargá Dotacion.xlsx una vez.");
      return;
    }

    const stats = buildIndexFromRows(payload.rows);
    setText("estadoDotacion", "Dotación cargada desde cache ✅");
    if ($("infoDotacion")) $("infoDotacion").textContent = `Filas: ${stats.rows} | Indexados (DNI): ${stats.indexed}`;
    setText("estadoCache", `Última carga: ${payload.saved_at}${payload.versionISO ? " | Versión: " + payload.versionISO : ""}`);
  } catch (err) {
    console.error(err);
    setText("estadoDotacion", "❌ Error al leer cache (mirá consola).");
    setText("estadoCache", "No se pudo leer el cache.");
  }
});

$("btnBorrarCache")?.addEventListener("click", async () => {
  if (!confirm("¿Borrar cache de dotación en este equipo?")) return;
  try {
    await clearDotacionCache();
    indexPorDni = new Map();
    setText("estadoCache", "Cache borrado ✅");
    setText("estadoDotacion", "Sin cargar");
    if ($("infoDotacion")) $("infoDotacion").textContent = "";
  } catch (err) {
    console.error(err);
    setText("estadoCache", "❌ No se pudo borrar cache (mirá consola).");
  }
});

/***********************
 * Buscar empleado por DNI (autocompleta)
 ***********************/
$("btnBuscar")?.addEventListener("click", () => {
  const dni = normalizarDni($("dni")?.value || "");
  if (!dni) return setText("estadoBusqueda", "⚠️ Ingresá un DNI.");

  if (!indexPorDni || indexPorDni.size === 0) {
    return setText("estadoBusqueda", "⚠️ Dotación no cargada. Cargá el Excel o usá cache.");
  }

  const row = indexPorDni.get(dni);
  if (!row) {
    clearDotacionFields();
    return setText("estadoBusqueda", "❌ DNI no encontrado en dotación.");
  }

  autocompletarDesdeDotacion(row);
  setText("estadoBusqueda", "Encontrado ✅ (datos autocompletados)");
});

$("btnLimpiar")?.addEventListener("click", () => {
  if ($("dni")) $("dni").value = "";
  clearDotacionFields();
  setText("estadoBusqueda", "");
});

// =====================
// REGISTROS (Firestore)
// =====================
let registrosCache = [];

function getRegistros() {
  return Array.isArray(registrosCache) ? registrosCache : [];
}
function setRegistros(arr) {
  registrosCache = Array.isArray(arr) ? arr : [];
}

function normalizeFirestoreValue(v) {
  if (v && typeof v === "object" && typeof v.toDate === "function") {
    return v.toDate().toISOString();
  }
  return v;
}

async function loadRegistrosFromCloud() {
  const rows = await window.FB.listAll(true);
  const normalized = rows.map(r => {
    const out = { id: r.id };
    for (const [k, v] of Object.entries(r)) out[k] = normalizeFirestoreValue(v);
    return out;
  });
  setRegistros(normalized);
}

function monthKeyFromRecord(r) {
  const base = r.Desde || "";
  return base ? base.slice(0, 7) : "";
}

/***********************
 * MODO EDICIÓN
 ***********************/
let editingId = null;

function entrarModoEdicion(record) {
  editingId = record.id;
  $("btnActualizar").disabled = false;
  $("btnGuardar").disabled = true;
  setText("estadoEdicion", `✏️ Editando ID: ${record.id}`);
}

function salirModoEdicion() {
  editingId = null;
  $("btnActualizar").disabled = true;
  $("btnGuardar").disabled = false;
  setText("estadoEdicion", "");
}

function cargarRegistroEnFormulario(r) {
  $("dni").value = r.DNI || "";
  $("cuil").value = r.CUIL || "";
  $("legajo").value = r.Legajo || "";
  $("nombre").value = r.Nombre || "";
  $("ubicacion").value = r.Ubicacion || "";
  $("funcion").value = r.Funcion || "";
  $("area").value = r.Area || "";
  $("provincia").value = r.Provincia || "";
  $("region").value = r.Region || "";
  $("personal").value = r.Personal || "";

  if ($("fecha")) $("fecha").value = r.Fecha || "";
  if ($("desde")) $("desde").value = r.Desde || "";
  if ($("hasta")) $("hasta").value = r.Hasta || "";

  if ($("diasTotal")) $("diasTotal").value = r["Dias_ Caidos"] || "";
  if ($("diasMesActual")) $("diasMesActual").value = r["Dias_ Caidos Mes (desde DESDE)"] || "";
  if ($("diasMesElegido")) $("diasMesElegido").value = r["Dias_ Caidos Mes elegido"] || "";

  if ($("anc")) $("anc").value = r.TipoAccidente || "A";
  if ($("gravedad")) $("gravedad").value = r.TipoDenuncia || "Leve";

  if ($("nroSiniestro")) $("nroSiniestro").value = r.Nro_Siniestro || "";
  if ($("cie10")) $("cie10").value = r.CIE10 || "";
  if ($("observacion")) $("observacion").value = r.Observacion || "";
  if ($("descripcion")) $("descripcion").value = r.Descripcion || "";
  if ($("prestador")) $("prestador").value = r.Prestador || "";
  if ($("envioDenuncia")) $("envioDenuncia").value = r["Envio Denuncia"] || "";
}




/* ===============================
   CÁLCULO DE DÍAS CAÍDOS (auto)
   - Usa Desde/Hasta (YYYY-MM-DD)
   - Dias_ Caidos: inclusive (Hasta - Desde + 1)
   - Dias_ Caidos Mes (desde DESDE): solapa con el mes de "Desde"
   - Dias_ Caidos Mes elegido: solapa con el mes seleccionado (si existe #mesElegido o #fMes)
================================ */

function parseISODate(v) {
  if (!v) return null;

  // Caso estándar de <input type="date">: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(v + "T00:00:00");
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Caso común si llega como DD/MM/YYYY (por locale o carga manual)
  const m = v.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yy = Number(m[3]);
    const d = new Date(yy, mm - 1, dd);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Último recurso (por si viene en otro formato)
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}


function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

// días inclusivo entre dos fechas (00:00)
function daysInclusive(a, b) {
  const ms = 24 * 60 * 60 * 1000;
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  const diff = Math.floor((db - da) / ms);
  return diff >= 0 ? diff + 1 : 0;
}

// solape inclusivo entre [a,b] y [x,y]
function overlapDays(a, b, x, y) {
  const start = (a > x) ? a : x;
  const end = (b < y) ? b : y;
  if (end < start) return 0;
  return daysInclusive(start, end);
}

function getSelectedMonthKeyForDiasElegido() {
  // Prioridad: input de "Mes a calcular" (tu HTML usa #mesCalculo)
  const mc = document.getElementById("mesCalculo")?.value;
  if (mc && /^\d{4}-\d{2}$/.test(mc)) return mc;

  // Alternativa: select explícito "mesElegido" (si lo llegás a usar)
  const m1 = document.getElementById("mesElegido")?.value;
  if (m1 && /^\d{4}-\d{2}$/.test(m1)) return m1;

  // Alternativa: filtro de mes del histórico (#fMes)
  const m2 = document.getElementById("fMes")?.value;
  if (m2 && /^\d{4}-\d{2}$/.test(m2)) return m2;

  return "";
}


function computeDiasFromInputs() {
  const desdeStr = getVal("desde");
  const hastaStr = getVal("hasta");

  const desde = parseISODate(desdeStr);
  const hasta = parseISODate(hastaStr);

  if (!desde || !hasta) return { total: "", mesDesde: "", mesElegido: "" };

  const total = daysInclusive(desde, hasta);

  // Mes de DESDE
  const ms = startOfMonth(desde);
  const me = endOfMonth(desde);
  const mesDesde = overlapDays(desde, hasta, ms, me);

  // Mes elegido (si existe)
  const mk = getSelectedMonthKeyForDiasElegido();
  let mesElegido = "";
  if (mk) {
    const [yy, mm] = mk.split("-").map(Number);
    const mStart = new Date(yy, mm - 1, 1);
    const mEnd = new Date(yy, mm, 0);
    mesElegido = overlapDays(desde, hasta, mStart, mEnd);
  }

  return { total, mesDesde, mesElegido };
}

function syncDiasFields({ force = false } = {}) {
  const r = computeDiasFromInputs();
  const totalEl = document.getElementById("diasTotal");
  const mesEl = document.getElementById("diasMesActual");
  const mesSelEl = document.getElementById("diasMesElegido");

  // Si force=false, solo completa si está vacío
  if (totalEl && (force || !String(totalEl.value || "").trim())) totalEl.value = r.total;
  if (mesEl && (force || !String(mesEl.value || "").trim())) mesEl.value = r.mesDesde;
  if (mesSelEl && (force || !String(mesSelEl.value || "").trim())) mesSelEl.value = r.mesElegido;
}


// Si un registro ya está en histórico pero no tiene días calculados, los completa en memoria
function ensureDiasOnRecord(r) {
  if (!r) return r;
  const tieneTotal = String(r["Dias_ Caidos"] ?? "").trim() !== "";
  const tieneMes = String(r["Dias_ Caidos Mes (desde DESDE)"] ?? "").trim() !== "";
  const tieneMesEleg = String(r["Dias_ Caidos Mes elegido"] ?? "").trim() !== "";

  if (tieneTotal && tieneMes && tieneMesEleg) return r;

  const desde = parseISODate(r.Desde || "");
  const hasta = parseISODate(r.Hasta || "");
  if (!desde || !hasta) return r;

  const total = daysInclusive(desde, hasta);
  const ms = startOfMonth(desde);
  const me = endOfMonth(desde);
  const mesDesde = overlapDays(desde, hasta, ms, me);

  // Mes elegido: usa el mismo selector (mesCalculo/mesElegido/fMes) si el usuario lo eligió en UI
  const mk = getSelectedMonthKeyForDiasElegido();
  let mesElegido = "";
  if (mk) {
    const [yy, mm] = mk.split("-").map(Number);
    const mStart = new Date(yy, mm - 1, 1);
    const mEnd = new Date(yy, mm, 0);
    mesElegido = overlapDays(desde, hasta, mStart, mEnd);
  }

  if (!tieneTotal) r["Dias_ Caidos"] = total;
  if (!tieneMes) r["Dias_ Caidos Mes (desde DESDE)"] = mesDesde;
  if (!tieneMesEleg) r["Dias_ Caidos Mes elegido"] = mesElegido;

  return r;
}
function bindDiasAutoCalc() {
  ["desde", "hasta", "mesCalculo", "fMes"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;

    el.addEventListener("change", () => syncDiasFields({ force: true }));
    el.addEventListener("input", () => syncDiasFields({ force: false }));
  });
}


  



function getVal(id) {
  return document.getElementById(id)?.value ?? "";
}

function getFormData() {
  return {
    DNI: normalizarDni(getVal("dni")),
    CUIL: getVal("cuil").trim(),
    Legajo: getVal("legajo").trim(),
    Nombre: getVal("nombre").trim(),
    Ubicacion: getVal("ubicacion").trim(),
    Funcion: getVal("funcion").trim(),
    Area: getVal("area").trim(),
    Provincia: getVal("provincia").trim(),
    Region: getVal("region").trim(),
    Personal: getVal("personal").trim(),

    Fecha: getVal("fecha"),
    Desde: getVal("desde"),
    Hasta: getVal("hasta"),

    "Dias_ Caidos": getVal("diasTotal"),
    "Dias_ Caidos Mes (desde DESDE)": getVal("diasMesActual"),
    "Dias_ Caidos Mes elegido": getVal("diasMesElegido"),

    TipoAccidente: getVal("anc"),
    TipoDenuncia: getVal("gravedad"),

    Nro_Siniestro: getVal("nroSiniestro"),
    CIE10: getVal("cie10"),
    Observacion: getVal("observacion"),
    Descripcion: getVal("descripcion"),
    Prestador: getVal("prestador"),
    "Envio Denuncia": getVal("envioDenuncia")
  };
}


/***********************
 * GUARDAR / ACTUALIZAR (Firestore)
 ***********************/
$("btnGuardar")?.addEventListener("click", async () => {
  const dni = normalizarDni($("dni").value);
  if (!dni) return setText("estadoGuardar", "⚠️ Cargá un DNI.");
  if (!$("desde").value) return setText("estadoGuardar", "⚠️ Cargá la fecha Desde.");

  try {
    setText("estadoGuardar", "Guardando en la nube...");
    const data = getFormData();

    const newId = await window.FB.createRegistro(data, CURRENT_USER_EMAIL);

    const registros = getRegistros();
    registros.unshift({ id: newId, ...data });
    setRegistros(registros);

    setText("estadoGuardar", "Guardado ✅");
    refrescarFiltros();
    renderHistorico();
  } catch (e) {
    console.error(e);
    setText("estadoGuardar", "❌ Error al guardar en Firebase (mirá consola).");
  }
});

$("btnActualizar")?.addEventListener("click", async () => {
  if (!editingId) return setText("estadoGuardar", "⚠️ No hay registro en edición.");
  const dni = normalizarDni($("dni").value);
  if (!dni) return setText("estadoGuardar", "⚠️ Cargá un DNI.");
  if (!$("desde").value) return setText("estadoGuardar", "⚠️ Cargá la fecha Desde.");

  try {
    setText("estadoGuardar", "Actualizando en la nube...");
    const data = getFormData();

    await window.FB.updateRegistro(editingId, data, CURRENT_USER_EMAIL);

    const registros = getRegistros().map(r => (r.id === editingId ? { ...r, ...data } : r));
    setRegistros(registros);

    salirModoEdicion();
    setText("estadoGuardar", "Actualizado ✅");
    refrescarFiltros();
    renderHistorico();
  } catch (e) {
    console.error(e);
    setText("estadoGuardar", "❌ Error al actualizar en Firebase (mirá consola).");
  }
});

$("btnCancelarEdicion")?.addEventListener("click", () => {
  salirModoEdicion();
  setText("estadoGuardar", "Edición cancelada.");
});

/***********************
 * FILTROS / HISTÓRICO
 ***********************/
function fillSelect(selectId, options, placeholder = "Todos") {
  const sel = $(selectId);
  if (!sel) return;
  sel.innerHTML = `<option value="">${placeholder}</option>`;
  for (const o of options) sel.innerHTML += `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`;
}

function applyFilters(arr) {
  const p = $("fProvincia")?.value || "";
  const a = $("fArea")?.value || "";
  const m = $("fMes")?.value || "";
  const anc = $("fANC")?.value || "";
  const obs = $("fObs")?.value || "";
  const pers = $("fPersonal")?.value || "";

  return arr.filter(r => {
    if (p && (r.Provincia || "") !== p) return false;
    if (a && (r.Area || "") !== a) return false;
    if (m && monthKeyFromRecord(r) !== m) return false;
    if (anc && String(r["Dias_ Caidos"] || "") !== anc) return false;
    if (obs && (r.Observacion || "") !== obs) return false;
    if (pers && (r.Personal || "") !== pers) return false;

    // filtros rápidos
    const fc = (id) => ($(`${id}`)?.value || "").trim().toLowerCase();
    const match = (val, needle) => !needle || String(val || "").toLowerCase().includes(needle);

    if (!match(r.Desde, fc("fcDesde"))) return false;
    if (!match(r.Hasta, fc("fcHasta"))) return false;
    if (!match(r.DNI, fc("fcDni"))) return false;
    if (!match(r.Nombre, fc("fcNombre"))) return false;
    if (!match(r.Provincia, fc("fcProvincia"))) return false;
    if (!match(r.Area, fc("fcArea"))) return false;
    if (!match(r.Ubicacion, fc("fcUbicacion"))) return false;
    if (!match(r["Dias_ Caidos"], fc("fcDiasTotal"))) return false;
    if (!match(r["Dias_ Caidos Mes (desde DESDE)"], fc("fcDiasMes"))) return false;
    if (!match(r.Observacion, fc("fcObs"))) return false;
    if (!match(r.Nro_Siniestro, fc("fcSiniestro"))) return false;

    return true;
  });
}

function renderHistorico() {
  const all = getRegistros();
  const filtered = applyFilters(all);

  setText("estadoHistorico", `Mostrando: ${filtered.length} (de ${all.length})`);

  const tb = $("tbodyHistorico");
  if (!tb) return;
  tb.innerHTML = "";

  for (const r of filtered) {
    ensureDiasOnRecord(r);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(r.id)}</td>
      <td class="mono">${escapeHtml(r.DNI || "")}</td>
      <td>${escapeHtml(r.Nombre || "")}</td>
      <td>${escapeHtml(r.Provincia || "")}</td>
      <td>${escapeHtml(r.Area || "")}</td>
      <td>${escapeHtml(r.Ubicacion || "")}</td>
      <td class="mono">${escapeHtml(r.Desde || "")}</td>
      <td class="mono">${escapeHtml(r.Hasta || "")}</td>
      <td class="mono">${escapeHtml(r["Dias_ Caidos"] ?? "")}</td>
      <td class="mono">${escapeHtml(r["Dias_ Caidos Mes (desde DESDE)"] ?? "")}</td>
      <td>${escapeHtml(r.Observacion || "")}</td>
      <td class="mono">${escapeHtml(r.Nro_Siniestro || "")}</td>
      <td><button class="btn2 btn-mini" data-action="edit" data-id="${r.id}">Editar</button></td>
      <td><button class="btn3 btn-mini" data-action="delete" data-id="${r.id}">Eliminar</button></td>
    `;
    tb.appendChild(tr);
  }
}

function refrescarFiltros() {
  const registros = getRegistros();
  const provincias = [...new Set(registros.map(r => (r.Provincia || "").trim()).filter(Boolean))].sort();
  const areas = [...new Set(registros.map(r => (r.Area || "").trim()).filter(Boolean))].sort();
  const obsList = [...new Set(registros.map(r => (r.Observacion || "").trim()).filter(Boolean))].sort();
  const persList = [...new Set(registros.map(r => (r.Personal || "").trim()).filter(Boolean))].sort();

  const meses = [...new Set(registros.map(r => monthKeyFromRecord(r)).filter(Boolean))].sort();
  const diasTotal = [...new Set(registros.map(r => String(r["Dias_ Caidos"] || "")).filter(Boolean))].sort();

  fillSelect("fProvincia", provincias, "Todas");
  fillSelect("fArea", areas, "Todas");
  fillSelect("fObs", obsList, "Todas");
  fillSelect("fPersonal", persList, "Todos");
  fillSelect("fMes", meses, "Todos");
  fillSelect("fANC", diasTotal, "Todos");
}

// refrescos por filtros
document.getElementById("btnRefrescar")?.addEventListener("click", renderHistorico);
["fProvincia","fArea","fMes","fANC","fObs","fPersonal"].forEach(id => $(id)?.addEventListener("change", renderHistorico));
[
  "fcFecha","fcDni","fcNombre","fcProvincia","fcArea","fcUbicacion",
  "fcDesde","fcHasta","fcDiasTotal","fcDiasMes","fcObs","fcSiniestro"
].forEach(id => $(id)?.addEventListener("input", renderHistorico));

/***********************
 * EDITAR / ELIMINAR (delegación)
 ***********************/
$("tbodyHistorico")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;

  const registros = getRegistros();
  const rec = registros.find(r => r.id === id);
  if (!rec) return;

  if (action === "edit") {
    cargarRegistroEnFormulario(rec);
    entrarModoEdicion(rec);
    setText("estadoGuardar", "Registro cargado para edición.");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (action === "delete") {
    if (!confirm("¿Eliminar este registro?")) return;

    try {
      setText("estadoHistorico", "Eliminando en la nube...");
      await window.FB.deleteRegistro(id);

      const nuevos = registros.filter(r => r.id !== id);
      setRegistros(nuevos);
      if (editingId === id) salirModoEdicion();

      setText("estadoHistorico", "Registro eliminado ✅");
      refrescarFiltros();
      renderHistorico();
    } catch (e2) {
      console.error(e2);
      setText("estadoHistorico", "❌ Error al eliminar (mirá consola).");
    }
  }
});

/***********************
 * BORRAR HISTÓRICO (Firestore)
 ***********************/
$("btnBorrarHistorico")?.addEventListener("click", async () => {
  const all = getRegistros();
  if (all.length === 0) return setText("estadoHistorico", "No hay registros para borrar.");

  const filtered = applyFilters(all);
  const hayFiltro = filtered.length !== all.length;

  let toDelete = all;
  if (hayFiltro) {
    const borrarFiltrado = confirm(
      `Tenés filtros aplicados.\n\nOK = borrar SOLO lo filtrado (${filtered.length})\nCancelar = borrar TODO (${all.length})`
    );
    toDelete = borrarFiltrado ? filtered : all;
  }

  const ids = toDelete.map(r => r.id).filter(Boolean);
  if (ids.length === 0) return setText("estadoHistorico", "No hay IDs para borrar.");

  if (!confirm(`¿Confirmás borrar ${ids.length} registro(s) en la nube?`)) return;

  try {
    setText("estadoHistorico", `Borrando ${ids.length}...`);
    await window.FB.deleteMany(ids);

    const idSet = new Set(ids);
    setRegistros(all.filter(r => !idSet.has(r.id)));

    if (editingId && idSet.has(editingId)) salirModoEdicion();

    setText("estadoHistorico", `Borrado ✅ (${ids.length})`);
    refrescarFiltros();
    renderHistorico();
  } catch (e) {
    console.error(e);
    setText("estadoHistorico", "❌ Error borrando en Firebase (mirá consola).");
  }
});



/* ===============================
   EXPORTS (Excel / PDF)
   - Requiere:
     * Excel: SheetJS (XLSX) ya lo tenés en el HTML
     * PDF: jsPDF + autotable (ya los tenés en el HTML)
   - IDs sugeridos (si existen en tu HTML):
     btnExportExcel, btnExportPdf, btnExportPDF, btnExcel, btnPdf
================================ */

function getFilteredHistorico() {
  // Usa el mismo filtro que la tabla
  return applyFilters(getRegistros());
}

function exportHistoricoExcel() {
  if (!window.XLSX) {
    alert("Falta XLSX (SheetJS). Revisá el <script> de xlsx en el HTML.");
    return;
  }
  const rows = getFilteredHistorico();
  if (!rows.length) return alert("No hay registros para exportar.");

  // Aplanar y ordenar columnas principales
  const data = rows.map(r => ({
    ID: r.id || "",
    DNI: r.DNI || "",
    CUIL: r.CUIL || "",
    Legajo: r.Legajo || "",
    Nombre: r.Nombre || "",
    Provincia: r.Provincia || "",
    Area: r.Area || "",
    Ubicacion: r.Ubicacion || "",
    Region: r.Region || "",
    Personal: r.Personal || "",
    Fecha: r.Fecha || "",
    Desde: r.Desde || "",
    Hasta: r.Hasta || "",
    "Dias Caidos": r["Dias_ Caidos"] ?? "",
    "Dias Caidos Mes (desde DESDE)": r["Dias_ Caidos Mes (desde DESDE)"] ?? "",
    "Dias Caidos Mes elegido": r["Dias_ Caidos Mes elegido"] ?? "",
    "Tipo Accidente": r.TipoAccidente || "",
    "Tipo Denuncia": r.TipoDenuncia || "",
    "Nro Siniestro": r.Nro_Siniestro || "",
    CIE10: r.CIE10 || "",
    Observacion: r.Observacion || "",
    Descripcion: r.Descripcion || "",
    Prestador: r.Prestador || "",
    "Envio Denuncia": r["Envio Denuncia"] || "",
    createdBy: r.createdBy || "",
    createdAt: r.createdAt || "",
    updatedBy: r.updatedBy || "",
    updatedAt: r.updatedAt || ""
  }));

  const ws = window.XLSX.utils.json_to_sheet(data);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, "Registros");

  const stamp = new Date().toISOString().slice(0, 10);
  window.XLSX.writeFile(wb, `registros_art_${stamp}.xlsx`);
}

function exportHistoricoPDF() {
  const jsPDFCtor = window.jspdf?.jsPDF;
  if (!jsPDFCtor) {
    alert("Falta jsPDF. Revisá los <script> de jsPDF en el HTML.");
    return;
  }
  const rows = getFilteredHistorico();
  if (!rows.length) return alert("No hay registros para exportar.");

  const doc = new jsPDFCtor({ orientation: "landscape", unit: "pt", format: "a4" });
  const stamp = new Date().toLocaleString();

  doc.setFontSize(14);
  doc.text("Registros Casos ART - Reporte", 40, 32);
  doc.setFontSize(10);
  doc.text(`Generado: ${stamp}`, 40, 48);

  const head = [[
    "DNI", "Nombre", "Provincia", "Area", "Ubicacion",
    "Desde", "Hasta", "Dias", "Dias Mes", "Obs", "Siniestro"
  ]];

  const body = rows.map(r => ([
    r.DNI || "",
    r.Nombre || "",
    r.Provincia || "",
    r.Area || "",
    r.Ubicacion || "",
    r.Desde || "",
    r.Hasta || "",
    String(r["Dias_ Caidos"] ?? ""),
    String(r["Dias_ Caidos Mes (desde DESDE)"] ?? ""),
    r.Observacion || "",
    r.Nro_Siniestro || ""
  ]));

  if (typeof doc.autoTable !== "function") {
    alert("Falta el plugin jsPDF-AutoTable. Revisá el <script> de jspdf-autotable en el HTML.");
    return;
  }

  doc.autoTable({
    head,
    body,
    startY: 62,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fontSize: 8 },
    margin: { left: 40, right: 40 }
  });

  const stampFile = new Date().toISOString().slice(0, 10);
  doc.save(`reporte_registros_art_${stampFile}.pdf`);
}

function bindExportButtons() {
  const idsExcel = ["btnExportExcel", "btnExcel", "btnReporteExcel", "btnDescargarExcel"];
  const idsPdf = ["btnExportPdf", "btnExportPDF", "btnPdf", "btnReportePDF", "btnDescargarPDF"];

  idsExcel.forEach(id => document.getElementById(id)?.addEventListener("click", exportHistoricoExcel));
  idsPdf.forEach(id => document.getElementById(id)?.addEventListener("click", exportHistoricoPDF));
}

// Bind extras
bindDiasAutoCalc();
bindExportButtons();

// Asegura que al guardar/actualizar se recalculen (por si el usuario no tocó el campo)
const _oldGetFormData = getFormData;
getFormData = function() {
  // fuerza recálculo antes de leer
  syncDiasFields({ force: true });
  return _oldGetFormData();
};
