const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const TOTAL_NUMBERS = 150000;
const SHARD_SIZE = 1000;
const PRESERVE_LEGACY_UNTIL = 10000;
const ADDITIONAL_PRIZE_POOL_CENTS = 1000000;
const MAIN_PRIZE_NAME = 'Honda XRE 190 2026';
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
  const prizesFileArg = argv.find((arg) => arg.startsWith('--prizes-file='));
  const preserveArg = argv.find((arg) => arg.startsWith('--preserve-until='));
  const poolArg = argv.find((arg) => arg.startsWith('--additional-prize-pool-cents='));
  return {
    apply: argv.includes('--apply'),
    materializeTickets: argv.includes('--materialize-tickets'),
    clearLegacyWinners: argv.includes('--clear-legacy-winners'),
    keepExistingWinners: argv.includes('--keep-existing-winners'),
    prizesFile: prizesFileArg ? prizesFileArg.split('=').slice(1).join('=') : '',
    preserveUntil: Number(preserveArg?.split('=')[1] || PRESERVE_LEGACY_UNTIL),
    additionalPrizePoolCents: Number(poolArg?.split('=')[1] || ADDITIONAL_PRIZE_POOL_CENTS),
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

function normalizeAssignment(number, value = {}) {
  const parsedNumber = Number(number);
  if (!Number.isInteger(parsedNumber) || parsedNumber < 1 || parsedNumber > TOTAL_NUMBERS) {
    throw new Error(`Número de prêmio inválido: ${number}`);
  }
  const premioId = String(value.premioId || value.prizeId || '').trim();
  const premioNome = String(value.premioNome || value.prizeName || '').trim();
  const premioTipo = String(value.premioTipo || value.prizeType || '').trim();
  const rawValue = value.premioValorCents ?? value.prizeValueCents;
  const premioValorCents = rawValue === undefined || rawValue === null || rawValue === ''
    ? null
    : Number(rawValue);
  if (!premioId || !premioNome || !premioTipo) {
    throw new Error(`O prêmio do número ${formatNumber(parsedNumber)} precisa de premioId, premioNome e premioTipo.`);
  }
  if (premioValorCents !== null && (!Number.isInteger(premioValorCents) || premioValorCents < 0)) {
    throw new Error(`premioValorCents inválido para o número ${formatNumber(parsedNumber)}.`);
  }
  return {
    numero: parsedNumber,
    numeroFormatado: formatNumber(parsedNumber),
    premioId,
    premioNome,
    premioTipo,
    premioValorCents,
  };
}

async function readPrizeFile(fileName) {
  if (!fileName) return new Map();
  const content = await fs.readFile(path.resolve(fileName), 'utf8');
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) throw new Error('O arquivo de prêmios deve conter uma lista JSON.');
  const assignments = new Map();
  for (const item of parsed) {
    const assignment = normalizeAssignment(item?.numero ?? item?.number, item);
    if (assignments.has(assignment.numero)) {
      throw new Error(`Número de prêmio duplicado: ${assignment.numeroFormatado}`);
    }
    assignments.set(assignment.numero, assignment);
  }
  return assignments;
}

async function readExistingPrizeAssignments(db) {
  const snapshot = await db.collection('numerosPremiados').get();
  const assignments = new Map();
  for (const document of snapshot.docs) {
    const data = document.data() || {};
    const number = Number(data.numero || document.id);
    if (!Number.isInteger(number) || number < 1 || number > TOTAL_NUMBERS) continue;
    assignments.set(number, {
      numero: number,
      numeroFormatado: formatNumber(number),
      premioId: data.premioId || 'legado-sem-catalogo',
      premioNome: data.premioNome || 'Prêmio legado — revisar antes da abertura',
      premioTipo: data.premioTipo || 'legado',
      premioValorCents: Number.isInteger(Number(data.premioValorCents)) ? Number(data.premioValorCents) : null,
    });
  }
  return assignments;
}

