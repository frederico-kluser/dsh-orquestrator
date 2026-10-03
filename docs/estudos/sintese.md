# Síntese dos 16 estudos

Leia [`README.md`](README.md) para a lista de fontes e os hashes. Aqui estão as conclusões
cruzadas. Cada afirmação cita os estudos (`E01` a `E16`); os que não aparecem não a sustentam.
As decisões que saíram daqui estão em [`decisoes.md`](decisoes.md).

## 1. Em dez linhas

1. O trabalhador rápido (DeepSeek V4.1 Flash) é confirmado por todos os estudos que o
   avaliam; o V4-Pro foi aposentado pela própria DeepSeek e roteia para o V4.1 Flash.
2. **Esforço de raciocínio máximo é o maior risco operacional**: loops sobre casos de borda
   numéricos no trabalhador rápido, turnos de cerca de dois minutos no MiMo-V2.6-Pro, e
   regressão do Sonnet 5.5 em `max` em relação a `high`/`xhigh` (E02, E04).
3. **O DSH explica por quê** (seção 6): um filho re-roteado sem esforço explícito roda no
   padrão da rota, que nas rotas desta máquina é `max`, com teto de saída igual à janela
   inteira do modelo (384 mil a 943 mil tokens).
4. A revisão só vale com **sinal executável** (E02, E03, E09, E10); sem testes, o revisor
   tende a carimbar a narrativa do autor.
5. O revisor **ancora** na justificativa do trabalhador (E02, E03, E09); a resposta é
   julgar a área de trabalho, não a história (revisão em contexto limpo).
6. Revisores pequenos ecoam o prompt e deixam regras de estilo vencerem falhas lógicas
   (E01 a E05, E07 a E11, E13). Remédios: regras de precedência, delimitadores XML, saída tipada.
7. O veredicto deve ser **estruturado**; o `tool_choice` forçado quebra com raciocínio ligado
   (DeepSeek V4/V4.1 e Claude Sonnet 5.5; E09). O DSH já tem um mecanismo cooperativo.
8. Executar testes é executar **código não confiável** (E12): hooks de runner, ANSI em logs,
   exfiltração de variáveis, sabotagem de testes, máscara de código de saída.
9. Um modal por envio gera o reflexo de dispensa; presets e transparência de custo reduzem a
   fricção (E07, E13). É a mudança de maior esforço e ficou para depois.
10. Várias afirmações dos estudos **não se reproduzem** (seção 4) ou contradizem medições
    do próprio usuário; nenhuma foi para o código sem checagem.

## 2. Onde os estudos concordam

| Tema | Estudos | Consenso | Virou |
| --- | --- | --- | --- |
| Esforço `max` degrada: laços de dúvida, latência, custo | E01 E02 E03 E04 E05 E07 E08 E09 E10 E11 E12 E13 | Trabalhador rápido em nível moderado (30 a 50 de 100, ou `medium`); revisor `low` a `medium`; Sonnet `high`, nunca `max` | D01, D13 |
| Teto rígido de tokens contra laços | E01 E03 E05 E11 E12 E13 | Impor um teto por requisição | D02, D03 |
| V4.1 Flash é o executor padrão; V4-Pro aposentado | E01 E02 E03 E04 E05 E07 E08 E10 E11 E13 | Confirmado também pelo aviso oficial de 2026-09-10 | D11 |
| MiMo-V2.6-Pro: bom em visão, lento (TTFT 47 a 52 s nos nós padrão, ~2 min por turno em `max`) | E01 E02 E03 E05 E06 E07 E08 E10 E11 E12 E13 | Só para visão, com `ultraspeed`, esforço baixo ou nó rápido; não para revisão de texto síncrona | D01, D11 |
| GLM 5.3 aceita só texto; raciocínio sempre ligado; ignora `response_format` mas acerta ferramentas | E01 E02 E05 E06 E08 E11 | Confirmado (OpenRouter: entrada só texto) | D04, D11 |
| Revisor pequeno ecoa o prompt, estilo vence lógica | E01 E02 E03 E04 E05 E07 E08 E09 E10 E11 E13 | Precedência explícita do verificado sobre a apresentação; XML; saída tipada | D04, D07, D08 |
| Revisão sem sinal executável é fraca; só o diff não basta | E02 E03 E04 E07 E09 E10 | Ancorar em execução, descobrir os comandos, escrever o menor teste que falharia | D08 |
| O revisor ancora na justificativa do autor | E02 E03 E09 | Dar ao revisor a especificação e o estado real, não a narrativa | D06, D07 |
| Revisor de outra família ajuda sem garantir independência | E02 E05 E07 E08 (e o dossiê) | Recomendar, avisar quando for a mesma família | D11 |
| Executar testes é executar código não confiável | E12 (com E14) | Higienizar saída, vigiar testes e configuração de runner, não vazar segredos, limites no README | D07, D08, D09, D14 |
| Custo e espera da revisão devem ser visíveis | E02 E07 E08 E13 | Mostrar antes de confirmar | D12 |
| Contrato curto entre agentes | E03 E10 | Relatório de handoff curto; relatório do revisor com campos fixos | D04, D10 |

