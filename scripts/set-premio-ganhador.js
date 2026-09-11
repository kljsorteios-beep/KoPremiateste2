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
  const nomeAlvo = (process.env.GANHADOR_NOME || 'Victor').toLowerCase().trim();
  const hoje = new Date();

  const snapshot = await db.collection('ganhadores').limit(500).get();

  let atualizados = 0;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const comprador = String(data.comprador || '').toLowerCase().trim();
    if (!comprador.includes(nomeAlvo)) continue;

    await doc.ref.update({
      premioNome: 'R$ 100,00',
      premioValorCents: 10000,
      confirmadoEm: hoje,
    });
    atualizados++;
    console.log(`Atualizado ganhadores/${doc.id} (cota ${data.numero || '?'}) -> R$ 100,00 em ${hoje.toLocaleString('pt-BR')}`);
  }

  console.log(`Total de registros atualizados: ${atualizados}`);
  if (atualizados === 0) {
    console.log('Nenhum ganhador com esse nome encontrado em ganhadores.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});