async function readWinnerManifest(db) {
  const snapshot = await db.doc('auditoria/rifa').get();
  const numbers = snapshot.exists ? snapshot.data()?.winnerNumbers : null;
  if (!Array.isArray(numbers)) return new Set();
  return new Set(numbers.map(Number).filter((number) => Number.isInteger(number) && number >= 1 && number <= TOTAL_NUMBERS));
}

function validatePrizePlan(assignments, additionalPrizePoolCents) {
  if (!assignments.size) return {
    principalCount: 0,
    additionalPrizeCount: 0,
    additionalPrizeTotalCents: 0,
  };

  const values = Array.from(assignments.values());
  const principals = values.filter((prize) => prize.premioTipo === 'principal');
  const additionals = values.filter((prize) => prize.premioTipo === 'adicional');
  if (principals.length !== 1) {
    throw new Error(`O arquivo de prêmios precisa conter exatamente um prêmio principal; encontrados: ${principals.length}.`);
  }
  if (principals[0].premioValorCents === null) {
    throw new Error('O prêmio principal precisa informar premioValorCents.');
  }
  if (additionals.length !== values.length - 1) {
    throw new Error('Cada prêmio deve ter premioTipo igual a principal ou adicional.');
  }
  if (additionals.some((prize) => prize.premioValorCents === null)) {
    throw new Error('Todos os prêmios adicionais precisam informar premioValorCents para controle do fundo.');
  }
  const additionalPrizeTotalCents = additionals.reduce(
    (total, prize) => total + prize.premioValorCents,
    0,
  );
  if (additionalPrizeTotalCents > additionalPrizePoolCents) {
    throw new Error(`Os prêmios adicionais somam ${additionalPrizeTotalCents} centavos, acima do limite configurado de ${additionalPrizePoolCents} centavos.`);
  }
  return {
    principalCount: principals.length,
    additionalPrizeCount: additionals.length,
    additionalPrizeTotalCents,
  };
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

function assignmentsFromNumbers(numbers) {
  const assignments = new Map();
  for (const number of numbers) {
    assignments.set(number, normalizeAssignment(number, {
      premioId: 'premio-a-definir',
      premioNome: 'Prêmio a definir',
      premioTipo: 'a-definir',
      premioValorCents: null,
    }));
  }
  return assignments;
}

async function applyPlan(plan, existing, assignments, args) {
  const { db, FieldValue } = loadAdmin();
  const existingPrizeSnapshot = await db.collection('numerosPremiados').get();
  const writer = db.bulkWriter();
  writer.onWriteError((error) => {
    if (error.failedAttempts < 5) return true;
    console.error('Falha permanente:', error);
    return false;
  });

  if (args.clearLegacyWinners) {
    for (const document of existingPrizeSnapshot.docs) writer.delete(document.ref);
  }

  await db.doc('auditoria/rifa').set({
    winnerNumbers: Array.from(assignments.keys()).sort((a, b) => a - b),
    totalWinningNumbers: assignments.size,
    prizeModel: 'premio_principal_mais_premios_adicionais',
    mainPrizeName: MAIN_PRIZE_NAME,
    additionalPrizePoolCents: args.additionalPrizePoolCents,
    generatedAt: new Date().toISOString(),
    note: 'Manifesto confidencial; os números e valores devem ser revisados antes da abertura.',
  }, { merge: true });

  if (args.materializeTickets) {
    for (let number = 1; number <= TOTAL_NUMBERS; number += 1) {
      const current = existing.get(number);
      const ticketRef = db.doc(`cotas/${number}`);
      const prize = assignments.get(number);
      const baseFields = {
        numero: number,
        numeroFormatado: formatNumber(number),
        premiada: Boolean(prize),
        premioId: prize?.premioId || null,
        premioNome: prize?.premioNome || null,
        premioTipo: prize?.premioTipo || null,
        premioValorCents: prize?.premioValorCents ?? null,
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

  for (const [number, prize] of assignments.entries()) {
    writer.set(db.doc(`numerosPremiados/${formatNumber(number)}`), {
      ...prize,
      status: 'disponivel',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  writer.set(db.doc('configuracoes/rifa'), {
    totalNumbers: TOTAL_NUMBERS,
    totalWinningNumbers: assignments.size,
    prizeModel: 'premio_principal_mais_premios_adicionais',
    mainPrizeName: MAIN_PRIZE_NAME,
    additionalPrizePoolCents: args.additionalPrizePoolCents,
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
    prizeModel: 'premio_principal_mais_premios_adicionais',
    mainPrizeName: MAIN_PRIZE_NAME,
    additionalPrizePoolCents: args.additionalPrizePoolCents,
    pricePerNumberCents: 50,
    status: 'preparacao',
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  await writer.close();
}

async function main() {
  const args = parseArgs(process.argv);
  if (!Number.isInteger(args.preserveUntil) || args.preserveUntil < 0 || args.preserveUntil > TOTAL_NUMBERS) {
    throw new Error('preserve-until inválido.');
  }
  if (!Number.isInteger(args.additionalPrizePoolCents) || args.additionalPrizePoolCents < 0) {
    throw new Error('additional-prize-pool-cents inválido.');
  }
  if (args.clearLegacyWinners && !args.apply) {
    throw new Error('--clear-legacy-winners só pode ser usado junto com --apply.');
  }

  const { db } = loadAdmin();
  const existing = await readExistingTickets(db);
  const existingAssignments = await readExistingPrizeAssignments(db);
  const manifestNumbers = await readWinnerManifest(db);
  const fileAssignments = await readPrizeFile(args.prizesFile);
  const prizePlan = args.prizesFile
    ? validatePrizePlan(fileAssignments, args.additionalPrizePoolCents)
    : validatePrizePlan(assignmentsFromNumbers([]), args.additionalPrizePoolCents);
  const { available, preservedClaimed } = buildAvailableNumbers(existing, args.preserveUntil);

  let assignments = fileAssignments;
  let winnerSource = args.prizesFile ? 'explicit-prizes-file' : 'none-configured';
  if (!assignments.size && args.keepExistingWinners) {
    assignments = existingAssignments.size ? existingAssignments : assignmentsFromNumbers(manifestNumbers);
    winnerSource = existingAssignments.size ? 'existing-explicitly-kept' : 'manifest-explicitly-kept';
  }
  if (!args.prizesFile && !args.keepExistingWinners && existingAssignments.size > 0 && args.apply) {
    throw new Error('A coleção numerosPremiados já possui registros. Informe --prizes-file=... ou use --keep-existing-winners após revisar o backup; para remover o legado, use --clear-legacy-winners.');
  }
  if (args.clearLegacyWinners && !args.prizesFile) {
    assignments = new Map();
    winnerSource = 'legacy-cleared-no-prizes';
  }

  const shards = groupShards(available);
  const plan = {
    totalNumbers: TOTAL_NUMBERS,
    winningNumbers: assignments.size,
    existingDocuments: existing.size,
    existingPrizeDocuments: existingAssignments.size,
    availableNumbers: available.length,
    preservedClaimed,
    shards: shards.length,
    winnerSource,
    additionalPrizePoolCents: args.additionalPrizePoolCents,
    principalCount: prizePlan.principalCount,
    additionalPrizeCount: prizePlan.additionalPrizeCount,
    additionalPrizeTotalCents: prizePlan.additionalPrizeTotalCents,
    apply: args.apply,
    ticketWriteMode: args.materializeTickets ? 'all-150000-documents' : 'sold-and-reserved-on-demand',
    warning: 'O modelo não gera vencedores automaticamente. Defina o arquivo de prêmios e revise backup, regras, quotas e regulamento antes de aplicar.',
  };

  console.log(JSON.stringify(plan, null, 2));
  if (!args.apply) {
    console.log('Modo planejamento: nada foi gravado. Use --apply somente após conferir o backup e as regras.');
    return;
  }

  await applyPlan({ shards }, existing, assignments, args);
  console.log('Expansão concluída. A campanha permanece em preparacao até ser aberta no painel administrativo.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
