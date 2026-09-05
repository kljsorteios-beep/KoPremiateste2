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
Agora descobrimos o "culpado"! Analisando o código do seu index.js que você me enviou, eunção checkAdminStatus não existe no seu servidor.

Você tem a função de criar pedido, a de roleta, a de e-mail... mas a função que verifica se o usuário é administrador (checkAdminStatus) não foi escrita no arquivo index.js.

O que acontece na prática:
Quando o seu site tenta perguntar ao servidor "Esse usuário é admin?", o servidor responde: "Eu não conheço nenhuma função com esse nome". O navegador recebe esse erro do servidor e, por segurança, ele reporta como um erro de CORS ou Internal Error. É por isso que o perfil não carrega e a roleta "abre e fecha" (porque ela tenta verificar o admin, falha e te joga para fora).

Vamos resolver isso agora com um "pacote completo" de correções.

1. Corrigindo o index.js (O Cérebro)

Você precisa adicionar a função checkAdminStatus no seu arquivo functions/index.js.

Copie este bloco de código e cole-o logo abaixo da função requireAdmin (por volta da linha 115) no seu index.js:

exports.checkAdminStatus = onCall({ region: 'southamerica-east1' }, async (request) => {
  return {
    isAdmin: isAdmin(request),
  };
});

Depois de colar isso, salve o arquivo e faça o deploy novamente:
firebase deploy --only functions

---

2. Sincronizando o Frontend (O Corpo)

Para garantir que tudo funcione sem erro de região ou de "undefined", use estas versões dos arquivos. Elas agora usam o firebase-client.js como a única fonte de verdade.

Arquivo: compra.js

Substitua todo o conteúdo por este:

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
  setText('display-price', formatMoney(Math.round(price * 100)));
  document.querySelectorAll('.cota-card').forEach((card) => card.classList.remove('selected'));
}

function selectCota(quantity, element) {
  document.querySelectorAll('.cota-card').forEach((card) => card.classList.remove('selected'));
  element?.classList.add('selected');
  const input = document.getElementById('input-qty');
  if (input) input.value = quantity;
  updatePriceFromInput();
}

function changeQty(delta) {
  const input = document.getElementById('input-qty');
  const current = Number(input?.value || 1);
  if (input) input.value = Math.max(1, current + delta);
  updatePriceFromInput();
}

window.updatePriceFromInput = updatePriceFromInput;
window.selectCota = selectCota;
window.changeQty = changeQty;
window.copyPixCode = copyPixCode;
window.handlePurchase = handlePurchase;

onAuthStateChanged(auth, (user) => {
  renderAuthNav(user);
  refreshPublicState();
});

document.addEventListener('DOMContentLoaded', () => {
  updatePriceFromInput();
  refreshPublicState();
  state.refreshTimer = setInterval(refreshPublicState, 30000);
  document.querySelector('.btn-participar')?.addEventListener('click', handlePurchase);
  document.getElementById('copy-pix-button')?.addEventListener('click', copyPixCode);
});
