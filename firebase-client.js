import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signOut,
  browserLocalPersistence,
  setPersistence,
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAsm6JE6w1I3IseTQcg3HlktHjimANRj98',
  authDomain: 'kopremia-128fe.firebaseapp.com',
  projectId: 'kopremia-128fe',
  storageBucket: 'kopremia-128fe.firebasestorage.app',
  messagingSenderId: '575510944994',
  appId: '1:575510944994:web:e2be838ad3841b6515d2bb',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, 'southamerica-east1');

export {
  app,
  auth,
  db,
  functions,
  httpsCallable,
  onAuthStateChanged,
  signOut,
  browserLocalPersistence,
  setPersistence,
};
