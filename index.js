const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require('firebase-admin/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

initializeApp();
const db = getFirestore();

const PAGBANK_ACCESS_TOKEN = defineSecret('PAGBANK_ACCESS_TOKEN');
const PAGBANK_WEBHOOK_TOKEN = defineSecret('PAGBANK_WEBHOOK_TOKEN');

const TOTAL_NUMBERS_DEFAULT = 150000;
const WINNING_NUMBERS_DEFAULT = 10000;
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

function getPagBankBaseUrl() {
  return getEnvironment('PAGBANK_API_URL', 'https://sandbox.api.pagseguro.com').replace(/\/$/, '');
}

function getWebhookUrl() {
  const explicitUrl = getEnvironment('PAGBANK_WEBHOOK_URL');
  if (explicitUrl) return explicitUrl;

  const projectId = getEnvironment('GCLOUD_PROJECT') || getEnvironment('GCP_PROJECT');
  if (!projectId) {
    throw new Error('Não foi possível descobrir o ID do projeto para montar a URL do webhook.');
  }
  return `https://southamerica-east1-${projectId}.cloudfunctions.net/pagbankWebhook`;
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
  requireAuth(request);
  if (!isAdmin(request)) {
    throw new HttpsError('permission-denied', 'Acesso restrito ao administrador.');
  }
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

async function getWinningNumberSet() {
  const snapshot = await db.doc('auditoria/rifa').get();
  const numbers = snapshot.exists && Array.isArray(snapshot.data()?.winnerNumbers)
    ? snapshot.data().winnerNumbers
    : [];
  return new Set(numbers.map(parseTicketNumber).filter((number) => number >= 1 && number <= TOTAL_NUMBERS_DEFAULT));
}

async function refreshPublicState(transaction, stateData, configData) {
  const soldNumbers = Number(stateData.soldNumbers || 0);
  const reservedNumbers = Number(stateData.reservedNumbers || 0);
  const targetSoldNumbers = Number(configData.targetSoldNumbers || configData.totalNumbers);
  const raffleStatus = stateData.status || configData.status || 'preparacao';

  transaction.set(publicStateRef, {
    totalNumbers: Number(configData.totalNumbers),
    targetSoldNumbers,
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
      status: reason === 'erro_pagbank' ? 'cancelado' : 'expirada',
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
    if (order.status === 'pago') {
      paid = true;
      return;
    }

    const paidCharge = Array.isArray(payload.charges)
      ? payload.charges.find((charge) => charge.status === 'PAID')
      : null;
    const paidAmount = Number(paidCharge?.amount?.value || 0);
    const paidCurrency = paidCharge?.amount?.currency || 'BRL';
    if (!paidCharge || paidAmount !== Number(order.totalCents) || paidCurrency !== 'BRL') {
      transaction.update(orderRef, {
        status: 'pagamento_inconsistente',
        pagbankPayload: payload,
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
        pagbankPayload: payload,
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
      pagbankOrderId: payload.id || order.pagbankOrderId || null,
      pagbankPayload: payload,
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
      pagbankOrderId: payload.id || order.pagbankOrderId || null,
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
    const winningNumbers = await getWinningNumberSet();
    await updateTicketDocuments(numbersToMark, (ticketNumber) => ({
      status: 'indisponivel',
      premiada: winningNumbers.has(ticketNumber),
      pedidoId: orderId,
      comprador: buyerName,
      cpf: buyerCpf,
      compradorUid: buyerUid,
      reservadoAte: null,
      vendidoEm: FieldValue.serverTimestamp(),
    }));
  }

  return { paid, quantity: numbersToMark.length };
}

async function createPagBankOrder({ orderId, user, quantity, totalCents, expiresAt }) {
  const accessToken = getSecretValue(PAGBANK_ACCESS_TOKEN);
  if (!accessToken) {
    throw new Error('PAGBANK_ACCESS_TOKEN não configurado.');
  }

  const customer = {
    name: user.nome || user.name || 'Cliente Kóòpremia',
    email: user.email,
  };
  const taxId = String(user.cpf || '').replace(/\D/g, '');
  if (taxId.length === 11) customer.tax_id = taxId;

  const response = await fetch(`${getPagBankBaseUrl()}/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-idempotency-key': orderId,
    },
    body: JSON.stringify({
      reference_id: orderId,
      customer,
      items: [{
        reference_id: `cotas-${quantity}`,
        name: 'Cotas Kóòpremia',
        quantity: 1,
        unit_amount: totalCents,
      }],
      qr_codes: [{
        amount: { value: totalCents },
        expiration_date: new Date(expiresAt).toISOString(),
      }],
      notification_urls: [getWebhookUrl()],
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
    logger.error('Falha ao criar pedido PagBank', { status: response.status, body });
    throw new Error(`PagBank retornou HTTP ${response.status}.`);
  }

  const qrCode = body.qr_codes?.[0];
  if (!body.id || !qrCode?.text) {
    throw new Error('PagBank não retornou um QR Code Pix válido.');
  }

  const imageLink = qrCode.links?.find((link) => link.media === 'image/png');

  return {
    pagbankOrderId: body.id,
    pixCopyPaste: qrCode.text,
    qrCodeImageUrl: imageLink?.href || null,
    pagbankStatus: body.status || 'WAITING',
  };
}

exports.getPublicRaffleState = onCall({ region: 'southamerica-east1' }, async () => {
  const snapshot = await publicStateRef.get();
  if (!snapshot.exists) {
    const defaults = getConfigDefaults();
    return {
      totalNumbers: defaults.totalNumbers,
      targetSoldNumbers: defaults.targetSoldNumbers,
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
  secrets: [PAGBANK_ACCESS_TOKEN, PAGBANK_WEBHOOK_TOKEN],
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
  let pagBankRequestStarted = false;

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

    const winningNumbers = await getWinningNumberSet();
    await updateTicketDocuments(selectedNumbers, (ticketNumber) => ({
      status: 'reservada',
      premiada: winningNumbers.has(ticketNumber),
      pedidoId: orderId,
      comprador: userData.nome || userData.name || auth.token.name || null,
      cpf: userData.cpf || null,
      compradorUid: auth.uid,
      reservadoAte: Timestamp.fromMillis(expiresAtMillis),
    }));

    pagBankRequestStarted = true;
    const pix = await createPagBankOrder({
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
    if (!pagBankRequestStarted) {
      await releaseReservationInternal(orderId, 'erro_pagbank').catch((releaseError) => {
        logger.error('Falha ao liberar reserva após erro', { orderId, error: releaseError.message });
      });
    } else {
      logger.warn('Pedido PagBank iniciado; reserva será resolvida por webhook ou expiração', { orderId });
    }

    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'Não foi possível criar o pedido Pix.');
  }
});

exports.pagbankWebhook = onRequest({
  region: 'southamerica-east1',
  secrets: [PAGBANK_ACCESS_TOKEN, PAGBANK_WEBHOOK_TOKEN],
}, async (request, response) => {
  if (request.method !== 'POST') {
    response.status(405).send('Método não permitido.');
    return;
  }

  const rawBody = request.rawBody
    ? Buffer.from(request.rawBody).toString('utf8')
    : JSON.stringify(request.body || {});
  const receivedSignature = String(request.get('x-authenticity-token') || '').trim().toLowerCase();
  const accountToken = getSecretValue(PAGBANK_WEBHOOK_TOKEN) || getSecretValue(PAGBANK_ACCESS_TOKEN);

  if (!receivedSignature || !accountToken) {
    response.status(401).send('Webhook não configurado.');
    return;
  }

  const expectedSignature = crypto
    .createHash('sha256')
    .update(`${accountToken}-${rawBody}`, 'utf8')
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const receivedBuffer = Buffer.from(receivedSignature, 'utf8');
  if (expectedBuffer.length !== receivedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
    response.status(401).send('Assinatura inválida.');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    response.status(400).send('JSON inválido.');
    return;
  }

  const paid = Array.isArray(payload.charges)
    && payload.charges.some((charge) => charge.status === 'PAID');
  if (paid && payload.reference_id) {
    try {
      await confirmPaidOrder(payload.reference_id, payload);
    } catch (error) {
      logger.error('Falha ao confirmar pagamento do webhook', {
        referenceId: payload.reference_id,
        error: error.message,
      });
      response.status(500).send('Falha temporária.');
      return;
    }
  }

  response.status(200).send('OK');
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

exports.getMyOrders = onCall({ region: 'southamerica-east1' }, async (request) => {
  const auth = requireAuth(request);
  const snapshot = await db.collection('pedidos')
    .where('uid', '==', auth.uid)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  return { orders: snapshot.docs.map(serializeOrder) };
});
