/* ===============================
   CONFIG Firebase + Acceso (para web estática)
   =============================== */

// ✅ Tu firebaseConfig real (lo que copiaste de Firebase Console)
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBwNENlwi_McM0WGXdWnDbHk1vxd1jMD8s",
  authDomain: "art-correo-app.firebaseapp.com",
  projectId: "art-correo-app",
  storageBucket: "art-correo-app.firebasestorage.app",
  messagingSenderId: "949252356346",
  appId: "1:949252356346:web:694cc1ef4094f17fd63143"
};

// ✅ Lista blanca (después agregás los 3 correos)
window.ALLOWED_EMAILS = [
  "lucianotoledoraul@gmail.com",
  // "usuario2@gmail.com",
  // "usuario3@gmail.com",
];

// ✅ Colección Firestore
window.FIRESTORE_COLLECTION = "registros_art";

// (Opcional)
window.DATA_VERSION = "2025-12";

//hola//

