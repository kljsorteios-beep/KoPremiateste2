# Relatório técnico da revisão da Kóòpremios

**Data:** 25 de agosto de 2026  
**Escopo:** frontend, Cloud Functions, Firestore, Pix PagBank, notificações, domínio e preparação de faturamento.

> **Nota de responsabilidade:** esta é uma revisão técnica do código e da configuração observada. Não substitui análise jurídica, regulatória, contábil ou financeira sobre a realização da campanha, a publicidade de sorteios, a premiação ou a cobrança de pagamentos. Antes de abrir vendas, peça a validação de um profissional habilitado.

## Resultado executivo

A cópia revisada mantém **150.000 números** e passa a tratar os **R$ 10.000,00 como fundo total de prêmios adicionais**, separado do prêmio principal. A frase da página foi alterada para “São 10 mil em prêmios, participe e boa sorte!”. O backend deixou de considerar automaticamente que existam 10.000 números vencedores.

Também foi preparado o envio automático dos números por e-mail após a confirmação `PAID` do PagBank. O comprador continua podendo consultar os números na área Minha Conta, agora com seis dígitos. A integração de e-mail usa a API do Resend dentro de uma Cloud Function e só será ativada depois de configurar chave, remetente e domínio verificado.

A campanha **não deve abrir vendas ainda**. O ambiente publicado apresenta dois bloqueios críticos: as Functions esperadas retornam HTTP 404 na região verificada, e um teste anônimo pelo SDK Firebase conseguiu ler `cotas/1` e `numerosPremiados/000001`, apesar de as regras corretas estarem no pacote revisado. As regras precisam ser publicadas no projeto/região corretos e testadas novamente.

## Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `index.html` | Corrige a frase para “São 10 mil em prêmios, participe e boa sorte!”. |
| `functions/index.js` | Mantém 150.000 números, adiciona modelo de prêmio principal + adicionais, lê somente prêmios catalogados, prepara e-mail pós-pagamento e reduz a leitura da coleção de prêmios aos números do pedido. |
| `scripts/generate-raffle.js` | Deixa a quantidade de vencedores em zero por padrão, adiciona fundo adicional e metadados do plano. |
| `scripts/expand-firestore.js` | Não gera 10.000 vencedores automaticamente; aceita um arquivo explícito de prêmios e exige flags conscientes para manter/remover legado. |
| `scripts/validate-generated.js` | Valida 150.000 números e quantidade de vencedores configurável. |
| `admin.html` | Troca a linguagem para “Números com prêmio” e informa que a lista é variável. |
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
| Quantidade de números com prêmio | Variável; não é automaticamente 10.000 |
| Coleção usada para o mapa | `numerosPremiados` |
| Campos do mapa | `numero`, `premioId`, `premioNome`, `premioTipo`, `premioValorCents` |

A coleção `numerosPremiados` da captura possui registros legados sem identificação de prêmio. Na versão revisada, documentos sem `premioId`, `premioNome` e `premioTipo` não são tratados pelo backend como números premiados. Para uma migração definitiva, faça backup e use um arquivo JSON confidencial com um único item `premioTipo: "principal"` e os demais itens como `premioTipo: "adicional"`. O script soma os prêmios adicionais e rejeita valores acima do fundo configurado.

O arquivo de prêmios não deve ser publicado na Vercel, no GitHub ou no frontend. Os exemplos de documentação são apenas ilustrativos. Nenhuma alteração destrutiva foi executada no Firestore.

## Estado dos componentes observados

| Componente | Resultado observado | Situação |
|---|---|---|
| Página inicial pública | Carregou na Vercel; a versão publicada ainda mostrava a frase antiga. | Deploy da cópia revisada pendente. |
| Prévia local | Mostrou a frase nova, galeria, cotômetro, seleção e botão de participação. | Validada localmente. |
| Cotômetro | Firestore público informa 150.000 como total e meta, mas as Functions esperadas retornaram 404. | Não considerar pronto. |
| Login | Formulário, Mostrar senha e Esqueci minha senha presentes. | Presença validada; autenticação real pendente de conta de teste. |
| Cadastro | Nome, telefone, CPF, e-mail, senha, nascimento e endereço presentes. | Presença validada; cadastro real pendente de conta de teste. |
| Minha Conta | Perfil sem sessão redirecionou ao login. | Proteção de rota validada; compra real pendente. |
| Pix | Código do backend cria pedido, QR Code e webhook, mas os endpoints publicados retornam 404. | Não está comprovado em produção. |
| E-mail | Gatilho pós-compra e chamada Resend preparados no backend. | Depende de chave, remetente e domínio verificado. |
| Firestore | `publico/rifa` tem 150.000 números e status `preparacao`. | Os dados públicos estão em preparação. |
| Segurança Firestore | Leitura anônima pelo SDK conseguiu acessar `cotas/1` e `numerosPremiados/000001`. | Bloqueio crítico; publicar regras e repetir teste. |

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

No PagBank, configure primeiro o ambiente sandbox, os segredos `PAGBANK_ACCESS_TOKEN` e `PAGBANK_WEBHOOK_TOKEN`, e confirme a URL pública do webhook. No Resend, configure `RESEND_API_KEY` como segredo da Function e `EMAIL_FROM` como remetente do domínio verificado. A API de envio exige `from`, `to` e `subject`, e usa autenticação Bearer [2].

Por último, faça uma compra sandbox pequena: cadastro, login, reserva, QR Code, pagamento, webhook `PAID`, criação de `compras`, números na Minha Conta, e-mail recebido, expiração de reserva, concorrência e rejeição de assinatura/valor incorretos. Só depois de todos esses testes o administrador deve abrir a campanha.

## Referências

[1]: https://developer.pagbank.com.br/reference/webhooks "PagBank — Webhooks"

[2]: https://resend.com/docs/api-reference/emails/send-email "Resend — Send Email API"

[3]: https://docs.cloud.google.com/billing/docs/concepts "Google Cloud — Cloud Billing overview"

[4]: https://firebase.google.com/docs/extensions/official/firestore-send-email "Firebase — Trigger Email extension"
