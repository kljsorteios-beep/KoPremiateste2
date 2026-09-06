const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

initializeApp();
const db = getFirestore();

const MERCADOPAGO_ACCESS_TOKEN = defineSecret('MERCADOPAGO_ACCESS_TOKEN');
const MERCADOPAGO_WEBHOOK_SECRET = defineSecret('MERCADOPAGO_WEBHOOK_SECRET');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

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

function isAdmin(request) {
  const uid = request.auth?.uid;
  if (!uid) return false;
  const adminUids = ["fWk3KbMKzqOt4savnPgj2hgIKLI2"];
  if (request.auth.token?.admin === true) return true;
  return adminUids.includes(uid);
}

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

exports.checkAdminStatus = onCall({ region: 'southamerica-east1' }, async (request) => {
  try {
    return { isAdmin: isAdmin(request) };
  } catch (e) {
    logger.error("Erro checkAdminStatus", e);
    throw new HttpsError('internal', 'Erro ao verificar status de admin');
  }
});

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

exports.updateRaffleConfig = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  try {
    const { targetSoldNumbers, status } = request.data;
    await db.runTransaction(async (transaction) => {
      const configSnapshot = await transaction.get(raffleConfigRef);
      const config = configSnapshot.exists ? configSnapshot.data() : getConfigDefaults();
      const publicSnap = await transaction.get(publicStateRef);
      const currentSoldNumbers = publicSnap.exists ? (publicSnap.data()?.soldNumbers || 0) : 0;

      const updatedConfig = {
        ...config,
        targetSoldNumbers: targetSoldNumbers !== undefined ? targetSoldNumbers : config.targetSoldNumbers,
        status: status !== undefined ? status : config.status,
        updatedAt: FieldValue.serverTimestamp()
      };

      // 1. Atualiza a configuração mestre
      transaction.set(raffleConfigRef, updatedConfig, { merge: true });

      // 2. Sincroniza imediatamente com o estado público para o admin e site verem a mudança
      transaction.set(publicStateRef, {
        ...updatedConfig,
        soldNumbers: currentSoldNumbers
      }, { merge: true });
    });
    return { success: true };
  } catch (e) {
    throw new HttpsError('internal', e.message);
  }
});

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
  const userEmail = user.token.email;

  let userNome = '';
  try {
    const userDocSnap = await db.doc(`usuarios/${user.uid}`).get();
    if (userDocSnap.exists) {
      userNome = userDocSnap.data()?.nome || '';
    }
  } catch (e) {
    logger.error("Erro ao buscar nome do usuario", e);
  }

  try {
    let rawToken = MERCADOPAGO_ACCESS_TOKEN.value();
    let token = String(rawToken || "").trim().replace(/^["\']|["\']$/g, '');
    const tokenLength = token.length;

    if (!token || tokenLength < 10) {
      throw new HttpsError('internal', `ERRO: Token vazio ou incompleto (Tamanho: ${tokenLength})`);
    }

    const reservedNumbers = [];
    let attempts = 0;
    const soldSnapshot = await db.collection('compras').select('numeros').get();
    const soldNumbersSet = new Set();
    soldSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.numeros) data.numeros.forEach(n => soldNumbersSet.add(n));
    });

    while (reservedNumbers.length < quantity && attempts < 5000) {
      const rand = Math.floor(Math.random() * TOTAL_NUMBERS_DEFAULT) + 1;
      if (!soldNumbersSet.has(rand)) {
        reservedNumbers.push(rand);
        soldNumbersSet.add(rand);
      }
      attempts++;
    }

    if (reservedNumbers.length < quantity) {
      throw new HttpsError('unavailable', 'Não foram encontrados números disponíveis suficientes.');
    }

    const totalCents = quantity * PRICE_PER_NUMBER_CENTS_DEFAULT;
    
    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': orderId
      },
      body: JSON.stringify({
        transaction_amount: totalCents / 100,
        description: `Compra de ${quantity} cotas - Rifa K-Premia`,
        payment_method_id: 'pix',
        payer: { email: userEmail }
      })
    });

    if (!mpResponse.ok) {
      const errorData = await mpResponse.json();
      logger.error("Erro MP API", errorData);
      const detailedError = errorData.message || "Erro desconhecido no Mercado Pago";
      throw new HttpsError('internal', `Mercado Pago: ${detailedError} (Token Len: ${tokenLength})`);
    }

    const mpData = await mpResponse.json();
    const pixCode = mpData.point_of_interaction?.transaction_data?.qr_code;
    const qrBase64 = mpData.point_of_interaction?.transaction_data?.qr_code_base64;

    if (!pixCode) throw new HttpsError('internal', 'Mercado Pago não retornou o código PIX');

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + RESERVATION_MINUTES_DEFAULT);

    const orderData = {
      uid: user.uid,
      nome: userNome,
      email: userEmail,
      status: 'aguardando_pagamento',
      totalCents: totalCents,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromDate(expiresAt),
      numeros: reservedNumbers,
      mpPaymentId: mpData.id
    };

    await db.doc(`pedidos/${orderId}`).set(orderData);

    return {
      orderId,
      pixCopyPaste: pixCode,
      qrCodeImageUrl: qrBase64 ? `data:image/png;base64,${qrBase64}` : null,
      totalCents: totalCents,
      expiresAt: expiresAt.toISOString()
    };
  } catch (e) {
    logger.error("Erro createPixOrder", e);
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', e.message || 'Erro ao processar pedido');
  }
});