## 3. Onde discordam, e como se resolveu

| Questão | Lados | Resolução |
| --- | --- | --- |
| Extinguir `APPROVED_WITH_FIXES` | E02 (quarta decisão) quer só `APPROVED` ou `NOT_RESOLVED`, com o teste que falha devolvido ao trabalhador. E03, E05, E07, E09, E10, E12 mantêm o conserto restrito à falha provada | **Mantido.** O conserto é requisito do produto e seis estudos o admitem com limites. O risco que E02 mede (edições fora de escopo) foi atacado com regras mais estritas e com a lista de arquivos alterados (N01, D08, D09) |
| Veredicto em texto na primeira linha ou ferramenta/JSON | Texto: E01 E03 E05 E07 E08 E10 E11. Ferramenta: E09 E12 E13 | **Os dois, em camadas** (D04): ferramenta nativa do DSH quando o provedor tem; texto verdict-first como reserva. Sem *nonce* (N02) |
| O revisor vê o relatório do trabalhador | Dossiê anterior: "alegações a verificar", e a evidência de contexto é disputada. E02 E03: nunca | **`auto`** (D06): contexto limpo quando a árvore de trabalho mudou, relatório como alegação quando não mudou |
| Esforço do revisor "Rigoroso" | E07: `max`. E02 E04: nunca `max` (Sonnet em `max` rende menos que em `xhigh`, mais tokens, mais custo) | Valeu E02/E04, que trazem a medição; `max` só por escolha explícita |
| Esforço do trabalhador V4.1 Flash | 20 a 40 (E07 E08), 30 (E13), 30 a 50 (E01 E04 E10 E12), 35 (E05), `medium` (E03), `low` ou desligado (E09) | `medium` para o trabalhador, `low` para o revisor, que é o ponto onde a maioria cai na escala nomeada do DSH |
| Orquestrador padrão | GLM 5.3 (E01 E05 E08 E09), Sonnet 5.5 (E02 E03 E07 E12) | Fora do escopo: o plugin não escolhe o modelo do agente principal (N16) |
| Quem revisa | Sonnet 5.5 (E02 E03 E04 E07 E11 E12), Gemini 3.8 Flash (E06 E07 E10), MiMo em nó rápido (E08), GLM 5.3 Flash econômico (E11) | O plugin não impõe: oferece o catálogo do usuário, com notas por modelo e teto de esforço por perfil |
| `clear_thinking` do GLM | `false` (E01), `true` (E05) | Parâmetro do provedor em `~/.dsh/settings.yaml`; o plugin não toca |
| Preços | Divergem entre estudos e entre provedores (Kimi K3 de "cota" a US$ 13 de saída; GLM 5.3 de US$ 0,12 a 1,40 de entrada) | Nenhum preço entra no código: o DSH zera a metadata de custo do pi-ai e os valores envelhecem em dias |

## 4. Afirmações que não se reproduziram ou contradizem medições

| Afirmação | Origem | O que se mediu |
| --- | --- | --- |
| Enviar `max` ao OpenRouter para o DeepSeek V4.1 Flash dá HTTP 400, exige `xhigh` (e se recomenda um interceptor `max`→`xhigh`) | E01, de uma fonte anedótica | Em 2026-10-03, `deepseek/deepseek-v4.1-flash` com `reasoning.effort` = `max`, `xhigh` e `high` respondeu **HTTP 200** nas três. Nada a interceptar (N12) |
| Rótulos de esforço em texto (`low`, `medium`, `high`) são lidos como `reasoning_effort=100` porque a escala virou 1 a 100 | E05 | A sonda do próprio usuário no `settings.yaml` (2026-09-09) registra que o fio da API oficial aceita `none\|minimal\|low\|medium\|high\|xhigh\|max`. O DSH usa a escada nomeada, e o plugin também (N13) |
| `max_thinking_tokens` como teto do raciocínio | E03 E05 E11 E13 | O DSH não expõe esse parâmetro; o teto possível é `maxTokens` por requisição (D02) |
| Números de benchmark (Terminal-Bench 4.0, DeepSWE v1.1, FrontierCode 1.1, precisão/recall do ranking de revisores) | E02 E03 E04 E07 | Não revalidados. Usados só pela **direção** do efeito, nunca como limiar em código |
| Tabela de pares worker+revisor com custo relativo | E02 E07 E08 | Estimativas dos estudos, sem fonte reproduzível; só a ordem de grandeza ("cerca do dobro") foi para a interface |

