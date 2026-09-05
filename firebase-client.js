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

2. Arquivo: compra.js

(Aqui era onde estava o erro "descobrimos". Use este código limpo).

import {
  auth,
  httpsCallable,
  functions,
  onAuthStateChanged,
  signOut,
} from './firebase-client.js';

const getPublicRaffleState = httpsCallable(functions, 'getPublicRaffleState');
const createPixOrder = httpsCallable(functions, 'createPixOrder');

const state = {
  currentOrder: null,
  countdownTimer: null,
  refreshTimer: null,
};

function createNavLink(text, href, className) {
  const link = document.createElement('a');
  link.href = href;
  link.className = className;
  link.textContent = text;
  return link;
}

function renderAuthNav(user) {
  const authNav = document.getElementById('authNav');
  if (!authNav) return;
  authNav.replaceChildren();

  if (!user) {
    authNav.append(
      createNavLink('Entrar', 'login.html', 'btn-login'),
      createNavLink('Criar Conta', 'cadastro.html', 'btn-primary'),
    );
    return;
  }

  authNav.appendChild(createNavLink('Minha conta', 'perfil.html', 'btn-login'));
  const logoutButton = document.createElement('button');
  logoutButton.type = 'button';
  logoutButton.className = 'btn-primary';
  logoutButton.textContent = 'Sair';
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    logoutButton.textContent = 'Saindo...';
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Erro ao sair:', error);
      logoutButton.disabled = false;
      logoutButton.textContent = 'Sair';
    }
  });
  authNav.appendChild(logoutButton);
}

function formatMoney(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function showMessage(message, type = 'info') {
  const element = document.getElementById('purchase-message');
  if (!element) return;
  element.textContent = message;
  element.dataset.type = type;
  element.hidden = false;
}

function hideMessage() {
  const element = document.getElementById('purchase-message');
  if (element) element.hidden = true;
}

function updateProgress(data) {
  const target = Number(data.targetSoldNumbers || data.totalNumbers || 0);
  const sold = Number(data.soldNumbers || 0);
  const percentage = Math.min(100, Number(data.percentSold ?? (target ? (sold / target) * 100 : 0)));
  const fill = document.querySelector('.progress-fill');
  if (fill) fill.style.width = `${percentage}%`;
  setText('progress-text', `${percentage.toFixed(0)}% Vendido`);

  const closed = data.status === 'encerrada' || sold >= target;
  const participateButton = document.querySelector('.btn-participar');
  if (participateButton && !state.currentOrder) {
    participateButton.disabled = closed;
    participateButton.dataset.closed = closed ? 'true' : 'false';
  }
  if (closed) showMessage('As vendas foram encerradas. Aguarde as informações do sorteio.', 'warning');
}

async function refreshPublicState() {
  try {
    const response = await getPublicRaffleState();
    updateProgress(response.data || {});
  } catch (error) {
    console.error('Erro ao carregar o estado da rifa:', error);
  }
}

function showOrderPanel(order) {
  state.currentOrder = order;
  const panel = document.getElementById('pix-order-panel');
  if (!panel) return;
  panel.hidden = false;
  setText('pix-order-id', order.orderId);
  setText('pix-order-total', formatMoney(order.totalCents));
  setText('pix-order-numbers', (order.numbers || []).map((number) => String(number).padStart(6, '0')).join(', '));
  const copyField = document.getElementById('pix-copy-paste');
  if (copyField) copyField.value = order.pixCopyPaste || '';
  const qrImage = document.getElementById('pix-qr-image');
  if (qrImage) {
    qrImage.hidden = !order.qrCodeImageUrl;
    qrImage.src = order.qrCodeImageUrl || '';
  }
  startCountdown(order.expiresAt);
  showMessage('Reserva criada. Pague o Pix antes do prazo para confirmar seus números.', 'success');
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function startCountdown(expiresAt) {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  const end = new Date(expiresAt).getTime();
  const tick = () => {
    const remaining = Math.max(0, end - Date.now());
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    setText('pix-countdown', `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`);
    if (remaining <= 0) {
      clearInterval(state.countdownTimer);
      showMessage('O prazo da reserva terminou. Se o pagamento não for confirmado, os números voltarão a ficar disponíveis.', 'warning');
    }
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

async function copyPixCode() {
  const field = document.getElementById('pix-copy-paste');
  if (!field?.value) return;
  try {
    await navigator.clipboard.writeText(field.value);
    showMessage('Pix copia e cola copiado.', 'success');
  } catch (error) {
    field.select();
    document.execCommand('copy');
    showMessage('Pix copia e cola copiado.', 'success');
  }
}

async function handlePurchase() {
  hideMessage();
  const input = document.getElementById('input-qty');
  const quantity = Number(input?.value || 0);
  if (!Number.isInteger(quantity) || quantity < 1) {
    showMessage('Informe uma quantidade válida de números.', 'error');
    return;
  }

  if (!auth.currentUser) {
    sessionStorage.setItem('quantidadeCotasPendente', String(quantity));
    window.location.href = 'login.html?returnTo=index.html#cotasSection';
    return;
  }

  const button = document.querySelector('.btn-participar');
  if (button) {
    button.disabled = true;
    button.dataset.loading = 'true';
  }

  try {
    const response = await createPixOrder({ quantity });
    showOrderPanel(response.data);
    await refreshPublicState();
  } catch (error) {
    console.error('Erro ao criar pedido:', error);
    const message = error?.message || 'Não foi possível criar a reserva agora.';
    showMessage(message.replace('INTERNAL:', '').trim(), 'error');
  } finally {
    if (button && !state.currentOrder) button.disabled = false;
  }
}

function updatePriceFromInput() {
  const input = document.getElementById('input-qty');
  let quantity = Number(input?.value || 1);
  if (!Number.isInteger(quantity) || quantity < 1) quantity = 1;
  if (input) input.value = quantity;
  const price = quantity * 0.5;
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
