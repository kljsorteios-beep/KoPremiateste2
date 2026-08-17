# Kóòpremia

Site da campanha com Firebase Authentication, Firestore e Cloud Functions para reserva de números e integração Pix PagBank.

A documentação completa está em [`IMPLEMENTACAO.md`](IMPLEMENTACAO.md) e a auditoria em [`AUDITORIA.md`](AUDITORIA.md).

## Desenvolvimento local

```bash
python3 -m http.server 4175
```

O frontend pode ser servido pela Vercel ou Firebase Hosting, mas a criação de pedidos e a confirmação de pagamento dependem das Cloud Functions implantadas.

## Instalação das funções

```bash
npm --prefix functions install
npm --prefix functions run lint
```

## Expansão do Firestore

Faça backup e configure uma conta de serviço segura antes de executar:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/caminho/seguro/firebase-service-account.json
node scripts/expand-firestore.js
node scripts/expand-firestore.js --apply
```

O primeiro comando é apenas planejamento; o segundo grava/atualiza os números de `1` a `150000`, cria os shards e mantém a campanha em preparação. Não publique a lista de premiados no frontend ou no GitHub.

## Deploy

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

Antes de abrir as vendas, configure o UID administrativo, os segredos PagBank e faça uma compra sandbox controlada. O domínio usado pela Vercel também deve estar autorizado no Firebase Authentication para login e recuperação de senha.
