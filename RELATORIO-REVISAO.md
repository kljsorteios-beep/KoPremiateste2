# Relatório técnico da revisão da Kóòpremios

**Data:** 25 de agosto de 2026  
**Escopo:** frontend, Cloud Functions, Firestore, Mercado Pago Pix, notificações, domínio e preparação de faturamento.

> **Nota de responsabilidade:** esta é uma revisão técnica do código e da configuração observada. Não substitui análise jurídica, regulatória, contábil ou financeira sobre a realização da campanha, a publicidade de sorteios, a premiação ou a cobrança de pagamentos. Antes de abrir vendas, peça a validação de um profissional habilitado.

## Resultado executivo

A cópia revisada mantém **150.000 números** e define exatamente **10.000 cotas adicionais premiadas**, separadas do prêmio principal. A frase da página foi ajustada para “São 10 Mil cotas premiadas, participe e boa sorte!”. A Honda XRE 190 2026 fica fora dessas cotas e só pode ser sorteada após 100% das vendas. O fundo de R$ 10.000,00 é distribuído entre as 10.000 cotas adicionais conforme o plano de prêmios.

Também foi preparado o envio automático dos números por e-mail após a confirmação `approved` consultada na API do Mercado Pago. O comprador continua podendo consultar os números na área Minha Conta, agora com seis dígitos. A integração de e-mail usa a API do Resend dentro de uma Cloud Function e só será ativada depois de configurar chave, remetente e domínio verificado.

A campanha **não deve abrir vendas ainda**. O ambiente publicado apresenta dois bloqueios críticos: as Functions esperadas retornam HTTP 404 na região verificada, e um teste anônimo pelo SDK Firebase conseguiu ler `cotas/1` e `numerosPremiados/000001`, apesar de as regras corretas estarem no pacote revisado. As regras precisam ser publicadas no projeto/região corretos e testadas novamente.

## Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `index.html` | Usa a frase “São 10 Mil cotas premiadas, participe e boa sorte!” e exibe somente o percentual do cotômetro. |
| `functions/index.js` | Mantém 150.000 números, adiciona modelo de prêmio principal + adicionais, lê somente prêmios catalogados, prepara e-mail pós-pagamento e reduz a leitura da coleção de prêmios aos números do pedido. |
| `scripts/generate-raffle.js` | Gera 10.000 vencedores adicionais por padrão, preservando a XRE como sorteio separado. |
| `scripts/expand-firestore.js` | Completa/preserva exatamente 10.000 vencedores adicionais e aceita catálogo confidencial opcional. |
| `scripts/validate-generated.js` | Valida 150.000 números e quantidade de vencedores configurável. |
| `admin.html` | Mostra auditoria das 10.000 cotas, compras, ganhadores adicionais e sorteio protegido da XRE. |
| `perfil.html` | Exibe títulos comprados no formato de seis dígitos. |
| `env.example` | Documenta `RESEND_API_KEY` e `EMAIL_FROM`. |
| `firebase.json` e pastas | Corrige a organização para `functions/` e `scripts/`, conforme a configuração declarada. |
| `README.md` e `IMPLEMENTACAO.md` | Atualiza o modelo, os comandos e o checklist operacional. |
| `premios.template.json` | Modelo vazio para evitar que um exemplo seja confundido com um mapa real. |

## Modelo correto de dados

| Conceito | Configuração |
|---|---:|
| Números da campanha | 150.000 |
| Preço por número | R$ 0,50 |
| Prêmio principal | Honda XRE 190 2026, a confirmar no regulamento |
| Fundo de prêmios adicionais | R$ 10.000,00, equivalente a 1.000.000 centavos |
| Quantidade de cotas adicionais premiadas | Exatamente 10.000, fora a XRE |
| Coleção usada para o mapa | `numerosPremiados` |
| Campos do mapa | `numero`, `premioId`, `premioNome`, `premioTipo`, `premioValorCents` |

A coleção `numerosPremiados` observada na captura possuía registros legados sem identificação de prêmio. Na versão revisada, a expansão garante 10.000 cotas adicionais com `isWinningNumber: true` e `prizeCategory: "adicional"`; a XRE não entra nessa coleção. Faça backup antes de aplicar a normalização e defina posteriormente o catálogo confidencial de valores e nomes dos prêmios.

O arquivo de prêmios não deve ser publicado na Vercel, no GitHub ou no frontend. Os exemplos de documentação são apenas ilustrativos. Nenhuma alteração destrutiva foi executada no Firestore.

## Estado dos componentes observados

