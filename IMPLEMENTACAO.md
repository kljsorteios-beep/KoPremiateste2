# Implementação da Kóòpremia

## Visão geral

O projeto agora separa o frontend público da lógica crítica. O navegador não escolhe números, não altera status de cotas, não confirma pagamentos e não recebe a lista de números premiados. Ele apenas solicita uma reserva e exibe o QR Code Pix retornado pelo backend.

A reserva usa transações atômicas e shards de disponibilidade no Firestore. O pedido fica com status `aguardando_pagamento` por 10 minutos. Quando o PagBank envia um webhook autenticado indicando `PAID`, o backend valida o pedido, o valor e a moeda, converte a reserva em compra definitiva, grava `compras/{pedidoId}`, atualiza os documentos de `cotas` e incrementa o cotômetro. A rotina agendada libera pedidos expirados.

> **Importante:** nenhuma cobrança real, nenhum número premiado e nenhuma escrita no Firebase de produção foram executados por esta tarefa. O gerador foi validado localmente.

## Estrutura adicionada

| Arquivo | Função |
|---|---|
| `firebase-client.js` | Configuração comum do Firebase Auth, Firestore e Functions no frontend. |
| `compra.js` | Cotômetro, menu autenticado, reserva, QR Code Pix, copia e cola e contador de 10 minutos. |
| `functions/index.js` | Reserva atômica, PagBank, webhook, expiração, estado público e painel administrativo. |
| `scripts/generate-raffle.js` | Geração criptograficamente aleatória, manifesto, hashes e publicação opcional. |
| `admin.html` | Configuração de meta/status e consulta protegida dos números premiados. |
| `firestore.rules` | Bloqueia manipulação de cotas, disponibilidade, pedidos e compras pelo navegador. |
| `firestore.indexes.json` | Índices para expiração e listagem de pedidos. |
| `firebase.json` | Hosting, Functions, regras e índices. |

## Modelo de dados

A coleção `disponibilidade` usa documentos `shard_000` até `shard_149`, cada um com até mil números disponíveis. A seleção é feita no backend usando `crypto.randomInt`; o navegador nunca lê esses shards.

A coleção `pedidos` guarda a reserva e o estado do pagamento. Os status principais são `criando_pagamento`, `aguardando_pagamento`, `pago`, `expirada`, `cancelado`, `pagamento_tardio` e `pagamento_inconsistente`.

A coleção `compras` contém somente pedidos confirmados e possui `uid`, dados básicos do comprador, `numeros`, `quantidade`, `totalCents`, `status`, `pagbankOrderId` e `paidAt`. O perfil do usuário lê os documentos dessa coleção filtrados pelo próprio UID.

A coleção `numerosPremiados` contém os 10 mil números vencedores, mas as regras negam sua leitura direta. A função `getWinningNumbers` só responde a usuários reconhecidos como administradores. O arquivo local `numeros-premiados.csv` e os hashes do manifesto são confidenciais.

## Configuração de administrador

Obtenha o UID do usuário administrador na tela Authentication do Firebase. Crie `functions/.env` localmente, sem publicar no GitHub:

```dotenv
PAGBANK_API_URL=https://sandbox.api.pagseguro.com
ADMIN_UIDS=UID_DO_ADMINISTRADOR
```

O UID também pode ser definido por custom claim `admin: true`, mas isso exige um procedimento administrativo separado. A página `admin.html` permite alterar `targetSoldNumbers`, abrir/encerrar a campanha e visualizar os números premiados em páginas de 200 registros.

## Segredos do PagBank

O token de API não deve ser colocado no HTML ou no GitHub. Configure-o no Secret Manager das Functions:

```bash
firebase functions:secrets:set PAGBANK_ACCESS_TOKEN
firebase functions:secrets:set PAGBANK_WEBHOOK_TOKEN
```

Se o PagBank fornecer um único token de conta para criação e validação da notificação, ele pode ser definido nos dois segredos. O código também pode montar automaticamente a URL de webhook como:

```text
https://southamerica-east1-SEU_PROJECT_ID.cloudfunctions.net/pagbankWebhook
```

O pedido Pix inclui `reference_id`, valor em centavos, data de expiração e `notification_urls`. O webhook valida o header `x-authenticity-token` calculando SHA-256 sobre `token-payload` sem formatar o JSON.

## Recuperação de senha e controles de acesso

A tela `login.html` agora oferece `Esqueci minha senha`. O Firebase envia o link usando `sendPasswordResetEmail`; para funcionar em produção, o domínio do Vercel precisa estar autorizado em **Authentication > Settings > Authorized domains**. O botão `Mostrar/Ocultar` altera apenas o tipo visual do campo no navegador e nunca grava a senha no Firestore.

## Expansão segura do Firestore para 150 mil números

