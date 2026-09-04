# Implementação da Kóòpremios

## Visão geral

O projeto separa o frontend público da lógica crítica. O navegador não escolhe números, não altera status de cotas, não confirma pagamentos e não recebe a lista de números com prêmio. Ele solicita uma reserva e exibe o QR Code Pix retornado pelo backend.

A campanha possui **150.000 números** e exatamente **10.000 cotas adicionais premiadas**. A Honda XRE 190 2026 é o prêmio principal e fica fora da coleção das 10.000; ela é sorteada em etapa separada quando a campanha atingir 100%. O fundo adicional de **R$ 10.000,00** é distribuído entre as 10.000 cotas conforme o plano de prêmios definido pelo administrador.

A reserva usa transações atômicas e shards de disponibilidade no Firestore. O pedido fica com status `aguardando_pagamento` por 10 minutos. Quando o Mercado Pago envia um webhook autenticado, o backend consulta `/v1/payments/{id}`, valida `status: "approved"`, referência externa, valor e moeda, converte a reserva em compra definitiva, grava `compras/{pedidoId}`, atualiza os documentos de `cotas` e incrementa o cotômetro. Uma rotina agendada libera pedidos expirados.

> **Importante:** nenhuma cobrança real, nenhum número premiado e nenhuma escrita no Firebase de produção foram executados durante esta revisão.

## Estrutura do projeto

| Caminho | Função |
|---|---|
| `firebase-client.js` | Configuração comum do Firebase Auth, Firestore e Functions no frontend. |
| `compra.js` | Cotômetro, menu autenticado, reserva, QR Code Pix, copia e cola e contador de 10 minutos. |
| `functions/index.js` | Reserva atômica, Mercado Pago Pix, webhook autenticado, expiração, estado público, painel administrativo e gatilho de e-mail. |
| `functions/package.json` | Dependências e scripts das Cloud Functions. |
| `scripts/generate-raffle.js` | Geração dos 150.000 números e exatamente 10.000 vencedores adicionais, hashes e publicação opcional. A XRE fica fora da lista. |
| `scripts/expand-firestore.js` | Normalização do Firestore, preservação/complementação até 10.000 vencedores adicionais e carga opcional do catálogo de prêmios. |
| `admin.html` | Configuração da meta/status, compras, ganhadores, auditoria das cotas e sorteio controlado da XRE. |
| `firestore.rules` | Bloqueia manipulação direta de cotas, disponibilidade, pedidos, compras e prêmios pelo navegador. |
| `firebase.json` | Hosting, Functions, regras e índices. |

O pacote foi reorganizado para corresponder ao `firebase.json`: as Functions ficam em `functions/` e os utilitários administrativos ficam em `scripts/`. Essa correção é necessária porque o arquivo recebido declarava essas pastas, mas elas não existiam no ZIP original.

## Modelo de dados

A coleção `disponibilidade` usa documentos `shard_000` até os shards necessários, cada um com até mil números disponíveis. A seleção é feita no backend usando `crypto.randomInt`; o navegador nunca lê esses shards.

A coleção `pedidos` guarda a reserva e o estado do pagamento. Os status principais são `criando_pagamento`, `aguardando_pagamento`, `pago`, `expirada`, `cancelado`, `pagamento_tardio` e `pagamento_inconsistente`.

A coleção `compras` contém somente pedidos confirmados e possui `uid`, dados básicos do comprador, `email`, `numeros`, `quantidade`, `totalCents`, `status`, `mercadopagoPaymentId` e `paidAt`. A área Minha Conta consulta os documentos filtrados pelo próprio UID e exibe os números formatados.

A coleção `numerosPremiados` contém exatamente as 10.000 cotas adicionais, com `isWinningNumber: true` e `prizeCategory: adicional`. Cada documento pode ter `numero`, `numeroFormatado`, `premioId`, `premioNome`, `premioTipo`, `premioValorCents`, `status` e `generationId`. Os nomes e valores podem ficar pendentes até o administrador definir o plano. A XRE não deve ser inserida nessa coleção.

