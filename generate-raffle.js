#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = {
  total: 150000,
  // 10.000 cotas adicionais; a XRE é sorteada separadamente aos 100%.
  winners: 10000,
  prizePoolCents: 1000000,
  mainPrizeName: 'Honda XRE 190 2026',
  target: 150000,
  priceCents: 50,
  reservationMinutes: 10,
  shardSize: 1000,
  preserveExistingCount: 10000,
  mainPrizeDrawStatus: 'aguardando_100_porcento',
};

function parseArgs(argv) {
  const args = { ...DEFAULTS, publish: false, writeTicketDocs: false, output: 'generated-raffle' };
  for (const raw of argv.slice(2)) {
    if (raw === '--publish') args.publish = true;
    else if (raw === '--write-ticket-docs') args.writeTicketDocs = true;
    else if (raw.startsWith('--')) {
      const [key, value] = raw.slice(2).split('=');
      if (key in args && value !== undefined) args[key] = Number(value) || value;
      else if (key === 'output' && value) args.output = value;
    }
  }
  return args;
}

function assertOptions(options) {
  if (!Number.isInteger(options.total) || options.total < 1) throw new Error('total inválido');
  if (!Number.isInteger(options.winners) || options.winners < 0 || options.winners > options.total) throw new Error('winners inválido');
  if (!Number.isInteger(options.prizePoolCents) || options.prizePoolCents < 0) throw new Error('prizePoolCents inválido');
  if (typeof options.mainPrizeName !== 'string' || !options.mainPrizeName.trim()) throw new Error('mainPrizeName inválido');
  if (!Number.isInteger(options.target) || options.target < 1 || options.target > options.total) throw new Error('target inválido');
  if (!Number.isInteger(options.shardSize) || options.shardSize < 1 || options.shardSize > 1000) throw new Error('shardSize inválido');
  if (!Number.isInteger(options.preserveExistingCount) || options.preserveExistingCount < 0 || options.preserveExistingCount > options.total) {
    throw new Error('preserveExistingCount inválido');
  }
}

