# Auditoria técnica da versão entregue

## Controles verificados

| Controle | Verificação |
|---|---|
| Quantidade total | O gerador aceita 150.000 como padrão e rejeita meta acima do total. |
| Números premiados | Usa `crypto.randomInt`, gera 10.000 vencedores únicos e mantém a coleção protegida por regras. |
| Distribuição | Todos os 150.000 números entram no pool de disponibilidade e são escolhidos aleatoriamente no backend. |
| Duplicidade | A retirada do pool ocorre em transação Firestore; duas reservas concorrentes não podem retirar o mesmo número. |
| Reserva | O pedido recebe expiração de 10 minutos; a rotina agendada libera pedidos em `criando_pagamento` ou `aguardando_pagamento`. |
| Pix | O backend cria pedido PagBank com `reference_id`, valor em centavos, QR Code de uso único e expiração. |
| Webhook | O header `x-authenticity-token` é validado com SHA-256 sobre `token-payload` sem reformatar o JSON. |
| Valor recebido | O webhook compara valor e moeda do pagamento com `totalCents` antes de criar a compra. |
| Meus Títulos | Somente confirmação `PAID` cria documento em `compras`; o perfil filtra pelo UID autenticado. |
| Cotômetro | O contador usa números vendidos confirmados e a meta configurável; reservas aparecem separadamente. |
| Encerramento | Ao atingir a meta, a função muda o estado para `encerrada` e novas reservas são rejeitadas. |
| Painel | `admin.html` chama funções protegidas; consulta anônima aos vencedores retornou HTTP 401 no emulador. |
| Segredos | Tokens PagBank não estão no HTML, no gerador nem no pacote como valores reais. |

## Testes executados

O backend passou em `node --check` e `npm --prefix functions run lint`. O gerador local produziu 150.000 números e 10.000 premiados únicos, com os vencedores contidos no conjunto total. O emulador do Firebase carregou todas as funções na região `southamerica-east1`; `getPublicRaffleState` retornou HTTP 200 e `getWinningNumbers` sem autenticação retornou HTTP 401. As telas de index, login, cadastro e perfil carregaram na prévia, e perfil sem sessão redirecionou para login.

## Limitações conhecidas

A confirmação automática PagBank ainda não foi testada contra uma cobrança real ou sandbox porque as credenciais da conta do responsável ainda não foram fornecidas. A publicação do gerador no Firestore também não foi executada. Antes de abrir a campanha, é obrigatório configurar os segredos PagBank, definir o UID de administrador, publicar Functions/regras/índices, gerar o pool e realizar uma compra sandbox controlada.

## Incrementos desta etapa

Foi adicionado o `scripts/expand-firestore.js`, que exige `--apply` para gravar e preserva o status dos documentos de cotas existentes. A confirmação de pagamento agora grava `comprador`, `cpf`, `compradorUid`, `pedidoId` e `status: "indisponivel"` no documento de cada número. Reservas não pagas continuam como `reservada` durante o prazo e retornam a `disponivel` quando expiram.

O login recebeu `sendPasswordResetEmail` e controles de visibilidade de senha; o cadastro recebeu o mesmo controle visual. O index informa que são 10 mil cotas premiadas distribuídas entre 150 mil números.

## Atualização visual e de autenticação — 2026-08-17

A tela de login foi validada com o link `Esqueci minha senha` e o controle `Mostrar/Ocultar`, que alterna o tipo do campo sem salvar a senha no Firestore. O cadastro foi validado com o mesmo controle.

A galeria do `index.html` recebeu composição responsiva para desktop e celular, foco por teclado, carregamento preguiçoso das fotos secundárias, lightbox com contador, setas, Escape, navegação por teclado, gesto de deslizar no celular, restauração de foco e animação de entrada. Foi adicionado suporte a `prefers-reduced-motion` para reduzir movimento quando solicitado pelo navegador.

A prévia local confirmou a abertura do lightbox e o carregamento das páginas. O console do `index.html` registrou apenas o erro esperado de chamada da Function de estado público em ambiente local sem Functions implantadas; não houve erro relacionado à galeria ou aos controles de autenticação.