exports.syncPaymentStatus = onCall({
  region: 'southamerica-east1',
  secrets: [MERCADOPAGO_ACCESS_TOKEN]
}, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sessão expirada. Faça login novamente.');
  
  const { orderId } = request.data;
  if (!orderId) throw new HttpsError('invalid-argument', 'ID do pedido não informado.');

  try {
    const orderDoc = await db.collection('pedidos').doc(orderId).get();
    if (!orderDoc.exists) throw new HttpsError('not-found', 'Pedido não encontrado.');
    
    const orderData = orderDoc.data();
    if (orderData.status === 'pago') return { status: 'pago', message: 'Pagamento já processado!' };

    const mpPaymentId = orderData.mpPaymentId;
    if (!mpPaymentId) throw new HttpsError('internal', 'Este pedido não possui um ID de pagamento vinculado.');

    let rawToken = MERCADOPAGO_ACCESS_TOKEN.value();
    let token = String(rawToken || "").trim().replace(/^["\']|["\']$/g, '');

    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${mpPaymentId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!mpResponse.ok) throw new HttpsError('internal', 'Erro ao consultar Mercado Pago.');
    
    const paymentData = await mpResponse.json();
    if (paymentData.status !== 'approved') {
      return { status: 'pendente', message: 'Pagamento ainda não aprovado pelo Mercado Pago.' };
    }

    // APROVADO! Processamos agora.
    await db.runTransaction(async (transaction) => {
      const publicRef = db.doc('publico/rifa');
      const publicSnap = await transaction.get(publicRef);
      const currentSold = publicSnap.exists ? (Number(publicSnap.data().soldNumbers) || 0) : 0;

      transaction.update(db.doc(`pedidos/${orderId}`), {
        status: 'pago',
        paidAt: FieldValue.serverTimestamp()
      });

      transaction.set(db.doc(`compras/${orderId}`), {
        ...orderData,
        status: 'pago',
        paidAt: FieldValue.serverTimestamp(),
        confirmadoEm: FieldValue.serverTimestamp()
      });

      transaction.set(publicRef, {
        soldNumbers: currentSold + (orderData.numeros?.length || 0)
      }, { merge: true });
    });

    return { status: 'pago', message: 'Pagamento confirmado! Suas cotas foram liberadas.' };

  } catch (e) {
    logger.error("Erro syncPaymentStatus", e);
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', e.message);
  }
});

exports.mercadoPagoWebhook = onRequest({
  region: 'southamerica-east1',
  secrets: [MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_WEBHOOK_SECRET]
}, async (req, res) => {
  try {
    const body = req.body;
    logger.info("WEBHOOK_RAW_DATA", { 
      headers: req.headers,
      body: body,
      timestamp: new Date().toISOString()
    });

    if (!body) {
      logger.warn("Webhook recebido com corpo vazio");
      return res.status(200).send('OK');
    }

    let paymentId = null;
    if (body.data && body.data.id) paymentId = body.data.id;
    else if (body.id) paymentId = body.id;
    else if (body.resource_id) paymentId = body.resource_id;
    else if (body.data && body.data.resource_id) paymentId = body.data.resource_id;

    if (!paymentId) {
      logger.warn("Notificacao recebida sem paymentId identificavel", { body });
      return res.status(200).send('OK');
    }

    let rawToken = MERCADOPAGO_ACCESS_TOKEN.value();
    let token = String(rawToken || "").trim().replace(/^["\']|["\']$/g, '');

    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!mpResponse.ok) {
      logger.error('Erro ao consultar pagamento no MP', { paymentId, status: mpResponse.status });
      return res.status(200).send('OK');
    }

    const paymentData = await mpResponse.json();
    if (paymentData.status !== 'approved') {
      logger.info('Pagamento ainda nao aprovado', { paymentId, status: paymentData.status });
      return res.status(200).send('OK');
    }

    const ordersSnapshot = await db.collection('pedidos').where('mpPaymentId', '==', paymentId).get();
    if (ordersSnapshot.empty) {
      logger.warn('Pagamento aprovado mas pedido nao encontrado no banco', { paymentId });
      return res.status(200).send('OK');
    }

    const orderDoc = ordersSnapshot.docs[0];
    const orderData = orderDoc.data();
    const orderId = orderDoc.id;

    if (orderData.status === 'pago') {
      return res.status(200).send('OK');
    }

    await db.runTransaction(async (transaction) => {
      const publicRef = db.doc('publico/rifa');
      const publicSnap = await transaction.get(publicRef);
      const currentSold = publicSnap.exists ? (Number(publicSnap.data().soldNumbers) || 0) : 0;

      transaction.update(db.doc(`pedidos/${orderId}`), {
        status: 'pago',
        paidAt: FieldValue.serverTimestamp()
      });

      transaction.set(db.doc(`compras/${orderId}`), {
        ...orderData,
        status: 'pago',
        paidAt: FieldValue.serverTimestamp(),
        confirmadoEm: FieldValue.serverTimestamp()
      });

      transaction.set(publicRef, {
        soldNumbers: currentSold + (orderData.numeros?.length || 0)
      }, { merge: true });
    });

    logger.info('Compra processada com sucesso via Webhook', { orderId, paymentId });
    res.status(200).send('OK');

  } catch (e) {
    logger.error('Erro critico no webhook', e);
    res.status(500).send('Erro Interno');
  }
});

exports.drawXreWinner = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  try {
    // 1. Verificação de Segurança: Só permite sortear se a meta for atingida e a campanha encerrada
    const stateSnap = await publicStateRef.get();
    const state = stateSnap.exists ? stateSnap.data() : getConfigDefaults();
    const sold = Number(state.soldNumbers || 0);
    const configSnap = await raffleConfigRef.get();
    const configData = configSnap.exists ? configSnap.data() : getConfigDefaults();
    const target = Number(state.targetSoldNumbers ?? configData.targetSoldNumbers ?? TOTAL_NUMBERS_DEFAULT);
    const status = state.status || configData.status || 'preparacao';

    if (status !== 'encerrada') {
      throw new HttpsError('failed-precondition', `Sorteio bloqueado: Campanha não encerrada (status: "${status}").`);
    }

    if (sold < target) {
      throw new HttpsError('failed-precondition', `Sorteio bloqueado: Meta não atingida (${sold}/${target} vendidos).`);
    }

    // 2. Buscar todas as compras pagas
    const comprasSnap = await db.collection('compras').where('status', '==', 'pago').get();

    if (comprasSnap.empty) {
      throw new HttpsError('not-found', 'Nenhuma compra paga encontrada para realizar o sorteio.');
    }

    const docs = comprasSnap.docs;
    const randomDoc = docs[Math.floor(Math.random() * docs.length)];
    const winnerData = randomDoc.data();

    // A compra pode ter vários números, sorteamos um deles
    const numeros = winnerData.numeros || [];
    const numeroSorteado = numeros[Math.floor(Math.random() * numeros.length)];

    const result = {
      numero: numeroSorteado,
      comprador: winnerData.nome || 'Comprador não informado',
      email: winnerData.email || 'E-mail não informado',
      pedidoId: randomDoc.id,
      sorteadoEm: FieldValue.serverTimestamp()
    };

    // 3. Gravar resultado para auditoria (Imutável)
    await db.doc('sorteios/xre').set({
      ...result,
      status: 'concluido'
    });

    await db.collection('ganhadores').doc('xre').set({
      ...result,
      categoria: 'principal'
    });

    return { status: 'concluido', winner: result };
  } catch (e) {
    logger.error("Erro drawXreWinner", e);
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', e.message);
  }
});

