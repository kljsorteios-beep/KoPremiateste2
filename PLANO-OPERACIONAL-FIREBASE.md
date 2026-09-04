# Plano operacional Firebase — Kóòpremios

## 1. Faturamento

A captura da conta apresenta três alertas: pagamento pendente de pelo menos R$ 200, cartão expirado e informações fiscais incompletas. Portanto, não é seguro concluir que basta pagar R$ 200. Primeiro, atualize o método de pagamento e os dados fiscais; depois quite o valor solicitado no Google Payments e aguarde a confirmação. Só então tente reabrir a Cloud Billing account.

A documentação do Google informa que uma conta fechada só pode ser reaberta depois de resolvidos os problemas de pagamentos ou suspensões e que é necessário ter permissão de Billing Account Administrator. O pagamento manual pode aparecer como crédito para uso futuro, mas pode haver atraso de processamento e outras pendências.

Ações manuais: abrir o Google Cloud Console, selecionar o billing account correto, corrigir cartão e informações fiscais, pagar o valor solicitado, verificar o status como `Active`/`Open`, reabrir a conta se o botão estiver disponível e confirmar que o projeto `kopremia-128fe` está vinculado a essa conta. Não desligar o Firebase nem apagar o projeto antigo.

## 2. Modelo da campanha

A campanha possui 150.000 números possíveis e exatamente 10.000 cotas adicionais premiadas. A XRE não pertence à coleção dos 10.000: ela é um prêmio principal separado, registrado em `sorteios/xre`, e só pode ser sorteada quando o estado da campanha estiver `encerrada` e `soldNumbers >= targetSoldNumbers`.

Os 10.000 números adicionais devem ser gerados com `crypto.randomInt`, armazenados em `numerosPremiados` com `isWinningNumber: true` e mantidos inacessíveis ao cliente. O comprador de uma dessas cotas é registrado em `ganhadores/adicional_XXXXXX`. O resultado da XRE é registrado em `ganhadores/xre` e `sorteios/xre`.

Antes do deploy, o administrador deve conferir um backup e confirmar que a coleção possui exatamente 10.000 documentos válidos, números únicos entre 1 e 150.000 e que a XRE não foi inserida nessa coleção.

## 3. Backend e compras

O backend reserva números aleatórios dentro de uma transação Firestore e registra pedidos em `pedidos`. Após o webhook do pagamento aprovado, a compra é gravada em `compras/{pedidoId}`, as cotas são marcadas como vendidas e, caso haja número premiado adicional, os dados do comprador são copiados para a coleção privada `ganhadores`.

O painel administrativo usa `getAdminPurchases` para listar pedidos, `getAdminWinners` para listar ganhadores e `drawXreWinner` para realizar o sorteio principal. O sorteio usa uma trava em `sorteios/xre`, impede execução antecipada, seleciona somente números de compras pagas e exclui cotas já registradas como vencedoras adicionais.

## 4. Segurança obrigatória

As regras Firestore bloqueiam leitura direta de `cotas`, `disponibilidade`, `numerosPremiados`, `ganhadores`, `sorteios`, `configuracoes` e `estado`. O acesso administrativo ocorre somente pelas Cloud Functions, validando claim `admin` ou UID presente em `ADMIN_UIDS`.

Após publicar as regras, testar com cliente anônimo e esperar `permission-denied` ao tentar ler `cotas/1` e `numerosPremiados/000001`. Testar também que usuário comum não acessa o painel administrativo e que somente o administrador consegue chamar as três Functions administrativas.

## 5. Ordem de publicação

1. Fazer backup do Firestore e guardar o arquivo fora do GitHub.
2. Atualizar o método de pagamento e reabrir a conta de faturamento.
3. Publicar as regras Firestore.
4. Gerar ou auditar os 150.000 números e os 10.000 vencedores adicionais em modo de planejamento.
5. Aplicar os dados somente após revisar o backup e colocar a campanha em `preparacao`.
6. Fazer deploy das Cloud Functions na região `southamerica-east1`.
7. Configurar `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` e o webhook HTTPS `mercadoPagoWebhook` no painel do Mercado Pago.
8. Configurar o segredo `RESEND_API_KEY` e `EMAIL_FROM`, caso o e-mail transacional seja utilizado.
9. Configurar o domínio na Vercel e autorizar o domínio no Firebase Authentication.
10. Criar conta de teste, testar cadastro, login, logout e recuperação de senha.
11. Fazer uma compra sandbox, confirmar o QR Code, verificar o webhook, a compra, os números e o cotômetro.
12. Confirmar que a compra de uma cota premiada cria o registro privado em `ganhadores`.
13. Somente depois de todos os testes, trocar credenciais sandbox por produção e abrir vendas.

## Referências

[1] [Google Cloud — Reabrir uma conta de faturamento](https://docs.cloud.google.com/billing/docs/how-to/close-or-reopen-billing-account).

[2] [Google Cloud — Pagamento manual ou antecipado](https://docs.cloud.google.com/billing/docs/how-to/manual-payment).

[3] [Firebase — Planos de faturamento](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans).

[4] [Firebase — Regras de segurança do Firestore](https://firebase.google.com/docs/firestore/security/get-started).
