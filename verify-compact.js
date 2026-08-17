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

async function main() {
  const db = loadFirestore();
  const [configSnapshot, stateSnapshot, publicSnapshot, auditSnapshot, winnersSnapshot, shardSnapshot] = await Promise.all([
    db.doc('configuracoes/rifa').get(),
    db.doc('estado/rifa').get(),
    db.doc('publico/rifa').get(),
    db.doc('auditoria/rifa').get(),
    db.collection('numerosPremiados').limit(1).get(),
    db.collection('disponibilidade').limit(3).get(),
  ]);

  const config = configSnapshot.exists ? configSnapshot.data() : {};
  const state = stateSnapshot.exists ? stateSnapshot.data() : {};
  const publicState = publicSnapshot.exists ? publicSnapshot.data() : {};
  const audit = auditSnapshot.exists ? auditSnapshot.data() : {};
  const firstShards = shardSnapshot.docs.map((doc) => ({
    id: doc.id,
    count: Array.isArray(doc.data().numbers) ? doc.data().numbers.length : 0,
    first: doc.data().numbers?.[0] || null,
  }));

  const result = {
    configExists: configSnapshot.exists,
    totalNumbers: Number(config.totalNumbers || 0),
    totalWinningNumbers: Number(config.totalWinningNumbers || 0),
    raffleStatus: state.status || config.status || null,
    soldNumbers: Number(state.soldNumbers || 0),
    reservedNumbers: Number(state.reservedNumbers || 0),
    publicState: {
      percentSold: publicState.percentSold ?? null,
      remainingNumbers: publicState.remainingNumbers ?? null,
    },
    auditWinnerCount: Array.isArray(audit.winnerNumbers) ? audit.winnerNumbers.length : 0,
    winningCollectionHasAtLeastOne: !winnersSnapshot.empty,
    sampledShards: firstShards,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
