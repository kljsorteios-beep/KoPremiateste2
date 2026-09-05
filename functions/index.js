const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

// Inicializa o Firebase Admin
initializeApp();
const db = getFirestore();

// --- SEGREDOS (Secrets) ---
// Estes valores são puxados do Secret Manager do Google Cloud
const MERCADOPAGO_ACCESS_TOKEN = defineSecret('MERCADOPAGO_ACCESS_TOKEN');
const MERCADOPAGO_WEBHOOK_SECRET = defineSecret('MERCADOPAGO_WEBHOOK_SECRET');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

// --- CONFIGURAÇÕES PADRÃO ---
const TOTAL_NUMBERS_DEFAULT = 150000;
const WINNING_NUMBERS_DEFAULT = 10000;
const ADDITIONAL_PRIZE_POOL_CENTS_DEFAULT = 1000000;
const PRICE_PER_NUMBER_CENTS_DEFAULT = 50;
const RESERVATION_MINUTES_DEFAULT = 10;
const SHARD_SIZE_DEFAULT = 1000;
const MAX_NUMBERS_PER_ORDER = 1000;

const raffleConfigRef = db.doc('configuracoes/rifa');
const raffleStateRef = db.doc('estado/rifa');
const publicStateRef = db.doc('publico/rifa');

// --- FUNÇÕES AUXILIARES ---

/**
 * Verifica se o usuário é administrador
 */
function isAdmin(request) {
  const uid = request.auth?.uid;
  if (!uid) return false;

  // UID do Administrador configurado fixamente
  const adminUids = ["fWk3KbMKzqOt4savnPgj2hgIKLI2"];

  if (request.auth.token?.admin === true) return true;
  return adminUids.includes(uid);
}

/**
 * Bloqueia acesso para não administradores
 */
function requireAdmin(request) {
  const auth = request.auth;
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', 'Faça login para continuar.');
  }
  if (!isAdmin(request)) {
    throw new HttpsError('permission-denied', 'Acesso restrito ao administrador.');
  }
  return auth;
}

function getConfigDefaults() {
  return {
    totalNumbers: TOTAL_NUMBERS_DEFAULT,
    targetSoldNumbers: TOTAL_NUMBERS_DEFAULT,
    status: 'preparacao',
    pricePerNumberCents: PRICE_PER_NUMBER_CENTS_DEFAULT,
  };
}

function formatTicketNumber(value) {
  return String(value).padStart(6, '0');
}

function parseTicketNumber(value) {
  const parsed = Number(String(value).replace(/\D/g, ''));
  return Number.isInteger(parsed) ? parsed : 0;
}

// --- FUNÇÕES EXPORTADAS (API do Site) ---

/**
 * Verifica se o usuário logado é admin (Usado no perfil e roleta)
 */
exports.checkAdminStatus = onCall({ region: 'southamerica-east1' }, async (request) => {
  try {
    return { isAdmin: isAdmin(request) };
  } catch (e) {
    logger.error("Erro checkAdminStatus", e);
    throw new HttpsError('internal', 'Erro ao verificar status de admin');
  }
});

/**
 * Retorna o estado atual da rifa para a tela inicial
 */
exports.getPublicRaffleState = onCall({ region: 'southamerica-east1' }, async () => {
  try {
    const snapshot = await publicStateRef.get();
    if (!snapshot.exists) return getConfigDefaults();
    return snapshot.data();
  } catch (e) {
    logger.error("Erro getPublicRaffleState", e);
    throw new HttpsError('internal', 'Erro ao carregar estado da rifa');
  }
});

/**
 * Atualiza configurações da rifa (Admin)
 */
exports.updateRaffleConfig = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  try {
    const { targetSoldNumbers, status } = request.data;
    await db.runTransaction(async (transaction) => {
      const configSnapshot = await transaction.get(raffleConfigRef);
      const config = configSnapshot.exists ? configSnapshot.data() : getConfigDefaults();

      transaction.set(raffleConfigRef, {
        ...config,
        targetSoldNumbers: targetSoldNumbers || config.targetSoldNumbers,
        status: status || config.status,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });
    return { success: true };
  } catch (e) {
    throw new HttpsError('internal', e.message);
  }
});

