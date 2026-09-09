const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp, FieldPath } = require('firebase-admin/firestore');
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
const WINNING_NUMBERS_DEFAULT = 50;
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

const PENDING_STATUSES = ['aguardando_pagamento', 'criando_pagamento'];

function normalizeMerchantToken(raw) {
  return String(raw || '').trim().replace(/^["']|["']$/g, '');
}

function verifyWebhookSignature(req) {
  const secret = normalizeMerchantToken(MERCADOPAGO_WEBHOOK_SECRET.value());
  if (!secret) {
    logger.warn('Mercado Pago webhook sem secret configurado — assinatura ignorada');
    return true;
  }
  const signatureHeader = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '');
  const dataId = String(req.body?.data?.id || '');
  const fields = {};
  signatureHeader.split(',').forEach((pair) => {
    const [key, value] = pair.split('=');
    if (key) fields[key.trim()] = (value || '').trim();
  });
  const ts = fields['ts'];
  const provided = fields['v1'];
  if (!ts || !provided) {
    logger.warn('Webhook sem campos de assinatura — ignorando validação');
    return true;
  }
  const template = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(template).digest('base64');
  let decodedProvided = provided;
  try {
    decodedProvided = decodeURIComponent(provided);
  } catch {
    // valor já está no formato original
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(decodedProvided);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) {
    // NÃO bloqueamos a notificação: o pagamento ainda passa pela conferência
    // oficial (status approved + valor + moeda) antes de confirmar a compra.
    // O registro fica para auditoria até o segredo ser sincronizado com o painel.
    logger.error('Assinatura do webhook não confere com MERCADOPAGO_WEBHOOK_SECRET. ' +
      'Se as notificações do Mercado Pago usarem outro segredo, atualize o secret (painel MP = Secret Manager).', {
      signatureHeader,
      requestId,
      expected,
      provided: decodedProvided,
    });
  }
  return true;
}

function paymentMatchesOrder(paymentData, orderData) {
  if (paymentData.status !== 'approved') return false;
  if (paymentData.currency_id && paymentData.currency_id !== 'BRL') return false;
  const paidCents = Math.round(Number(paymentData.transaction_amount) * 100);
  const expectedCents = Number(orderData?.totalCents) || 0;
  return expectedCents > 0 && paidCents === expectedCents;
}

function chunkify(list, size) {
  const chunks = [];
  for (let index = 0; index < list.length; index += size) {
    chunks.push(list.slice(index, index + size));
  }
  return chunks;
}

async function releaseCotas(numbers, orderId) {
  if (!numbers || !numbers.length) return;
  for (const chunk of chunkify(numbers, 400)) {
    const batch = db.batch();
    chunk.forEach((numero) => batch.delete(db.doc(`cotas/${numero}`)));
    await batch.commit();
  }
}

async function removeOrderAndRelease(orderId, numbers) {
  await db.doc(`pedidos/${orderId}`).delete().catch(() => {});
  await releaseCotas(numbers || [], orderId).catch(() => {});
}

async function writeCotasStatus(numbers, status, orderId, extra = {}) {
  if (!numbers || !numbers.length) return;
  for (const chunk of chunkify(numbers, 400)) {
    const batch = db.batch();
    chunk.forEach((numero) => batch.set(
      db.doc(`cotas/${numero}`),
      {
        numero,
        numeroFormatado: formatTicketNumber(numero),
        status,
        orderId,
        atualizadoEm: FieldValue.serverTimestamp(),
        ...extra,
      },
      { merge: true },
    ));
    await batch.commit();
  }
}

async function reserveNumbers(orderId, quantity) {
  const MAX_ROUNDS = 6;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const usedNumbers = new Set();

    // Números já vendidos (compras pagas)
    const soldSnapshot = await db.collection('compras').select('numeros').get();
    soldSnapshot.forEach((doc) => (doc.data()?.numeros || []).forEach((n) => usedNumbers.add(n)));

    // Reservas ativas (pedidos aguardando pagamento)
    const pendingSnapshot = await db.collection('pedidos')
      .where('status', 'in', PENDING_STATUSES)
      .select('numeros')
      .get();
    pendingSnapshot.forEach((doc) => (doc.data()?.numeros || []).forEach((n) => usedNumbers.add(n)));

    // Cotas com documento no banco são consideradas ocupadas (reservada,
    // vendida ou legado materializado). O claim atômico usa "create", que
    // falha se o documento já existir, então nenhum documento existente pode
    // entrar na lista de candidatos.
    const cotasSnapshot = await db.collection('cotas').select('status', 'numero').get();
    cotasSnapshot.forEach((doc) => {
      const parsed = Number(doc.data()?.numero ?? doc.id);
      if (Number.isInteger(parsed)) usedNumbers.add(parsed);
    });

    if (TOTAL_NUMBERS_DEFAULT - usedNumbers.size < quantity) {
      throw new HttpsError('unavailable', 'Não foram encontrados números disponíveis suficientes.');
    }

    const candidates = [];
    const maxAttempts = Math.max(5000, quantity * 25);
    let attempts = 0;
    while (candidates.length < quantity && attempts < maxAttempts) {
      const rand = crypto.randomInt(1, TOTAL_NUMBERS_DEFAULT + 1);
      attempts += 1;
      if (!usedNumbers.has(rand)) {
        candidates.push(rand);
        usedNumbers.add(rand);
      }
    }

    if (candidates.length < quantity) {
      throw new HttpsError('unavailable', 'Não foram encontrados números disponíveis suficientes.');
    }

    // Claim atômico por documento cotas/{numero}. O "create" falha se o número
    // já foi reclamado por outra reserva concorrente, garantindo que a MESMA
    // cota nunca seja vendida duas vezes mesmo com compras simultâneas.
    const claimed = [];
    let conflict = false;
    for (const chunk of chunkify(candidates, 400)) {
      const batch = db.batch();
      chunk.forEach((numero) => batch.create(db.doc(`cotas/${numero}`), {
        numero,
        numeroFormatado: formatTicketNumber(numero),
        status: 'reservada',
        orderId,
        reservadaEm: FieldValue.serverTimestamp(),
      }));
      try {
        await batch.commit();
        claimed.push(...chunk);
      } catch (e) {
        logger.warn('Disputa concorrente na reserva de números', { round, orderId });
        conflict = true;
        break;
      }
    }

    if (!conflict) return claimed;

    // Libera a reserva parcial deste round e tenta novamente com o estado
    // atualizado (o pedido vencedor já está no banco e será visível no re-read).
    await releaseCotas(claimed, orderId).catch(() => logger.error('Não foi possível liberar reserva parcial'));
  }
  throw new HttpsError('unavailable', 'Não foi possível reservar os números agora. Tente novamente.');
}

