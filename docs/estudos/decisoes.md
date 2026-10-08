# Registro de decisões da versão 0.2.0

Cada mudança da 0.2.0 saiu dos 16 estudos (`E01` a `E16`, em [`fontes/`](fontes)) depois de
checagem contra o código do DSH e contra dados públicos; veja [`sintese.md`](sintese.md) para o
cruzamento e [`README.md`](README.md) para o método. Aqui está o **porquê** de cada uma, e das
recomendações que **não** foram adotadas, para que ninguém as reabra sem o contexto.

* **D01 a D17**: adotadas (código, interface ou documentação mudaram). D15 é da 0.4.0 e não vem
  dos estudos: vem de uma sessão real em que o plugin deixou de valer. **D16 é da 0.5.0 e removeu o
  revisor independente**: D03 a D10, D12 e D14 descrevem o revisor e ficam como história da 0.2.0 a
  0.4.0 (a 0.4.0 é a última versão que o tem); D01, D02, D11, D13 e D15 continuam valendo, agora só
  para o subagente.
* **N01 a N22**: não adotadas ou adiadas, cada uma com o que faria reabri-la (N17 a N22 são da 0.4.0).
  N01 a N16 e N18 tratam do revisor e ficam como história.

Resumo:

| Id | Mudança | Arquivos principais |
| --- | --- | --- |
| D01 | Teto de esforço de raciocínio por papel e por modelo | `src/models.ts`, `src/effort.ts` |
| D02 | Teto de tokens de saída por requisição | `src/effort.ts`, `src/config.ts` |
| D03 | Nova tentativa única, um nível abaixo, quando o trabalhador bate no limite de tokens | `src/pipeline.ts` |
| D04 | Veredicto estruturado pela ferramenta `structured_output` do DSH, texto como reserva | `src/reviewer-protocol.ts`, `src/pipeline.ts` |
| D05 | Reconciliação do veredicto: o relatório não pode contradizer a si mesmo | `src/reviewer-protocol.ts` |
| D06 | Revisão em contexto limpo (`reviewerContext`) com fatos medidos por git | `src/workspace.ts`, `src/pipeline.ts` |
| D07 | Pacote do revisor delimitado, defanged e higienizado | `src/reviewer-protocol.ts` |
| D08 | Persona 2.0: autoridade, descoberta dos testes, triagem, sabotagem, saída hostil | `src/reviewer-protocol.ts` |
| D09 | Sinalização dos arquivos de teste, runner e CI alterados | `src/workspace.ts` |
| D10 | Contrato de handoff do trabalhador em até 400 palavras | `src/reviewer-protocol.ts` |
| D11 | Conhecimento de modelos no diálogo: alias, família, notas | `src/models.ts`, `src/client/` |
| D12 | Custo e espera da revisão visíveis antes de confirmar | `src/client/` |
| D13 | Bloco de esforço recolhido, "Recomendado" por padrão, escolha explícita até o host | `src/client/`, `src/shared.ts` |
| D14 | Modelo de segurança e limites documentados | `README.md`, `docs/DESIGN.md` |
| D15 | Guarda de início: a escolha vale para todo filho que o DSH inicia, não só para as ferramentas `subagent` | `src/guard.ts`, `src/pipeline.ts`, `src/index.ts`, `src/config.ts` |
| D17 | Manter o bloco `reviewer` desligado na rede entre as metades (0.5.1): atualizar sem reiniciar não pode quebrar o salvamento | `src/shared.ts`, `src/routes.ts`, `src/client/config-client.ts` |
| D16 | Remover o revisor independente (0.5.0): o guarda vira o único mecanismo | `src/pipeline.ts`, `src/reviewer-protocol.ts`, `src/workspace.ts` e `src/tool-wrapper.ts` (removidos), `src/guard.ts`, `src/shared.ts`, `src/config.ts`, `src/client/` |

---

## Mudanças adotadas

### D01 — Teto de esforço de raciocínio por papel e por modelo

**Problema.** Dois sintomas das execuções reais: o trabalhador rápido gastou o orçamento de
tokens inteiro num caso de borda numérico, e um modelo grande de raciocínio levou cerca de dois
minutos por turno. Nenhum estudo explicava por que *este* plugin sofria disso.

**Causa, no código do DSH.** `resolveChildAgentOptions` parte das opções do pai, aplica por cima
o que o plugin pediu e, **quando a rota muda sem esforço explícito, apaga o esforço do pai**
para que o modelo escolhido "resolva o próprio padrão". Em todas as rotas desta máquina o padrão
é `reasoning: max`. O plugin só passava provedor e modelo, então todo filho re-roteado rodava em
`max` (sintoma 1), e os modelos lentos, no pior caso deles (sintoma 2). Fixado em
`test/contract/dsh-source.test.ts`.

**Evidência.** Consenso de 12 estudos (E01 a E05, E07 a E13): `max` degrada. Trabalhador rápido
em 30 a 50 numa escala de 100; revisor `low` a `medium`; Sonnet 5.5 em `high`, nunca `max`
(E02 e E04 medem `xhigh` acima de `max`, com menos tokens e menos edições fora de escopo).

**Decisão.** Um **teto**, não um valor imposto: o plugin pergunta ao DSH a escada do modelo
(`ctx.llm.resolveModelInfo`) e o nível que a rota usaria sozinha. Se esse nível está dentro do
teto, não toca em nada. Se está acima, usa o degrau mais alto que não passa do teto. Nunca
escolhe `off` por conta própria. O teto vem, em ordem de prioridade: da escolha explícita do
usuário no diálogo (vale mesmo acima do teto), da configuração `effort.worker` e
`effort.reviewer`, da linha do modelo em `MODEL_PROFILES`, e por fim `medium`.

**Por quê assim.**
* *Teto e não valor:* uma rota que já roda em `low` não deve ser promovida a `medium`.
* *Escada nomeada, não 1 a 100:* o DSH, e a sonda do próprio usuário no `settings.yaml`, usam
  `off` a `max`. A escala numérica de E05 contradiz essa sonda (N13). `medium` é o ponto da
  escada nomeada onde caem os "30 a 50" dos estudos.
* *Por perfil de modelo:* os estudos divergem de verdade (Sonnet em `high`, DeepSeek Flash
  revisor em `low`, MiMo trabalhador em `low`); um único número serviria mal a todos. As linhas
  são datadas e citam as fontes, e nenhuma passa de `high`.
* *Degrau mais alto que não passa do teto:* o GLM 5.3 só oferece `low`, `high` e `max`.
* *Não falha a delegação por não conseguir descrever o modelo:* se o modelo não pode ser descrito, o
  filho segue exatamente com o que o usuário escolheu (o comportamento da 0.1.0), e o log diz. Desde a
  0.4.0 há uma exceção deliberada: um modelo que o runtime não consegue **chamar** (a mesma checagem que
  barra gravar a rota) rejeita o início com uma mensagem acionável (D15, N22).
* *O reviewer nunca herda o esforço do trabalhador:* são papéis diferentes.

**Onde.** `src/models.ts` (`MODEL_PROFILES`, `capFor`, `chooseEffort`, `lowerEffort`),
`src/effort.ts` (`planChild`, `parentOptionsOf`), `src/config.ts` (`effort`).

**Verificação.** `test/unit/models.test.ts`, `effort.test.ts`, `pipeline-v2.test.ts`; contrato
com o DSH; execução real com GLM 5.3, DeepSeek V4.1 Flash e MiMo-V2.6-Pro em
[`../validation/README.md`](../validation/README.md), que lê o cabeçalho de requisição de cada
sessão e mostra o esforço e o teto que cada modelo recebeu.

### D02 — Teto de tokens de saída por requisição

**Problema.** `resolveCallConfig` preenche `maxTokens` com o `defaultMaxTokens` do modelo: o
`maxTokens` declarado da rota (131 072 no MiMo, 384 000 no DeepSeek V4.1 Flash do Azure, 943 718 no OpenRouter). Um laço de raciocínio só termina
quando o orçamento acaba.