function shuffle(values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

function formatNumber(value) {
  return String(value).padStart(6, '0');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function createData(options) {
  const orderedNumbers = Array.from({ length: options.total }, (_, index) => index + 1);
  const winnerSelection = shuffle([...orderedNumbers]);
  const winners = winnerSelection.slice(0, options.winners).sort((a, b) => a - b);
  const winnerSet = new Set(winners);
  const distributionPool = shuffle(orderedNumbers.filter((number) => !winnerSet.has(number)));

  // Todos os números podem ser vendidos, inclusive os premiados.
  // A ordem de distribuição é aleatória para impedir previsibilidade entre compradores.
  const allNumbersForDistribution = shuffle([...orderedNumbers]);
  const shards = [];
  for (let offset = 0, shardIndex = 0; offset < allNumbersForDistribution.length; offset += options.shardSize, shardIndex += 1) {
    shards.push({
      shardIndex,
      numbers: allNumbersForDistribution.slice(offset, offset + options.shardSize).map(formatNumber),
    });
  }

  const winnersCsv = winners.length ? `${winners.map(formatNumber).join('\n')}\n` : '';
  const distributionCsv = distributionPool.length ? `${distributionPool.map(formatNumber).join('\n')}\n` : '';
  const generationId = crypto.randomUUID();

  return {
    generationId,
    winners,
    winnersHash: sha256(winnersCsv),
    distributionHash: sha256(distributionCsv),
    shards,
    allNumbers: allNumbersForDistribution,
  };
}

async function initializeAdmin() {
  const { initializeApp, applicationDefault, cert, getApps } = require('../functions/node_modules/firebase-admin/app');
  const { getFirestore } = require('../functions/node_modules/firebase-admin/firestore');

  if (getApps().length) return getFirestore();

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
  } else {
    initializeApp({ credential: applicationDefault() });
  }
  return getFirestore();
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function publishData(options, data, outputDir) {
  const db = await initializeAdmin();
  const { FieldValue } = require('../functions/node_modules/firebase-admin/firestore');
  const writer = db.bulkWriter();
  writer.onWriteError((error) => {
    if (error.failedAttempts < 5) return true;
    console.error('Falha permanente no BulkWriter:', error);
    return false;
  });

  const configRef = db.doc('configuracoes/rifa');
  const stateRef = db.doc('estado/rifa');
  const publicRef = db.doc('publico/rifa');
  const auditRef = db.doc(`auditoriaGeracoes/${data.generationId}`);

  writer.set(configRef, {
    totalNumbers: options.total,
    totalWinningNumbers: data.winners.length,
    prizeModel: '10000_cotas_adicionais_mais_xre_posterior',
    mainPrizeName: options.mainPrizeName,
    mainPrizeDrawStatus: options.mainPrizeDrawStatus,
    additionalPrizeCount: data.winners.length,
    additionalPrizePoolCents: options.prizePoolCents,
    targetSoldNumbers: options.target,
    pricePerNumberCents: options.priceCents,
    reservationMinutes: options.reservationMinutes,
    shardSize: options.shardSize,
    shardCount: data.shards.length,
    status: 'preparacao',
    generationId: data.generationId,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  writer.set(stateRef, {
    soldNumbers: 0,
    reservedNumbers: 0,
    status: 'preparacao',
    generationId: data.generationId,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  writer.set(publicRef, {
    totalNumbers: options.total,
    targetSoldNumbers: options.target,
    prizeModel: '10000_cotas_adicionais_mais_xre_posterior',
    mainPrizeName: options.mainPrizeName,
    mainPrizeDrawStatus: options.mainPrizeDrawStatus,
    additionalPrizeCount: data.winners.length,
    additionalPrizePoolCents: options.prizePoolCents,
    pricePerNumberCents: options.priceCents,
    soldNumbers: 0,
    reservedNumbers: 0,
    remainingNumbers: options.target,
    percentSold: 0,
    status: 'preparacao',
    generationId: data.generationId,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  writer.set(auditRef, {
    generationId: data.generationId,
    totalNumbers: options.total,
    totalWinningNumbers: data.winners.length,
    winnersHash: data.winnersHash,
    distributionHash: data.distributionHash,
    prizeModel: '10000_cotas_adicionais_mais_xre_posterior',
    mainPrizeName: options.mainPrizeName,
    mainPrizeDrawStatus: options.mainPrizeDrawStatus,
    additionalPrizeCount: data.winners.length,
    additionalPrizePoolCents: options.prizePoolCents,
    createdAt: FieldValue.serverTimestamp(),
    status: 'sealed',
  });

  for (const shard of data.shards) {
    writer.set(db.doc(`disponibilidade/shard_${String(shard.shardIndex).padStart(3, '0')}`), {
      shardIndex: shard.shardIndex,
      numbers: shard.numbers,
      availableCount: shard.numbers.length,
      generationId: data.generationId,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  for (const number of data.winners) {
    writer.set(db.doc(`numerosPremiados/${formatNumber(number)}`), {
      numero: number,
      numeroFormatado: formatNumber(number),
      generationId: data.generationId,
      isWinningNumber: true,
      prizeCategory: 'adicional',
      status: 'disponivel',
      premioId: null,
      premioNome: null,
      premioTipo: null,
      premioValorCents: null,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  if (options.writeTicketDocs) {
    for (const number of data.allNumbers) {
      // Preserva os documentos legados até preserveExistingCount.
      if (number <= options.preserveExistingCount) continue;
      writer.set(db.doc(`cotas/${number}`), {
        numero: number,
        numeroFormatado: formatNumber(number),
        status: 'disponivel',
        pedidoId: null,
        compradorUid: null,
        reservadoAte: null,
        generationId: data.generationId,
        atualizadoEm: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  await writer.close();
  await writeJson(path.join(outputDir, 'publish-result.json'), {
    generationId: data.generationId,
    totalNumbers: options.total,
    totalWinningNumbers: data.winners.length,
    prizeModel: '10000_cotas_adicionais_mais_xre_posterior',
    mainPrizeName: options.mainPrizeName,
    mainPrizeDrawStatus: options.mainPrizeDrawStatus,
    additionalPrizeCount: data.winners.length,
    additionalPrizePoolCents: options.prizePoolCents,
    winnersHash: data.winnersHash,
    distributionHash: data.distributionHash,
    writeTicketDocs: options.writeTicketDocs,
    preserveExistingCount: options.preserveExistingCount,
    publishedAt: new Date().toISOString(),
  });
}

async function main() {
  const options = parseArgs(process.argv);
  assertOptions(options);
  const outputDir = path.resolve(options.output);
  await fs.mkdir(outputDir, { recursive: true });

  const data = createData(options);
  const winnersCsv = data.winners.map(formatNumber).join('\n') + '\n';
  const allNumbersCsv = data.allNumbers.map(formatNumber).join('\n') + '\n';

  await fs.writeFile(path.join(outputDir, 'numeros-premiados.csv'), winnersCsv, 'utf8');
  await fs.writeFile(path.join(outputDir, 'ordem-distribuicao.csv'), allNumbersCsv, 'utf8');
  await writeJson(path.join(outputDir, 'manifesto.json'), {
    generationId: data.generationId,
    totalNumbers: options.total,
    totalWinningNumbers: data.winners.length,
    prizeModel: '10000_cotas_adicionais_mais_xre_posterior',
    mainPrizeName: options.mainPrizeName,
    mainPrizeDrawStatus: options.mainPrizeDrawStatus,
    additionalPrizeCount: data.winners.length,
    additionalPrizePoolCents: options.prizePoolCents,
    targetSoldNumbers: options.target,
    pricePerNumberCents: options.priceCents,
    reservationMinutes: options.reservationMinutes,
    shardSize: options.shardSize,
    preserveExistingCount: options.preserveExistingCount,
    winnersHash: data.winnersHash,
    distributionHash: data.distributionHash,
    generatedAt: new Date().toISOString(),
    note: 'O arquivo numeros-premiados.csv é confidencial. Contém 10.000 vencedores adicionais; a XRE é sorteada separadamente quando a campanha atingir 100%. Não publicar este arquivo no frontend ou no GitHub público.',
  });

  if (options.publish) {
    await publishData(options, data, outputDir);
  }

  console.log(JSON.stringify({
    outputDir,
    generationId: data.generationId,
    totalNumbers: options.total,
    totalWinningNumbers: data.winners.length,
    prizeModel: '10000_cotas_adicionais_mais_xre_posterior',
    mainPrizeName: options.mainPrizeName,
    mainPrizeDrawStatus: options.mainPrizeDrawStatus,
    additionalPrizeCount: data.winners.length,
    additionalPrizePoolCents: options.prizePoolCents,
    winnersHash: data.winnersHash,
    distributionHash: data.distributionHash,
    published: options.publish,
    writeTicketDocs: options.writeTicketDocs,
    preserveExistingCount: options.preserveExistingCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