exports.getRandomBoughtWinningQuote = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  try {
    const snapshot = await db.collection('ganhadores').where('categoria', '==', 'adicional').get();
    if (snapshot.empty) {
      throw new HttpsError('not-found', 'Nenhum ganhador adicional encontrado no banco de dados.');
    }
    const docs = snapshot.docs;
    const randomDoc = docs[Math.floor(Math.random() * docs.length)];
    const data = randomDoc.data();
    return { 
      status: 'concluido', 
      winner: { 
        numero: data.numero, 
        comprador: data.comprador || data.nome, 
        email: data.email 
      } 
    };
  } catch (e) {
    logger.error("Erro getRandomBoughtWinningQuote", e);
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', e.message);
  }
});

exports.getAdminPurchases = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const snapshot = await db.collection('compras').limit(100).get();
  return { purchases: snapshot.docs.map(d => ({ id: d.id, ...d.data() })) };
});

exports.getAdminWinners = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const snapshot = await db.collection('ganhadores').limit(100).get();
  return { winners: snapshot.docs.map(d => ({ id: d.id, ...d.data() })) };
});

exports.getMyOrders = onCall({ region: 'southamerica-east1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login necessário');
  const snapshot = await db.collection('pedidos').where('uid', '==', request.auth.uid).get();
  return { orders: snapshot.docs.map(d => ({ id: d.id, ...d.data() })) };
});

