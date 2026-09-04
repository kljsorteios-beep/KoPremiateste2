# Relatório técnico — retorno ao Firebase

**Projeto analisado:** Kóòpremios / `kopremia-128fe`  
**Data da verificação:** 04/09/2026  
**Ambiente alterado:** cópia local de trabalho; nenhuma alteração foi publicada em produção.

## Resumo executivo

A versão pública anterior da Vercel estava acessível, mas o backend correspondente não estava disponível nos endpoints verificados. A cópia final usa a frase “São 10 Mil cotas premiadas, participe e boa sorte!” e substitui o antigo webhook por `mercadoPagoWebhook` para Mercado Pago Pix. Nenhuma alteração desta cópia local foi publicada em produção.

A versão revisada mantém 150.000 números possíveis. Os 10.000 vencedores adicionais ficam na coleção privada `numerosPremiados`; a XRE não deve estar nessa coleção. O novo painel registra compradores premiados em `ganhadores/adicional_XXXXXX` e o resultado principal em `sorteios/xre` e `ganhadores/xre`.

## Alterações realizadas

O gerador `scripts/generate-raffle.js` agora usa 10.000 vencedores por padrão, sorteados com `crypto.randomInt`, mantendo a XRE em uma etapa separada. A expansão `scripts/expand-firestore.js` foi corrigida para importar `node:crypto`, preservar vencedores existentes, completar a lista até 10.000 quando necessário e marcar os documentos com `isWinningNumber: true` e `prizeCategory: adicional`.

O backend reconhece as 10.000 cotas adicionais mesmo quando o catálogo de prêmio está pendente. Após um pagamento confirmado, ele grava o comprador em `ganhadores`, atualiza `numerosPremiados` e mantém o histórico de `compras`. Foram adicionadas as Functions `getAdminPurchases`, `getAdminWinners` e `drawXreWinner`. O sorteio da XRE exige autenticação administrativa, campanha encerrada e `soldNumbers >= targetSoldNumbers`; usa trava em `sorteios/xre`, seleciona apenas números de compras pagas e exclui ganhadores adicionais.

O painel `admin.html` agora apresenta histórico de compras, ganhadores adicionais, a roleta visual de apresentação e o botão do sorteio principal bloqueado até 100%. A escolha real é feita pelo backend; a animação é somente visual. As regras Firestore mantêm `cotas`, `disponibilidade`, `numerosPremiados`, `ganhadores`, `sorteios`, `configuracoes` e `estado` inacessíveis diretamente ao navegador.

## Faturamento

A captura enviada mostra três pendências no Google Payments: pagamento de pelo menos R$ 200, cartão expirado e dados fiscais incompletos. Não é possível afirmar que o pagamento de R$ 200 seja a única exigência. O cartão e os dados fiscais precisam ser corrigidos; depois o pagamento deve ser confirmado e a Cloud Billing account reaberta. O valor pago pode aparecer como crédito, mas a conta só ficará utilizável quando estiver em estado ativo e vinculada ao projeto correto.

## Testes realizados

A sintaxe de `functions/index.js`, `scripts/generate-raffle.js` e `scripts/expand-firestore.js` passou, assim como o lint declarado das Functions. A geração local produziu 150.000 números de distribuição e 10.000 vencedores, todos únicos. O teste real do emulador e uma compra Mercado Pago não foram executados neste sandbox por falta de Firebase CLI/projeto/credenciais.

## Bloqueios antes da publicação

As Functions precisam ser implantadas no projeto Firebase correto, na região correta, e o frontend precisa apontar para os mesmos endpoints. Depois do deploy, a chamada pública de `getPublicRaffleState` deve retornar o estado; o webhook precisa responder conforme o protocolo do provedor de pagamento; e o login/cadastro devem ser testados com uma conta de teste.

As regras Firestore precisam ser publicadas e testadas com cliente anônimo. Leituras de `cotas/1` e `numerosPremiados/000001` devem retornar `permission-denied`. O administrador deve ter claim `admin` ou UID listado em `ADMIN_UIDS`; apenas a existência de uma conta logada não deve conceder acesso ao painel.

Antes de abrir vendas, execute uma compra de teste completa no Mercado Pago, confirme o QR Code, valide `x-signature`, a consulta `/v1/payments/{id}`, a criação de `compras`, a atualização do estado público e a criação de `ganhadores` quando uma cota premiada for comprada. Não execute `drawXreWinner` em produção até que a campanha esteja realmente encerrada e o cotômetro tenha atingido 100%.

## Referências oficiais

[1] [Google Cloud — Fechar ou reabrir uma conta de faturamento](https://docs.cloud.google.com/billing/docs/how-to/close-or-reopen-billing-account).

[2] [Google Cloud — Fazer um pagamento manual ou antecipado](https://docs.cloud.google.com/billing/docs/how-to/manual-payment).

[3] [Firebase — Regras de segurança do Cloud Firestore](https://firebase.google.com/docs/firestore/security/get-started).