/**
 * Cria um pedido Pix e reserva números (Fluxo Principal)
 */
exports.createPixOrder = onCall({
  region: 'southamerica-east1',
  secrets: [MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_WEBHOOK_SECRET]
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login necessário');

  const quantity = Number(request.data?.quantity || 0);
  if (quantity < 1 || quantity > MAX_NUMBERS_PER_ORDER) {
    throw new HttpsError('invalid-argument', 'Quantidade inválida');
  }

  const orderId = crypto.randomUUID();
  const user = request.auth;

  try {
    const orderRef = db.doc(`pedidos/${orderId}`);

    // Aqui simulamos a criação do pedido.
    // Em produção, deve-se integrar com a lógica de escolha de números e API do Mercado Pago.
    const orderData = {
      uid: user.uid,
      email: user.token.email,
      status: 'aguardando_pagamento',
      totalCents: quantity * PRICE_PER_NUMBER_CENTS_DEFAULT,
      createdAt: FieldValue.serverTimestamp(),
      numeros: []
    };

    await orderRef.set(orderData);

    return {
      orderId,
      pixCopyPaste: "COLE_AQUI_O_CODIGO_PIX_DO_MP",
      qrCodeImageUrl: null,
      totalCents: orderData.totalCents
    };
  } catch (e) {
    logger.error("Erro createPixOrder", e);
    throw new HttpsError('internal', 'Erro ao processar pedido');
  }
});

/**
 * Webhook do Mercado Pago para confirmação de pagamento
 */
exports.mercadoPagoWebhook = onRequest({
  region: 'southamerica-east1',
  secrets: [MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_WEBHOOK_SECRET]
}, async (req, res) => {
  // Lógica de validação de assinatura e confirmação de pagamento
  res.status(200).send('OK');
});

/**
 * Sorteio do Prêmio Principal (XRE) - Admin
 */
exports.drawXreWinner = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  try {
    // Simulação de sorteio para teste de fluxo
    return { status: 'concluido', winner: { numero: 123456, comprador: 'Sorteado XRE', email: 'sorteado@email.com' } };
  } catch (e) {
    throw new HttpsError('internal', e.message);
  }
});

/**
 * Sorteio de Prêmios Adicionais - Admin
 */
exports.getRandomBoughtWinningQuote = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  try {
    return { status: 'concluido', winner: { numero: 654321, comprador: 'Sorteado Adicional', email: 'adicional@email.com' } };
  } catch (e) {
    throw new HttpsError('internal', e.message);
  }
});

/**
 * Lista de compras para auditoria (Admin)
 */
exports.getAdminPurchases = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const snapshot = await db.collection('compras').limit(100).get();
  return { purchases: snapshot.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/**
 * Lista de ganhadores para auditoria (Admin)
 */
exports.getAdminWinners = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const snapshot = await db.collection('ganhadores').limit(100).get();
  return { winners: snapshot.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/**
 * Meus Pedidos (Usuário logando)
 */
exports.getMyOrders = onCall({ region: 'southamerica-east1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login necessário');
  const snapshot = await db.collection('pedidos').where('uid', '==', request.auth.uid).get();
  return { orders: snapshot.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/**
 * Rotina de expiração de reservas
 */
exports.expireReservations = onSchedule({
  region: 'southamerica-east1',
  schedule: 'every 5 minutes'
}, async () => {
  logger.info("Executando rotina de expiração...");
  // Lógica de expiração aqui
});

/**
 * Gatilho de e-mail ao criar compra
 */
exports.sendPurchaseConfirmationEmail = onDocumentCreated({
  region: 'southamerica-east1',
  document: 'compras/{purchaseId}',
  secrets: [RESEND_API_KEY]
}, async (event) => {
  logger.info("Nova compra detectada, preparando e-mail...");
  // Lógica de envio de e-mail aqui
});