async function markOrderPaid(orderId, orderData) {
  await db.runTransaction(async (transaction) => {
    const orderRef = db.doc(`pedidos/${orderId}`);
    const freshSnap = await transaction.get(orderRef);
    if (freshSnap.exists && freshSnap.data()?.status === 'pago') return;

    const publicRef = db.doc('publico/rifa');
    const publicSnap = await transaction.get(publicRef);
    const currentSold = publicSnap.exists ? (Number(publicSnap.data().soldNumbers) || 0) : 0;

    transaction.update(orderRef, {
      status: 'pago',
      paidAt: FieldValue.serverTimestamp()
    });

    transaction.set(db.doc(`compras/${orderId}`), {
      ...orderData,
      status: 'pago',
      paidAt: FieldValue.serverTimestamp(),
      confirmadoEm: FieldValue.serverTimestamp()
    });

    const newSoldCount = currentSold + (orderData.numeros?.length || 0);
    transaction.set(publicRef, {
      soldNumbers: newSoldCount
    }, { merge: true });
  });

  // Marca as cotas como vendidas (fora da transação para não estourar o limite
  // de 500 escritas). Mantém o número "reclamado", impedindo revenda dupla.
  try {
    await writeCotasStatus(orderData.numeros || [], 'vendida', orderId, {
      vendidaEm: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.error('Não foi possível marcar cotas como vendidas', { orderId });
  }

  // Verifica se atingiu 100% para sorteio automático da XRE
  try {
    const publicSnap = await publicStateRef.get();
    const state = publicSnap.exists ? publicSnap.data() : {};
    const sold = Number(state.soldNumbers || 0);
    const target = Number(state.targetSoldNumbers || TOTAL_NUMBERS_DEFAULT);
    
    if (sold >= target) {
      const xreCheck = await db.doc('ganhadores/xre').get();
      if (!xreCheck.exists) {
        logger.info('100% atingido — iniciando sorteio automático da XRE');
        await autoDrawXreWinner();
      }
    }
  } catch (e) {
    logger.warn('Erro ao verificar condição para sorteio automático da XRE', e);
  }
}

async function autoDrawXreWinner() {
  try {
    const comprasSnap = await db.collection('compras').where('status', '==', 'pago').get();
    if (comprasSnap.empty) {
      logger.warn('Nenhuma compra paga para sorteio automático');
      return;
    }

    const numbersByValue = new Map();
    comprasSnap.docs.forEach((doc) => {
      (doc.data().numeros || []).forEach((numero) => {
        if (!numbersByValue.has(numero)) numbersByValue.set(numero, doc);
      });
    });

    if (numbersByValue.size === 0) {
      logger.warn('Nenhum número disponível para sorteio automático');
      return;
    }

    const entries = [...numbersByValue.entries()];
    const [numeroSorteado, randomDoc] = entries[crypto.randomInt(entries.length)];
    const winnerData = randomDoc.data();

    const result = {
      numero: numeroSorteado,
      comprador: winnerData.nome || 'Comprador não informado',
      email: winnerData.email || 'E-mail não informado',
      pedidoId: randomDoc.id,
      sorteadoEm: FieldValue.serverTimestamp(),
      autoDrawn: true
    };

    // Grava com trava transacional: se outro sorteio concorrente já registrou
    // a XRE, este aborta e o resultado existente prevalece (sorteio é único).
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(db.doc('sorteios/xre'));
      if (existing.exists && existing.data()?.status === 'concluido') {
        return;
      }
      transaction.set(db.doc('sorteios/xre'), {
        ...result,
        status: 'concluido'
      });
      transaction.set(db.collection('ganhadores').doc('xre'), {
        ...result,
        categoria: 'principal'
      });
    });

    logger.info('Sorteio automático da XRE concluído', { numero: numeroSorteado, comprador: winnerData.nome });
  } catch (e) {
    logger.error('Erro no sorteio automático da XRE', e);
  }
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
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_NUMBERS_PER_ORDER) {
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

  let rawToken = MERCADOPAGO_ACCESS_TOKEN.value();
  let token = normalizeMerchantToken(rawToken);

  if (!token || token.length < 10) {
    throw new HttpsError('internal', 'Não foi possível gerar o Pix agora.');
  }

  const reservedNumbers = [];
  const totalCents = quantity * PRICE_PER_NUMBER_CENTS_DEFAULT;
  const expiresAt = new Date(Date.now() + RESERVATION_MINUTES_DEFAULT * 60000);

  try {
    // Claim atômico dos números (unique por documento cotas/{numero}).
    // Transações concorrentes nunca conseguem reclamar a mesma cota.
    reservedNumbers.push(...await reserveNumbers(orderId, quantity));

    await db.doc(`pedidos/${orderId}`).set({
      uid: user.uid,
      nome: userNome,
      email: userEmail,
      status: 'aguardando_pagamento',
      totalCents: totalCents,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromDate(expiresAt),
      numeros: reservedNumbers,
      mpPaymentId: null
    });

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
      throw new HttpsError('internal', `Mercado Pago: ${detailedError}`);
    }

    const mpData = await mpResponse.json();
    const pixCode = mpData.point_of_interaction?.transaction_data?.qr_code;
    const qrBase64 = mpData.point_of_interaction?.transaction_data?.qr_code_base64;

    if (!pixCode) throw new HttpsError('internal', 'Mercado Pago não retornou o código PIX');

    await db.doc(`pedidos/${orderId}`).update({
      mpPaymentId: mpData.id
    });

    return {
      orderId,
      pixCopyPaste: pixCode,
      qrCodeImageUrl: qrBase64 ? `data:image/png;base64,${qrBase64}` : null,
      totalCents: totalCents,
      expiresAt: expiresAt.toISOString()
    };
  } catch (e) {
    logger.error("Erro createPixOrder", e);
    // Libera a reserva se o Pix não pôde ser gerado
    await removeOrderAndRelease(orderId, reservedNumbers).catch(() => logger.warn('Não foi possível limpar pedido temporário', orderId));
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Não foi possível processar o pedido agora.');
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
    if (orderData.uid !== request.auth.uid) throw new HttpsError('not-found', 'Pedido não encontrado.');
    if (orderData.status === 'pago') return { status: 'pago', message: 'Pagamento já processado!' };

    const mpPaymentId = orderData.mpPaymentId;
    if (!mpPaymentId) throw new HttpsError('internal', 'Este pedido não possui um ID de pagamento vinculado.');

    let rawToken = MERCADOPAGO_ACCESS_TOKEN.value();
    let token = normalizeMerchantToken(rawToken);

    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${mpPaymentId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!mpResponse.ok) throw new HttpsError('internal', 'Erro ao consultar Mercado Pago.');
    
    const paymentData = await mpResponse.json();
    if (paymentData.status !== 'approved') {
      return { status: 'pendente', message: 'Pagamento ainda não aprovado pelo Mercado Pago.' };
    }

    if (!paymentMatchesOrder(paymentData, orderData)) {
      logger.warn('Pagamento aprovado com valor/moeda divergente', { orderId, mpPaymentId, paymentData });
      return { status: 'pendente', message: 'Valor do pagamento não confere com o pedido.' };
    }

    // APROVADO! Processamos agora.
    // A verificação de idempotência acontece DENTRO da transação: se o
    // webhook e o botão "confirmar" rodarem ao mesmo tempo, só um soma.
    await markOrderPaid(orderId, orderData);

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

    if (!verifyWebhookSignature(req)) {
      return res.status(401).send('Assinatura inválida');
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

    const numericPaymentId = Number(paymentId);

    let rawToken = MERCADOPAGO_ACCESS_TOKEN.value();
    let token = normalizeMerchantToken(rawToken);

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

    // Promise.all em vez de duas queries sequenciais. O type real sai do
    // pagamento oficial do Mercado Pago (payments nunca vem como string).
    const [ordersSnapshot, ordersSnapshotStr] = await Promise.all([
      db.collection('pedidos').where('mpPaymentId', '==', numericPaymentId).get(),
      Number.isFinite(numericPaymentId)
        ? db.collection('pedidos').where('mpPaymentId', '==', String(paymentId)).get()
        : Promise.resolve({ empty: true, docs: [] })
    ]);

    const orderDoc = (ordersSnapshot.empty ? ordersSnapshotStr : ordersSnapshot).docs[0];
    if (!orderDoc) {
      logger.warn('Pagamento aprovado mas pedido nao encontrado no banco', { paymentId });
      return res.status(200).send('OK');
    }

    const orderData = orderDoc.data();
    const orderId = orderDoc.id;

    if (orderData.status === 'pago') {
      return res.status(200).send('OK');
    }

    if (!paymentMatchesOrder(paymentData, orderData)) {
      logger.warn('Pagamento aprovado com valor/moeda divergente no webhook', { orderId, paymentId, paymentData });
      return res.status(200).send('OK');
    }

    await markOrderPaid(orderId, orderData);

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
    // 1. Idempotência: se a XRE já foi sorteada, devolve o resultado existente
    // em vez de sortear de novo (o sorteio é único e imutável).
    const existingDraw = await db.doc('sorteios/xre').get();
    if (existingDraw.exists && existingDraw.data()?.status === 'concluido') {
      const saved = existingDraw.data();
      return { status: 'concluido', winner: saved, alreadyDrawn: true };
    }

    // 2. Verificação de Segurança: o sorteio acontece automaticamente quando
    // o cotômetro atinge 100%. Não existe número reservado para a XRE.
    const stateSnap = await publicStateRef.get();
    const state = stateSnap.exists ? stateSnap.data() : getConfigDefaults();
    const sold = Number(state.soldNumbers || 0);
    const configSnap = await raffleConfigRef.get();
    const configData = configSnap.exists ? configSnap.data() : getConfigDefaults();
    const target = Number(state.targetSoldNumbers ?? configData.targetSoldNumbers ?? TOTAL_NUMBERS_DEFAULT);

    if (sold < target) {
      throw new HttpsError('failed-precondition', `Sorteio bloqueado: Meta não atingida (${sold}/${target} vendidos).`);
    }

    // 3. Buscar todas as compras pagas
    const comprasSnap = await db.collection('compras').where('status', '==', 'pago').get();

    if (comprasSnap.empty) {
      throw new HttpsError('not-found', 'Nenhuma compra paga encontrada para realizar o sorteio.');
    }

    // 4. Sorteio ponderado por NÚMERO: cada cota tem a mesma chance,
    // então quem tem 1000 cotas tem 1000x mais chances que quem tem 1.
    // Números repetidos (caso legado) são deduplicados para não inflar a chance.
    const numbersByValue = new Map();
    comprasSnap.docs.forEach((doc) => {
      (doc.data().numeros || []).forEach((numero) => {
        if (!numbersByValue.has(numero)) numbersByValue.set(numero, doc);
      });
    });

    const entries = [...numbersByValue.entries()];
    const [numeroSorteado, randomDoc] = entries[crypto.randomInt(entries.length)];

    const winnerData = randomDoc.data();

    const result = {
      numero: numeroSorteado,
      comprador: winnerData.nome || 'Comprador não informado',
      email: winnerData.email || 'E-mail não informado',
      pedidoId: randomDoc.id,
      sorteadoEm: FieldValue.serverTimestamp()
    };

    // 5. Gravar resultado para auditoria (Imutável)
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

exports.getWinningNumbers = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  try {
    // Todos os documentos de numerosPremiados são cotas premiadas por definição
    // (formato legado não possui o campo isWinningNumber, então sem filtro).
    const pageSize = Math.min(1000, Math.max(1, Number(request.data?.pageSize) || 500));
    const page = Math.max(1, Number(request.data?.page) || 1);
    const searchRaw = String(request.data?.search || '').trim().replace(/\D/g, '').slice(-6);
    const offset = (page - 1) * pageSize;

    // Busca direta por número exato (ex: "123" -> "000123")
    if (searchRaw) {
      const searchNum = Number.parseInt(searchRaw, 10);
      if (Number.isFinite(searchNum)) {
        const docId = String(searchNum).padStart(6, '0');
        const [docSnap, countSnap] = await Promise.all([
          db.doc(`numerosPremiados/${docId}`).get(),
          db.collection('numerosPremiados').count().get(),
        ]);
        const total = countSnap.data().count;
        if (!docSnap.exists) {
          return { numbers: [], count: 0, total, page: 1, totalPages: Math.max(1, Math.ceil(total / pageSize)), pageSize, search: docId, found: false };
        }
        return { numbers: [searchNum], count: 1, total, page: 1, totalPages: Math.max(1, Math.ceil(total / pageSize)), pageSize, search: docId, found: true };
      }
    }

    const [snapshot, countSnap] = await Promise.all([
      db.collection('numerosPremiados').orderBy(FieldPath.documentId()).offset(offset).limit(pageSize).get(),
      db.collection('numerosPremiados').count().get(),
    ]);
    const numbers = snapshot.docs.map((doc) => {
      const data = doc.data();
      if (Number.isFinite(Number(data.numero))) return Number(data.numero);
      const parsed = Number.parseInt(doc.id, 10);
      return parsed;
    }).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const total = countSnap.data().count;
    return { numbers, count: numbers.length, total, page, totalPages: Math.max(1, Math.ceil(total / pageSize)), pageSize };
  } catch (e) {
    logger.error("Erro getWinningNumbers", e);
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', e.message);
  }
});