Não use a opção **Adicionar documento** do console para criar 140 mil registros manualmente. O comando `scripts/expand-firestore.js` lê a coleção `cotas`, preserva documentos já existentes, cria os shards compactos de disponibilidade e grava os 10 mil documentos de `numerosPremiados` sem expor a lista ao frontend. O modo padrão não materializa os 150 mil documentos `cotas`; eles são criados somente quando um número é reservado ou vendido. A opção `--materialize-tickets` existe apenas para projetos com quota/faturamento suficientes e não deve ser usada no plano gratuito.

Primeiro faça um backup do Firestore. Depois instale as dependências e rode o modo de planejamento usando uma conta de serviço com permissão administrativa:

```bash
npm --prefix functions install
export GOOGLE_APPLICATION_CREDENTIALS=/caminho/seguro/firebase-service-account.json
node scripts/expand-firestore.js
```

O modo de planejamento apenas lê o banco e mostra a quantidade de documentos existentes, números disponíveis, shards previstos e a origem da lista premiada. Se `numerosPremiados` estiver vazio, o script gera uma lista criptograficamente aleatória de 10 mil números. Depois da primeira publicação, as próximas execuções reutilizam exatamente a lista existente; se houver uma coleção incompleta, o script para e exige conferência manual. Quando conferir o resultado, rode explicitamente:

```bash
node scripts/expand-firestore.js --apply
```

No plano gratuito, use exatamente o comando acima. Ele grava aproximadamente 10 mil documentos premiados, cerca de 150 shards e poucos documentos de configuração; não grava 150 mil documentos `cotas`. Não acrescente `--materialize-tickets`.

O script mantém a campanha em `preparacao` depois da carga. Isso é intencional: primeiro confirme o webhook Pix em sandbox e só depois abra a venda pelo painel. Para alterar o limite de documentos legados preservados, use, por exemplo, `--preserve-until=10000`. No modo compacto, a operação grava aproximadamente 10.150 documentos iniciais, além de preservar os documentos existentes, e recalcula o pool de números disponíveis.

Quando o pagamento for confirmado, a Cloud Function atualiza os documentos `cotas/{numero}` com `comprador`, `cpf`, `compradorUid`, `pedidoId` e `status: "indisponivel"`. O mesmo número não pode ser escolhido novamente porque foi removido do pool dentro de uma transação Firestore. Se a reserva vencer sem pagamento, os campos são limpos e o status volta para `disponivel`.

## Geração local dos números

O comando abaixo gera arquivos locais sem publicar nada:

```bash
node scripts/generate-raffle.js --output=generated-raffle
```

O comando de publicação deve ser executado somente depois de conferir backup e regras do banco:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/caminho/seguro/firebase-service-account.json
node scripts/generate-raffle.js --publish --write-ticket-docs --output=generated-raffle
```

Por compatibilidade com o banco existente, `--write-ticket-docs` preserva `cotas/1` até `cotas/10000` e cria os novos documentos `cotas/10001` até `cotas/150000`. Se os documentos legados não corresponderem a esse intervalo, ajuste `--preserveExistingCount` antes da publicação.

O gerador define a campanha como `preparacao`. Depois de revisar a configuração, o administrador pode abrir a venda no painel. O limite de vendas é configurável e não pode superar 150 mil.

## Deploy

Depois de adicionar as credenciais como segredos e revisar `functions/.env`, instale as dependências e publique:

```bash
npm --prefix functions install
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

A publicação das Functions deve ocorrer antes de testar uma cobrança PagBank. A URL exibida no console do Firebase será a mesma usada automaticamente na próxima criação de pedido.

## Teste sandbox recomendado

O primeiro teste deve usar uma conta de teste e uma compra pequena. O roteiro é: criar/login do usuário; abrir a campanha em sandbox; selecionar uma quantidade; confirmar que os números aparecem como reserva; pagar o QR Code Pix do PagBank; verificar que o webhook chega; confirmar `pedidos/{id}` como `pago`; confirmar a criação de `compras/{id}`; atualizar o perfil; conferir que o cotômetro aumentou; tentar reservar novamente o mesmo fluxo concorrente; e esperar ou simular a expiração para confirmar a devolução dos números.

Não coloque a campanha em `aberta` antes de confirmar que o webhook está validado e que o valor recebido é comparado com `totalCents`. A confirmação de qualquer payload com valor diferente deve permanecer como `pagamento_inconsistente` e não pode liberar números.

## Referências técnicas

[1]: https://developer.pagbank.com.br/reference/criar-pedido-pedido-com-qr-code "PagBank — Criar pedido com QR Code Pix"

[2]: https://developer.pagbank.com.br/reference/webhooks "PagBank — Webhooks"

[3]: https://developer.pagbank.com.br/reference/confirmar-autenticidade-da-notificacao "PagBank — Confirmar autenticidade da notificação"

[4]: https://firebase.google.com/docs/firestore/manage-data/transactions "Firebase — Transactions and batched writes"