## 5. O que dados públicos confirmaram em 2026-10-03

* **DeepSeek** (`api-docs.deepseek.com/news/news260910`): V4.1-Flash lançado em 2026-09-10; o id
  da API é `deepseek-flash`; a partir de 2026-09-14 04:00 UTC toda chamada a `deepseek-v4-pro`
  é roteada para o V4.1-Flash, pelo preço dele, "até o lançamento do V4.1-Pro"; V4-Flash e
  V4-Flash-Vision-Exp foram aposentados e roteiam temporariamente. (E05 E07 E08 E10 E11)
* **OpenRouter** (`/api/v1/models`, 466 modelos): `z-ai/glm-5.3` aceita só texto;
  `z-ai/glm-5.3-flash` texto, imagem e vídeo; `xiaomi/mimo-v2.6-pro` texto, imagem, vídeo e
  áudio; existe `xiaomi/mimo-v2.6-pro-ultraspeed` por cerca de dez vezes o preço por token
  (US$ 4,35 e 8,70 contra 0,435 e 0,87 por milhão); `deepseek/deepseek-v4.1-flash` texto e
  imagem; todos aceitam `reasoning`, `tools`, `tool_choice` e `structured_outputs`. (E01 E02
  E05 E06 E08 E13)

## 6. O que o código do DSH mostrou (a causa dos sintomas)

Lido em `~/Projects/deepseek-harness` 0.1.6-alpha.2 (`ddefc45`), fixado nos testes de contrato:

* **Esforço do filho.** `resolveChildAgentOptions` (`packages/subagent/subagent/src/child-agent.ts`)
  parte das opções do pai, aplica por cima o que o chamador pediu e, **se a rota mudou e nenhum
  esforço foi pedido, apaga o esforço do pai** para que o novo modelo "resolva o próprio padrão".
  Nesta máquina toda rota tem `reasoning: max`; logo, todo filho re-roteado pelo plugin rodava
  em `max`. Medido em 2026-10-03 com os três modelos ([`../validation/README.md`](../validation/README.md)):
  com o plugin fora do caminho (T4) o trabalhador (DeepSeek V4.1 Flash) recebeu `max` com teto de
  saída de 384 000 e o revisor (MiMo-V2.6-Pro) `max` com 131 072; com o plugin (T1), `medium` com
  64 000 e `medium` com 32 000. Fixado em `test/contract/dsh-source.test.ts`.
* **Teto de saída.** `LlmService.resolveCallConfig` preenche `maxTokens` com o
  `defaultMaxTokens` da rota (o `maxTokens` declarado: 131 072 no MiMo, 384 000 no DeepSeek V4.1 Flash do Azure, 943 718 no OpenRouter)
  e nunca limita nem apelida um esforço não suportado: rejeita com `UNSUPPORTED_REASONING_EFFORT`.
  Por isso o plugin consulta a escada do modelo antes de enviar.