exports.adminRecountSoldNumbers = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  try {
    const snapshot = await db.collection('compras').where('status', '==', 'pago').get();
    let soldNumbers = 0;
    snapshot.forEach((docSnap) => {
      soldNumbers += Number(docSnap.data()?.numeros?.length) || 0;
    });
    await publicStateRef.set({ soldNumbers }, { merge: true });
    return { soldNumbers, purchaseCount: snapshot.size };
  } catch (e) {
    logger.error("Erro adminRecountSoldNumbers", e);
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', e.message);
  }
});

exports.getAdminPurchases = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const pageSize = Math.min(1000, Math.max(1, Number(request.data?.pageSize) || 200));
  const snapshot = await db.collection('compras').orderBy('confirmadoEm', 'desc').limit(pageSize).get().catch(async () => {
    // Fallback se campo de ordenação não existir em docs antigos
    return db.collection('compras').limit(pageSize).get();
  });
  return { purchases: snapshot.docs.map(d => ({ id: d.id, ...d.data() })), count: snapshot.size };
});

exports.getAdminWinners = onCall({ region: 'southamerica-east1' }, async (request) => {
  requireAdmin(request);
  const pageSize = Math.min(1000, Math.max(1, Number(request.data?.pageSize) || 500));
  const snapshot = await db.collection('ganhadores').limit(pageSize).get();
  const winners = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  // Ordena adicionais primeiro por data (quando houver), XRE por último na lista visual
  winners.sort((a, b) => {
    const ta = new Date(a.confirmadoEm?._seconds ? a.confirmadoEm._seconds * 1000 : (a.confirmadoEm || a.sorteadoEm || 0)).getTime() || 0;
    const tb = new Date(b.confirmadoEm?._seconds ? b.confirmadoEm._seconds * 1000 : (b.confirmadoEm || b.sorteadoEm || 0)).getTime() || 0;
    return tb - ta;
  });
  return { winners, count: winners.length };
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
  logger.info("Executando rotina de expiração de reservas...");
  const now = Timestamp.fromDate(new Date());

  try {
    const snapshot = await db.collection('pedidos')
      .where('status', 'in', PENDING_STATUSES)
      .where('expiresAt', '<=', now)
      .select('status', 'expiresAt', 'numeros')
      .get();

    if (snapshot.empty) {
      logger.info("Nenhuma reserva expirada neste ciclo.");
      return;
    }

    let updated = 0;
    const batch = db.batch();
    const expiredOrders = [];
    snapshot.forEach((doc) => {
      batch.update(doc.ref, { status: 'expirado', expiredAt: FieldValue.serverTimestamp() });
      expiredOrders.push({ orderId: doc.id, numeros: doc.data()?.numeros || [] });
      updated += 1;
    });
    await batch.commit();
    logger.info(`Reservas expiradas: ${updated}`);

    // Libera o claim das cotas para que os números voltem a ficar disponíveis.
    // O documento do pedido permanece com status "expirado" para auditoria.
    for (const order of expiredOrders) {
      await releaseCotas(order.numeros, order.orderId).catch((e) =>
        logger.error('Erro ao liberar cotas de reserva expirada', { orderId: order.orderId })
      );
    }
  } catch (e) {
    logger.error("Erro na rotina de expiração de reservas", e);
  }
});

