# Kóòpremios

Site da campanha com Firebase Authentication, Firestore e Cloud Functions para reserva de números e integração Pix PagBank.

A campanha utiliza 150.000 números. O plano de premiação é separado da quantidade de números: há um prêmio principal, atualmente a Honda XRE 190 2026, e um fundo de prêmios adicionais de R$ 10.000,00. O valor de R$ 10.000,00 não significa 10.000 cotas premiadas.

## Desenvolvimento local

```bash
python3 -m http.server 4175
```

O frontend pode ser servido pela Vercel ou Firebase Hosting. A criação de pedidos, a confirmação de pagamento e o envio automático de e-mail dependem das Cloud Functions implantadas e configuradas.

## Instalação das Functions

```bash
npm --prefix functions install
npm --prefix functions run lint
```

## Modelo de prêmios

Não publique uma lista automática de 10.000 vencedores. O mapa real de prêmios deve ser criado em um arquivo JSON confidencial contendo somente os números que realmente receberão prêmio e os campos `premioId`, `premioNome`, `premioTipo` e, quando aplicável, `premioValorCents`. O script `scripts/expand-firestore.js` não gera números premiados por padrão.

## Expansão segura do Firestore

Faça backup e configure uma conta de serviço segura antes de executar. O primeiro comando é apenas planejamento; o segundo grava/atualiza a campanha. Nenhum dos comandos deve ser executado contra produção sem revisar o backup, o regulamento, o mapa de prêmios e as regras:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/caminho/seguro/firebase-service-account.json
node scripts/expand-firestore.js --prizes-file=/caminho/seguro/premios.json
node scripts/expand-firestore.js --apply --prizes-file=/caminho/seguro/premios.json
```

Se os registros legados da coleção `numerosPremiados` ainda representarem uma configuração antiga, a exclusão deve ser uma decisão explícita e só ocorrer após backup:

```bash
node scripts/expand-firestore.js --apply --clear-legacy-winners
```

O modo compacto não materializa 150.000 documentos `cotas`; eles são criados sob demanda quando números são reservados ou vendidos. Não use `--materialize-tickets` no plano gratuito sem verificar quota e faturamento.

## Segredos

Tokens e chaves não devem ser colocados no HTML ou no GitHub:

```bash
firebase functions:secrets:set PAGBANK_ACCESS_TOKEN
firebase functions:secrets:set PAGBANK_WEBHOOK_TOKEN
firebase functions:secrets:set RESEND_API_KEY
```

Configure `EMAIL_FROM` com um endereço de remetente de domínio verificado no provedor de e-mail. Configure o UID administrativo em `ADMIN_UIDS` ou por custom claim `admin: true`.

## Deploy

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

Antes de abrir as vendas, configure o faturamento do projeto, publique as Functions, valide o domínio no Firebase Authentication, configure o PagBank e execute uma compra sandbox controlada. O webhook deve confirmar somente pagamentos `PAID` com valor e moeda compatíveis.

A documentação detalhada está em [`IMPLEMENTACAO.md`](IMPLEMENTACAO.md), e a auditoria histórica está em [`AUDITORIA.md`](AUDITORIA.md).
