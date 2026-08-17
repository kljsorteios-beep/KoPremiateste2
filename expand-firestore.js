#!/usr/bin/env node

const crypto = require('node:crypto');
const path = require('node:path');

const TOTAL_NUMBERS = 150000;
const WINNING_NUMBERS = 10000;
const SHARD_SIZE = 1000;
const PRESERVE_LEGACY_UNTIL = 10000;
const AVAILABLE_STATUSES = new Set(['disponivel', undefined, null, '']);

function formatNumber(number) {
  return String(number).padStart(6, '0');
}

function shuffle(values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    materializeTickets: argv.includes('--materialize-tickets'),
    preserveUntil: Number(argv.find((arg) => arg.startsWith('--preserve-until='))?.split('=')[1] || PRESERVE_LEGACY_UNTIL),
  };
}

function loadAdmin() {
  const requireFromFunctions = require('node:module').createRequire(
    path.resolve(__dirname, '../functions/package.json'),
  );
  const { initializeApp, applicationDefault, cert, getApps } = requireFromFunctions('firebase-admin/app');
  const { getFirestore, FieldValue } = requireFromFunctions('firebase-admin/firestore');
  if (!getApps().length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    } else {
      initializeApp({ credential: applicationDefault() });
    }
  }
  return {
    db: getFirestore(),
    FieldValue,
  };
}

function buildWinnerSet() {
  const numbers = Array.from({ length: TOTAL_NUMBERS }, (_, index) => index + 1);
  return new Set(shuffle(numbers).slice(0, WINNING_NUMBERS));
}

async function readExistingWinners(db) {
  const snapshot = await db.collection('numerosPremiados').get();
  const winners = new Set();
  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const parsed = Number(data.numero || doc.id);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= TOTAL_NUMBERS) winners.add(parsed);
  }
  return winners;
}

async function readWinnerManifest(db) {
  const snapshot = await db.doc('auditoria/rifa').get();
  const numbers = snapshot.exists ? snapshot.data()?.winnerNumbers : null;
  if (!Array.isArray(numbers) || numbers.length === 0) return new Set();
  const winners = new Set(numbers.map(Number).filter((number) => Number.isInteger(number) && number >= 1 && number <= TOTAL_NUMBERS));
  if (winners.size !== WINNING_NUMBERS) {
    throw new Error(`O manifesto auditoria/rifa possui ${winners.size} números válidos. Faça uma conferência manual antes de continuar.`);
  }
  return winners;
}

async function readExistingTickets(db) {
  const snapshot = await db.collection('cotas').get();
  const existing = new Map();
  for (const doc of snapshot.docs) {
    const data = doc.data() || {};
    const parsed = Number(data.numero || doc.id);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= TOTAL_NUMBERS) {
      existing.set(parsed, { id: doc.id, data });
    }
  }
  return existing;
}

function buildAvailableNumbers(existing, preserveUntil) {
  const available = [];
  let preservedClaimed = 0;
  for (let number = 1; number <= TOTAL_NUMBERS; number += 1) {
    const item = existing.get(number);
    const status = item?.data?.status;
    const isAvailable = AVAILABLE_STATUSES.has(status);
    if (isAvailable) available.push(number);
    else if (number <= preserveUntil) preservedClaimed += 1;
  }
  return { available, preservedClaimed };
}

function groupShards(numbers) {
  const shuffled = shuffle([...numbers]);
  const shards = [];
  for (let offset = 0, index = 0; offset < shuffled.length; offset += SHARD_SIZE, index += 1) {
    shards.push({
      shardIndex: index,
      numbers: shuffled.slice(offset, offset + SHARD_SIZE).map(formatNumber),
    });
  }
  return shards;
}

