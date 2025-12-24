// firebase.js (CDN modular) - expone helpers en window.FB y exports para app.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

import {
  getFirestore,
  collection,
  addDoc,
  doc,
  getDocs,
  query,
  orderBy,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// ✅ NO importamos config.js como módulo.
// config.js define window.FIREBASE_CONFIG, window.ALLOWED_EMAILS, etc.

function assertConfig() {
  if (
    !window.FIREBASE_CONFIG ||
    !window.FIREBASE_CONFIG.projectId ||
    window.FIREBASE_CONFIG.projectId === "PONER_PROJECT_ID"
  ) {
    console.error("⚠️ FIREBASE_CONFIG no está configurado. Editá config.js y pegá la config real de Firebase.");
  }
}
assertConfig();

// ✅ Usar un nombre distinto para evitar choques por duplicados
const FB_CONFIG = window.FIREBASE_CONFIG;

if (!FB_CONFIG) {
  throw new Error("FIREBASE_CONFIG no está cargado. Asegurate de incluir ./js/config.js antes de app.js");
}

const app = initializeApp(FB_CONFIG);

// ✅ Export para que app.js pueda hacer: import { auth, db } from "./firebase.js";
export const auth = getAuth(app);
export const db = getFirestore(app);

const provider = new GoogleAuthProvider();

function emailAllowed(email) {
  const list = Array.isArray(window.ALLOWED_EMAILS) ? window.ALLOWED_EMAILS : [];
  // si la lista está vacía, por seguridad BLOQUEA
  if (list.length === 0) return false;
  return list
    .map(e => String(e).toLowerCase().trim())
    .includes(String(email).toLowerCase().trim());
}

async function login() {
  return signInWithPopup(auth, provider);
}

async function logout() {
  return signOut(auth);
}

function onUser(cb) {
  return onAuthStateChanged(auth, (user) => cb(user));
}

// ---- Firestore helpers ----
function colRef() {
  const colName = window.FIRESTORE_COLLECTION || "registros_art";
  return collection(db, colName);
}

async function listAll(orderDesc = true) {
  const q = query(colRef(), orderBy("createdAt", orderDesc ? "desc" : "asc"));
  const snap = await getDocs(q);
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

async function createRegistro(data, userEmail) {
  const payload = {
    ...data,
    createdAt: serverTimestamp(),
    createdBy: userEmail || null,
    updatedAt: serverTimestamp(),
    updatedBy: userEmail || null,
    dataVersion: window.DATA_VERSION || null
  };
  const ref = await addDoc(colRef(), payload);
  return ref.id;
}

async function updateRegistro(id, data, userEmail) {
  const ref = doc(db, window.FIRESTORE_COLLECTION || "registros_art", id);
  const payload = {
    ...data,
    updatedAt: serverTimestamp(),
    updatedBy: userEmail || null
  };
  await updateDoc(ref, payload);
}

async function deleteRegistro(id) {
  const ref = doc(db, window.FIRESTORE_COLLECTION || "registros_art", id);
  await deleteDoc(ref);
}

async function deleteMany(ids = []) {
  // Firestore batch: 500 ops por batch
  const colName = window.FIRESTORE_COLLECTION || "registros_art";
  let batch = writeBatch(db);
  let count = 0;
  const commits = [];

  for (const id of ids) {
    const ref = doc(db, colName, id);
    batch.delete(ref);
    count++;
    if (count === 450) { // margen
      commits.push(batch.commit());
      batch = writeBatch(db);
      count = 0;
    }
  }
  if (count > 0) commits.push(batch.commit());
  await Promise.all(commits);
}

// Compatibilidad: también dejo tu objeto global window.FB
window.FB = {
  app, auth, db,
  emailAllowed,
  login, logout, onUser,
  listAll, createRegistro, updateRegistro, deleteRegistro, deleteMany
};

// señal para app.js
window.dispatchEvent(new CustomEvent("fb-ready"));