| Componente | Resultado observado | Situação |
|---|---|---|
| Página inicial pública | A cópia local final usa a frase solicitada e mantém o backend desacoplado. | Deploy da cópia revisada ainda pendente. |
| Prévia local | Mostrou a frase nova, galeria, cotômetro, seleção e botão de participação. | Validada localmente. |
| Cotômetro | O frontend usa o estado público da Function e exibe somente o percentual; a disponibilidade em produção depende do deploy correto das Functions. | Validado no código; teste de produção pendente. |
| Login | Formulário, Mostrar senha e Esqueci minha senha presentes. | Presença validada; autenticação real pendente de conta de teste. |
| Cadastro | Nome, telefone, CPF, e-mail, senha, nascimento e endereço presentes. | Presença validada; cadastro real pendente de conta de teste. |
| Minha Conta | Perfil sem sessão redirecionou ao login. | Proteção de rota validada; compra real pendente. |
| Pix | Código do backend cria pedido, QR Code e webhook, mas os endpoints publicados retornam 404. | Não está comprovado em produção. |
| E-mail | Gatilho pós-compra e chamada Resend preparados no backend. | Depende de chave, remetente e domínio verificado. |
| Firestore | `publico/rifa` tem 150.000 números e status `preparacao`. | Os dados públicos estão em preparação. |
| Segurança Firestore | As regras da cópia final bloqueiam leitura e escrita anônimas de `cotas`, `disponibilidade`, `numerosPremiados`, `ganhadores` e `sorteios`. | Publicar no projeto correto e repetir teste anônimo; a observação de leitura aberta é histórica da versão publicada anterior. |

## Opções para o e-mail transacional

| Abordagem | Trade-offs | Custo | Complexidade de configuração |
|---|---|---|---|
| Resend por API dentro da Cloud Function | Controle direto, sem depender de extensão; exige API key e domínio remetente verificado. Foi a opção preparada na cópia. | Serviço externo conforme plano/uso. | Média. |
| Extensão Firebase Trigger Email com SMTP | Menos código próprio, mas exige SMTP e regras cuidadosas; a documentação do Firebase informa que o serviço Extensions está depreciado e tem desligamento previsto para 31/03/2027. | Serviço SMTP conforme provedor. | Baixa a média inicialmente, maior risco de migração. |

A solução preparada envia o e-mail somente depois de uma compra com `status: "pago"`, não no momento da reserva. Os números também permanecem disponíveis na área Minha Conta como caminho alternativo.

## Roteiro obrigatório antes de abrir vendas

Primeiro, confirme no console do Firebase que o projeto ativo é `kopremia-128fe` e que a região usada pelas Functions é `southamerica-east1`. A partir da raiz do projeto revisado, instale as dependências e publique regras, índices, Functions e Hosting:

```bash
npm --prefix functions install
npm --prefix functions run lint
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

Depois do deploy, repita uma leitura anônima pelo SDK e espere `permission-denied` para `cotas/1` e `numerosPremiados/000001`. Confirme também que `getPublicRaffleState` responde e que uma chamada GET ao webhook retorna uma resposta de método não permitido, não 404.

Em seguida, faça backup do Firestore e defina o arquivo real de prêmios. Não use `--clear-legacy-winners` sem backup e sem decidir formalmente se os registros antigos devem ser removidos. A campanha deve permanecer em `preparacao` durante toda essa etapa.

No Google Cloud, crie ou vincule uma **Cloud Billing account** ao projeto por um usuário com permissão de administrador de faturamento, adicione um método de pagamento válido e crie orçamento com alertas antes de publicar serviços pagos. Essa configuração pode gerar cobrança conforme o uso e não foi executada nesta revisão. A documentação oficial descreve a relação entre a conta de faturamento, o perfil de pagamentos e os recursos do projeto [3].

Na Vercel, adicione o domínio comprado e configure exatamente os registros DNS exibidos no painel. Depois, autorize o domínio final em **Firebase Authentication > Settings > Authorized domains**. Se o domínio for usado para e-mail, verifique-o também no Resend.

No Mercado Pago, configure primeiro as credenciais de teste, os segredos `MERCADOPAGO_ACCESS_TOKEN` e `MERCADOPAGO_WEBHOOK_SECRET`, e confirme a URL pública `mercadoPagoWebhook`. No Resend, configure `RESEND_API_KEY` como segredo da Function e `EMAIL_FROM` como remetente do domínio verificado. A API de envio exige `from`, `to` e `subject`, e usa autenticação Bearer [2].

Por último, faça uma compra de teste pequena: cadastro, login, reserva, QR Code Mercado Pago, pagamento, webhook `approved`, criação de `compras`, números na Minha Conta, e-mail recebido, expiração de reserva, concorrência e rejeição de assinatura/valor incorretos. Só depois de todos esses testes o administrador deve abrir a campanha.

## Referências

[1]: https://www.mercadopago.com.br/developers/en/docs/your-integrations/notifications/webhooks "Mercado Pago — Webhooks"

[2]: https://resend.com/docs/api-reference/emails/send-email "Resend — Send Email API"

[3]: https://docs.cloud.google.com/billing/docs/concepts "Google Cloud — Cloud Billing overview"

[4]: https://firebase.google.com/docs/extensions/official/firestore-send-email "Firebase — Trigger Email extension"
