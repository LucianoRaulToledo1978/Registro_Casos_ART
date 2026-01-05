console.log("APP VERSION ✅ 2025-12-24 (dias+export fix)");
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



// const DELETE_PASSWORD = "1234";
window.DELETE_PASSWORD = "1234";

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

// function askDeletePassword(accion) {
//   const p = prompt(`Para ${accion}, ingresá la contraseña:`);
//   return p === DELETE_PASSWORD;
// }

window.askDeletePassword = function (accion) {
  const p = prompt(`Para ${accion}, ingresá la contraseña:`);
  return p === window.DELETE_PASSWORD;
};

/* ===============================
   DOTACIÓN (Excel + IndexedDB cache)
   - Carga Dotacion.xlsx (solo en tu PC) para autocompletar por DNI
   - Guarda cache local en IndexedDB (por PC/navegador)
================================ */

const DOT_DB_NAME = "art_app_db";
const DOT_STORE = "dotacion";
const DOT_DB_VERSION = 4; // 👈 SUBIMOS versión (antes era 1 o 2)

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
      if (!db.objectStoreNames.contains("cie10")) {
        db.createObjectStore("cie10");
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


// =====================
// CIE-10 (Excel -> IndexedDB -> Map)
// =====================
const CIE_DB_NAME = "art_app_db";
const CIE_STORE = "cie10";
const CIE_CACHE_KEY = "cie10_cache_v1";

let indexCie10 = new Map(); // codigo -> descripcion

function openDB(name, version = 1, onUpgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => onUpgrade?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDB(CIE_DB_NAME, 4, (db) => {
    if (!db.objectStoreNames.contains(DOT_STORE)) db.createObjectStore(DOT_STORE); // si ya tenías dotación
    if (!db.objectStoreNames.contains(CIE_STORE)) db.createObjectStore(CIE_STORE);
  });

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

async function cieSetCache(value) {
  await withStore(CIE_STORE, "readwrite", (store) => store.put(value, CIE_CACHE_KEY));
}
async function cieGetCache() {
  return await withStore(CIE_STORE, "readonly", (store) => store.get(CIE_CACHE_KEY));
}

function normalizarCie(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

// Detecta columnas típicas: "Codigo" / "CIE10" / "CIE-10" y "Descripcion"
function mapearFilasCie(rows) {
  // rows: array de objetos (SheetJS)
  // Buscamos keys posibles
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  const kCodigo =
    keys.find(k => /^(codigo|c[oó]digo|cie10|cie-?10)$/i.test(k)) || "Codigo";
  const kDesc =
    keys.find(k => /^(descripcion|descripci[oó]n|detalle|diagnostico|diagnóstico)$/i.test(k)) || "Descripcion";

  const map = new Map();
  for (const r of rows) {
    const cod = normalizarCie(r[kCodigo]);
    const desc = String(r[kDesc] ?? "").trim();
    if (cod) map.set(cod, desc);
  }
  return map;
}

async function loadCie10FromExcel(file) {
  if (!window.XLSX) throw new Error("Falta XLSX (SheetJS).");

  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const map = mapearFilasCie(rows);

  // Guardamos en cache como array (para persistir) y armamos Map en memoria
  await cieSetCache({ rows, savedAt: new Date().toISOString() });
  indexCie10 = map;

  return { count: indexCie10.size };
}

async function initCie10Cache() {
  const cached = await cieGetCache();
  if (cached?.rows?.length) {
    indexCie10 = mapearFilasCie(cached.rows);
    return { loaded: true, count: indexCie10.size, savedAt: cached.savedAt };
  }
  return { loaded: false, count: 0 };
}

function getCieDescripcion(code) {
  const c = normalizarCie(code);
  return indexCie10.get(c) || "";
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

// Inicializa cache CIE10 al cargar
initCie10Cache().then(info => {
  if (info.loaded) setText("estadoCie10", `✅ CIE-10 cargado (${info.count} códigos)`);
  else setText("estadoCie10", "ℹ️ Subí CIE10.xlsx para habilitar descripción automática.");
}).catch(() => {
  setText("estadoCie10", "⚠️ No se pudo leer cache CIE-10.");
});

// Subida de CIE10.xlsx
$("fileCIE10")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    setText("estadoCie10", "Cargando CIE-10...");
    const { count } = await loadCie10FromExcel(file);
    setText("estadoCie10", `✅ CIE-10 cargado (${count} códigos).`);
  } catch (err) {
    console.error(err);
    alert("No se pudo cargar CIE-10. Revisá que sea un .xlsx válido.");
    setText("estadoCie10", "❌ Error al cargar CIE-10.");
  } finally {
    e.target.value = "";
  }
});

// Cuando escribís el código CIE10, completa la descripción
$("cie10")?.addEventListener("input", () => {
  const code = $("cie10").value;
  const desc = getCieDescripcion(code);

  if ($("cie10Desc")) $("cie10Desc").value = desc;
});







// =====================
// CARGA EXCEL CIE-10
// =====================
$("fileCIE10")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    setText("estadoCie10", "⏳ Cargando CIE-10...");

    const { count } = await loadCie10FromExcel(file);

    setText(
      "estadoCie10",
      `✅ CIE-10 cargado correctamente (${count} códigos)`
    );
  } catch (err) {
    console.error(err);
    alert("No se pudo cargar el archivo CIE-10.");
    setText("estadoCie10", "❌ Error al cargar CIE-10");
  } finally {
    e.target.value = ""; // permite volver a subir el mismo archivo
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

// funcion para buscar y caragar desde el boton"buscar y cargar"//
function buscarRegistroParaEdicion() {
  const dniBuscado = normalizarDni(getVal("buscarRegDni"));
  const sinBuscado = String(getVal("buscarRegSiniestro") || "").trim();

  if (!dniBuscado && !sinBuscado) {
    setText("estadoEdicion", "⚠️ Ingresá DNI o N° de siniestro para buscar.");
    return;
  }

  const registros = getRegistros();

  const rec = registros.find(r => {
    const dniOk = dniBuscado && normalizarDni(r.DNI) === dniBuscado;
    const sinOk = sinBuscado && String(r.Nro_Siniestro || "").trim() === sinBuscado;
    return dniOk || sinOk;
  });

  if (!rec) {
    setText("estadoEdicion", "❌ No se encontró el registro con esos datos.");
    return;
  }

  cargarRegistroEnFormulario(rec);
  entrarModoEdicion(rec);
  setText("estadoEdicion", `✏️ Editando ID: ${rec.id}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ✅ Botón "Buscar y cargar"
$("btnBuscarRegistro")?.addEventListener("click", buscarRegistroParaEdicion);

// ✅ Enter desde los inputs
["buscarRegDni", "buscarRegSiniestro"].forEach(id => {
  $(id)?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") buscarRegistroParaEdicion();
  });
});



function getVal(id) {
  return document.getElementById(id)?.value ?? "";
}

function getFormData() {

  const desdeStr = getVal("desde");
  const hastaStr = getVal("hasta");

  const diasPorMesCalc = calcDiasPorMes(desdeStr, hastaStr);

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
    CIE10_Desc: getCieDescripcion(getVal("cie10")),
    Observacion: getVal("observacion"),
    Descripcion: getVal("descripcion"),
    Prestador: getVal("prestador"),
    "Envio Denuncia": getVal("envioDenuncia"),
    diasPorMes: diasPorMesCalc,

  };
}

async function migrarDiasPorMesHistorico() {
  try {
    setText("estadoHistorico", "⏳ Recalculando histórico...");
    await loadRegistrosFromCloud();

    const registros = getRegistros();
    let ok = 0, fail = 0;

    for (const r of registros) {
      try {
        const diasPorMes = calcDiasPorMes(r.Desde, r.Hasta);
        if (!Object.keys(diasPorMes).length) continue;

        await window.FB.updateRegistro(r.id, {
          diasPorMes
        });

        ok++;
      } catch (e1) {
        console.error("Error en registro", r.id, e1);
        fail++;
      }
    }

    setText(
      "estadoHistorico",
      `✅ Migración finalizada — OK: ${ok} | Error: ${fail}`
    );

    await loadRegistrosFromCloud();
    refrescarFiltros();
    renderHistorico();

  } catch (e) {
    console.error(e);
    setText("estadoHistorico", "❌ Error en migración (ver consola)");
  }
}

$("btnMigrarDiasPorMes")?.addEventListener("click", () => {
  if (!confirm("Esto actualizará los registros históricos en la nube. ¿Continuar?")) return;
  migrarDiasPorMesHistorico();
});


/***********************
 * CÁLCULO DÍAS CAÍDOS
 * - TOTAL: inclusive (Hasta - Desde + 1)
 * - MES (desde DESDE): solape con el mes de "Desde"
 * - MES elegido: solape con el mes seleccionado en #mesCalculo (type="month")
 ***********************/
function _parseYMD(s){
  if(!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if(m){
    const y=+m[1], mo=+m[2], d=+m[3];
    return new Date(y, mo-1, d);
  }
  const m2 = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if(m2){
    const d=+m2[1], mo=+m2[2], y=+m2[3];
    return new Date(y, mo-1, d);
  }
  return null;
}
function _daysInclusive(a,b){
  if(!a||!b) return "";
  const A=new Date(a.getFullYear(),a.getMonth(),a.getDate());
  const B=new Date(b.getFullYear(),b.getMonth(),b.getDate());
  const diff = Math.floor((B-A)/86400000)+1;
  return diff>0 ? String(diff) : "";
}

function calcDiasPorMes(desdeStr, hastaStr) {
  const desde = _parseYMD(desdeStr);
  const hasta = _parseYMD(hastaStr);
  if (!desde || !hasta) return {};

  const d0 = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
  const d1 = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
  if (d1 < d0) return {};

  const out = {};
  let y = d0.getFullYear();
  let m = d0.getMonth();

  const endY = d1.getFullYear();
  const endM = d1.getMonth();

  while (y < endY || (y === endY && m <= endM)) {
    const first = new Date(y, m, 1);
    const last  = new Date(y, m + 1, 0);
    const v = _overlapDays(d0, d1, first, last);
    const n = v === "" ? 0 : Number(v);

    if (n > 0) {
      const key = `${y}-${String(m + 1).padStart(2, "0")}`;
      out[key] = n;
    }

    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }

  return out;
}







function _overlapDays(a1,a2,b1,b2){
  if(!a1||!a2||!b1||!b2) return "";
  const s = a1>b1 ? a1 : b1;
  const e = a2<b2 ? a2 : b2;
  return _daysInclusive(s,e);
}

function syncDiasFields({force=false} = {}){
  const desdeStr = $("desde")?.value || "";
  const hastaStr = $("hasta")?.value || "";
  const mesKey = $("mesCalculo")?.value || ""; // YYYY-MM

  const desde = _parseYMD(desdeStr);
  const hasta = _parseYMD(hastaStr);

  if(force && (!desde || !hasta)){
    if($("diasTotal")) $("diasTotal").value = "";
    if($("diasMesActual")) $("diasMesActual").value = "";
    if($("diasMesElegido")) $("diasMesElegido").value = "";
    return;
  }

  const total = _daysInclusive(desde, hasta);

  let mesActual = "";
if (desde && hasta) {
  const hoy = new Date(); // ✅ fecha actual (hoy)
  const first = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const last  = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
  mesActual = _overlapDays(desde, hasta, first, last);
}




  let mesElegido = "";
  if(mesKey && /^\d{4}-\d{2}$/.test(mesKey) && desde && hasta){
    const [y, m] = mesKey.split("-").map(Number);
    const first = new Date(y, m-1, 1);
    const last  = new Date(y, m, 0);
    mesElegido = _overlapDays(desde, hasta, first, last);
  }

  if($("diasTotal")) $("diasTotal").value = total;
  if($("diasMesActual")) $("diasMesActual").value = mesActual;



  if($("diasMesElegido")) $("diasMesElegido").value = mesElegido;
}

function bindDiasAutoCalc(){
  ["desde","hasta","mesCalculo","fMes"].forEach(id=>{
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener("change", ()=>syncDiasFields({force:true}));
    el.addEventListener("input",  ()=>syncDiasFields({force:false}));
  });
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
    syncDiasFields({ force: true });
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
    syncDiasFields({ force: true });
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
    if (anc && String(r["TipoAccidente"] || "") !== anc) return false;
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
    if (!match(r.TipoAccidente, fc("fcANC"))) return false;
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
      <td>${escapeHtml(r.TipoAccidente || "")}</td>
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
  "fcDesde","fcHasta","fcDiasTotal","fcDiasMes","fcANC","fcObs","fcSiniestro"
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

    // 🔒 1) PEDIR CONTRASEÑA
    if (!window.askDeletePassword("eliminar ESTE registro")) {
      setText("estadoHistorico", "Contraseña incorrecta. No se eliminó el registro.");
      return;
    }

    // ❓ 2) CONFIRMACIÓN
    if (!confirm("¿Eliminar este registro?")) return;

    try {
      // 🗑️ 3) BORRADO REAL
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
  let vaABorrarTodo = true;

  if (hayFiltro) {
    const borrarFiltrado = confirm(
      `Tenés filtros aplicados.\n\nOK = borrar SOLO lo filtrado (${filtered.length})\nCancelar = borrar TODO (${all.length})`
    );
    toDelete = borrarFiltrado ? filtered : all;
    vaABorrarTodo = !borrarFiltrado; // ✅ si canceló, eligió BORRAR TODO
  }

  // 🔒 Pedimos contraseña SOLO si va a borrar TODO
  // 🔒 Pedimos contraseña SIEMPRE (filtrado o todo)
const okPass = askDeletePassword(
  hayFiltro
    ? `borrar ${toDelete.length} registro(s) FILTRADOS`
    : `BORRAR TODO el histórico (${toDelete.length})`
);

if (!okPass) {
  setText("estadoHistorico", "Contraseña incorrecta. No se borró nada.");
  return;
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

/***********************
 * EXPORT (Excel / PDF)
 ***********************/
function _getHistoricoFiltrado(){
  const all = getRegistros();
  return applyFilters(all);
}

function exportToExcel(){
  try{
    if(!window.XLSX) return alert("Falta XLSX (SheetJS). Revisá el <script> de xlsx.");

    const rows = _getHistoricoFiltrado(); // tu función actual
    if(!rows.length) return alert("No hay registros para exportar (según filtros).");

    const mesFiltro = document.getElementById("fMes")?.value || ""; // "YYYY-MM" o ""

    const getDiasMesSeleccionado = (r) => {
      if(!mesFiltro) return "";
      const map = (r?.diasPorMes && typeof r.diasPorMes === "object") ? r.diasPorMes : {};
      const n = Number(map?.[mesFiltro] ?? 0);
      return n > 0 ? n : "";
    };

    const data = rows.map(r => ({
      "ID": r.id || "",
      "Fecha": r.Fecha || "",
      "DNI": r.DNI || "",
      "Cuil": r.CUIL || "",
      "Legajo": r.Legajo || "",
      "Nombre": r.Nombre || "",
      "Ubicación": r.Ubicacion || "",
      "Función": r.Funcion || "",
      "Provincia": r.Provincia || "",
      "Área": r.Area || "",
      "Personal": r.Personal || "",
      "Desde": r.Desde || "",
      "Hasta": r.Hasta || "",

      "Días Total": r["Dias_ Caidos"] ?? "",

      // ✅ NUEVO: días del mes seleccionado (si hay filtro)
      ...(mesFiltro ? { [`Días Mes (${mesFiltro})`]: getDiasMesSeleccionado(r) } : {}),

      // ✅ Compatibilidad: lo que ya tenías fijo (mes de DESDE)
      "Días Mes (DESDE)": r["Dias_ Caidos Mes (desde DESDE)"] ?? "",

      "A/NC": r.TipoAccidente  || "",
      "N° Siniestro": r.Nro_Siniestro || "",
      "CIE-10": r.CIE10 || "",
      "Descripción CIE-10": r.CIE10_Desc || getCieDescripcion(r.CIE10) || "",
      "Gravedad": r.TipoDenuncia || "",

      "Obs": r.Observacion || "",
      "Descripción del hecho":
        r["Descripción_del_hecho"] ??
        r.Descripcion_del_hecho ??
        r.DescripcionHecho ??
        r.descripcion ??
        r.Descripcion ??
        "",

      "Prestador": r.Prestador || ""
    }));

    const ws = window.XLSX.utils.json_to_sheet(data);
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Registros");

    const nombre = `registros_art_${new Date().toISOString().slice(0,10)}${mesFiltro ? "_" + mesFiltro : ""}.xlsx`;
    window.XLSX.writeFile(wb, nombre);

  }catch(e){
    console.error(e);
    alert("Error exportando Excel (mirá consola).");
  }
}


function exportToPDF(){
  try{
    const rows = _getHistoricoFiltrado();
    if(!rows.length) return alert("No hay registros para exportar (según filtros).");

    const jsPDF = window.jspdf?.jsPDF || window.jsPDF;
    if(!jsPDF) return alert("Falta jsPDF. Revisá los <script> de jspdf y autotable.");

    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    doc.setFontSize(12);
    doc.text("Registros Casos ART (filtrado)", 40, 30);

    const body = rows.map(r=>[
      r.Fecha || "",
      r.DNI || "",
      r.Nombre || "",
      r.Provincia || "",
      r.Area || "",
      r.Ubicacion || "",
      r.Desde || "",
      r.Hasta || "",
      r["Dias_ Caidos"] ?? "",
      r["Dias_ Caidos Mes (desde DESDE)"] ?? "",
      r.Observacion || "",
      r.Nro_Siniestro || ""
    ]);

    doc.autoTable({
      startY: 45,
      head: [[
        "Fecha","DNI","Nombre","Provincia","Área","Ubicación","Desde","Hasta",
        "Días Total","Días Mes (DESDE)","Obs","N° Siniestro"
      ]],
      body,
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fontSize: 8 }
    });

    doc.save(`reporte_art_${new Date().toISOString().slice(0,10)}.pdf`);
  }catch(e){
    console.error(e);
    alert("Error exportando PDF (mirá consola).");
  }
}

// =======================
// EXPORTES (Excel / PDF) con diasPorMes
// =======================
function getMesFiltroActual() {
  return $("fMes")?.value || ""; // "YYYY-MM" o ""
}

function getDiasPorMesValue(r, mesKey) {
  const map = r?.diasPorMes && typeof r.diasPorMes === "object" ? r.diasPorMes : {};
  const n = Number(map?.[mesKey] ?? 0);
  return n > 0 ? n : 0;
}

// arma filas según lo que estás viendo (filtros aplicados)
function buildExportRowsFromHistorico() {
  const all = getRegistros();
  const filtered = applyFilters(all);

  const mesFiltro = getMesFiltroActual();
  const hasMes = !!mesFiltro;

  return filtered.map(r => {
    const diasMes = hasMes ? getDiasPorMesValue(r, mesFiltro) : "";

    return {
      ID: r.id ?? "",
      DNI: r.DNI ?? "",
      Nombre: r.Nombre ?? "",
      Provincia: r.Provincia ?? "",
      Area: r.Area ?? "",
      Ubicacion: r.Ubicacion ?? "",
      Desde: r.Desde ?? "",
      Hasta: r.Hasta ?? "",
      "Dias Caidos Total": r["Dias_ Caidos"] ?? "",
      ...(hasMes ? { [`Dias Caidos ${mesFiltro}`]: diasMes } : {}),
      TipoAccidente: r.TipoAccidente ?? "",
      Observacion: r.Observacion ?? "",
      Siniestro: r.Nro_Siniestro ?? ""
    };
  });
}

function exportHistoricoExcel() {
  try {
    if (typeof XLSX === "undefined") throw new Error("XLSX no disponible");

    const rows = buildExportRowsFromHistorico();
    if (!rows.length) {
      alert("No hay registros para exportar con los filtros actuales.");
      return;
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Historico");

    const mes = getMesFiltroActual();
    const fileName = `historico_art${mes ? "_" + mes : ""}.xlsx`;
    XLSX.writeFile(wb, fileName);

  } catch (e) {
    console.error(e);
    alert("Error exportando Excel. Mirá consola.");
  }
}

function exportHistoricoPDF() {
  try {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) throw new Error("jsPDF no disponible (window.jspdf.jsPDF)");

    const rows = buildExportRowsFromHistorico();
    if (!rows.length) {
      alert("No hay registros para exportar con los filtros actuales.");
      return;
    }

    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });

    // ✅ chequear autotable después de crear doc
    if (typeof doc.autoTable !== "function") {
      throw new Error("autoTable no disponible (falta cargar jspdf-autotable o no enganchó con jsPDF)");
    }

    const mes = getMesFiltroActual();
    const title = `Histórico ART${mes ? " - " + mes : ""}`;

    doc.setFontSize(12);
    doc.text(title, 40, 30);

    const head = [Object.keys(rows[0])];
    const body = rows.map(o => Object.values(o));

    doc.autoTable({
      head,
      body,
      startY: 45,
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fontSize: 8 },
      margin: { left: 20, right: 20 }
    });

    const fileName = `historico_art${mes ? "_" + mes : ""}.pdf`;
    doc.save(fileName);

  } catch (e) {
    console.error(e);
    alert(`Error exportando PDF: ${e.message}`);
  }
}




$("btnAplicarFiltros")?.addEventListener("click", (e) => {
  e.preventDefault();
  renderHistorico();
});

$("btnExportExcel")?.addEventListener("click", (e) => {
  e.preventDefault();
  exportToExcel(); // ✅ tu función adaptada a diasPorMes
});

$("btnExportPDF")?.addEventListener("click", (e) => {
  e.preventDefault();
  exportHistoricoPDF(); // ✅ tu PDF corregido
});



// ✅ Bindings extra
bindDiasAutoCalc();
bindExportButtons();
// ✅ cálculo inicial
syncDiasFields({ force: true });

