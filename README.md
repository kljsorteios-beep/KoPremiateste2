# Kóòpremios

Site da campanha com Firebase Authentication, Firestore e Cloud Functions para reserva de números e integração Mercado Pago Pix.

A campanha utiliza 150.000 números, dos quais exatamente 10.000 cotas adicionais são reservadas para premiação. A Honda XRE 190 2026 é o prêmio principal e fica fora dessas 10.000 cotas; ela será sorteada separadamente quando a campanha atingir 100%. O fundo adicional de R$ 10.000,00 é dividido entre as cotas adicionais conforme o plano de prêmios definido pelo administrador.

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

O gerador cria exatamente 10.000 cotas vencedoras adicionais por padrão, com `isWinningNumber: true` e `prizeCategory: adicional`. O mapa permanece confidencial e os nomes/valores podem ser definidos posteriormente. A XRE não é gravada nessa lista; seu resultado fica em `sorteios/xre` e `ganhadores/xre` após 100%.

## Expansão segura do Firestore

Faça backup e configure uma conta de serviço segura antes de executar. O primeiro comando é apenas planejamento; o segundo grava/atualiza a campanha. Nenhum dos comandos deve ser executado contra produção sem revisar o backup, o regulamento, o mapa de prêmios e as regras:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/caminho/seguro/firebase-service-account.json
node scripts/expand-firestore.js
node scripts/expand-firestore.js --apply --keep-existing-winners
```

Se os registros legados da coleção `numerosPremiados` ainda representarem uma configuração antiga, a exclusão deve ser uma decisão explícita e só ocorrer após backup:

```bash
node scripts/expand-firestore.js --apply --clear-legacy-winners
```

O modo compacto não materializa 150.000 documentos `cotas`; eles são criados sob demanda quando números são reservados ou vendidos. Não use `--materialize-tickets` no plano gratuito sem verificar quota e faturamento.

## Segredos

Tokens e chaves não devem ser colocados no HTML ou no GitHub:

```bash
firebase functions:secrets:set MERCADOPAGO_ACCESS_TOKEN
firebase functions:secrets:set MERCADOPAGO_WEBHOOK_SECRET
firebase functions:secrets:set RESEND_API_KEY
```

Configure `EMAIL_FROM` com um endereço de remetente de domínio verificado no provedor de e-mail. Configure o UID administrativo em `ADMIN_UIDS` ou por custom claim `admin: true`.

## Deploy

```bash
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

Antes de abrir as vendas, resolva todas as pendências do faturamento, publique as Functions e regras, valide o domínio no Firebase Authentication, configure o Mercado Pago Pix e execute uma compra de teste controlada. O webhook deve consultar o pagamento oficial e confirmar somente status `approved`, valor e moeda compatíveis. Confirme também que uma cota premiada cria um documento privado em `ganhadores` e que o sorteio da XRE permanece bloqueado antes de 100%.

A documentação detalhada está em [`IMPLEMENTACAO.md`](IMPLEMENTACAO.md), e a auditoria histórica está em [`AUDITORIA.md`](AUDITORIA.md).
