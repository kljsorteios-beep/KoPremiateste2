#!/usr/bin/env node

const fs = require('node:fs');
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

async function exportCollection(db, collectionName) {
  const snapshot = await db.collection(collectionName).get();
  return snapshot.docs.map((document) => ({
    id: document.id,
    data: document.data(),
  }));
}

async function main() {
  const db = loadFirestore();
  const backup = {
    exportedAt: new Date().toISOString(),
    projectId: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null,
    collections: {},
  };

  for (const collectionName of ['cotas', 'usuarios', 'numerosPremiados']) {
    backup.collections[collectionName] = await exportCollection(db, collectionName);
    console.log(`${collectionName}: ${backup.collections[collectionName].length} documentos lidos`);
  }

  const outputName = `backup-kpremia-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outputPath = path.resolve(process.cwd(), outputName);
  fs.writeFileSync(outputPath, JSON.stringify(backup, null, 2), { encoding: 'utf8', flag: 'wx' });
  console.log(`Backup salvo em: ${outputPath}`);
  console.log('Mantenha este arquivo fora do GitHub e não o envie para ninguém; ele contém dados pessoais.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