exports.expireReservations = onSchedule({
  region: 'southamerica-east1',
  schedule: 'every 5 minutes'
}, async () => {
  logger.info("Executando rotina de expiraÃ§Ã£o...");
});

exports.sendPurchaseConfirmationEmail = onDocumentCreated({
  region: 'southamerica-east1',
  document: 'compras/{purchaseId}',
  secrets: [RESEND_API_KEY]
}, async (event) => {
  logger.info("Nova compra detectada, preparando e-mail...");
});

exports.checkAdditionalPrize = onDocumentCreated({
  region: 'southamerica-east1',
  document: 'compras/{purchaseId}'
}, async (event) => {
  try {
    const purchaseDoc = await db.doc(`compras/${event.params.purchaseId}`).get();
    if (!purchaseDoc.exists) return;

    const purchaseData = purchaseDoc.data();
    if (purchaseData?.status !== 'pago') return;

    const numerosComprados = purchaseData.numeros || [];
    const compradorNome = purchaseData.nome || 'Comprador';
    const compradorEmail = purchaseData.email || 'sem email';
    const pedidoId = event.params.purchaseId;

    let addedCount = 0;
    for (const numero of numerosComprados) {
      const numFormatted = String(numero).padStart(6, '0');
      const numDoc = await db.doc(`numerosPremiados/${numFormatted}`).get();
      if (!numDoc.exists) continue;

      const numData = numDoc.data();
      if (!numData?.isWinningNumber) continue;

      const existingCheck = await db.collection('ganhadores')
        .where('numero', '==', numero)
        .where('pedidoId', '==', pedidoId)
        .limit(1)
        .get();
      if (!existingCheck.empty) continue;

      await db.collection('ganhadores').add({
        numero,
        comprador: compradorNome,
        email: compradorEmail,
        pedidoId,
        premioNome: numData.premioNome || null,
        premioTipo: numData.premioTipo || null,
        premioValorCents: numData.premioValorCents || null,
        categoria: 'adicional',
        status: 'confirmado',
        confirmadoEm: FieldValue.serverTimestamp()
      });
      addedCount++;
    }

    if (addedCount > 0) {
      logger.info(`Adicionados ${addedCount} ganhadores adicionais para pedido ${pedidoId}`);
    }
  } catch (e) {
    logger.error("Erro checkAdditionalPrize", e);
  }
});

// Force Deploy 09/05/2026 19:13:33
