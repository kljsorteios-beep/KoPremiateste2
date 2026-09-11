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
  const nomeAlvo = (process.env.GANHADOR_NOME || 'Victor').toLowerCase();

  const snapshot = await db.collection('ganhadores')
    .where('categoria', '==', 'adicional')
    .limit(50)
    .get();

  let atualizados = 0;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const comprador = String(data.comprador || '').trim().toLowerCase();
    if (comprador !== nomeAlvo) continue;

    await doc.ref.update({
      premioNome: 'R$ 100,00',
      premioValorCents: 10000,
    });
    atualizados++;
    console.log(`Atualizado ganhadores/${doc.id} (cota ${data.numero || '?'}) -> R$ 100,00`);
  }

  console.log(`Total de registros atualizados: ${atualizados}`);
  if (atualizados === 0) {
    console.log('Nenhum ganhador com esse nome encontrado em ganhadores (categoria adicional).');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});