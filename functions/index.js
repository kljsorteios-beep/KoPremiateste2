const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require('firebase-admin/firestore');
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
// São exatamente 10.000 cotas de prêmios adicionais. A XRE fica fora
// desta coleção e só pode ser sorteada quando o cotômetro atingir 100%.
const WINNING_NUMBERS_DEFAULT = 10000;
const ADDITIONAL_PRIZE_POOL_CENTS_DEFAULT = 1000000;
const PRICE_PER_NUMBER_CENTS_DEFAULT = 50;
const RESERVATION_MINUTES_DEFAULT = 10;
const SHARD_SIZE_DEFAULT = 1000;
const MAX_NUMBERS_PER_ORDER = 1000;

const raffleConfigRef = db.doc('configuracoes/rifa');
const raffleStateRef = db.doc('estado/rifa');
const publicStateRef = db.doc('publico/rifa');

function nowTimestamp() {
  return Timestamp.now();
}

function nowMillis() {
  return Date.now();
}

function getEnvironment(name, fallback = '') {
  return process.env[name] || fallback;
}

function getMercadoPagoBaseUrl() {
  return getEnvironment('MERCADOPAGO_API_URL', 'https://api.mercadopago.com').replace(/\/$/, '');
}

function getWebhookUrl() {
  const explicitUrl = getEnvironment('MERCADOPAGO_WEBHOOK_URL');
  if (explicitUrl) return explicitUrl;

  const projectId = getEnvironment('GCLOUD_PROJECT') || getEnvironment('GCP_PROJECT');
  if (!projectId) {
    throw new Error('Não foi possível descobrir o ID do projeto para montar a URL do webhook.');
  }
  return `https://southamerica-east1-${projectId}.cloudfunctions.net/mercadoPagoWebhook`;
}

function getSecretValue(secretParam) {
  try {
    return secretParam.value() || '';
  } catch (error) {
    return '';
  }
}

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Faça login para continuar.');
  }
  return request.auth;
}

function isAdmin(request) {
  const uid = request.auth?.uid;
  if (!uid) return false;
  if (request.auth.token?.admin === true) return true;
  const adminUids = getEnvironment('ADMIN_UIDS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return adminUids.includes(uid);
}

function requireAdmin(request) {
  const auth = requireAuth(request);
  if (!isAdmin(request)) {
    throw new HttpsError('permission-denied', 'Acesso restrito ao administrador.');
  }
  return auth;
} // <--- A função requireAdmin termina aqui com essa chave

// Agora, FORA dela, você começa a nova função:
exports.checkAdminStatus = onCall({ region: 'southamerica-east1' }, async (request) => {
  return {
    isAdmin: isAdmin(request),
  };
});
  const auth = requireAuth(request);
  if (!isAdmin(request)) {
    throw new HttpsError('permission-denied', 'Acesso restrito ao administrador.');
  }
  return auth;
}

function normalizeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function formatTicketNumber(value) {
  return String(value).padStart(6, '0');
}

function parseTicketNumber(value) {
  const parsed = Number(String(value).replace(/\D/g, ''));
  return Number.isInteger(parsed) ? parsed : 0;
}

function shardId(index) {
  return `shard_${String(index).padStart(3, '0')}`;
}

function getShardIndex(numberValue, shardSize) {
  const parsed = parseTicketNumber(numberValue);
  return Math.floor((parsed - 1) / shardSize);
}

function getConfigDefaults() {
  return {
    totalNumbers: TOTAL_NUMBERS_DEFAULT,
    totalWinningNumbers: WINNING_NUMBERS_DEFAULT,
    prizeModel: '10000_cotas_adicionais_mais_xre_posterior',
    mainPrizeName: 'Honda XRE 190 2026',
    mainPrizeDrawStatus: 'aguardando_100_porcento',
    additionalPrizeCount: WINNING_NUMBERS_DEFAULT,
    additionalPrizePoolCents: ADDITIONAL_PRIZE_POOL_CENTS_DEFAULT,
    targetSoldNumbers: TOTAL_NUMBERS_DEFAULT,
    pricePerNumberCents: PRICE_PER_NUMBER_CENTS_DEFAULT,
    reservationMinutes: RESERVATION_MINUTES_DEFAULT,
    shardSize: SHARD_SIZE_DEFAULT,
    shardCount: Math.ceil(TOTAL_NUMBERS_DEFAULT / SHARD_SIZE_DEFAULT),
    status: 'preparacao',
  };
}

function getPercent(soldNumbers, targetSoldNumbers) {
  if (!targetSoldNumbers) return 0;
  return Math.min(100, Number(((soldNumbers / targetSoldNumbers) * 100).toFixed(2)));
}

function serializeTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return value;
}

function serializeOrder(snapshot) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    ...data,
    createdAt: serializeTimestamp(data.createdAt),
    expiresAt: serializeTimestamp(data.expiresAt),
    paidAt: serializeTimestamp(data.paidAt),
    releasedAt: serializeTimestamp(data.releasedAt),
  };
}

