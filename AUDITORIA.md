# Auditoria técnica — Kóòpremios Firebase

## Controles verificados

| Controle | Resultado |
|---|---|
| Quantidade total | O projeto mantém 150.000 números e o painel rejeita meta superior a esse limite. |
| Cotas adicionais premiadas | O gerador e a expansão trabalham com exatamente 10.000 cotas adicionais, marcadas como `isWinningNumber: true`. |
| Prêmio principal | A XRE fica fora da coleção das 10.000 cotas e possui sorteio separado em `sorteios/xre`. |
| Distribuição | Os números são distribuídos em shards e escolhidos aleatoriamente no backend com `crypto.randomInt`. |
| Duplicidade | A retirada do pool ocorre em transação Firestore; reservas concorrentes não devem retirar o mesmo número. |
| Reserva | O pedido recebe expiração de 10 minutos; a rotina agendada libera pedidos em `criando_pagamento` ou `aguardando_pagamento`. |
| Pagamento | A versão final usa Mercado Pago Pix em `/v1/payments`, `external_reference`, QR Code e webhook `mercadoPagoWebhook`. |
| Webhook | O endpoint Mercado Pago verifica `x-signature`/`x-request-id`, consulta o pagamento oficial e confirma somente `approved`. |
| Valor recebido | O webhook compara valor e moeda do pagamento com `totalCents` antes de criar a compra. |
| Histórico de compras | Compras pagas são gravadas em `compras/{pedidoId}` e agora podem ser consultadas pelo administrador via `getAdminPurchases`. |
| Ganhadores adicionais | Quando uma compra paga contém uma das 10.000 cotas, o comprador é copiado para `ganhadores/adicional_XXXXXX` e o número premiado é atualizado. |
| Sorteio da XRE | `drawXreWinner` exige administrador, estado `encerrada`, meta atingida e usa uma trava em `sorteios/xre`; o resultado também é gravado em `ganhadores/xre`. |
| Cotômetro | O contador usa números vendidos confirmados e a meta configurável, exibindo somente o percentual no frontend. |
| Autenticação | Login, cadastro, perfil e recuperação de senha carregam visualmente na Vercel; a autenticação real requer teste com conta autorizada. |
| Segurança | O Firestore bloqueia leitura direta de cotas, disponibilidade, números premiados, ganhadores, sorteios, configuração e estado. |
| Administração | O painel possui histórico de compras, ganhadores, auditoria das cotas e roleta visual; a escolha real é feita no backend. |
| E-mail | O gatilho de e-mail existente depende de `RESEND_API_KEY` e `EMAIL_FROM`; a configuração real ainda não foi comprovada. |

## Testes locais

Foram aprovados `node --check` para `functions/index.js`, `scripts/generate-raffle.js`, `scripts/expand-firestore.js` e para o JavaScript embutido do painel. O lint declarado das Functions passou. A geração local produziu 150.000 números de distribuição e 10.000 vencedores adicionais únicos.

## Verificações públicas

Em 04/09/2026, a página inicial, o login e o cadastro carregaram na Vercel. A versão publicada anterior respondeu HTTP 200 anônimo para `numerosPremiados` e retornou HTTP 404 nas Functions esperadas, incluindo o antigo endpoint PagBank. Isso é evidência histórica da necessidade de publicar a cópia final, não uma validação da configuração atual.

O HTTP 200 anônimo da coleção é um bloqueio de segurança. As regras do pacote precisam ser publicadas no projeto correto; depois, uma leitura anônima de `cotas/1` e `numerosPremiados/000001` deve retornar `permission-denied`. O HTTP 404 das Functions indica que o backend esperado não está implantado nessa URL/região/projeto ou usa nomes diferentes.

## Faturamento

A captura apresentada mostra pagamento pendente de pelo menos R$ 200, cartão expirado e informações fiscais incompletas. Não é possível afirmar que apenas o pagamento resolve a situação. É necessário corrigir os três alertas, confirmar o processamento e reabrir a Cloud Billing account. O Google Cloud informa que problemas de pagamentos ou suspensões precisam ser resolvidos antes da reabertura [1] [2].

## Ações obrigatórias antes de abrir vendas

Faça backup do Firestore; corrija faturamento; publique `firestore.rules`; publique as Functions na região declarada pelo frontend; configure os secrets Mercado Pago e Resend; confirme o claim `admin` ou `ADMIN_UIDS`; teste login, cadastro e perfil; faça uma compra de teste; valide QR Code, webhook, `compras`, cotas e `ganhadores`; e só então configure o domínio e abra vendas.

Não execute o sorteio da XRE em teste de produção. A Function somente deve permitir a operação quando a campanha estiver encerrada e 100% da meta estiver confirmada. A regularidade jurídica e regulatória da campanha deve continuar sendo mantida pelo responsável e seus profissionais.

## Referências

[1] [Google Cloud — Fechar ou reabrir uma conta de faturamento](https://docs.cloud.google.com/billing/docs/how-to/close-or-reopen-billing-account).

[2] [Google Cloud — Fazer pagamento manual ou antecipado](https://docs.cloud.google.com/billing/docs/how-to/manual-payment).