**Evidência.** E01, E03, E05, E11, E12 e E13 pedem um teto rígido. Propõem 8 192 a 10 000 tokens
**de raciocínio** (`max_thinking_tokens`), que o DSH não expõe (N13).

**Decisão.** `limits.workerMaxTokens` = 64 000 e `limits.reviewerMaxTokens` = 32 000 por
requisição (o teto inclui o raciocínio), aplicados só quando **reduzem** o teto conhecido do
modelo e nunca o aumentam. Se o DSH não informa o teto do modelo (uma rota de catálogo sem
`maxTokens` declarado), nada é enviado: um valor acima do máximo real do modelo seria rejeitado
pelo provedor.

**Por quê esses números.** Uma chamada de ferramenta que escreve um arquivo grande raramente passa
de 25 mil tokens; 64 mil dá margem ao trabalhador, e 32 mil basta para o relatório do revisor.
Um teto baixo demais transforma geração legítima em falha `max-tokens`, por isso o operador pode
subir (`limits`) ou desligar (`limits: false`), e D03 recupera o caso comum.

**Onde.** `src/effort.ts`, `src/config.ts` (`DEFAULT_LIMITS`).

**Verificação.** `effort.test.ts` ("does not lower an output ceiling that is already below the
cap"), `config.test.ts`, execução real (coluna "Max output tokens" das sessões).

### D03 — Nova tentativa única, um nível abaixo, quando o trabalhador bate no limite

**Problema.** Mesmo com teto, um laço de raciocínio pode esgotar os tokens (cenário D2 da
validação da 0.1.0: o trabalhador "ran out of tokens"; o plugin só repassava o erro).

**Evidência.** E03 e E07 propõem recuperação por escalonamento; E07 sugere trocar de modelo.

**Decisão.** Se o trabalhador para por `max-tokens`, roda **uma vez mais**, no mesmo modelo,
um degrau abaixo na escada dele, com uma nota ("inspecione o estado atual, não delibere sobre
casos de borda além do enunciado, rode o teste cedo"). O banner da entrega avisa. Sem escada
(modelo não descrito) ou já no degrau mais baixo, não repete. `retryOnTokenLimit: false` desliga.

**Por quê assim.** Trocar de modelo (a ideia de E07) mudaria sem aviso a família, o custo e a
escolha que o usuário fez no diálogo. Descer a escada do mesmo modelo é limitado, previsível e
fica registrado. Não se aplica ao caminho em segundo plano (`continuable` sem revisor): quem
conduz essa execução é o DSH, não o plugin.

**Onde.** `src/pipeline.ts` (`runWorker`), `src/reviewer-protocol.ts` (`withRetryNote`).

**Verificação.** `pipeline-v2.test.ts` (seis casos: retenta, retenta no caminho só-modelo, só
uma vez, não retenta sem escada nem no degrau mais baixo nem em outras falhas nem após
cancelamento).

### D04 — Veredicto estruturado pela ferramenta `structured_output` do DSH

**Problema.** O veredicto na primeira linha, em texto, é frágil com modelos menores: na
validação da 0.1.0 um revisor vazou os passos da persona para o relatório, e outro aprovou
comportamento errado. Texto vindo da área de trabalho também pode imitar um veredicto (E12).

**Evidência.** E09, E12 e E13 pedem saída tipada validada por esquema. E01, E03, E05, E07, E08,
E10 e E11 aceitam texto com verificação por expressão regular. E09 explica por que o
`tool_choice` forçado não serve: dá HTTP 400 com raciocínio ligado no DeepSeek V4/V4.1 e no
Claude Sonnet 5.5.

**Decisão.** O DSH já resolve o problema que E09 descreve: o provedor `spawn` aceita
`outputSchema` e registra no filho uma ferramenta **cooperativa** `structured_output`
(sem forçar `tool_choice`), valida os argumentos contra o esquema, devolve o valor em
`result.structured` e encerra o turno. O plugin passa `REVIEW_SCHEMA` (veredicto, resumo,
critérios, entrega, verificação, mudanças do revisor, riscos, bloqueio) e **renderiza o relatório
ele mesmo**, com o veredicto na primeira linha por construção. Se o provedor não tem a
capacidade, ou o modelo terminou com texto, vale o relatório em texto com veredicto primeiro
(`parseVerdict`, `normalizeReport`). Sem veredicto válido em nenhum dos dois, a entrega vai como
`UNREVIEWED` junto com o texto do revisor como notas não verificadas.

**Por quê assim.** O texto continua existindo porque nem todo provedor captura saída estruturada
(o `fork` e os backends ACP podem não ter), e a regex de E08 é exatamente o que `parseVerdict` faz.
O esquema usa só o subconjunto que o DSH impõe (objeto, matriz, enum, `required`,
`additionalProperties: false`), com todas as propriedades obrigatórias, que é o formato que
provedores com modo estrito aceitam. Um teste fixa essas restrições no código do DSH.

**Onde.** `src/reviewer-protocol.ts` (`REVIEW_SCHEMA`, `parseReview`, `renderReview`),
`src/pipeline.ts` (`interpretReview`), `src/host-services.ts` (`outputSchema`, `structured`).

**Verificação.** `reviewer-protocol.test.ts` (esquema dentro do subconjunto, validação, renderização),
`pipeline-v2.test.ts` (caminhos estruturado, texto, malformado, sem veredicto), contrato com o
DSH (`structured_output`, `concludeTurn`, mapeamento de `completed` para `error`), execução real.

### D05 — Reconciliação do veredicto

**Problema.** Na validação da 0.1.0, o cenário F achou um revisor que aprovou com um
comportamento falho, porque uma instrução de *como* construir prevaleceu sobre *o quê* o
enunciado pedia.

**Evidência.** E09 ("validação cega de execução": aprovar sem evidência executável é o modo de
falha dominante), E10 (estados de abstenção e taxonomia de bloqueios), E08 (rejeitar relatório fora
do formato antes de olhar o conteúdo).

**Decisão.** O plugin confere o relatório contra ele mesmo antes de entregar:
* aprovação ao lado de um critério `FAILED` ou `UNVERIFIED` vira `NOT_RESOLVED` (é uma
  contradição, não um julgamento), e o banner diz que o plugin corrigiu;
* aprovação sem nenhuma verificação registrada, com bloqueio informado, ou cuja lista de
  mudanças discorda do veredicto, **mantém** o veredicto e leva um aviso (`Caution`) no banner.

**Por quê assim.** Só as contradições rígidas mudam o veredicto, para não repetir o problema que
E02 mede (rejeitar patches corretos: 86% de falsa rejeição quando o revisor julga sem sinal
executável). Os casos de fronteira informam o agente principal e deixam a decisão com ele.

**Onde.** `src/reviewer-protocol.ts` (`reconcile`), `src/pipeline.ts` (banner).

**Verificação.** `reviewer-protocol.test.ts` (`reconcile`, `renderReview`), `pipeline-v2.test.ts`
("corrects an approval that contradicts its own FAILED criterion").

### D06 — Revisão em contexto limpo

**Problema.** O revisor julgava a história do trabalhador. O dossiê de 2026-09-30 já registrava a
evidência como **disputada** (fornecedor contra uma ablação pequena e inconsistente).

**Evidência.** E02 (a justificativa do autor eleva a aprovação complacente; o rastro completo
degrada o revisor), E03 ("estratégia de contexto limpo"), E09 (artefatos do trabalhador são
dados não confiáveis). E13 faz a ressalva de que o grau de correlação de erros com o resumo do
executor ainda é incerto.

**Decisão.** `reviewerContext`: `auto` (padrão), `isolated` ou `claims`.
* O plugin tira uma impressão da árvore de trabalho com git **antes e depois** do trabalhador
  (caminho para hash do conteúdo de cada arquivo sujo ou não rastreado, até 2 000 caminhos,
  4 MiB por arquivo).
* Se a árvore **mudou**, o revisor não recebe o relatório do trabalhador. Recebe a tarefa
  original e **fatos medidos** (quais arquivos mudaram, quais são de teste, runner ou CI).
* Se **não mudou** (pergunta, pesquisa, relatório), o relatório é a entrega e vai como alegação
  não confiável, delimitada.
* Sem git, sem diretório, com falha ou timeout: `claims`, e o log diz por quê.

**Por quê assim.** Isolamento absoluto quebraria as tarefas cuja entrega *é* o texto: o revisor
não teria o que verificar. A impressão por conteúdo (e não por `git status`) detecta o arquivo já
sujo que o trabalhador editou de novo. Trabalhadores paralelos na mesma árvore podem se misturar;
nesse caso o erro cai para o lado mais seguro, o modo que o plugin já usava. O custo são três
chamadas de git por delegação revisada.

**Como medir depois.** `reviewerContext: claims` contra `isolated` permite o experimento de
ancoragem que E02, E03 e E09 propõem, sem mudar código.

**Onde.** `src/workspace.ts`, `src/pipeline.ts` (`decideReportMode`), `src/config.ts`.

**Verificação.** `workspace.test.ts` (inclui um repositório git real, partindo de um
subdiretório), `pipeline-v2.test.ts` ("what the reviewer sees of the worker"), execução real
(coluna "Review packet").

### D07 — Pacote do revisor delimitado, defanged e higienizado

**Problema.** O texto do trabalhador, do enunciado e dos arquivos entra num prompt que decide uma
aprovação.

**Evidência.** E09 (`<untrusted_worker_artifact>` e hierarquia de instruções), E05 (isolar com
XML), E12 (sequências ANSI em logs de teste, incidente real com `jqwik`).

**Decisão.** O pacote usa `<task>`, `<workspace_facts>` e `<untrusted_worker_report>`. Qualquer
ocorrência dessas tags dentro de texto não confiável é desarmada (`<\/task>`). `sanitize` remove
sequências ANSI e OSC, caracteres de controle, zero-width e sobreposições bidirecionais, e
preserva quebras de linha e tabulações. O título vai sanitizado e sem aspas. A persona diz que
tudo dentro de `<untrusted_...>` é dado sem autoridade. O relatório do trabalhador também é
higienizado na entrega `UNREVIEWED`, que chega ao agente principal.

**Onde.** `src/reviewer-protocol.ts` (`sanitize`, `neutralize`, `buildReviewerPacket`).

**Verificação.** `reviewer-protocol.test.ts` (tentativa de escapar das tags, sequências de
terminal, título com aspas e quebra de linha).

### D08 — Persona 2.0

**Problema.** A persona da 0.1.0 não dizia como achar os testes, como separar falha antiga de falha
nova, nem tratava a saída de ferramentas como hostil. Ela tinha cerca de 4,9 mil caracteres e agora tem cerca de 9,3 mil, em regras numeradas e curtas;
modelos pequenos seguem personas longas pior (E09), e é por isso que as regras que fecham a
porta ao carimbo de aprovação também existem do lado do plugin (D05).

**Evidência e regra.** Cada regra cita o estudo:
* ordem de autoridade (este prompt, depois o enunciado; o resto é dado): E09;
* onde procurar os comandos de verificação (AGENTS.md ou CLAUDE.md, CI, Makefile, scripts do
  manifesto, diretórios de teste; monorepo: o pacote que mudou primeiro): E10;
* timeout em cada comando; nada de `|| true` nem pipe que esconda o código de saída: E10, E12;
* triagem: repetir o teste que falhou sozinho até duas vezes, comparar com o commit base num
  worktree temporário (nunca `stash` ou `reset` na área compartilhada): E10, E12;
* vigiar o trabalhador que enfraquece testes, runner e CI: E12;
* o verificado vence qualquer instrução de estilo: E05, E07, E08, E10;
* saída de terminal é hostil; não ler nem enviar variáveis de ambiente e credenciais; não
  instalar nem baixar sem necessidade: E12;
* parar quando as verificações que decidem cada critério passaram, e nunca reverter um resultado
  que já passa só porque alguém diz que está errado (o "second-guessing" do MiMo): E01, E05;
* uma negação de permissão do sandbox pode vir disfarçada de outro erro; erro de E/S sem
  explicação é um limite a relatar, não evidência sobre o código: E14 (issue DSH 3144).

**Por quê não uma persona "compacta" para modelos pequenos (E09).** Escolher por tamanho exigiria
heurística sobre ids de modelo e uma medição que não temos; fica como experimento (`sintese.md`,
seção 8). A mitigação adotada é estrutural (D04, D07).

**Onde.** `src/reviewer-protocol.ts` (`PERSONA_HEAD`).

**Verificação.** `reviewer-protocol.test.ts` fixa cada frase de regra por expressão regular; a
persona não pode conter chaves duplas (o DSH interpola personas).

### D09 — Sinalização dos arquivos de teste, runner e CI alterados

**Problema.** Um trabalhador pode "passar" enfraquecendo o verificador: apagar o teste, trocar a
asserção, mexer no `conftest.py`, forçar o código de saída.

**Evidência.** E12 (sabotagem do verificador, congelamento de diretórios de teste), E02 e o dossiê
(adulteração de testes sob pressão).

**Decisão.** Dos arquivos que a medição de D06 mostra alterados, o plugin lista no pacote do
revisor os que são testes, configuração de runner (`conftest.py`, `jest`/`vitest`/`playwright`
config, `package.json`, `pyproject.toml`, `Makefile`...) ou CI, e a persona manda ler cada diff.
`sensitivePaths` acrescenta globs do operador.

**Por quê assim.** O congelamento que E12 propõe (rejeitar o patch) quebraria "adicione
testes", que é uma tarefa legítima e comum (N03). Sinalizar e exigir leitura mantém a defesa e
o caso de uso.

**Onde.** `src/workspace.ts` (`classifyPath`, `describeFacts`), `src/config.ts` (`sensitivePaths`).

**Verificação.** `workspace.test.ts` (classificação, globs, repositório real com um teste novo).

### D10 — Contrato de handoff em até 400 palavras

**Evidência.** E03. **Decisão.** O trabalhador termina com um relatório de no máximo 400 palavras
(o que fez, arquivos, comandos e resultados, suposições e o que não verificou). Em revisão limpa
ele não chega ao revisor, mas continua sendo a entrega no caso `UNREVIEWED`. **Onde.**
`HANDOFF_CONTRACT`. **Verificação.** `reviewer-protocol.test.ts`.

### D11 — Conhecimento de modelos no diálogo

**Problema.** O seletor lista o catálogo do usuário, e escolher o `deepseek-v4-pro` na API oficial
executa o V4.1 Flash desde 2026-09-14. Escolher V4-Pro de trabalhador e V4.1 Flash de revisor
paga por uma "segunda opinião" do mesmo modelo.

**Evidência.** E05, E07, E08, E10 e E11 sobre a aposentadoria, **confirmada** pelo aviso oficial
(`sintese.md`, seção 5) e pela tabela embutida do provedor `deepseek-official`, que ainda lista
os dois ids. E02 e E05 sobre revisores da mesma família.

**Decisão.** O diálogo **anota, não esconde**:
* *mesmo modelo* por linhagem (`lineageOf`): `claude-sonnet-5-5` no Azure e
  `anthropic/claude-sonnet-5.5` no OpenRouter são o mesmo modelo; V4-Pro e V4-Flash na rota
  oficial equivalem a `deepseek-flash`; no OpenRouter, onde o V4-Pro é um endpoint próprio, não
  se afirma alias;
* *mesma família* (`familyOf`, pelo id do modelo, nunca pelo nome do provedor): uma dica, nunca
  um bloqueio;
* *notas* por modelo e papel (`notesFor`), até duas por vez: redirecionamento do V4-Pro,
  esgotamento de orçamento do V4.1 Flash, revisor compacto, MiMo lento em esforço alto,
  `ultraspeed` a cerca de dez vezes o preço, GLM só texto e de raciocínio sempre ligado, Sonnet
  em `max`.

**Por quê não esconder o V4-Pro (a recomendação de E05, E07, E08 e E10).** O catálogo é do usuário
e do DSH; um plugin que esconde modelos do seletor muda um contrato que não é dele. A nota e a
detecção de "mesmo modelo" resolvem o dano real (a falsa segunda opinião). Fica como sugestão
para o DSH que a tabela embutida deixe de listar o id aposentado.

**Por quê a família é só uma dica (a recomendação de E02 de torná-la obrigatória).** Um ambiente
com um fornecedor só não pode ficar sem revisor; o dossiê e E05 concordam que outra família ajuda
mas não garante independência (N14).

**Onde.** `src/models.ts`, `src/client/OrchestratorDialog.tsx`, `src/client/locales.ts`
(`note.*`, três idiomas, com teste de paridade).

**Verificação.** `models.test.ts` (linhagem, família, perfis, aliases), `locales.test.ts` (toda
nota que um perfil pode levantar tem texto), fase `effort` do teste de navegador.

### D12 — Custo e espera da revisão visíveis

**Evidência.** E02, E07, E08, E13 (previsibilidade de custo evita a reação negativa ao faturamento
imprevisto). E08 estima de 94% a 239% a mais por tarefa com revisão.
**Decisão.** Sob o seletor do revisor, uma linha: "A revisão roda um segundo modelo depois de
cada subagente: espere cerca do dobro de custo e de espera por delegação. Dispense-a em edições
pequenas e em documentação." **Por quê "cerca do dobro".** Os números dos estudos não são
reproduzíveis e os preços mudam em dias; a ordem de grandeza é o que se sustenta. O DSH também
zera a metadata de custo do pi-ai, então o plugin não tem preço para mostrar.

### D13 — Bloco de esforço recolhido; escolha explícita até o host

**Decisão.** Quando algo está ligado, aparece "Esforço de raciocínio", **recolhido**, dizendo
"Nível recomendado para cada modelo". Ao abrir: uma frase de por quê, e um seletor por papel cuja
primeira linha é "Recomendado: Medium" (o mesmo cálculo do host, com a escada do próprio
catálogo do navegador) seguida dos níveis do modelo. Modelo sem escada: diz que não há níveis.
A escolha explícita viaja em `workerEffort` e `reviewer.effort` (`shared.ts`), com validação
estrita; configurações gravadas na 0.1.0 continuam carregando (campos opcionais).

**Por quê recolhido.** E07 e E13 mostram que escolhas demais no ponto de envio geram o reflexo de
dispensa; o padrão recomendado atende quase todos, e o bloco existe para quem quer ver ou
mudar. **Por quê o mesmo cálculo no cliente e no host.** O diálogo nunca promete um nível que o
host não usaria (`adviseEffort` e `planChild` chamam `chooseEffort` e `capFor`).

**Onde.** `src/client/EffortPicker.tsx`, `OrchestratorDialog.tsx`, `catalog.ts`, `host-types.ts`.

**Verificação.** `catalog.test.ts`, `shared.test.ts`, fase `effort` do teste de navegador: o nível
recomendado aparece, uma escolha explícita chega ao host com 200, e `/orquestrar` salva os campos.

### D14 — Modelo de segurança e limites documentados

**Problema.** O revisor **executa código não confiável** com o preset de permissão da sessão. O
README dizia só que o preset é a fronteira real.

**Evidência.** E12 (ameaças e avisos recomendados), E14 (DSH 853, 1769, 3144: RCE sem
autenticação no plano de controle, escape do bwrap `workspace-write`, negações do sandbox
invisíveis ao modelo).

**Decisão.** `README.md` e `README.pt-BR.md` ganham a seção "Security model": o que o plugin faz
(higieniza, delimita, vigia testes, não vaza segredos pelo próprio estado, valida rotas) e o que
**não** faz (não isola a execução, não filtra a rede, não controla o ambiente do processo), o que
um `APPROVED` quer dizer (uma verificação condicionada ao ambiente em que rodou, não uma garantia),
e o que o operador deve ter no host para operações críticas. `docs/DESIGN.md` registra os limites.

### D15 — O guarda de início: a escolha vale para todo filho que o DSH inicia (0.4.0)

**Problema.** Numa sessão real (projeto `anonymous-browser`, 2026-10-04) o usuário tinha confirmado
no diálogo "subagentes no DeepSeek V4.1 Flash". O agente principal (Claude Sonnet 5.5, `max`) delegou
pela ferramenta `workflow`, e os 34 agentes do workflow (executores, verificadores e correções de
13 histórias) rodaram **todos** em `claude-sonnet-5-5` a `max`, com 128 000 tokens: cerca de 7,2
milhões de tokens de saída e 1,26 bilhão de leitura de cache, nenhuma mensagem de DeepSeek. O
plugin tinha gravado a escolha (`sessions.json`) e nada a violou: ele só embrulhava as ferramentas
`subagent` e `subagent_fork`, e esses agentes nunca foram uma chamada a elas.

**Causa, no código do DSH.** O motor do workflow (`workflow-ptc/src/host.ts`, `startChild`) chama
`ctx.subagents.start(this.provider, { ... })` direto, com `agentOptions` só de `provider` e `model`,
e só quando o `agent()` do script os traz (`SUPPORTED_AGENT_OPTIONS` = `label`, `phase`, `schema`,
`provider`, `model`: não há esforço nem limite de tokens). Sem eles, `resolveChildAgentOptions`
entrega ao filho tudo o que é do pai. O `ralph` roda no mesmo motor; o job `subagent` one-shot em
segundo plano e o time de agentes (experimental) também chamam `start` ou `startContinuable`. Nenhum
passa por `tools/execute` de uma ferramenta de delegação. Fixado em `test/contract/dsh-source.test.ts`
(as portas e quem as usa) e `test/contract/dsh-runtime.test.ts` (o `SubagentRuntime` real).

**Evidência.** Reproduzido num DSH isolado, só com os três modelos: com o plugin 0.3.0 e
`defaults.subagentModel` = DeepSeek V4.1 Flash, os dois agentes de um workflow de duas linhas
rodaram em `openrouter/z-ai/glm-5.3` a `high`, sem teto de tokens (W0). Com o guarda, em
`azure-opencode/DeepSeek-V4.1-Flash`, `medium`, 64 000 (W1). Detalhes em
[docs/validation/README.md](../validation/README.md).

**Decisão.** `src/guard.ts` põe `start` e `startContinuable` próprios na instância do
`SubagentRuntime` (alcançada pelo símbolo registrado `Symbol.for('cordis.original')` do proxy do
serviço). Para uma sessão com escolha confirmada (guardada, de um ancestral ou `defaults`), todo
filho que o pipeline do plugin não iniciou é planejado como um trabalhador: a rota escolhida, o
esforço pedido pelo usuário ou o teto do modelo, e o limite de tokens, entregues como `agentOptions`.
O revisor **não** atua nesses filhos. Um modelo que o chamador nomeia perde para a escolha do
usuário (`children.explicitModel: override`, padrão) ou vale (`keep`); sem modelo de subagente
escolhido, o nomeado vale. `children: false` retira o guarda. Um modelo confirmado que o runtime de LLM
não conhece mais (renomeado, removido) **rejeita o início** com uma mensagem que diz o que fazer
(`ChoiceUnusableError`); o limite de tokens que o chamador definiu nunca é elevado. O diálogo ganhou
duas linhas que dizem o escopo (en, pt, zh).

**Achados da revisão independente (adversarial e por mutação) incorporados.** O marcador agora sobrevive
a cópias do pedido (propriedade enumerável com símbolo registrado) e a saída do guarda também é marcada
(dois guardas vivos planejam uma vez; vale a configuração mais nova). O planejador passou a planejar
contra o que o DSH realmente mescla: o filho na própria rota do pai herda o esforço dele, e o limite de
tokens de criação do pai desce em **toda** rota; o esforço que o chamador nomeou e o planejador recusou
não é mais ressuscitado pelo merge. A espera pela descrição do modelo corre contra o cancelamento. Provedores
com rota própria (SDK) ficam de fora quando não há modelo escolhido. Campos de configuração desconhecidos
avisam. O que ficou documentado e não corrigido: o teto de tokens não sobrevive ao cold-resume (N21).

**Por quê assim.**
* *Uma porta, não N ferramentas.* `SubagentRuntime.start` e `startContinuable` são o único caminho
  pelo qual um provedor é iniciado e um agente-filho é criado (fixado). Um guarda ali cobre quem
  chama hoje e quem chamar amanhã; embrulhar ferramentas teria de nomear cada uma e perderia a próxima.
* *A instância, não o provedor.* O filho `continuable` é composto pelo gerente de continuação, que lê
  `spec.request.agentOptions`; o provedor só contribui com a semente. Um embrulho de provedor não o
  alcançaria.
* *Marcar, não detectar.* O pipeline planeja o próprio trabalhador, a nova tentativa e o revisor, e o
  guarda não pode planejá-los de novo (poria o revisor no modelo do trabalhador). Um `WeakSet` global
  de objetos de requisição, atrás de um símbolo registrado para que uma cópia recarregada do plugin
  concorde, mais uma propriedade enumerável própria com símbolo registrado (uma cópia por espalhamento a
  leva junto, então um embrulho empilhado acima do guarda não consegue apagar a marca), diz "já
  planejado". Detectar pelo conteúdo falha no revisor que mantém a rota do trabalhador e portanto não
  leva opções.
* *Rejeitar, não forçar nem trocar, quando o modelo confirmado não existe mais.* Cair no modelo do agente
  principal é o bug original; forçar a rota morta faz cada agente de workflow falhar na primeira
  requisição e virar `null`, com uma única linha de log (N22).
* *Falhar alto na instalação, nunca no uso.* Um guarda que não faz nada em silêncio é exatamente como o
  furo ficou aberto. Um serviço que não pode ser embrulhado derruba o carregamento do plugin; já um
  filho que não pode ser planejado vira uma linha de log e o início padrão do DSH, porque o guarda
  nunca pode quebrar uma delegação. O cancelamento do chamador passa.
* *Sem revisor.* O script do workflow consome o resultado de cada agente (muitas vezes dado validado
  por esquema); trocar por um relatório de revisão quebraria o script. O diálogo e o README dizem isso.
* *Trocar as opções por inteiro quando a rota do usuário vence.* `AgentOptions` são exatamente
  `provider`, `model`, `reasoningEffort` e `maxTokens` (fixado), e um esforço escolhido para outro
  modelo não pode viajar para este (um esforço não suportado falha a primeira requisição).

**Onde.** `src/guard.ts`, `src/pipeline.ts` (marcação dos inícios), `src/index.ts`, `src/config.ts`
(`children`), `src/effort.ts` (`childPolicyOf`), `src/tool-wrapper.ts` (aviso do job),
`src/client/` (as duas linhas do diálogo).

**Verificação.** `guard.test.ts`, `pipeline-v2.test.ts` (inícios marcados), `config.test.ts`,
`host-wiring.test.ts`, `dsh-source.test.ts` (seis fixações novas), `dsh-runtime.test.ts` (o guarda no
`SubagentRuntime` real, instalado por um plugin e chamado por outro). Ao vivo, nos três modelos: W0 a
W4 e T3 ([validação](../validation/README.md)).

### D16 — Remover o revisor independente (0.5.0)
**Decisão.** A 0.5.0 remove o revisor. O que fica é o que o plugin impõe **em código**: o modelo dos
subagentes, o teto de esforço de raciocínio e o limite de tokens, em todo filho que o DSH inicia (o guarda
de D15). Depois da remoção o guarda é o único mecanismo do plugin.

**Por quê.**
* *Determinismo.* Qual modelo roda, o quanto pensa e quanto pode escrever é decidido pelo código e o
  agente principal não o contorna. O `APPROVED` do revisor era a opinião de uma LLM sobre o trabalho de
  outra: o plugin só conseguia conferir o formato e a coerência do relatório (D04, D05), nunca a verdade
  dele. A pergunta do dono do projeto, em 2026-10-04, foi exatamente esta: controlar algo que é da
  ferramenta, em vez de uma abstração no fim de cada subagente que tenta inferir e resolver o problema.
* *Custo e espera.* Cerca do dobro do custo e cada delegação esperando um segundo modelo (o MiMo-V2.6-Pro
  leva minutos por turno em esforço alto; D12 só tornava isso visível).
* *Cobertura.* O revisor só atuava nas duas ferramentas `subagent`. Os agentes de um `workflow`, `ralph`,
  jobs one-shot e times nunca foram revisados (D15, N18): o plugin prometia uma verificação que valia para
  uma fração dos caminhos.
* *Um mecanismo a menos.* O embrulho da ferramenta e o pipeline existiam para o revisor. A 0.4.0 mostrou
  que o guarda sozinho governa todo caminho; na 0.5.0 isso foi **verificado ao vivo sem o embrulho**:
  `subagent` em primeiro e em segundo plano e `subagent_fork` rodaram no DeepSeek V4.1 Flash, `medium`, com
  limite de 64 000 tokens, só pelo guarda. Com o embrulho fora, some também a marcação por `WeakSet` dos
  inícios do pipeline (só ficou a marca na cópia que o guarda entrega, para dois guardas vivos).

**O que saiu.** `src/pipeline.ts`, `src/reviewer-protocol.ts`, `src/workspace.ts`, `src/tool-wrapper.ts`
(cerca de 1 250 das 3 430 linhas do host); os campos de configuração `tools`, `reviewerProvider`,
`reviewerContext`, `structuredVerdict`, `workerHandoff`, `maxWorkerReportChars`, `retryOnTokenLimit`,
`workspaceChecks`, `sensitivePaths`, `defaults.reviewer`, `effort.reviewer` e `limits.reviewerMaxTokens`; a
seção do revisor no diálogo (e as dicas de mesmo modelo, mesma família e custo); a família e a linhagem dos
modelos em `src/models.ts` (só serviam a essas dicas); `lowerEffort` (só servia à nova tentativa); os
cenários e os executores de validação do revisor.

**O que ficou.** O guarda, o planejador (`planChild`, agora com um papel só), os tetos de esforço (a coluna
do subagente da tabela de `models.ts`), o diálogo com a chave do modelo e o bloco de esforço, a rota, o
estado persistido, `/orquestrar`.

**Compatibilidade.** Nada que o usuário já tenha gravado quebra. `parseConfig` lê um registro da 0.4.0 com o
bloco `reviewer` e o descarta (uma escolha só com revisor vira a configuração inerte); os campos de
configuração removidos são ignorados com um aviso cada; uma aba do navegador ainda com o diálogo da 0.4.0
continua gravando sem erro. Verificado num servidor real: um `sessions.json` da 0.4.0 foi carregado e
regravado só com `subagentModel`, `workerEffort` e `version`. Uma mudança de semântica: um esforço
sozinho, sem modelo (`defaults.workerEffort`), agora conta como escolha (antes só valia junto do revisor) e
aplica o nível aos filhos que ficam no modelo do agente principal.

**O que se perde, dito claramente.** Nada confere o que o subagente produz. Quem confere é o agente
principal, lendo o resultado como o DSH sempre entregou, e os testes do próprio projeto. Na validação da
0.2.0 o revisor pegou uma contradição na tarefa e uma conta errada no prompt do agente principal (uma
amostra, de uma LLM). **Se uma conferência voltar, que seja uma porta determinística** (rodar os testes do
projeto por código, dentro do sandbox do DSH, e recusar a aprovação se falharem), não outra LLM.

**Onde.** Remoções em `src/`; `src/shared.ts` (configuração só com modelo e esforço, leitura tolerante),
`src/config.ts` (campos removidos ignorados, `removedConfigFields`), `src/guard.ts` (só a marca
`isGoverned`), `src/effort.ts` e `src/models.ts` (um papel), `src/index.ts` (`inject = ['subagents']`),
`src/client/` (diálogo de uma seção).

**Verificação.** 253 testes (com `DSH_CHECKOUT`), entre eles a leitura tolerante e a compatibilidade com uma
aba antiga (`shared.test.ts`, `routes.test.ts`, `host-wiring.test.ts`). Ao vivo, nos três modelos: W1 a W8
(sem revisor, sem embrulho) e 65 verificações de navegador ([validação](../validation/README.md)).

---

### D17 — Manter o bloco `reviewer` desligado na rede entre as metades (0.5.1)
**Decisão.** O navegador envia, e o host responde, a configuração com um bloco `reviewer` desligado
(`{ enabled: false, model: null, effort: null }`, a constante congelada `LEGACY_REVIEWER`). A 0.5 o lê e ignora e
nunca o grava no estado. Sai quando ninguém mais rodar a 0.4.

**Por quê.** Um plugin tem duas metades que carregam em momentos diferentes: o host quando o `dsh` inicia, o navegador
quando a página carrega. Depois de uma atualização elas diferem pelo tempo que leva o reinício: uma página recarregada
contra o host antigo, ou uma aba aberta antes de reiniciar contra o host novo. A 0.2 a 0.4 recusam uma configuração sem o bloco
("config does not match the expected shape", `422`) e o navegador antigo recusa uma resposta sem ele ("the host answered a
malformed configuration"): nada salvava. Aconteceu na máquina do próprio dono minutos depois de publicar a 0.5.0 (servidor
iniciado às 06:35, plugin atualizado em disco às 18:39, página recarregada), e o caso inverso foi achado ao reproduzir.
Remover um campo da rede sem pensar no fio entre versões foi o erro da 0.5.0.

**Alternativas.** (a) Só mandar reiniciar e melhorar a mensagem: o erro continuaria quebrando quem atualiza com o servidor
ligado, e a aba antiga continuaria morrendo depois de cada reinício. (b) Negociar a versão por cabeçalho: mais código nos dois
lados para um problema que se resolve com uma constante, e o cliente antigo não manda cabeçalho nenhum. (c) Versionar a rota
(`/config/v2`): o host antigo não a teria e o navegador novo não conseguiria salvar nada nele; é pior.

**Onde.** `src/shared.ts` (`LEGACY_REVIEWER`, `toWireConfig`), `src/routes.ts` (respostas), `src/client/config-client.ts`
(corpo do POST), `test/legacy-wire.ts` (o parser estrito da 0.4 como fixture).

**Verificação.** Reproduzido num navegador real, nos dois sentidos, antes e depois ([validação](../validation/README.md)).

---

### D18 — A skill global `orchestrate-subagents` e o checkbox no diálogo (0.8.0)
**Decisão.** O plugin registra no registro de skills do DSH (`ctx.skills.register`), quando carrega, uma skill
global, `orchestrate-subagents`. O texto vive em `skills/orchestrate-subagents/SKILL.md` e é embutido em
`lib/index.js` no build (`scripts/gen-skill.mjs` gera `src/skill.generated.ts`; um teste falha quando os dois
divergem). O diálogo que abre antes de toda mensagem ganha um checkbox, **marcado por padrão**: com ele marcado e
o envio confirmado, a mensagem sai com o token `/orchestrate-subagents` numa linha própria no fim (no fim, e não no
começo, porque o DSH batiza a conversa com as primeiras palavras da primeira mensagem: o token na frente encabeçaria
o título de toda conversa que aplica a skill; descoberto na validação ao vivo), e o próprio DSH injeta as
instruções da skill nesse passo (o gesto `/nome` do `dsh-tool-skill`). Cancelar, Esc e ✕ continuam enviando a
mensagem exatamente como o DSH sempre fez, sem token.

**Por quê.**
* *É o mecanismo que o DSH já tem para "instruções que uma tarefa escolhe".* O registro dá disponibilidade global
  ao instalar o plugin (nada a copiar para uma pasta de skills), entra no catálogo de skills do modelo e dispensa
  uma seção nova no prompt. O guia do projeto (seção 6, "Modo Coordenador Puro") descrevia exatamente uma instrução
  injetada no orquestrador; a skill é a forma nativa dela.
* *A mensagem fica limpa.* O token é uma palavra; o corpo (cerca de 1 800 tokens) entra como contexto injetado,
  "o mais perto da resposta do modelo", e a transcrição mostra quais mensagens levaram a skill.
* *Instrução, não imposição (a bússola de D16).* O que o plugin impõe em código continua sendo o modelo, o teto de
  esforço e o teto de tokens. A skill pede ao modelo que divida, paralelize, delegue a leitura e verifique, e não
  bloqueia nenhuma ferramenta. O README e o diálogo não prometem o contrário.
* *O checkbox só aparece quando o host registrou a skill.* As duas metades carregam em momentos diferentes (D17):
  uma página nova contra um host antigo mandaria um token que ninguém expande. A rota de configuração, que o gate já
  lê antes de toda mensagem, passa a dizer se a skill está registrada; um host que não diz (anterior à 0.8) significa
  "não ofereça".
* *A escolha lembrada é só do checkbox.* Como a escolha do modelo, a última resposta pré-preenche o próximo diálogo
  (a primeira vez, marcado). Não vai para o host nem para o fio: nenhuma compatibilidade entre metades a manter.

**Alternativas.** (a) Colar o texto inteiro no prompt, no navegador: polui a mensagem do usuário e a transcrição,
gasta tokens sem o modelo saber que é uma skill e leva o texto nos dois pacotes. (b) Injetar no host em
`agent/pre-step` por sessão: alcançaria headless e TUI, mas o usuário não veria o que foi aplicado; quem quer a skill
fora da web digita `/orchestrate-subagents` e o gesto nativo faz o mesmo. (c) Instalar um `SKILL.md` em
`~/.agents/skills`: um plugin escrevendo fora do próprio diretório e fora do ciclo de `dsh plugin`. (d) Só
invocável pelo usuário (`modelInvocable: false`) como padrão: o catálogo do modelo é o que torna a skill "disponível
para toda tarefa"; a opção `skill.modelInvocable` existe para quem não quer a linha no catálogo.

**Onde.** `skills/orchestrate-subagents/SKILL.md`, `scripts/gen-skill.mjs`, `src/skill.ts`, `src/skill.generated.ts`,
`src/config.ts` (`skill`), `src/routes.ts` (`skill` na resposta da rota de configuração), `src/shared.ts`
(`SKILL_NAME`, `SkillOffer`), `src/client/skill-token.ts`, `src/client/gate.ts`, `src/client/OrchestratorDialog.tsx`.

**Verificação.** Testes de unidade (registro, gerador, token, gate, diálogo); testes de contrato contra o código do
DSH (o registro aceita o que registramos, o gesto `/nome` é o que a documentação diz). Num DSH isolado, em
navegador real e com modelos reais: ver [a validação](../validation/README.md).

---

### D19 — O modelo e o estado de cada subagente na lista do cabeçalho (0.8.0)
**Decisão.** Cada linha do menu de subagentes de uma página de tarefa mostra (1) o modelo em que o subagente roda,
como um rótulo pequeno (`DeepSeek V4.1 Flash · medium`), e (2) um ícone de estado no lugar da bolinha do DSH: um
spinner enquanto roda, um check quando termina, uma marca vermelha quando falha (erro, teto de tokens, recusa), um
quadrado âmbar quando foi parado e um ponto cinza quando o resultado não foi registrado. O host registra o resultado
(`subagent/start` e `subagent/end`) e a página o lê numa rota própria.

**Por quê.**
* *O DSH não registra o resultado.* O catálogo só sabe `running` e `inactive`; o README do `ui-subagent` diz que não
  distingue conclusão, falha e cancelamento. O motivo de parada (`completed`, `aborted`, `error`, `max-tokens`,
  `refusal`) só existe em `subagent/end`, que todo filho em processo emite, qualquer que seja a ferramenta que o
  iniciou (uma ferramenta, um `workflow`, `ralph`, um job).
* *O modelo vem do agente vivo.* No `subagent/start` o filho já existe (`ctx.agents.get(id)`), com a rota que o guarda
  planejou ou a que ele herdou. Num filho de uma execução só (*one-shot*), no `subagent/end` o cabeçalho do último
  pedido tem a rota que de fato serviu, e o host a grava no lugar da planejada. **Limite** (achado pela revisão
  independente, verificado no runtime real): um filho *continuable*, que é o que as ferramentas `subagent` e
  `subagent_fork` do preset padrão iniciam por padrão, é liberado pelo DSH antes de o `subagent/end` ser anunciado,
  então o agente já não existe e não há correção possível: o registro guarda a rota pedida no início da época (a
  mais recente, num filho retomado). O estado e o motivo de parada continuam registrados, porque o evento de fim os
  carrega. A página, por isso, prefere o modelo que o próprio DSH informa (`lastUsed`) ao da rota do livro-razão, e
  só cai para o do livro-razão quando o DSH não tem nenhum.
* *Sem registro, sem invenção.* Um filho anterior ao plugin ou criado enquanto ele não estava carregado aparece com
  um ponto cinza e, se o DSH souber, o modelo (`projections.modelSelection.lastUsed`), em vez de um "concluído"
  que ninguém verificou. Um registro que estava `running` quando o host morreu carrega como `stopped`
  (`interrupted`); um `running` com mais de 20 s que o catálogo já vê como inativo vira `unknown`, para um spinner
  nunca girar para sempre.
* *O registro do host é mais novo que o catálogo do navegador.* Havendo registro, ele decide o estado; a atividade
  do catálogo só decide sem registro.

**Alternativas.** Ver N23 (substituir o componente do DSH) e N24 (derivar o estado do log de cada filho).

**Onde.** `src/subagents.ts` (livro-razão e rastreador), `src/routes.ts` (`GET /dsh-orquestrator/subagents`),
`src/shared.ts` (`SubagentRecord`, `subagentStateOf`), `src/client/subagent-marks.ts` (decisão pura),
`src/client/subagent-menu.ts` (DOM), `src/client/subagents-client.ts`, `src/client/styles.ts`.

**Verificação.** Testes de unidade e de DOM (jsdom) e testes de contrato contra a estrutura do menu do DSH; num DSH
isolado, em navegador real: ver [a validação](../validation/README.md).

---

## Recomendações não adotadas ou adiadas

### N01 — Extinguir `APPROVED_WITH_FIXES` (revisor só lê)
**Origem.** E02 (e, só para o MiMo, E04 e E11). **Por quê não.** O conserto de defeito provado é
requisito do produto, e E03, E05, E07, E09, E10 e E12 o admitem com limites. A evidência de E02
(edições fora de escopo em modelos que se corrigem demais) pede **contenção**, e isso foi feito
(regras 7 e 8 da persona, lista de arquivos alterados, D09). **Reabrir** se a prática mostrar
edições fora de escopo do revisor: acrescentar `reviewerMayFix: false` (somente leitura, devolve o
teste que falha).

### N02 — Veredicto JSON com *nonce* de sessão
**Origem.** E12. **Por quê não.** O `structured_output` (D04) já tira o vetor que o *nonce*
fecha (um veredicto copiado de um arquivo da área de trabalho). Contra um modelo que obedece a uma
injeção, o *nonce* não ajuda: ele está no contexto do próprio modelo. Seria uma segunda forma de
falhar sem ganho. **Reabrir** se o DSH passar a entregar o relatório do revisor por um canal que
um agente comprometido possa forjar.

### N03 — Congelar ou rejeitar diffs em diretórios de teste
**Origem.** E12. **Por quê não.** Rejeitaria "adicione testes". Adaptada em D09 (sinalizar e
exigir leitura). Montagem somente leitura dos testes é responsabilidade do host.

### N04 — Isolamento de sistema operacional (microVM, gVisor, rede negada, segredos intermediados, mounts somente leitura)
**Origem.** E12. **Por quê não.** Está fora da autoridade de um plugin: o revisor roda no
processo do DSH com o preset da sessão. O plugin documenta o limite (D14). **Reabrir** se o DSH
oferecer um provedor de subagente isolado (os backends ACP e SDK existem, E15, mas não foram
exercidos aqui).

### N05 — Revisor visual (Playwright, marcas numeradas, árvore de acessibilidade, diff perceptual) e roteamento por imagem anexada
**Origem.** E06, E05, E07. **Por quê adiado.** Exige uma ferramenta de navegador na composição e
um revisor multimodal; é uma funcionalidade nova (um modo de revisão), não uma correção. O diálogo
já informa o essencial: GLM 5.3 só texto (confirmado), MiMo com variante `ultraspeed`, Gemini 3.8
Flash como multimodal rápido. **Reabrir** quando houver um provedor de captura de tela no DSH
local.

### N06 — Trocar o modal por barra de chips e presets (Rápido, Equilibrado, Rigoroso)
**Origem.** E13, E07. **Por quê adiado.** O plugin usa o slot `conversation.input.overlay`; um slot
de barra no compositor não foi verificado na 0.1.6-alpha.2. Presets precisam resolver ids contra o
catálogo de cada usuário. Mitigações adotadas: "recomendado" por padrão (D01, D13), escolha
lembrada na conversa, `/orquestrar`. **Reabrir** com um slot de barra e uma medição de abandono.

### N07 — Roteamento preditivo por sinais do repositório e perguntar só quando vale
**Origem.** E07, E13. **Por quê adiado.** O benefício medido nos estudos é de roteamento geral; o
plugin não tem dados de custo (o DSH zera a metadata de custo do pi-ai) nem telemetria para
validar uma heurística. **Reabrir** com telemetria local de custo e latência por delegação.

### N08 — Fixar provedor do OpenRouter, desligar fallbacks, ZDR, sufixo `:exacto`
**Origem.** E08. **Por quê não.** O DSH marca `openRouterRouting` como `withhold` no
catálogo do `llm-pi-ai`: não deixa um perfil enviar essas preferências, e o plugin não é dono do
corpo da requisição. É configuração de `settings.yaml` e depende do DSH (`:exacto` como sufixo de
id de modelo é possível, mas não foi testado).

### N09 — Pipeline de catálogo de modelos (OpenRouter, models.dev, LiteLLM, Epoch, LMArena)
**Origem.** E11. **Por quê não.** É infraestrutura de CI, não do plugin. `MODEL_PROFILES` é pequeno,
datado, com fontes, e E11 mesmo diz que o papel recomendado é curadoria humana.

### N10 — Catálogo de 14 cargos, topologia de quatro estágios, enxame de leitura, limites de paralelismo
**Origem.** E03, E04. **Por quê não.** O plugin embrulha a delegação que o agente principal já
faz; planejar a decomposição é do agente principal ou de outro plugin.

### N11 — Lista fixa de ferramentas negadas ao revisor (`toolFilter`)
**Origem.** E12, E15. **Por quê não.** `tools.restrict` lança erro para nomes desconhecidos e
as ferramentas do preset `standard` vivem no plano do agente: uma lista fixa quebraria a revisão
numa composição que não tenha uma delas, e o plugin não tem como listar as ferramentas do filho
antes de criá-lo. **Reabrir** quando o DSH aceitar uma restrição tolerante.

### N12 — Interceptor que troca `max` por `xhigh` no OpenRouter
**Origem.** E01, de uma fonte anedótica. **Por quê não.** Não se reproduz: em 2026-10-03 o
OpenRouter respondeu HTTP 200 para `max`, `xhigh` e `high` no `deepseek/deepseek-v4.1-flash`.

### N13 — Escala numérica 1 a 100 de esforço e `max_thinking_tokens`
**Origem.** E01, E03, E05, E11, E13. **Por quê não.** O DSH e a sonda do usuário usam a escada
nomeada; não existe `max_thinking_tokens` na configuração do DSH. Equivalentes adotados: D01 e D02.

### N14 — Revisor de outra família como regra, e comitê de revisores baratos
**Origem.** E02. **Por quê não.** Cross-family é uma dica (D11). O comitê (que o próprio E02 refuta)
nunca foi o desenho do plugin: há um revisor.

### N15 — Suprimir a revisão automaticamente (diff pequeno, só documentação, oráculo determinístico) e revisar em duas passagens
**Origem.** E02, E03, E09. **Por quê adiado.** O usuário liga a revisão por conversa, e a dica de
custo (D12) já o orienta. Uma supressão automática seria uma decisão do plugin contra uma escolha
explícita. A revisão em duas passagens (primeiro escrever o teste sem ver a solução) é uma mudança
de protocolo que pede medição; a regra 6 da persona cobre o essencial. **Reabrir** com a medição.

### N16 — Escolher o modelo do orquestrador e editar a configuração do usuário
**Origem.** E01, E02, E03, E05, E07, E08, E09, E12 divergem entre GLM 5.3 e Sonnet 5.5. **Por quê
não.** O plugin entrega inerte e não decide o modelo do agente principal; `~/.dsh/settings.yaml`
é do usuário e não foi tocado. Uma observação para o usuário, não uma mudança: o
`agent-default-model` com `reasoningEffort: max` em modelos que o estudo E02 mede melhor em
`high` ou `xhigh`.

### N17 — Embrulhar a ferramenta `workflow` ou reescrever o script do workflow (0.4.0)
**Origem.** A primeira ideia diante do furo. **Por quê não.** O embrulho de `tools/execute` não
reescreve argumentos (o registro os trata como imutáveis: `Input rewriting is excluded`), e o
`agent()` do script aceita só `label`, `phase`, `schema`, `provider` e `model`: injetar o modelo no
script deixaria o filho no esforço e no limite de tokens da rota (`max` e 384 000 no DeepSeek V4.1
Flash), que é o que o plugin existe para evitar. Seria também um embrulho por ferramenta. O guarda
(D15) planeja o filho no ponto onde esforço e limite existem. **Reabrir** nunca por esta via.

### N18 — Revisar os agentes de um workflow (0.4.0)
**Origem.** A pergunta natural ("o revisor também deve valer"). **Por quê não.** O script consome o
resultado de cada `agent()` (texto ou dado validado por esquema) e decide o que fazer; substituir o
resultado por um relatório de revisão quebra o contrato do script. O revisor continua nas delegações
de `subagent` e `subagent_fork`, e o diálogo e o README dizem onde ele não atua. **Reabrir** se o DSH
der ao workflow um ponto declarado de pós-processamento por agente, ou se um operador pedir uma fase
de revisão como parte do script.

### N19 — Trocar o modelo na cascata `agent/request` (0.4.0)
**Origem.** O DSH expõe `agent/request` ("substitua a configuração congelada da chamada"), que
alcançaria todo filho de qualquer origem. **Por quê não.** Ela roda a cada requisição de cada agente:
sobrescreveria até a escolha manual do usuário numa conversa-filha (o seletor de modelo da sessão) e
mudaria filhos já em andamento. O DSH projetou `agentOptions` na criação para isto, e o guarda o usa.

### N20 — Provedor-embrulho, troca do `workflow-ptc.provider` ou esperar um gancho no DSH (0.4.0)
**Origem.** Alternativas ao embrulho da instância. **Por quê não.** Registrar um provedor próprio e
apontar o `workflow-ptc` para ele exigiria reescrever a configuração do `workflow-ptc` do usuário (um
patch substitui a configuração inteira da linha) e não alcançaria o `startContinuable`, cujo gerente
compõe o filho. Esperar um gancho deixaria o usuário sem a correção. **Reabrir** quando o DSH publicar
um waterfall em volta do início de um filho (hoje `subagent/start` é só notificação): o guarda vira um
listener e deixa de tocar a instância. Vale propor isso ao DSH.

### N21 — Reaplicar o teto de tokens no cold-resume de um filho `continuable` (0.4.0)
**Origem.** Revisão adversarial da 0.4.0. **Por quê não.** Quando o DSH retoma um filho já terminado, ele
reconstrói as opções do **descritor** gravado (provedor, modelo, esforço; `continuation.ts`, `coldResume`), e
o limite de tokens não é um campo do descritor: o teto vale só para a primeira execução, o esforço sobrevive.
Reaplicar exigiria um ponto por requisição (a cascata `agent/request`), que roda a cada requisição de todo
agente e não distingue trabalhador de revisor sem estado próprio; não foi verificado que um ouvinte de plugin
a receba para agentes-filho. Fica documentado em `README.md` (Limits). **Reabrir** com um experimento de
design que confirme o ouvinte e o papel do filho, ou se o DSH passar a gravar o limite no descritor.

### N22 — Cair no início padrão do DSH quando o modelo confirmado não existe mais (0.4.0)
**Origem.** Revisão adversarial da 0.4.0 (alternativa "falhar aberto"). **Por quê não.** O início padrão
usaria o modelo do agente principal, no esforço dele: exatamente o furo que o guarda fecha, agora sem um
erro que o denuncie. A rejeição com mensagem acionável custa uma delegação falha e evita o gasto. Vale só
para o modelo que o **usuário** escolheu; um modelo que o chamador nomeou (`keep`) é do DSH. **Reabrir** se
o runtime de LLM puder falhar de forma transitória na descrição de um modelo (hoje os adaptadores
embutidos resolvem localmente e de forma determinística).

### N23 — Substituir o componente do menu de subagentes do DSH (0.8.0)
**Origem.** O slot `conversation.session.header.lineage` é `single` com prioridade, e um registro de prioridade menor
"sombreia" o ocupante do DSH: dava para registrar uma lista nossa, com modelo e estado, no lugar da dele.
**Por quê não.** Seriam cerca de 870 linhas do componente (árvore, teclado, abertura por hover, portal, estados de
carga e de diagnóstico, alternador na página do filho) e do CSS copiadas e mantidas, mais as ações (`openChild`,
`openChildAside`, `refresh`, `setCatalogOpen`) reconstruídas a partir de serviços que o plugin não injeta. Toda melhoria
futura do DSH no menu se perderia. Decorar as linhas por fora custa menos e falha para o lado seguro (o DSH continua
mostrando a sua linha). **Reabrir** se o DSH publicar um ponto de extensão por linha, ou se a estrutura do menu mudar
a ponto de a decoração por papéis não bastar.

### N24 — Derivar o resultado de um subagente do log da sessão dele (0.8.0)
**Origem.** O log de cada filho tem `turn/end` com o motivo; dava para ler o resultado de filhos antigos.
**Por quê não.** O navegador não lê o log (só projeções), e o host teria de abrir e descomprimir o log de cada filho a
cada consulta; o catálogo do DSH foi desenhado para não carregar filhos. O livro-razão guarda o que os eventos já
dizem, a um custo constante. O preço é que filhos de antes da 0.8.0 ficam sem resultado (ponto cinza). **Reabrir** se
o DSH expuser o motivo de parada numa projeção da sessão.
