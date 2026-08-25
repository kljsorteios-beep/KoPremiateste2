# Auditoria técnica da versão atualizada

## Controles verificados

| Controle | Verificação |
|---|---|
| Quantidade total | O projeto mantém 150.000 números como total e o painel rejeita uma meta superior a esse limite. |
| Modelo de prêmios | O texto e a configuração distinguem 150.000 números de um fundo adicional de R$ 10.000,00. A quantidade de números com prêmio passou a ser variável e não é mais gerada automaticamente como 10.000. |
| Prêmio principal e adicionais | O backend suporta `premioTipo`, `premioNome`, `premioId` e `premioValorCents` na coleção `numerosPremiados`, permitindo separar o prêmio principal dos adicionais. |
| Distribuição | Os números são distribuídos em shards e escolhidos aleatoriamente no backend. O navegador não lê o pool de disponibilidade. |
| Duplicidade | A retirada do pool ocorre em transação Firestore; reservas concorrentes não devem retirar o mesmo número. |
| Reserva | O pedido recebe expiração de 10 minutos; a rotina agendada libera pedidos em `criando_pagamento` ou `aguardando_pagamento`. |
| Pix | O backend cria pedido PagBank com `reference_id`, valor em centavos, QR Code e expiração. |
| Webhook | O endpoint verifica o header `x-authenticity-token` e confirma somente cobranças `PAID`. |
| Valor recebido | O webhook compara valor e moeda do pagamento com `totalCents` antes de criar a compra. |
| Meus Títulos | Somente a confirmação `PAID` cria `compras/{pedidoId}`; o perfil filtra pelo UID autenticado e exibe os números com seis dígitos. |
| Cotômetro | O contador usa números vendidos confirmados e a meta configurável; reservas aparecem separadamente. |
| Encerramento | Ao atingir a meta, o backend muda o estado para `encerrada` e rejeita novas reservas. |
| Painel | A área administrativa continua protegida por autenticação e reconhecimento de administrador. A lista foi renomeada para “Números com prêmio”. |
| E-mail | Foi adicionado um gatilho após a criação de uma compra paga. Ele envia os números por Resend quando `RESEND_API_KEY` e `EMAIL_FROM` estão configurados; caso contrário, registra `aguardando_configuracao`. |
| Segredos | Tokens do PagBank e a chave Resend ficam previstos como segredos das Functions e não são inseridos no frontend. |
| Deploy | A árvore foi corrigida para corresponder ao `firebase.json`: `functions/index.js`, `functions/package.json` e utilitários em `scripts/`. |

## Testes locais realizados

A URL pública `https://ko-premiateste2.vercel.app/` carregou a página inicial, a galeria, o cotômetro inicial em 0 de 150.000, os controles de quantidade e o botão de participação. O console da página não apresentou mensagens de erro durante o carregamento observado. A versão publicada consultada ainda era a anterior à alteração do texto, pois o deploy da cópia modificada não foi executado.

Na cópia atualizada, foram executadas verificações de sintaxe nos arquivos JavaScript antes da finalização. O gerador e o validador foram ajustados para 150.000 números e zero vencedores por padrão, e a expansão do Firestore foi alterada para exigir um arquivo explícito de prêmios quando registros reais forem cadastrados.

## Limitações e ações pendentes

A confirmação do PagBank ainda não foi testada contra uma cobrança real ou sandbox porque as credenciais da conta do responsável não estão disponíveis nesta sessão. A publicação do Firestore e das Functions não foi executada. O envio real de e-mail depende de uma conta de provedor, domínio verificado, chave secreta e remetente configurado.

O banco atualmente mostrado na captura contém uma coleção `numerosPremiados` com registros legados. Isso não deve ser apagado ou reinterpretado automaticamente. Faça backup, confira o regulamento e escolha explicitamente entre carregar um novo arquivo de prêmios, manter os registros legados para revisão ou removê-los com `--clear-legacy-winners`.

A conta de faturamento do Google Cloud não foi criada nem vinculada nesta revisão. Essa operação exige acesso autenticado à conta do responsável e pode gerar cobrança conforme o uso; configure orçamento e alertas antes de publicar serviços pagos.

## Decisão de segurança

A campanha deve permanecer em `preparacao` até que o responsável defina os números premiados, o valor e a divisão dos prêmios adicionais, revise o regulamento, publique as Functions, valide o webhook em sandbox e confirme a entrega do e-mail. Não foi feita nenhuma alteração destrutiva no banco de produção.


## Achado crítico no ambiente publicado — 25/08/2026

Embora o arquivo `firestore.rules` desta versão bloqueie `cotas` e `numerosPremiados`, o teste anônimo pelo SDK Web contra o projeto publicado `kopremia-128fe` conseguiu ler `cotas/1` e `numerosPremiados/000001`. Portanto, as regras do pacote ainda precisam ser publicadas no projeto correto e verificadas novamente. A campanha deve permanecer fechada até que uma leitura anônima retorne `permission-denied` para essas duas coleções.

As Cloud Functions `getPublicRaffleState` e `pagbankWebhook` também retornaram HTTP 404 nas URLs esperadas da região `southamerica-east1`, indicando que o backend esperado não está implantado nessa região/projeto ou que o deploy usa outro nome/região. O Firestore público respondeu com `totalNumbers: 150000`, `targetSoldNumbers: 150000` e `status: preparacao`, mas isso não comprova que o fluxo Pix esteja operacional.