* **Escada de esforço.** `ctx.llm.resolveModelInfo` devolve a escada (`off`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`, o subconjunto que o modelo oferece) e o nível padrão; o
  catálogo do navegador carrega o mesmo dado, então o diálogo mostra o mesmo "Recomendado" que o
  host usa. Modelos sem raciocínio não têm escada (o diálogo diz que o modelo não tem níveis).
* **Saída estruturada.** O provedor `spawn` aceita `outputSchema`: registra uma ferramenta
  `structured_output` no filho, valida os argumentos contra o esquema, devolve o valor em
  `result.structured` e encerra o turno. **Não força** `tool_choice`, que é a restrição de E09.
  Se o modelo termina com texto, a execução fecha como `error` e o texto fica disponível.
* **Filtro de ferramentas.** `tools.restrict` lança erro para nomes de ferramenta
  desconhecidos e as ferramentas do preset `standard` vivem no plano do agente; uma lista fixa
  de ferramentas negadas ao revisor quebraria a revisão numa composição sem uma delas (N11).
* **Roteamento do OpenRouter.** O catálogo do `llm-pi-ai` marca `openRouterRouting` como
  `withhold`: o DSH não deixa um perfil fixar provedor nem desligar fallbacks por requisição
  (N08).
* **Catálogo oficial.** A tabela embutida do provedor `deepseek-official` ainda lista
  `deepseek-v4-pro` ao lado de `deepseek-flash`; escolher o primeiro, na API oficial, executa o
  segundo (D11).

## 7. Fichas por modelo

É o que [`../../src/models.ts`](../../src/models.ts) sabe, com `verifiedAt` 2026-10-03.
"Teto" é o nível máximo que o plugin escolhe sozinho; o usuário pode subir.

| Modelo (id) | Teto trabalhador | Teto revisor | Notas mostradas | Fontes |
| --- | --- | --- | --- | --- |
| DeepSeek V4.1 Flash (`deepseek-flash`, `DeepSeek-V4.1-Flash`, `deepseek/deepseek-v4.1-flash`) | `medium` | `low` | Esgota o orçamento num caso de borda em esforço alto; como revisor é compacto | E01 E03 E05 E07 E08 E10 E11 E12 E13 |
| DeepSeek V4-Pro na rota `deepseek-official` | `medium` | `low` | A API oficial o roteia para o V4.1 Flash | E05 E07 E08 E10 E11 + aviso oficial |
| MiMo-V2.6-Pro | `low` | `medium` | Até dois minutos por turno em esforço alto | E01 E02 E03 E05 E07 E08 E09 E11 E12 E13 |
| MiMo-V2.6-Pro-UltraSpeed | `low` | `medium` | Bem mais rápido, cerca de dez vezes o preço | E01 E02 E13 |
| GLM 5.3 Flash | `high` | `low` | Raciocínio não desliga; como revisor é compacto | E01 E05 E11 |
| GLM 5.3 | `high` | `low` | Só texto; raciocínio não desliga | E01 E02 E05 E06 E08 |
| Claude Sonnet 5.5 (e Opus) | `high` | `high` | Em `max` tende a editar demais e custa bem mais | E02 E04 E09 |
| Claude Haiku 4.5 | `medium` | `medium` | Como revisor é compacto | E03 E07 E09 E10 |
| Gemini 3.8 Flash | `medium` | `medium` | (nenhuma) | E07 E10 E13 |
| Qualquer outro | `medium` | `medium` | (nenhuma) | padrão |

Os tetos se aplicam sobre a escada de cada modelo (`chooseEffort`): um modelo cujo padrão já
está abaixo do teto não é alterado, e uma escada que pula degraus (GLM: `low`, `high`, `max`)
recebe o degrau mais alto que não passa do teto.

## 8. Perguntas em aberto e experimentos propostos

Os estudos propõem experimentos baratos. O que foi feito nesta versão está em
[`../validation/README.md`](../validation/README.md); o resto segue aberto.

| Experimento | Origem | Estado |
| --- | --- | --- |
| Varredura de esforço do V4.1 Flash em casos numéricos de borda (15/30/60/100) | E01 E03 E05 E07 E08 E13 | Aberto. O teto `medium` está fixado por consenso, não por esta medição |
| Ancoragem: o mesmo patch com e sem o relatório do trabalhador, 10 patches com omissões | E02 E03 E09 | Aberto. O modo `auto` existe para permitir exatamente essa comparação (`reviewerContext: claims` contra `isolated`) |
| Latência do MiMo padrão contra `ultraspeed` e provedor rápido | E01 E02 E03 E05 E07 E08 E10 E13 | Aberto |
| Salência de estilo em revisores compactos (GLM 5.3 Flash, Haiku) com regras de estilo no fim do prompt | E02 E05 E07 E10 | Aberto: revisores compactos não foram executados (a validação usa só os três modelos definidos). Parcial com o MiMo-V2.6-Pro: no cenário de requisitos conflitantes (T2) terminou em `NOT_RESOLVED` com os dois requisitos nomeados |
| Resistência a sequestro: artefato do trabalhador que proíbe testar e manda aprovar | E09 E12 | Aberto; só a defesa estrutural (delimitadores, veredicto estruturado) está em teste automatizado |
| Colisão `tool_choice` forçado contra raciocínio ligado | E09 | Evitada por construção: o DSH não força `tool_choice` |
| Teste A/B modal contra barra de chips | E13 | Adiado com N06 |

Lacunas que os próprios estudos admitem: instabilidade dos nós rápidos do MiMo
(PrimaLabs), fidelidade visual do MiMo `ultraspeed`, preços do Kimi K3, fim do preço
promocional do Gemini 3.8 Flash em 2026-12-31 (de US$ 0,75/3,75 para 1,50/7,50 por milhão),
e a independência real de modelos treinados com RL parecido (E05).