function shuffleInPlace(values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

function chooseFromPools(poolSnapshots, quantity) {
  const shardIndexes = poolSnapshots.map((_, index) => index);
  shuffleInPlace(shardIndexes);

  const chosenNumbers = [];
  const updatedPools = new Map();
  let remaining = quantity;

  for (const snapshotIndex of shardIndexes) {
    if (remaining <= 0) break;
    const snapshot = poolSnapshots[snapshotIndex];
    const data = snapshot.exists ? snapshot.data() : null;
    const numbers = Array.isArray(data?.numbers) ? [...data.numbers] : [];
    if (!numbers.length) continue;

    const amount = Math.min(remaining, numbers.length);
    for (let offset = 0; offset < amount; offset += 1) {
      const randomIndex = offset + crypto.randomInt(numbers.length - offset);
      [numbers[offset], numbers[randomIndex]] = [numbers[randomIndex], numbers[offset]];
      chosenNumbers.push(numbers[offset]);
    }

    updatedPools.set(snapshot.ref.path, {
      ref: snapshot.ref,
      numbers: numbers.slice(amount),
    });
    remaining -= amount;
  }

  if (remaining > 0) {
    throw new HttpsError('resource-exhausted', 'Não há números disponíveis suficientes.');
  }

  return { chosenNumbers, updatedPools };
}

function groupNumbersByShard(numbers, shardSize) {
  const groups = new Map();
  for (const ticketNumber of numbers) {
    const index = getShardIndex(ticketNumber, shardSize);
    if (!groups.has(index)) groups.set(index, []);
    groups.get(index).push(formatTicketNumber(parseTicketNumber(ticketNumber)));
  }
  return groups;
}

async function updateTicketDocuments(numbers, fieldsOrFactory) {
  if (!numbers?.length) return;
  const writer = db.bulkWriter();
  const operations = numbers.map((ticketNumber) => {
    const parsedNumber = parseTicketNumber(ticketNumber);
    const fields = typeof fieldsOrFactory === 'function' ? fieldsOrFactory(parsedNumber) : fieldsOrFactory;
    const ticketRef = db.doc(`cotas/${parsedNumber}`);
    return writer.set(ticketRef, {
      numero: parsedNumber,
      ...fields,
      atualizadoEm: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  try {
    await Promise.all(operations);
  } finally {
    await writer.close();
  }
}

async function recordAdditionalWinnerDocuments(numbers, assignments, orderId, buyer) {
  const winners = (Array.isArray(numbers) ? numbers : [])
    .map((number) => parseTicketNumber(number))
    .filter((number) => assignments.has(number));
  if (!winners.length) return;

  const writer = db.bulkWriter();
  for (const number of winners) {
    const assignment = assignments.get(number) || {};
    const winnerData = {
      numero: number,
      numeroFormatado: formatTicketNumber(number),
      categoria: 'adicional',
      premioId: assignment.premioId || null,
      premioNome: assignment.premioNome || null,
      premioTipo: assignment.premioTipo || 'a-definir',
      premioValorCents: assignment.premioValorCents ?? null,
      premioStatus: assignment.premioId ? 'definido' : 'pendente',
      pedidoId: orderId,
      compradorUid: buyer.uid || null,
      comprador: buyer.name || null,
      email: buyer.email || null,
      cpf: buyer.cpf || null,
      confirmadoEm: FieldValue.serverTimestamp(),
    };
    writer.set(db.doc(`ganhadores/adicional_${formatTicketNumber(number)}`), winnerData, { merge: true });
    writer.set(db.doc(`numerosPremiados/${formatTicketNumber(number)}`), {
      status: 'vendido',
      pedidoId: orderId,
      compradorUid: buyer.uid || null,
      comprador: buyer.name || null,
      email: buyer.email || null,
      cpf: buyer.cpf || null,
      vendidoEm: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await writer.close();
}

async function getPrizeAssignmentMap(numbers = null) {
  const documents = Array.isArray(numbers)
    ? await Promise.all(numbers.map((number) => db.doc(`numerosPremiados/${formatTicketNumber(number)}`).get()))
    : (await db.collection('numerosPremiados').get()).docs;
  const assignments = new Map();
  for (const document of documents) {
    if (!document.exists) continue;
    const data = document.data() || {};
    // A coleção contém os 10.000 vencedores adicionais. O catálogo do prêmio
    // pode ficar pendente, mas a cota já deve ser marcada como vencedora.
    if (data.isWinningNumber === false) continue;
    const number = parseTicketNumber(data.numero || document.id);
    if (number < 1 || number > TOTAL_NUMBERS_DEFAULT) continue;
    assignments.set(number, {
      premioId: data.premioId || null,
      premioNome: data.premioNome || null,
      premioTipo: data.premioTipo || null,
      premioValorCents: Number.isInteger(Number(data.premioValorCents))
        ? Number(data.premioValorCents)
        : null,
      prizeCategory: data.prizeCategory || 'adicional',
    });
  }
  return assignments;
}

async function refreshPublicState(transaction, stateData, configData) {
  const soldNumbers = Number(stateData.soldNumbers || 0);
  const reservedNumbers = Number(stateData.reservedNumbers || 0);
  const targetSoldNumbers = Number(configData.targetSoldNumbers || configData.totalNumbers);
  const raffleStatus = stateData.status || configData.status || 'preparacao';

  transaction.set(publicStateRef, {
    totalNumbers: Number(configData.totalNumbers),
    targetSoldNumbers,
    prizeModel: configData.prizeModel || '10000_cotas_adicionais_mais_xre_posterior',
    mainPrizeName: configData.mainPrizeName || 'Honda XRE 190 2026',
    mainPrizeDrawStatus: configData.mainPrizeDrawStatus || 'aguardando_100_porcento',
    additionalPrizeCount: Number(configData.additionalPrizeCount ?? WINNING_NUMBERS_DEFAULT),
    additionalPrizePoolCents: Number(configData.additionalPrizePoolCents ?? ADDITIONAL_PRIZE_POOL_CENTS_DEFAULT),
    pricePerNumberCents: Number(configData.pricePerNumberCents),
    soldNumbers,
    reservedNumbers,
    remainingNumbers: Math.max(0, targetSoldNumbers - soldNumbers - reservedNumbers),
    percentSold: getPercent(soldNumbers, targetSoldNumbers),
    status: raffleStatus,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function releaseReservationInternal(orderId, reason = 'expirada') {
  const orderRef = db.doc(`pedidos/${orderId}`);
  let releasedNumbers = [];
  let releasedUid = null;

  await db.runTransaction(async (transaction) => {
    const [orderSnapshot, configSnapshot, stateSnapshot] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(raffleConfigRef),
      transaction.get(raffleStateRef),
    ]);

    if (!orderSnapshot.exists) return;
    const order = orderSnapshot.data();
    if (!['aguardando_pagamento', 'criando_pagamento'].includes(order.status)) return;

    const config = configSnapshot.exists ? configSnapshot.data() : getConfigDefaults();
    const state = stateSnapshot.exists ? stateSnapshot.data() : {
      soldNumbers: 0,
      reservedNumbers: 0,
      status: 'aberta',
    };
    releasedNumbers = Array.isArray(order.numeros) ? order.numeros : [];
    releasedUid = order.uid || null;

    const groups = groupNumbersByShard(releasedNumbers, Number(config.shardSize || SHARD_SIZE_DEFAULT));
    const poolSnapshots = new Map();
    for (const shardIndex of groups.keys()) {
      const ref = db.doc(`disponibilidade/${shardId(shardIndex)}`);
      poolSnapshots.set(shardIndex, await transaction.get(ref));
    }

    for (const [shardIndex, numbers] of groups.entries()) {
      const snapshot = poolSnapshots.get(shardIndex);
      const current = snapshot.exists && Array.isArray(snapshot.data().numbers)
        ? snapshot.data().numbers
        : [];
      const merged = Array.from(new Set([...current, ...numbers]));
      transaction.set(snapshot.ref, {
        shardIndex,
        numbers: shuffleInPlace(merged),
        availableCount: merged.length,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    const newState = {
      ...state,
      reservedNumbers: Math.max(0, Number(state.reservedNumbers || 0) - releasedNumbers.length),
    };

    transaction.update(orderRef, {
      status: reason === 'erro_mercadopago' ? 'cancelado' : 'expirada',
      releaseReason: reason,
      releasedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(raffleStateRef, {
      reservedNumbers: newState.reservedNumbers,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await refreshPublicState(transaction, newState, config);
  });

  if (releasedNumbers.length) {
    await updateTicketDocuments(releasedNumbers, {
      status: 'disponivel',
      pedidoId: null,
      comprador: null,
      cpf: null,
      compradorUid: null,
      reservadoAte: null,
    });
  }

  logger.info('Reserva liberada', { orderId, releasedUid, quantity: releasedNumbers.length, reason });
  return releasedNumbers.length;
}

async function confirmPaidOrder(orderId, payload) {
  const orderRef = db.doc(`pedidos/${orderId}`);
  let numbersToMark = [];
  let buyerUid = null;
  let buyerName = null;
  let buyerCpf = null;
  let buyerEmail = null;
  let paid = false;

  await db.runTransaction(async (transaction) => {
    const [orderSnapshot, configSnapshot, stateSnapshot] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(raffleConfigRef),
      transaction.get(raffleStateRef),
    ]);

    if (!orderSnapshot.exists) {
      throw new Error(`Pedido ${orderId} não encontrado.`);
    }

    const order = orderSnapshot.data();
    buyerUid = order.uid || null;
    buyerName = order.nome || null;
    buyerCpf = order.cpf || null;
    buyerEmail = order.email || null;
    if (order.status === 'pago') {
      paid = true;
      return;
    }

    const payment = payload.payment || payload;
    const paidAmount = Math.round(Number(payment.transaction_amount || 0) * 100);
    const paidCurrency = String(payment.currency_id || 'BRL');
    if (payment.status !== 'approved' || paidAmount !== Number(order.totalCents) || paidCurrency !== 'BRL') {
      transaction.update(orderRef, {
        status: 'pagamento_inconsistente',
        mercadopagoPayload: payload,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    const config = configSnapshot.exists ? configSnapshot.data() : getConfigDefaults();
    const state = stateSnapshot.exists ? stateSnapshot.data() : {
      soldNumbers: 0,
      reservedNumbers: 0,
      status: 'aberta',
    };
    const now = nowMillis();
    const expiresAt = order.expiresAt?.toMillis ? order.expiresAt.toMillis() : 0;
    const orderNumbers = Array.isArray(order.numeros) ? order.numeros : [];

    if (expiresAt && expiresAt < now) {
      transaction.update(orderRef, {
        status: 'pagamento_tardio',
        mercadopagoPayload: payload,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    const newSoldNumbers = Number(state.soldNumbers || 0) + orderNumbers.length;
    const newReservedNumbers = Math.max(0, Number(state.reservedNumbers || 0) - orderNumbers.length);
    const targetSoldNumbers = Number(config.targetSoldNumbers || config.totalNumbers);
    const newStatus = newSoldNumbers >= targetSoldNumbers ? 'encerrada' : (state.status || 'aberta');

    numbersToMark = orderNumbers;
    paid = true;

    transaction.update(orderRef, {
      status: 'pago',
      paidAt: FieldValue.serverTimestamp(),
      mercadopagoPaymentId: String(payload.id || order.mercadopagoPaymentId || ''),
      mercadopagoPayload: payload,
      updatedAt: FieldValue.serverTimestamp(),
    });

    transaction.set(db.doc(`compras/${orderId}`), {
      pedidoId: orderId,
      uid: order.uid,
      email: order.email || null,
      nome: order.nome || null,
      cpf: order.cpf || null,
      nomeRifa: order.nomeRifa || 'Kóòpremia — Honda XRE 190 2026',
      numeros: orderNumbers,
      quantidade: orderNumbers.length,
      totalCents: order.totalCents,
      status: 'pago',
      mercadopagoPaymentId: String(payload.id || order.mercadopagoPaymentId || ''),
      paidAt: FieldValue.serverTimestamp(),
      criadoEm: FieldValue.serverTimestamp(),
    }, { merge: true });

    const newState = {
      ...state,
      soldNumbers: newSoldNumbers,
      reservedNumbers: newReservedNumbers,
      status: newStatus,
    };
    transaction.set(raffleStateRef, {
      soldNumbers: newSoldNumbers,
      reservedNumbers: newReservedNumbers,
      status: newStatus,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await refreshPublicState(transaction, newState, config);
  });

  if (paid && numbersToMark.length) {
    const prizeAssignments = await getPrizeAssignmentMap(numbersToMark);
    await updateTicketDocuments(numbersToMark, (ticketNumber) => ({
      status: 'indisponivel',
      premiada: prizeAssignments.has(ticketNumber),
      premioId: prizeAssignments.get(ticketNumber)?.premioId || null,
      premioNome: prizeAssignments.get(ticketNumber)?.premioNome || null,
      premioTipo: prizeAssignments.get(ticketNumber)?.premioTipo || null,
      premioValorCents: prizeAssignments.get(ticketNumber)?.premioValorCents ?? null,
      pedidoId: orderId,
      comprador: buyerName,
      cpf: buyerCpf,
      compradorUid: buyerUid,
      reservadoAte: null,
      vendidoEm: FieldValue.serverTimestamp(),
    }));
    await recordAdditionalWinnerDocuments(numbersToMark, prizeAssignments, orderId, {
      uid: buyerUid,
      name: buyerName,
      cpf: buyerCpf,
      email: buyerEmail,
    });
  }

  return { paid, quantity: numbersToMark.length };
}

async function createMercadoPagoPayment({ orderId, user, quantity, totalCents, expiresAt }) {
  const accessToken = getSecretValue(MERCADOPAGO_ACCESS_TOKEN);
  if (!accessToken) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN não configurado.');
  }

  const email = String(user.email || '').trim();
  if (!email) throw new Error('O comprador precisa ter um e-mail válido para gerar o Pix.');
  const taxId = String(user.cpf || '').replace(/\D/g, '');
  const payer = { email };
  if (taxId.length === 11) payer.identification = { type: 'CPF', number: taxId };

  const response = await fetch(`${getMercadoPagoBaseUrl()}/v1/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Idempotency-Key': orderId,
    },
    body: JSON.stringify({
      transaction_amount: Number((totalCents / 100).toFixed(2)),
      description: `Cotas Kóòpremia (${quantity})`,
      payment_method_id: 'pix',
      payer,
      external_reference: orderId,
      date_of_expiration: new Date(expiresAt).toISOString(),
      notification_url: getWebhookUrl(),
      metadata: { order_id: orderId, quantity },
    }),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    body = { raw: bodyText };
  }

  if (!response.ok) {
    logger.error('Falha ao criar pagamento Mercado Pago', { status: response.status, body });
    throw new Error(`Mercado Pago retornou HTTP ${response.status}.`);
  }

  const transactionData = body.point_of_interaction?.transaction_data;
  if (!body.id || !transactionData?.qr_code) {
    throw new Error('Mercado Pago não retornou um QR Code Pix válido.');
  }

  return {
    mercadopagoPaymentId: String(body.id),
    pixCopyPaste: transactionData.qr_code,
    qrCodeImageUrl: transactionData.qr_code_base64
      ? `data:image/png;base64,${transactionData.qr_code_base64}`
      : null,
    mercadopagoStatus: body.status || 'pending',
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '\"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function formatOrderNumbers(numbers) {
  return (Array.isArray(numbers) ? numbers : [])
    .map((number) => formatTicketNumber(number))
    .join(', ');
}

async function sendPurchaseConfirmationEmail(purchaseId, purchase) {
  const apiKey = getSecretValue(RESEND_API_KEY);
  const from = getEnvironment('EMAIL_FROM');
  if (!purchase.email) return { status: 'sem_email' };
  if (!apiKey || !from) {
    logger.warn('Confirmação de e-mail aguardando configuração', { purchaseId });
    return { status: 'aguardando_configuracao' };
  }

  const buyerName = purchase.nome || 'participante';
  const numbers = formatOrderNumbers(purchase.numeros);
  const subject = `Compra confirmada — ${purchase.nomeRifa || 'Kóòpremios'}`;
  const text = [
    `Olá, ${buyerName}!`,
    '',
    'Seu pagamento foi confirmado e seus números estão registrados:',
    numbers || 'Nenhum número informado',
    '',
    'Guarde esta mensagem. Você também pode consultar seus títulos na área Minha conta do site.',
  ].join('\\n');
  const html = `
    <p>Olá, <strong>${escapeHtml(buyerName)}</strong>!</p>
    <p>Seu pagamento foi confirmado e seus números estão registrados:</p>
    <p><strong>${escapeHtml(numbers || 'Nenhum número informado')}</strong></p>
    <p>Guarde esta mensagem. Você também pode consultar seus títulos na área Minha conta do site.</p>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      from,
      to: purchase.email,
      subject,
      text,
      html,
      tags: [
        { name: 'tipo', value: 'confirmacao-compra' },
        { name: 'pedido', value: purchaseId },
      ],
    }),
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (error) {
    body = { raw: bodyText };
  }
  if (!response.ok) {
    logger.error('Falha ao enviar confirmação por e-mail', {
      purchaseId,
      status: response.status,
      body,
    });
    throw new Error(`Resend retornou HTTP ${response.status}.`);
  }

  return {
    status: 'enviado',
    provider: 'resend',
    providerMessageId: body.id || null,
  };
}

exports.sendPurchaseConfirmationEmail = onDocumentCreated({
  region: 'southamerica-east1',
  document: 'compras/{purchaseId}',
  secrets: [RESEND_API_KEY],
  retry: true,
}, async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const purchase = snapshot.data() || {};
  if (purchase.status !== 'pago' || purchase.confirmationEmail?.status === 'enviado') return;

  const delivery = await sendPurchaseConfirmationEmail(snapshot.id, purchase);
  await snapshot.ref.set({
    confirmationEmail: {
      ...delivery,
      updatedAt: FieldValue.serverTimestamp(),
    },
  }, { merge: true });
});

exports.checkAdminStatus = onCall({ region: 'southamerica-east1' }, async (request) => {
  try {
    requireAdmin(request);
    return { isAdmin: true };
  } catch (error) {
    return { isAdmin: false };
  }
});

exports.getRandomBoughtWinningQuote = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const snapshot = await db.collection('ganhadores').where('categoria', '==', 'adicional').get();
  if (snapshot.empty) {
    throw new HttpsError('not-found', 'Nenhuma cota premiada adicional foi comprada ainda.');
  }
  const docs = snapshot.docs;
  const randomDoc = docs[crypto.randomInt(docs.length)];
  return {
    winner: randomDoc.data(),
    id: randomDoc.id,
  };
});

exports.getPublicRaffleState = onCall({ region: 'southamerica-east1' }, async () => {
  const snapshot = await publicStateRef.get();
  if (!snapshot.exists) {
    const defaults = getConfigDefaults();
    return {
      totalNumbers: defaults.totalNumbers,
      targetSoldNumbers: defaults.targetSoldNumbers,
      prizeModel: defaults.prizeModel,
      mainPrizeName: defaults.mainPrizeName,
      additionalPrizePoolCents: defaults.additionalPrizePoolCents,
      pricePerNumberCents: defaults.pricePerNumberCents,
      soldNumbers: 0,
      reservedNumbers: 0,
      remainingNumbers: defaults.targetSoldNumbers,
      percentSold: 0,
      status: 'preparacao',
    };
  }
  return snapshot.data();
});

exports.createPixOrder = onCall({
  region: 'southamerica-east1',
  secrets: [MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_WEBHOOK_SECRET],
}, async (request) => {
  const auth = requireAuth(request);
  const quantity = normalizeInteger(request.data?.quantity, 0);
  if (quantity < 1 || quantity > MAX_NUMBERS_PER_ORDER) {
    throw new HttpsError('invalid-argument', `Escolha entre 1 e ${MAX_NUMBERS_PER_ORDER} números.`);
  }

  const orderId = crypto.randomUUID();
  let selectedNumbers = [];
  let userData = null;
  let totalCents = 0;
  let expiresAtMillis = 0;
  let mercadoPagoRequestStarted = false;

  try {
    await db.runTransaction(async (transaction) => {
      const [configSnapshot, stateSnapshot, userSnapshot] = await Promise.all([
        transaction.get(raffleConfigRef),
        transaction.get(raffleStateRef),
        transaction.get(db.doc(`usuarios/${auth.uid}`)),
      ]);

      const config = configSnapshot.exists ? configSnapshot.data() : getConfigDefaults();
      const state = stateSnapshot.exists ? stateSnapshot.data() : {
        soldNumbers: 0,
        reservedNumbers: 0,
        status: 'aberta',
      };
      userData = userSnapshot.exists ? userSnapshot.data() : {};

      const raffleStatus = state.status || config.status;
      const targetSoldNumbers = Number(config.targetSoldNumbers || config.totalNumbers);
      const committedNumbers = Number(state.soldNumbers || 0) + Number(state.reservedNumbers || 0);
      if (raffleStatus !== 'aberta' || committedNumbers + quantity > targetSoldNumbers) {
        throw new HttpsError('failed-precondition', 'As vendas estão encerradas ou não há números suficientes para este pedido.');
      }

      const shardCount = Number(config.shardCount || Math.ceil(config.totalNumbers / config.shardSize));
      const poolSnapshots = [];
      for (let index = 0; index < shardCount; index += 1) {
        poolSnapshots.push(await transaction.get(db.doc(`disponibilidade/${shardId(index)}`)));
      }

      const picked = chooseFromPools(poolSnapshots, quantity);
      selectedNumbers = picked.chosenNumbers;
      totalCents = quantity * Number(config.pricePerNumberCents || PRICE_PER_NUMBER_CENTS_DEFAULT);
      const reservationMinutes = Number(config.reservationMinutes || RESERVATION_MINUTES_DEFAULT);
      expiresAtMillis = nowMillis() + reservationMinutes * 60 * 1000;

      for (const poolUpdate of picked.updatedPools.values()) {
        transaction.update(poolUpdate.ref, {
          numbers: poolUpdate.numbers,
          availableCount: poolUpdate.numbers.length,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }

      const newState = {
        ...state,
        reservedNumbers: Number(state.reservedNumbers || 0) + quantity,
      };
      const orderRef = db.doc(`pedidos/${orderId}`);
      transaction.set(orderRef, {
        uid: auth.uid,
        email: auth.token.email || userData.email || null,
        nome: userData.nome || userData.name || auth.token.name || null,
        cpf: userData.cpf || null,
        nomeRifa: 'Kóòpremia — Honda XRE 190 2026',
        numeros: selectedNumbers,
        quantidade: quantity,
        totalCents,
        status: 'criando_pagamento',
        expiresAt: Timestamp.fromMillis(expiresAtMillis),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.set(raffleStateRef, {
        reservedNumbers: newState.reservedNumbers,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await refreshPublicState(transaction, newState, config);
    });

    const prizeAssignments = await getPrizeAssignmentMap(selectedNumbers);
    await updateTicketDocuments(selectedNumbers, (ticketNumber) => ({
      status: 'reservada',
      premiada: prizeAssignments.has(ticketNumber),
      premioId: prizeAssignments.get(ticketNumber)?.premioId || null,
      premioNome: prizeAssignments.get(ticketNumber)?.premioNome || null,
      premioTipo: prizeAssignments.get(ticketNumber)?.premioTipo || null,
      premioValorCents: prizeAssignments.get(ticketNumber)?.premioValorCents ?? null,
      pedidoId: orderId,
      comprador: userData.nome || userData.name || auth.token.name || null,
      cpf: userData.cpf || null,
      compradorUid: auth.uid,
      reservadoAte: Timestamp.fromMillis(expiresAtMillis),
    }));

    mercadoPagoRequestStarted = true;
    const pix = await createMercadoPagoPayment({
      orderId,
      user: {
        ...userData,
        email: auth.token.email || userData.email,
      },
      quantity,
      totalCents,
      expiresAt: expiresAtMillis,
    });

    await db.doc(`pedidos/${orderId}`).update({
      status: 'aguardando_pagamento',
      ...pix,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      orderId,
      numbers: selectedNumbers,
      quantity,
      totalCents,
      expiresAt: new Date(expiresAtMillis).toISOString(),
      ...pix,
    };
  } catch (error) {
    logger.error('Erro ao criar pedido Pix', { orderId, error: error.message });
    if (!mercadoPagoRequestStarted) {
      await releaseReservationInternal(orderId, 'erro_mercadopago').catch((releaseError) => {
        logger.error('Falha ao liberar reserva após erro', { orderId, error: releaseError.message });
      });
    } else {
      logger.warn('Pagamento Mercado Pago iniciado; reserva será resolvida por webhook ou expiração', { orderId });
    }

    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'Não foi possível criar o pedido Pix.');
  }
});

function isValidMercadoPagoSignature(request, paymentId) {
  const secret = getSecretValue(MERCADOPAGO_WEBHOOK_SECRET);
  if (!secret) return false;
  const signature = String(request.get('x-signature') || '');
  const requestId = String(request.get('x-request-id') || '');
  const parts = Object.fromEntries(signature.split(',').map((item) => item.trim().split('=')));
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1 || !requestId || !paymentId) return false;
  const manifest = `id:${String(paymentId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest, 'utf8').digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(v1, 'utf8');
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

exports.mercadoPagoWebhook = onRequest({
  region: 'southamerica-east1',
  secrets: [MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_WEBHOOK_SECRET],
}, async (request, response) => {
  if (request.method !== 'POST') {
    response.status(405).send('Método não permitido.');
    return;
  }

  const payload = request.body || {};
  const paymentId = String(payload.data?.id || request.query['data.id'] || '');
  const topic = String(payload.type || payload.topic || '').toLowerCase();
  if (topic && topic !== 'payment') {
    response.status(200).send('Evento ignorado.');
    return;
  }
  if (!paymentId || !isValidMercadoPagoSignature(request, paymentId)) {
    response.status(401).send('Assinatura inválida ou webhook não configurado.');
    return;
  }

  const accessToken = getSecretValue(MERCADOPAGO_ACCESS_TOKEN);
  if (!accessToken) {
    response.status(503).send('Mercado Pago não configurado.');
    return;
  }

  try {
    const paymentResponse = await fetch(`${getMercadoPagoBaseUrl()}/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const paymentText = await paymentResponse.text();
    let payment;
    try {
      payment = JSON.parse(paymentText);
    } catch (error) {
      payment = { raw: paymentText };
    }
    if (!paymentResponse.ok) {
      logger.error('Falha ao consultar pagamento Mercado Pago', { paymentId, status: paymentResponse.status, payment });
      response.status(500).send('Falha temporária.');
      return;
    }

    const orderId = String(payment.external_reference || payment.metadata?.order_id || '');
    if (orderId && payment.status === 'approved') {
      await confirmPaidOrder(orderId, { id: paymentId, payment, provider: 'mercadopago' });
    }
    response.status(200).send('OK');
  } catch (error) {
    logger.error('Falha ao processar webhook Mercado Pago', { paymentId, error: error.message });
    response.status(500).send('Falha temporária.');
  }
});

exports.expireReservations = onSchedule({
  region: 'southamerica-east1',
  schedule: 'every 5 minutes',
  timeZone: 'America/Sao_Paulo',
}, async () => {
  const expiredSnapshot = await db.collection('pedidos')
    .where('status', 'in', ['aguardando_pagamento', 'criando_pagamento'])
    .where('expiresAt', '<=', nowTimestamp())
    .limit(50)
    .get();

  for (const orderSnapshot of expiredSnapshot.docs) {
    await releaseReservationInternal(orderSnapshot.id, 'expirada');
  }

  logger.info('Rotina de expiração concluída', { count: expiredSnapshot.size });
});

exports.getWinningNumbers = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const pageSize = Math.min(500, Math.max(1, normalizeInteger(request.data?.pageSize, 200)));
  const startAfter = String(request.data?.startAfter || '');
  let query = db.collection('numerosPremiados').orderBy('numero').limit(pageSize);
  if (startAfter) query = query.startAfter(Number(startAfter));

  const snapshot = await query.get();
  const numbers = snapshot.docs.map((doc) => doc.data().numero);
  return {
    numbers,
    nextStartAfter: numbers.length ? numbers[numbers.length - 1] : null,
    hasMore: numbers.length === pageSize,
  };
});

exports.updateRaffleConfig = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const currentSnapshot = await raffleConfigRef.get();
  const current = currentSnapshot.exists ? currentSnapshot.data() : getConfigDefaults();
  const requestedTarget = request.data?.targetSoldNumbers;
  const requestedStatus = request.data?.status;
  const targetSoldNumbers = requestedTarget === undefined
    ? Number(current.targetSoldNumbers)
    : normalizeInteger(requestedTarget, 0);

  if (targetSoldNumbers < 1 || targetSoldNumbers > Number(current.totalNumbers)) {
    throw new HttpsError('invalid-argument', 'O limite de vendas deve estar entre 1 e o total de números.');
  }
  if (requestedStatus && !['preparacao', 'aberta', 'encerrada'].includes(requestedStatus)) {
    throw new HttpsError('invalid-argument', 'Status de rifa inválido.');
  }

  await db.runTransaction(async (transaction) => {
    const stateSnapshot = await transaction.get(raffleStateRef);
    const state = stateSnapshot.exists ? stateSnapshot.data() : { soldNumbers: 0, reservedNumbers: 0 };
    const status = requestedStatus || current.status || 'preparacao';
    transaction.set(raffleConfigRef, {
      ...current,
      targetSoldNumbers,
      status,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(raffleStateRef, {
      status,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await refreshPublicState(transaction, { ...state, status }, { ...current, targetSoldNumbers, status });
  });

  return { targetSoldNumbers, status: requestedStatus || current.status || 'preparacao' };
});

function serializeWinner(snapshot) {
  const data = snapshot.data() || {};
  return {
    id: snapshot.id,
    ...data,
    confirmadoEm: serializeTimestamp(data.confirmadoEm),
    sorteadoEm: serializeTimestamp(data.sorteadoEm),
  };
}

exports.getAdminPurchases = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const pageSize = Math.min(200, Math.max(1, normalizeInteger(request.data?.pageSize, 100)));
  const startAfter = request.data?.startAfter ? Timestamp.fromMillis(Number(request.data.startAfter)) : null;
  let query = db.collection('compras').orderBy('criadoEm', 'desc').limit(pageSize);
  if (startAfter) query = query.startAfter(startAfter);
  const snapshot = await query.get();
  const purchases = snapshot.docs.map((document) => ({
    id: document.id,
    ...document.data(),
    criadoEm: serializeTimestamp(document.data().criadoEm),
    paidAt: serializeTimestamp(document.data().paidAt),
  }));
  const last = snapshot.docs.at(-1)?.data()?.criadoEm;
  return {
    purchases,
    nextStartAfter: last?.toMillis ? last.toMillis() : null,
    hasMore: purchases.length === pageSize,
  };
});

exports.getAdminWinners = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const pageSize = Math.min(200, Math.max(1, normalizeInteger(request.data?.pageSize, 100)));
  const startAfter = normalizeInteger(request.data?.startAfter, 0);
  let query = db.collection('ganhadores').orderBy('numero').limit(pageSize);
  if (startAfter) query = query.startAfter(startAfter);
  const snapshot = await query.get();
  const winners = snapshot.docs.map(serializeWinner).filter((winner) => winner.categoria === 'adicional');
  const nextStartAfter = winners.length ? Number(winners[winners.length - 1].numero) : null;
  return { winners, nextStartAfter, hasMore: snapshot.docs.length === pageSize };
});

exports.drawXreWinner = onCall({ region: 'southamerica-east1' }, async (request) => {
  const auth = requireAdmin(request);
  const drawRef = db.doc('sorteios/xre');
  let shouldProceed = false;
  let completedDraw = null;

  await db.runTransaction(async (transaction) => {
    const [drawSnapshot, stateSnapshot, configSnapshot] = await Promise.all([
      transaction.get(drawRef),
      transaction.get(raffleStateRef),
      transaction.get(raffleConfigRef),
    ]);
    if (drawSnapshot.exists && drawSnapshot.data()?.status === 'concluido') {
      completedDraw = drawSnapshot.data();
      return;
    }
    if (drawSnapshot.exists && drawSnapshot.data()?.status === 'sorteando') {
      throw new HttpsError('already-exists', 'Já existe um sorteio da XRE em andamento.');
    }
    const state = stateSnapshot.exists ? stateSnapshot.data() : {};
    const config = configSnapshot.exists ? configSnapshot.data() : getConfigDefaults();
    const soldNumbers = Number(state.soldNumbers || 0);
    const targetSoldNumbers = Number(config.targetSoldNumbers || config.totalNumbers || TOTAL_NUMBERS_DEFAULT);
    if (soldNumbers < targetSoldNumbers || state.status !== 'encerrada') {
      throw new HttpsError('failed-precondition', 'O sorteio da XRE só pode ocorrer quando o cotômetro atingir 100%.');
    }
    transaction.set(drawRef, {
      status: 'sorteando',
      startedAt: FieldValue.serverTimestamp(),
      startedByUid: auth.uid,
      targetSoldNumbers,
      soldNumbers,
    }, { merge: true });
    shouldProceed = true;
  });

  if (completedDraw) return { status: 'concluido', winner: completedDraw };
  if (!shouldProceed) throw new HttpsError('failed-precondition', 'Não foi possível iniciar o sorteio.');

  try {
    const [purchasesSnapshot, additionalWinnersSnapshot] = await Promise.all([
      db.collection('compras').where('status', '==', 'pago').get(),
      db.collection('ganhadores').where('categoria', '==', 'adicional').get(),
    ]);
    const additionalNumbers = new Set(additionalWinnersSnapshot.docs.map((document) => Number(document.data()?.numero)));
    const candidates = [];
    for (const purchaseSnapshot of purchasesSnapshot.docs) {
      const purchase = purchaseSnapshot.data() || {};
      for (const rawNumber of Array.isArray(purchase.numeros) ? purchase.numeros : []) {
        const number = parseTicketNumber(rawNumber);
        if (number >= 1 && number <= TOTAL_NUMBERS_DEFAULT && !additionalNumbers.has(number)) {
          candidates.push({
            numero: number,
            pedidoId: purchase.pedidoId || purchaseSnapshot.id,
            uid: purchase.uid || null,
            nome: purchase.nome || null,
            email: purchase.email || null,
            cpf: purchase.cpf || null,
          });
        }
      }
    }
    if (!candidates.length) throw new Error('Nenhum número elegível para a XRE.');
    const selected = candidates[crypto.randomInt(candidates.length)];
    const configSnapshot = await raffleConfigRef.get();
    const config = configSnapshot.exists ? configSnapshot.data() : getConfigDefaults();
    const winner = {
      categoria: 'principal',
      premioId: 'xre-190-2026',
      premioNome: config.mainPrizeName || 'Honda XRE 190 2026',
      premioTipo: 'principal',
      numero: selected.numero,
      numeroFormatado: formatTicketNumber(selected.numero),
      pedidoId: selected.pedidoId,
      compradorUid: selected.uid,
      comprador: selected.nome,
      email: selected.email,
      cpf: selected.cpf,
      categoriaElegibilidade: 'comprado_e_nao_premiado_adicional',
      candidatoCount: candidates.length,
      sorteadoPorUid: auth.uid,
      sorteadoEm: FieldValue.serverTimestamp(),
      status: 'concluido',
    };

    await db.runTransaction(async (transaction) => {
      const [drawSnapshot, stateSnapshot] = await Promise.all([
        transaction.get(drawRef),
        transaction.get(raffleStateRef),
      ]);
      if (drawSnapshot.data()?.status === 'concluido') return;
      const state = stateSnapshot.exists ? stateSnapshot.data() : {};
      if (Number(state.soldNumbers || 0) < Number(state.targetSoldNumbers || config.targetSoldNumbers || TOTAL_NUMBERS_DEFAULT)) {
        throw new HttpsError('failed-precondition', 'A campanha deixou de estar completa; o sorteio foi cancelado.');
      }
      transaction.set(drawRef, winner, { merge: true });
      transaction.set(db.doc('ganhadores/xre'), winner, { merge: true });
    });

    await updateTicketDocuments([selected.numero], {
      status: 'indisponivel',
      premiada: true,
      premioId: winner.premioId,
      premioNome: winner.premioNome,
      premioTipo: winner.premioTipo,
      pedidoId: selected.pedidoId,
      comprador: selected.nome,
      cpf: selected.cpf,
      compradorUid: selected.uid,
      vendidoEm: FieldValue.serverTimestamp(),
    });
    logger.info('Sorteio da XRE concluído', { numero: selected.numero, pedidoId: selected.pedidoId, candidateCount: candidates.length });
    return { status: 'concluido', winner: { ...winner, sorteadoEm: new Date().toISOString() } };
  } catch (error) {
    await drawRef.set({ status: 'erro', errorMessage: error.message, failedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'Não foi possível concluir o sorteio da XRE.');
  }
});

exports.getMyOrders = onCall({ region: 'southamerica-east1' }, async (request) => {
  const auth = requireAuth(request);
  const snapshot = await db.collection('pedidos')
    .where('uid', '==', auth.uid)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  return { orders: snapshot.docs.map(serializeOrder) };
});
