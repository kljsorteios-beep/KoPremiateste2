#!/usr/bin/env node

const path = require('node:path');

function loadFirestore() {
  const requireFromFunctions = require('node:module').createRequire(
    path.resolve(__dirname, '../functions/package.json'),
  );
  const { initializeApp, applicationDefault, cert, getApps } = requireFromFunctions('firebase-admin/app');
  const { getFirestore } = requireFromFunctions('firebase-admin/firestore');
  if (!getApps().length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
    } else {
      initializeApp({ credential: applicationDefault() });
    }
  }
  return getFirestore();
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

async function main() {
  const db = loadFirestore();
  const refs = {
    config: db.doc('configuracoes/rifa'),
    state: db.doc('estado/rifa'),
    publicState: db.doc('publico/rifa'),
    audit: db.doc('auditoria/rifa'),
    firstShard: db.doc('disponibilidade/shard_000'),
    firstWinning: db.doc('numerosPremiados/000001'),
  };

  const [configSnapshot, stateSnapshot, publicSnapshot, auditSnapshot, shardSnapshot, winningSnapshot] = await Promise.all([
    refs.config.get(),
    refs.state.get(),
    refs.publicState.get(),
    refs.audit.get(),
    refs.firstShard.get(),
    refs.firstWinning.get(),
  ]);

  const config = configSnapshot.exists ? configSnapshot.data() : {};
  const state = stateSnapshot.exists ? stateSnapshot.data() : {};
  const publicState = publicSnapshot.exists ? publicSnapshot.data() : {};
  const audit = auditSnapshot.exists ? auditSnapshot.data() : {};
  const shard = shardSnapshot.exists ? shardSnapshot.data() : {};
  const winning = winningSnapshot.exists ? winningSnapshot.data() : {};

  console.log(JSON.stringify({
    configExists: configSnapshot.exists,
    totalNumbers: Number(config.totalNumbers || 0),
    totalWinningNumbers: Number(config.totalWinningNumbers || 0),
    raffleStatus: state.status || config.status || null,
    soldNumbers: Number(state.soldNumbers || 0),
    reservedNumbers: Number(state.reservedNumbers || 0),
    publicPercentSold: publicState.percentSold ?? null,
    publicRemainingNumbers: publicState.remainingNumbers ?? null,
    auditExists: auditSnapshot.exists,
    auditWinnerCount: countArray(audit.winnerNumbers),
    firstShardExists: shardSnapshot.exists,
    firstShardCount: countArray(shard.numbers),
    firstShardAvailableCount: Number(shard.availableCount || 0),
    firstWinningDocumentExists: winningSnapshot.exists,
    readsUsedByThisScript: 6,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