async function applyPlan(plan, existing, winnerSet, args) {
  const { db, FieldValue } = loadAdmin();
  await db.doc('auditoria/rifa').set({
    winnerNumbers: Array.from(winnerSet).sort((a, b) => a - b),
    totalWinningNumbers: WINNING_NUMBERS,
    generatedAt: new Date().toISOString(),
    note: 'Manifesto confidencial; não publicar no frontend.',
  }, { merge: true });

  const writer = db.bulkWriter();
  writer.onWriteError((error) => {
    if (error.failedAttempts < 5) return true;
    console.error('Falha permanente:', error);
    return false;
  });

  if (args.materializeTickets) {
    for (let number = 1; number <= TOTAL_NUMBERS; number += 1) {
      const current = existing.get(number);
      const ticketRef = db.doc(`cotas/${number}`);
      const baseFields = {
        numero: number,
        numeroFormatado: formatNumber(number),
        premiada: winnerSet.has(number),
        atualizadoEm: FieldValue.serverTimestamp(),
      };
      if (!current) baseFields.status = 'disponivel';
      writer.set(ticketRef, baseFields, { merge: true });
    }
  }

  for (const shard of plan.shards) {
    writer.set(db.doc(`disponibilidade/shard_${String(shard.shardIndex).padStart(3, '0')}`), {
      shardIndex: shard.shardIndex,
      numbers: shard.numbers,
      availableCount: shard.numbers.length,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  for (const number of winnerSet) {
    writer.set(db.doc(`numerosPremiados/${formatNumber(number)}`), {
      numero: number,
      numeroFormatado: formatNumber(number),
      status: 'disponivel',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  writer.set(db.doc('configuracoes/rifa'), {
    totalNumbers: TOTAL_NUMBERS,
    totalWinningNumbers: WINNING_NUMBERS,
    targetSoldNumbers: TOTAL_NUMBERS,
    pricePerNumberCents: 50,
    reservationMinutes: 10,
    shardSize: SHARD_SIZE,
    shardCount: plan.shards.length,
    status: 'preparacao',
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  writer.set(db.doc('estado/rifa'), {
    status: 'preparacao',
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  writer.set(db.doc('publico/rifa'), {
    totalNumbers: TOTAL_NUMBERS,
    targetSoldNumbers: TOTAL_NUMBERS,
    pricePerNumberCents: 50,
    status: 'preparacao',
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await writer.close();
}

async function main() {
  const args = parseArgs(process.argv);
  const { db } = loadAdmin();
  const existing = await readExistingTickets(db);
  const existingWinners = await readExistingWinners(db);
  const manifestWinners = await readWinnerManifest(db);
  const { available, preservedClaimed } = buildAvailableNumbers(existing, args.preserveUntil);
  let winnerSet;
  let winnerSource;
  if (existingWinners.size === WINNING_NUMBERS) {
    winnerSet = existingWinners;
    winnerSource = 'existing';
  } else if (manifestWinners.size === WINNING_NUMBERS) {
    winnerSet = manifestWinners;
    winnerSource = 'manifest';
    if (existingWinners.size > 0 && [...existingWinners].some((number) => !winnerSet.has(number))) {
      throw new Error('A coleção numerosPremiados contém números fora do manifesto auditoria/rifa; faça uma conferência manual.');
    }
  } else if (existingWinners.size > 0) {
    throw new Error(`A coleção numerosPremiados possui apenas ${existingWinners.size} números e não há manifesto completo para recuperação.`);
  } else {
    winnerSet = buildWinnerSet();
    winnerSource = 'new-random-generation';
  }
  const shards = groupShards(available);
  const plan = {
    totalNumbers: TOTAL_NUMBERS,
    winningNumbers: WINNING_NUMBERS,
    existingDocuments: existing.size,
    availableNumbers: available.length,
    preservedClaimed,
    shards: shards.length,
    winnerSource,
    apply: args.apply,
    ticketWriteMode: args.materializeTickets ? 'all-150000-documents' : 'sold-and-reserved-on-demand',
    warning: 'Modo compacto: --apply não cria 150 mil documentos cotas; use --materialize-tickets somente com faturamento e quota suficientes.',
  };

  console.log(JSON.stringify(plan, null, 2));
  if (!args.apply) {
    console.log('Modo planejamento: nada foi gravado. Use --apply somente após conferir o backup e as regras.');
    return;
  }

  await applyPlan({ shards }, existing, winnerSet, args);
  console.log('Expansão concluída. A campanha permanece em preparacao até ser aberta no painel administrativo.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