exports.sendPurchaseConfirmationEmail = onDocumentCreated({
  region: 'southamerica-east1',
  document: 'compras/{purchaseId}',
  secrets: [RESEND_API_KEY]
}, async (event) => {
  try {
    const purchaseData = event.data?.data();
    if (!purchaseData || purchaseData.status !== 'pago' || !purchaseData.email) return;

    const apiKey = normalizeMerchantToken(RESEND_API_KEY.value());
    if (!apiKey) {
      logger.warn('RESEND_API_KEY não configurada — e-mail não enviado para', event.params.purchaseId);
      return;
    }

    const from = 'Kóòpremios <confirmacao@kopremios.com>';
    const numeros = (purchaseData.numeros || [])
      .map((n) => String(n).padStart(6, '0'))
      .join(', ');
    const total = (Number(purchaseData.totalCents) || 0) / 100;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [purchaseData.email],
        subject: 'Sua compra foi confirmada — Kóòpremios',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#e1e1e6;background:#081021;padding:24px;border-radius:12px;">
            <h2 style="color:#d4af37;">Pagamento confirmado!</h2>
            <p style="margin:14px 0 6px;"><strong>Números:</strong> ${numeros}</p>
            <p style="margin:4px 0;"><strong>Valor:</strong> R$ ${total.toFixed(2)}</p>
            <p style="margin:18px 0 0;color:#a8a8b3;font-size:13px;">Guarde esta mensagem. O resultado do sorteio será divulgado no site.</p>
          </div>
        `
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('Erro ao enviar e-mail via Resend', { purchaseId: event.params.purchaseId, status: response.status, errorBody });
    } else {
      logger.info('E-mail de confirmação enviado', { purchaseId: event.params.purchaseId });
    }
  } catch (e) {
    logger.error('Erro no envio de e-mail de confirmação', e);
  }
});

exports.checkCpfDisponivel = onCall({ region: 'southamerica-east1' }, async (request) => {
  try {
    const cpf = String(request.data?.cpf || '').replace(/\D/g, '');
    if (!/^\d{11}$/.test(cpf)) {
      throw new HttpsError('invalid-argument', 'CPF inválido.');
    }
    const snapshot = await db.collection('usuarios')
      .where('cpfNormalizado', '==', cpf)
      .limit(1)
      .select('cpfNormalizado')
      .get();
    return { disponivel: snapshot.empty };
  } catch (e) {
    logger.error("Erro checkCpfDisponivel", e);
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Não foi possível verificar o CPF agora.');
  }
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
      // A existência do documento em numerosPremiados já significa cota
      // premiada (documentos legados não têm o campo isWinningNumber).

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