A coleção `auditoria/rifa` guarda o conjunto confidencial de números com prêmio, seus hashes e metadados da geração. A função `getWinningNumbers` só responde a usuários reconhecidos como administradores. A coleção `numerosPremiados` e a auditoria continuam bloqueadas para o navegador público.

## Configuração de administrador

Obtenha o UID do usuário administrador na tela Authentication do Firebase. O UID pode ser definido pela variável `ADMIN_UIDS` nas Functions ou por custom claim `admin: true`. A página `admin.html` permite alterar `targetSoldNumbers` e o status da campanha. O administrador só deve abrir a venda após revisar o mapa de prêmios, as regras, os segredos e o teste sandbox.

## Configuração do Mercado Pago Pix

O Access Token e a chave secreta do webhook não devem ser colocados no HTML, no frontend ou no GitHub. Configure os segredos nas Cloud Functions:

```bash
firebase functions:secrets:set MERCADOPAGO_ACCESS_TOKEN
firebase functions:secrets:set MERCADOPAGO_WEBHOOK_SECRET
```

Use `MERCADOPAGO_API_URL=https://api.mercadopago.com`. Se não definir `MERCADOPAGO_WEBHOOK_URL`, o backend monta automaticamente:

```text
https://southamerica-east1-SEU_PROJECT_ID.cloudfunctions.net/mercadoPagoWebhook
```

O backend cria o pagamento em `/v1/payments` com `transaction_amount` em reais, `payment_method_id: "pix"`, `external_reference`, `date_of_expiration` e `notification_url`. A resposta usa `point_of_interaction.transaction_data.qr_code` e, quando fornecido, `qr_code_base64`. O webhook valida `x-signature`/`x-request-id`, consulta o pagamento na API do Mercado Pago e só confirma `approved` com referência, valor e moeda compatíveis.

## Confirmação automática por e-mail

Depois que o webhook cria `compras/{pedidoId}` com `status: "pago"`, a Function `sendPurchaseConfirmationEmail` envia uma mensagem com os números comprados. O fluxo não envia e-mail na simples reserva; isso evita confirmar uma compra que ainda não foi paga.

A implementação usa a API do Resend por HTTPS. Configure a chave como segredo e o remetente como variável de ambiente da Function:

```bash
firebase functions:secrets:set RESEND_API_KEY
# Em functions/.env local ou no ambiente de deploy:
EMAIL_FROM="Kóòpremios <confirmacao@seu-dominio.com>"
```

O domínio do remetente precisa ser verificado no Resend. Em produção, defina `EMAIL_FROM` no ambiente das Functions sem colocar a chave secreta no repositório. Nunca coloque `RESEND_API_KEY` em `firebase-client.js`, em arquivo HTML ou no repositório público.

O status da entrega é salvo em `compras/{pedidoId}.confirmationEmail`. Os estados esperados incluem `enviado`, `sem_email` e `aguardando_configuracao`. Enquanto o segredo ou o remetente não estiver configurado, os números continuam disponíveis na área Minha Conta, mas o e-mail não será enviado.

## Arquivo explícito do plano de prêmios

O script `scripts/expand-firestore.js` garante 10.000 vencedores adicionais aleatórios por padrão. Se alguns prêmios já estiverem definidos, crie localmente um arquivo JSON confidencial para completar o catálogo, por exemplo:

```json
[
  {
    "numero": 12345,
    "premioId": "pix-001",
    "premioNome": "Prêmio adicional Pix",
    "premioTipo": "adicional",
    "premioValorCents": 50000
  },
  {
    "numero": 54321,
    "premioId": "pix-002",
    "premioNome": "Prêmio adicional Pix",
    "premioTipo": "adicional",
    "premioValorCents": 10000
  }
]
```

O arquivo deve conter apenas números realmente premiados, sem duplicidade, e deve ser mantido fora do frontend e do GitHub público. O exemplo acima é ilustrativo e não deve ser publicado como resultado real.

Antes de qualquer aplicação, faça backup do Firestore, revise o regulamento e rode o modo de planejamento:

```bash
npm --prefix functions install
export GOOGLE_APPLICATION_CREDENTIALS=/caminho/seguro/firebase-service-account.json
node scripts/expand-firestore.js --prizes-file=/caminho/seguro/premios.json
```

Se a coleção antiga `numerosPremiados` ainda contiver os 10.000 registros legados, não use `--apply` automaticamente. Primeiro faça a conferência. Para manter os registros antigos de forma explícita, use `--keep-existing-winners`; para remover a coleção antiga antes de cadastrar nenhum número, use somente depois do backup:

```bash
node scripts/expand-firestore.js --apply --clear-legacy-winners
```

O modo compacto não materializa 150.000 documentos `cotas`; esses documentos são criados quando um número é reservado ou vendido. A opção `--materialize-tickets` só deve ser usada se o projeto tiver quota e faturamento suficientes.

## Geração local dos 150.000 números

O comando abaixo gera os arquivos localmente, sem publicar, com 150.000 números e 10.000 vencedores adicionais:

```bash
node scripts/generate-raffle.js --output=generated-raffle
node scripts/validate-generated.js generated-raffle --expected-winners=10000
```

Se for necessário gerar novamente a lista, mantenha `--winners=10000` e revise o resultado. A XRE continua separada. O fundo adicional pode ser informado em centavos:

```bash
node scripts/generate-raffle.js \
  --winners=10000 \
  --prizePoolCents=1000000 \
  --publish \
  --output=generated-raffle
```

A geração mantém `targetSoldNumbers` em 150.000 e inicia a campanha em `preparacao`. O administrador deve abrir as vendas somente depois de confirmar o mapa de prêmios e o fluxo de pagamento.

## Deploy

Depois de adicionar as credenciais como segredos, confirmar a conta de faturamento e revisar o projeto:

```bash
npm --prefix functions install
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

A publicação das Functions deve ocorrer antes de testar uma cobrança Mercado Pago. A URL exibida no console do Firebase será usada automaticamente pelo próximo pedido, salvo se `MERCADOPAGO_WEBHOOK_URL` estiver definida.

## Checklist de teste sandbox

O primeiro teste deve usar uma conta de teste e uma compra pequena. Crie e autentique o usuário, abra a campanha em sandbox, selecione uma quantidade, confirme que a reserva é criada, pague o QR Code Pix de teste, verifique se o webhook chega, confirme `pedidos/{id}` como `pago`, confirme a criação de `compras/{id}`, confira se os números aparecem na área Minha Conta e valide o recebimento do e-mail.

Também teste a expiração sem pagamento, duas reservas concorrentes, pagamento com valor incompatível, webhook com assinatura inválida, usuário sem permissão administrativa e falha temporária do provedor de e-mail. Não coloque a campanha em `aberta` antes desses testes.

## Domínio e faturamento

O domínio comprado deve ser adicionado na Vercel e apontado pelos registros DNS exibidos no painel da Vercel. O mesmo domínio final deve ser autorizado em **Firebase Authentication > Settings > Authorized domains**. Se for usado como remetente, ele também deve ser verificado no provedor de e-mail.

A conta do Google Cloud Billing deve ser criada ou vinculada ao projeto `kopremia-128fe` por um usuário com permissão de administrador de faturamento. Antes de fazer deploy, configure orçamento e alertas de gasto. A ativação do faturamento é uma operação na conta do usuário e não foi executada nesta revisão.

## Referências técnicas

[1]: https://www.mercadopago.com.br/developers/en/docs/checkout-api/payment-integration "Mercado Pago — Integração de meios de pagamento"
[2]: https://www.mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks "Mercado Pago — Webhooks"
[3]: https://www.mercadopago.com.br/developers/en/reference/payments/_payments/post "Mercado Pago — Criar pagamento"

[4]: https://firebase.google.com/docs/firestore/manage-data/transactions "Firebase — Transactions and batched writes"

[5]: https://resend.com/docs/api-reference/emails/send-email "Resend — Send Email API"

[6]: https://docs.cloud.google.com/billing/docs/concepts "Google Cloud — Cloud Billing overview"
