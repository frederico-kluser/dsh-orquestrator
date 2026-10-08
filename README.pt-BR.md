# dsh-orquestrator

[![ci](https://github.com/frederico-kluser/dsh-orquestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/frederico-kluser/dsh-orquestrator/actions/workflows/ci.yml)
[![licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)

Plugin para o [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). Quando você envia
uma nova tarefa, um diálogo no visual padrão do DSH faz uma pergunta:

Os **subagentes devem usar outro modelo** que não o selecionado para o agente principal?

Se sim, você escolhe o modelo e o plugin o impõe **em código**, em todo filho que o DSH inicia
naquela sessão: as ferramentas `subagent`, mas também os agentes que um `workflow` inicia, as
rodadas do `ralph`, jobs em segundo plano one-shot e times de agentes. O agente principal não
consegue contornar: não é uma instrução ao modelo, é o plugin parado nas portas por onde o DSH
inicia filhos. Veja [Quais delegações são cobertas](#quais-delegações-são-cobertas).

Todo filho governado também recebe um **teto de esforço de raciocínio** e um **limite de tokens de
saída**, porque o DSH, por padrão, roda um filho re-roteado no padrão da rota dele (`max` em muitas
configurações): a causa de subagentes que queimam o orçamento inteiro num caso de borda. Veja
[Esforço de raciocínio](#esforço-de-raciocínio).

Desde a 0.8.0 o plugin também traz uma **agent skill global**, a `orchestrate-subagents`, e o
diálogo ganha um checkbox para ela, marcado por padrão: com ele marcado, a mensagem sai com
`/orchestrate-subagents` e o DSH carrega as instruções da skill para aquela tarefa. A skill ensina o
agente principal a dividir o trabalho em partes pequenas, rodar subagentes em paralelo, mandar subagentes
lerem o código em vez de ler ele mesmo e conferir cada resultado com subagentes verificadores. Veja
[A skill de orquestração](#a-skill-de-orquestração). A lista de subagentes da página de uma tarefa agora
também mostra em que modelo cada subagente roda e um ícone de estado (rodando, concluído, falhou). Veja
[Lista de subagentes: modelo e estado](#lista-de-subagentes-modelo-e-estado).

****Cancelar, Escape e o botão de fechar significam a mesma coisa agora: abortar o envio** — nada sai, nenhuma bolha aparece e o texto digitado fica no compositor como rascunho. Só "Send with these options" envia.**
Nada mais no DSH muda.

| Escuro | Claro |
| --- | --- |
| ![Diálogo, tema escuro](docs/img/modal-dark.png) | ![Diálogo, tema claro](docs/img/modal-light.png) |

Com um modelo escolhido na lista do próprio compositor:

![Diálogo com um modelo de subagente escolhido](docs/img/modal-filled.png)

> English: [README.md](README.md)

> **A 0.5.0 removeu o revisor independente** que as versões 0.2 a 0.4 ofereciam ao lado da escolha
> de modelo. O que governa os modelos ficou, e agora é o único mecanismo do plugin. Escolhas
> guardadas e arquivos de patch escritos para a 0.4 continuam funcionando (os campos do revisor
> são ignorados, com um aviso). O porquê: [Por que o revisor foi removido](#por-que-o-revisor-foi-removido).

## Instalação

```sh
dsh plugin --profile web add github:frederico-kluser/dsh-orquestrator
dsh --profile web            # (re)inicie: veja a nota abaixo
```

**Reinicie o `dsh` depois de instalar ou atualizar, não só a página.** A metade do host de um plugin é carregada
quando o `dsh` inicia e a metade do navegador quando a página carrega, então atualizar só a página deixa a metade
antiga do host rodando (e o guarda antigo junto). A partir da 0.5.1 as duas metades também continuam conversando com
metades da 0.2 a 0.4 enquanto você reinicia (um bloco `reviewer` desligado continua na rede para isso), então um estado
misturado ainda salva; antes disso, falhava com "config does not match the expected shape".

A partir de um clone local: `dsh plugin --profile web add /caminho/para/dsh-orquestrator`.

Testado no **DSH 0.1.6-alpha.2** (Node 24, pnpm 11). O `lib/` commitado é a saída do
build, então a instalação não precisa compilar nada.

## Uso

Digite o que for no compositor e envie. O diálogo aparece antes de **todas** as mensagens que
você envia — texto simples, referências `@arquivo` ou invocações `/skill`, em qualquer conversa,
mesmo com um turno a correr:

- **Modelo dos subagentes**: ligue e escolha um modelo na mesma lista agrupada por
  provedor que o seletor de modelo do compositor usa. Vale para todo subagente, inclusive os
  agentes que um workflow inicia. Desligado, os subagentes mantêm o modelo do agente principal. O
  diálogo mostra notas curtas e datadas para os modelos que precisam delas (por exemplo: o
  MiMo-V2.6-Pro pode levar minutos por turno em esforço alto; o GLM 5.3 é só texto).
- **Esforço de raciocínio** (um select logo abaixo do seletor de modelo, sempre visível — não existe mais
  uma secção para abrir): só os níveis que o modelo escolhido realmente oferece, do menor ao maior, mais um
  neutro `Model default`. Escolher ou trocar de modelo faz o select saltar de imediato para o **maior** nível
  daquele modelo; mude se quiser menos. O último nível que confirmou pré-preenche o próximo diálogo (e sobrevive
  a um modelo cuja escada ainda está a carregar). Com o switch desligado o select continua a funcionar: um nível
  escolhido aí é uma escolha só de esforço (os filhos ficam no modelo do agente principal, sob esse teto).
- **O que o modelo entende** (uma faixa pequena sob o select de esforço): quatro marcas — áudio, foto, texto,
  vídeo — acesas quando o modelo escolhido aceita esse tipo de entrada, e o seu score de topo,
  `Terminal-Bench 4 · 41.8%` quando a classificação oficial Terminal-Bench 4.0 conhece o modelo (um snapshot
  embutido no build) ou `Intelligence · 39.5`, o índice de inteligência do OpenRouter. Os dados vêm ao vivo do
  catálogo público de modelos do OpenRouter (sem chave, sem proxy); um modelo que não resolve não mostra faixa.

  ![O que o modelo entende: áudio, foto, texto, vídeo — e o score do Terminal-Bench 4](docs/img/model-facts.png)
- **Skill de orquestração** (um checkbox, marcado por padrão; aparece quando a metade do host do plugin
  registrou a skill): aplica a skill global `orchestrate-subagents` a esta mensagem. A mensagem sai com o
  token `/orchestrate-subagents` e o DSH injeta as instruções da skill nesse passo. Desmarque para enviar a
  mensagem sem a skill; o diálogo lembra a sua última resposta para a próxima mensagem. Ele está sempre visível
  e pode ser ligado/desligado, seja o que for que o switch do modelo de subagentes diga. Se a mensagem já contém o
  token (você o digitou), o checkbox aparece marcado e travado, porque o DSH carrega a skill de qualquer jeito.
  Veja [A skill de orquestração](#a-skill-de-orquestração).
- **Não existe "não perguntar de novo"**: o modal aparece em toda mensagem que você envia e nada
  o silencia. Uma resposta nunca o esconde de uma mensagem seguinte nem de outra conversa. A
  última escolha confirmada só pré-preenche o diálogo.
- **Cancelar / Esc / ✕**: aborta o envio — nada sai, nenhuma bolha aparece e o texto digitado fica no
  compositor como rascunho; nada é guardado. Só "Send with these options" envia.

`/orquestrar` abre o mesmo diálogo sob demanda (para mudar ou limpar a escolha guardada).

Um chip pequeno debaixo do compositor (a linha `conversation.composer.dock`) mostra sempre a
orquestração desta conversa — `Subagentes: <modelo> · <esforço>` com modelo escolhido,
`Subagentes: mesmo modelo do agente principal` sem ele — e um clique abre o mesmo diálogo.

Nada pula o diálogo: só um envio vazio segue direto. Versões antigas pulavam linhas com `/`,
mensagens enviadas com um turno a correr e conversas de subagentes — então toda tarefa que
começava com uma invocação de skill (`/skill ...`) saía sem diálogo nenhum; a partir da 0.6.0 a
pergunta é feita não importa como a mensagem seja.

## Quais delegações são cobertas

O DSH tem mais jeitos de iniciar um filho do que as duas ferramentas `subagent`. Todos passam por
duas portas, `SubagentRuntime.start()` e `startContinuable()`, e o **guarda de início**
(`src/guard.ts`) fica nas duas. Para uma sessão com escolha confirmada (guardada, de um ancestral ou
em `defaults`) ele planeja todo filho: a rota escolhida, o esforço que o usuário pediu ou o teto do
modelo, e o limite de tokens de saída, entregues ao DSH como o `agentOptions` do filho.

| Como o DSH inicia o filho | Modelo, teto de esforço, limite de tokens |
| --- | --- |
| ferramentas `subagent` e `subagent_fork` (o preset padrão) | sim |
| `subagent` como job one-shot em segundo plano (`backgroundMode: one-shot`, `run_in_background: true`) | sim |
| a ferramenta `workflow`: cada chamada `agent()` do script | sim |
| `ralph` (desligado no preset padrão; roda no motor do workflow) | sim |
| times de agentes (experimental) | sim |
| provedores `codex`, `claude-code` e ACP | não: rodam agentes próprios, em modelos próprios, e não aceitam opções de agente (o plugin avisa uma vez por provedor) |
| o provedor SDK do DSH (um runtime de filho separado) | sim quando um modelo de subagente é escolhido (ele aceita rota, esforço e limite de tokens); sem modelo escolhido, o filho dele mantém o modelo do próprio provedor |

O que foi rodado ao vivo, nos três modelos-alvo: a ferramenta `subagent` (primeiro plano e segundo
plano), `subagent_fork` e a ferramenta `workflow` (com o padrão `override`, com `keep` e com o
enforcement desligado), por linha de comando e pelo diálogo num navegador real. As outras linhas
decorrem das portas que usam, que os testes de contrato fixam contra o código-fonte do DSH (o `ralph`
roda no motor do workflow, um job one-shot e o time chamam `start` / `startContinuable`, o provedor
SDK aceita opções de agente). Nenhuma execução ao vivo usou job one-shot em segundo plano, `ralph`,
time de agentes, provedor SDK nem `codex` / `claude-code` / ACP.

Por que um guarda e não um embrulho de ferramenta: o embrulho nunca via os agentes de uma chamada
`workflow`, porque o motor os inicia pelo próprio serviço. Na sessão que expôs isso, 34 agentes de
workflow rodaram no Claude Sonnet 5.5 em `max` (cerca de 7,2 milhões de tokens de saída e 1,26 bilhão
de tokens de leitura de cache) embora o DeepSeek V4.1 Flash estivesse confirmado para os subagentes.
A versão 0.3 e as anteriores têm esse buraco; [a página de validação](docs/validation/README.md)
o reproduz num DSH isolado e mostra o buraco fechado.

O que um filho governado recebe: o modelo que o usuário escolheu, o esforço que o usuário escolheu (ou
o teto do modelo) e o limite de tokens de saída. O agente principal nunca é tocado, e uma sessão sem
escolha confirmada também não.

Se o modelo que você confirmou sumiu (renomeado ou removido das configurações do seu DSH depois da
confirmação), o início do filho é rejeitado com uma mensagem que diz isso e o que fazer
(`/orquestrar`, ou cancelar o diálogo). As alternativas são piores: rodar o filho no modelo do agente
principal é o bug que este desenho existe para evitar, e forçar a rota morta faz todo agente de
workflow falhar num `null` silencioso.

Um modelo que o próprio chamador nomeia (`agent({ provider, model })` num script de workflow) perde
para a escolha do usuário por padrão (`children.explicitModel: override`): o diálogo é a instrução
explícita do usuário. `keep` deixa o modelo do chamador valer, sob os mesmos tetos. Uma escolha com
esforço mas sem modelo (`defaults.workerEffort` sozinho) deixa os filhos no modelo do agente
principal sob esse nível, e um modelo que o próprio script nomeia vale.

## A skill de orquestração

Ao carregar, o plugin registra uma skill no registro de skills do DSH: `orchestrate-subagents`
([`skills/orchestrate-subagents/SKILL.md`](skills/orchestrate-subagents/SKILL.md)). Ela é registrada pelo
plugin, não copiada para uma pasta de skills, então instalar o plugin basta para toda tarefa de toda
sessão tê-la.

O que ela ensina ao agente que coordena (nunca a um subagente; a própria skill diz isso):

1. **Quebrar a tarefa em partes pequenas primeiro**, num plano escrito com as dependências entre elas, cada
   parte valendo um subagente (itens pequenos do mesmo formato são agrupados, não um agente para cada).
2. **Iniciar junto tudo o que pode rodar junto**: várias chamadas `subagent` numa mensagem, jobs em segundo
   plano para as partes lentas, um script `workflow` quando muitas partes têm o mesmo formato.
3. **Partes em paralelo dividem uma só árvore de trabalho**: todo arquivo tem um dono, um arquivo de que várias
   partes precisam é uma parte própria feita antes, uma linha de base dos testes é registrada antes de mudar
   código, e commits, stashes e mudanças de dependências só acontecem quando a tarefa pede.
4. **Não ler código você mesmo.** Mandar um subagente ler e responder uma pergunta, pedindo referências
   `caminho:linha`, fatos separados de palpites e um limite de tamanho, para um relatório custar pouco
   contexto.
5. **Não escrever nem rodar nada você mesmo.** Edições, builds e testes são dos subagentes.
6. **Verificar com um subagente diferente**, iniciado depois que a parte termina e recebendo os requisitos e
   onde olhar, não o relatório do autor; uma descoberta só de leitura ganha um leitor que tenta refutá-la. Um
   verificador final confere a mudança inteira.
7. **Reparar em rodadas e parar**: no máximo duas rodadas por parte, depois relatar o que continua quebrado.
8. **Relatar a partir de evidências**: o que foi provado, por qual comando, e o que não foi verificado.

Ela também traz o modelo de briefing (objetivo, onde, fora do escopo, contexto, pronto quando, formato do
relatório), o briefing do verificador e o formato fixo de relatório que todo subagente recebe. A redação foi
testada em quatro tarefas imaginadas (uma mudança de código, uma pergunta só de leitura, um erro de digitação
de uma linha, uma migração de 40 arquivos) antes de se firmar, e as arestas que isso expôs são o que as
regras 3 e 6 dizem agora.

Ela chega a uma tarefa de três jeitos, todos nativos do DSH:

| Como | O que acontece |
| --- | --- |
| O checkbox do diálogo (marcado por padrão) | A mensagem sai com o token `/orchestrate-subagents` numa linha própria no fim (no fim, porque o DSH titula a conversa com as cinco primeiras palavras da primeira mensagem; uma primeira
mensagem com menos de cinco palavras ainda leva o token no título). O gesto de skill do DSH o vê e injeta as instruções completas da skill nesse passo, o mais perto da resposta do modelo. A transcrição mostra o token, então dá para ver quais mensagens levaram a skill. |
| Você digita `/orchestrate-subagents` (qualquer perfil, headless incluído) | O mesmo gesto. |
| A escolha do próprio modelo | A skill aparece no catálogo de skills do modelo, então o agente principal pode carregá-la com a ferramenta `skill` quando uma tarefa claramente combina. `skill: { modelInvocable: false }` a tira do catálogo, e só o token a carrega. |

O checkbox só aparece quando a metade do host registrou a skill e o `dsh-tool-skill` do DSH, o plugin que é
dono do gesto `/nome`, está carregado (o diálogo pergunta ao host), então uma página cujo host é anterior à
0.8.0, ou uma composição sem o registro de skills do DSH ou sem esse plugin, nunca envia um token que nada
expandiria. Ele também não aparece quando você digita para um subagente na conversa dele: a skill é
para o agente que coordena, e um filho que a recebesse tentaria coordenar. `skill: false` desliga o registro, e
o checkbox junto.

![Uma mensagem que levou a skill: o token numa linha própria no fim, e o DSH injetando a skill (as linhas "Context injection")](docs/img/skill-transcript.png)

O texto da skill é embutido em `lib/index.js` no build (`pnpm run gen:skill` gera `src/skill.generated.ts`
a partir do Markdown, e os testes falham quando os dois divergem), então o plugin instalado nunca o lê do
disco; o arquivo só é entregue ao DSH como o caminho da skill, para a transcrição poder abri-lo. Para usar o
mesmo texto em outro harness de agentes, aponte um link da pasta para o diretório de skills desse harness (no
Claude Code: `ln -s <clone>/skills/orchestrate-subagents ~/.claude/skills/orchestrate-subagents`). Não a ligue
em `~/.agents/skills`: o DSH lê esse diretório também e só registraria, a cada montagem do catálogo, que o
registro do próprio plugin tem precedência sobre a cópia.

**É uma instrução, não uma imposição.** Diferente do modelo, do teto de esforço e do limite de tokens, que o
guarda de início impõe em código, a skill pede ao modelo que trabalhe de um certo jeito, e um modelo pode
ignorá-la, sobretudo no fim de uma conversa longa. Ela não bloqueia nenhuma ferramenta: o agente principal
ainda pode ler e editar arquivos. Se importa que o agente principal nunca toque em código, isso é trabalho do
preset de permissão da sessão.

## Lista de subagentes: modelo e estado

A página de uma tarefa lista os subagentes num dropdown no cabeçalho (a contagem ao lado do título). Desde a
0.8.0 cada linha também mostra:

- **O modelo** em que o subagente roda, num rótulo pequeno sob a linha (`DeepSeek V4.1 Flash · medium`): o nome
  do modelo no catálogo do próprio compositor, mais o nível de raciocínio quando há um.
- **Um ícone de estado** no lugar da bolinha do DSH: um spinner enquanto roda, um check quando termina, uma
  marca vermelha quando falha (um erro, o teto de tokens, uma recusa), um quadrado âmbar quando foi parado e um
  ponto cinza quando o resultado não foi registrado.

![O dropdown de subagentes: um subagente rodando (spinner), outro concluído (check), cada um com o modelo em que roda](docs/img/subagent-list.png)

O DSH não registra resultado de subagente (o catálogo dele só sabe "rodando" e "não rodando"), então a metade
do host registra um. Ela escuta os eventos `subagent/start` e `subagent/end` do DSH, que todo filho em
processo emite qualquer que seja a ferramenta que o iniciou, e guarda o modelo, o estado e o motivo de parada
da última execução de cada filho em `<stateDir>/subagents.json` (só do dono, os 2000 mais recentes). A página
lê isso de `GET /dsh-orquestrator/subagents?sessionId=<id>`, atrás da mesma cerca de confiança da rota de
configuração. Um filho que rodou antes da 0.8.0, ou enquanto o plugin não estava carregado, não tem registro:
a linha dele mostra o modelo que o próprio DSH conhece, quando conhece, e um ponto cinza, nunca um "concluído"
inventado.

O modelo numa linha é o que o próprio DSH informa para a sessão do filho (`lastUsed`), quando há um, e senão o
que o host gravou quando a execução começou. O host só consegue corrigir o que gravou, no fim da execução, num
filho de uma execução só (*one-shot*): o DSH libera um filho *continuable* (o que as ferramentas `subagent` e
`subagent_fork` do preset padrão iniciam por padrão) antes de anunciar o fim, então o agente já não existe, e o
registro guarda a rota pedida no início da execução. O estado e o motivo de parada continuam registrados.

O dropdown do DSH não pode ser estendido por um slot, então a metade da página decora as linhas por fora: ela
observa o menu, descobre qual filho cada linha é a partir do próprio estado de sessões do DSH e acrescenta dois
elementos pequenos à linha. É fail-open (qualquer coisa inesperada deixa a linha do DSH como está), lê só
papéis e estrutura, nunca nomes de classe, e remove tudo o que acrescentou quando o plugin descarrega. A
estrutura do DSH de que ela depende é fixada nos testes de contrato.

## Configuração

Tudo é opcional; sem configuração o plugin não faz nada até um usuário confirmar o diálogo.
Coloque as alterações no `cordis.patch.yml` do seu perfil (um patch substitui o `config`
inteiro da linha):

```yaml
- id: orquestrator
  config:
    # Sessões headless/TUI/SDK não têm diálogo: aplique isto a toda sessão.
    defaults:
      subagentModel: { provider: azure-opencode, model: DeepSeek-V4.1-Flash }
      workerEffort: medium           # opcional; ausente = o nível recomendado para o modelo
    effort:                        # teto do esforço de raciocínio de todo subagente; false desliga
      worker: medium
    limits:                        # tokens de saída por requisição ao modelo, raciocínio incluído; false = sem limite
      workerMaxTokens: 64000
    children:                      # o guarda de início; false desliga o enforcement (o diálogo ainda guarda escolhas)
      explicitModel: override      # override | keep: um modelo que o chamador nomeia, ex.: agent({ model }) num script de workflow
    skill:                         # a skill global de orquestração; false = não registrar (o diálogo fica sem o checkbox)
      modelInvocable: true         # listá-la no catálogo de skills do modelo; false = só o token /orchestrate-subagents a carrega
    persist: true                  # lembrar as escolhas e os resultados dos subagentes entre reinícios
    stateDir: /home/eu/.dsh/dsh-orquestrator   # caminho absoluto: "~" não é expandido
    maxSessions: 500               # sessões guardadas antes de podar as mais antigas
```

Campos da 0.4 e anteriores que eram do revisor (`tools`, `reviewerProvider`, `reviewerContext`,
`structuredVerdict`, `workerHandoff`, `maxWorkerReportChars`, `retryOnTokenLimit`, `workspaceChecks`,
`sensitivePaths`, `defaults.reviewer`, `effort.reviewer`, `limits.reviewerMaxTokens`) são ignorados
com um aviso no log do DSH, então um arquivo de patch existente continua carregando.

### Esforço de raciocínio

O DSH resolve as opções de um filho a partir do pai, e quando a rota muda sem um esforço ele limpa
o nível do pai para que o novo modelo "resolva o próprio padrão". Em configurações cujas rotas dizem
`reasoning: max`, isso significa que todo filho re-roteado pensa em `max`, com o teto de saída
inteiro declarado pela rota (131K a 943K tokens nas rotas em que isto foi construído) como limite.

Por isso o plugin pergunta ao DSH a escada do próprio modelo e aplica um **teto**, nunca um valor
fixo: uma rota que já está no teto ou abaixo dele é deixada como está, e uma escada que pula degraus
(o GLM 5.3 oferece `low`, `high`, `max`) recebe o degrau mais alto que não passa do teto. `off`
nunca é escolhido sozinho. O teto é, nesta ordem: o nível escolhido no diálogo (pode ficar acima do
teto), `effort.worker`, a linha do modelo em [`src/models.ts`](src/models.ts) (datada, com as fontes)
e `medium`.

| Modelo | Teto do subagente |
| --- | --- |
| DeepSeek V4.1 Flash | `medium` |
| MiMo-V2.6-Pro | `low` |
| GLM 5.3 / GLM 5.3 Flash | `high` |
| Claude Sonnet / Opus | `high` |
| Qualquer outro | `medium` |

`limits` limita os tokens de saída de uma única requisição ao modelo (raciocínio incluído) e só
reduz um teto que o modelo sabidamente tem. Por que estes números, e quais recomendações dos estudos
ficaram de fora e por quê: [docs/estudos/](docs/estudos/README.md).

## Limites

- **A skill de orquestração é uma instrução, não uma imposição.** O modelo, o teto de esforço e o limite de
  tokens são impostos em código; a skill pede ao modelo que divida, paralelize, delegue a leitura e verifique, e
  um modelo pode ignorá-la, sobretudo no fim de uma conversa longa. Ela não bloqueia ferramenta nenhuma (o
  agente principal ainda pode ler e editar arquivos), e só o agente principal a recebe: os subagentes veem
  apenas os briefings que o agente principal escreve, e por isso a skill manda o agente principal pôr neles o
  formato de relatório e as regras do verificador. A cada vez que o checkbox está marcado o texto da skill
  (cerca de 1.800 tokens) é injetado de novo, então desmarque numa continuação curta.
  **Orquestrar custa tempo e tokens.** Numa execução medida (uma amostra por braço, GLM 5.3 como agente
  principal) uma tarefa de três arquivos levou 374 s e cerca de 1,08 milhão de tokens registrados com a skill
  (um plano, dois escritores em paralelo, uma rodada de reparo, um verificador independente), contra 9,5 s e 88
  mil tokens para o agente principal fazendo o mesmo sozinho; os dois terminaram corretos. A skill compensa
  quando a tarefa é grande o bastante para paralelizar e para precisar de uma conferência independente;
  desmarque o checkbox nas pequenas.
- **O estado de um subagente só é conhecido para filhos que iniciaram com o plugin carregado.** Os mais
  antigos mostram o modelo que o DSH conhece para eles e um ponto cinza. Depois de atualizar o plugin,
  reinicie o `dsh` e recarregue a página: uma página carregada antes de o host ter a rota nova pediu-a uma vez,
  recebeu 404 e não pede de novo (até ser recarregada); as linhas então mostram um spinner para um filho que o
  DSH diz estar rodando, um ponto cinza para os demais e o modelo que o DSH conhece para cada um. Um filho de um backend sem sessão
  própria (`acp`, `codex`, `claude-code`) nem aparece no dropdown do DSH, então não tem linha para marcar. Um
  filho cancelado aparece como parado, e qualquer outro fim que não seja uma conclusão normal, como falhou.
- **As marcas nas linhas do dropdown são acrescentadas por fora do componente fechado do DSH.** Elas dependem
  dos papéis e da estrutura dele (um menu `role="tree"` no corpo da página, linhas `role="treeitem"`, a bolinha
  de estado e o span de conteúdo), que os testes de contrato fixam contra um checkout do DSH; quando o DSH os
  muda, as marcas somem e as linhas do DSH ficam como estavam. Qual filho uma linha é vem de casar a linha com
  o estado de sessões do DSH (o número de linhas e o rótulo e o título de cada uma, em ordem). Quando dois
  catálogos servem igualmente bem ao mesmo menu (duas conversas na página cujos subagentes têm rótulos e
  títulos idênticos), o plugin não marca nada em vez de adivinhar, então um menu nunca é decorado com os
  filhos de outra conversa.
- **O plugin controla qual modelo roda e o quanto ele pensa. Não confere o que um subagente
  produz.** O agente principal lê o resultado como o DSH sempre entregou; se você quer uma conferência,
  marque a skill de orquestração (ela manda o agente principal verificar cada parte com um subagente
  verificador à parte, o que é uma instrução, veja acima), peça ao agente principal que verifique, ou rode os
  testes do próprio projeto. (Um revisor independente fazia isso em código; veja
  [abaixo](#por-que-o-revisor-foi-removido).)
- Provedores que não aceitam opções de agente (`codex`, `claude-code`, ACP) mantêm os modelos em que
  rodam; o plugin avisa no log (uma vez por provedor) e não toca nos filhos deles. Um provedor que
  roda uma rota padrão própria (o provedor SDK) é deixado em paz quando nenhum modelo de subagente é
  escolhido, porque o plugin não tem como saber em que o filho dele roda.
- **O limite de tokens de saída não é durável para filhos `continuable`.** Quando o DSH retoma
  depois um filho já terminado (uma mensagem de acompanhamento depois que ele liberou o filho, ou
  depois de um reinício) ele reconstrói as opções do filho a partir do descritor gravado, que guarda
  provedor, modelo e esforço, mas não o limite de tokens. O teto de esforço sobrevive; o limite vale só
  para a primeira rodada. Corrigir exige outro ponto de apoio (veja
  [decisoes.md](docs/estudos/decisoes.md), N21).
- Um modelo que o agente principal nomeia numa chamada `subagent` (a seleção de modelo do DSH, ligada
  no preset padrão) é ignorado enquanto há uma escolha confirmada; `override` aplica a mesma regra a
  todo outro chamador. Um limite de tokens que um chamador define (uma linha de ferramenta do
  operador, a escala de um time) nunca é elevado: vale o menor entre o do chamador e o do plugin.
- Campos desconhecidos no nível raiz da configuração são ignorados com um aviso no log do DSH (um
  `explicitModel: keep` com indentação errada rodaria como `override`).
- O DSH não tem gancho em volta do início de um filho (`subagent/start` dispara depois que o filho
  existe), então o guarda instala o próprio `start` e `startContinuable` na instância do serviço. Os
  testes de contrato (`test/contract/`) fixam essa premissa contra um checkout do DSH e um
  `SubagentRuntime` real, e falham primeiro quando o DSH a muda. Eles rodam numa máquina que tem um
  checkout do DSH (`DSH_CHECKOUT`), não no CI. Se o serviço não puder ser embrulhado, o plugin falha ao
  carregar; nunca funciona pela metade. `children: false` tira o guarda.
- O teto de esforço de raciocínio e o limite de tokens valem para os filhos que o plugin governa,
  nunca para o agente principal. Um modelo que o runtime de LLM não consegue descrever mas consegue
  chamar mantém exatamente as opções que o usuário escolheu (o log diz isso); um que ele não consegue
  chamar é rejeitado, como descrito acima.
- O conselho sobre modelos no diálogo (notas, tetos) é dado datado de estudos de setembro e outubro
  de 2026 e envelhece em semanas; um modelo que ele não conhece recebe o teto genérico e nenhuma nota.
- As strings em português e chinês vêm como dicionários. Aparecem quando o DSH (ou outro plugin)
  registrou esse idioma; este plugin nunca registra um idioma, para não colidir com o plugin que o possui.

## Modelo de segurança

O plugin não executa código dos subagentes e não inicia nenhum processo próprio. Ele só muda as opções
com que o DSH inicia um filho. O que faz: serve duas rotas (a rota de configuração e a rota de leitura dos
subagentes) atrás da cerca de confiança do DSH (cerca de Host/Origin e autenticação do navegador) com
validação estrita do formato, guarda o estado em arquivos só do dono, que contêm ids de provedor e de
modelo, estados e motivos de parada e nenhuma credencial (as escolhas por sessão e o livro-razão dos
subagentes), escuta só para ler os eventos de ciclo de vida dos subagentes do DSH, registra um texto de
skill estático no registro de skills do DSH, e nunca lê, grava nem repassa chaves de API. O que **não**
faz: não oferece sandbox, não filtra rede e não controla o ambiente dos processos. O que os subagentes
podem fazer é decidido pelo preset de permissão da sessão, exatamente como sem o plugin. A skill acrescenta
instruções a uma mensagem; não concede permissão nenhuma.

## Por que o revisor foi removido

As versões 0.2 a 0.4 também ofereciam um revisor independente: um segundo modelo que conferia o
trabalho de cada subagente, corrigia o que estivesse quebrado e entregava o resultado ao agente
principal no lugar do subagente. A versão 0.5.0 o removeu, por três motivos:

1. **Era uma LLM julgando outra LLM.** O que o plugin impõe em código (qual modelo roda, o quanto pensa,
   quanto pode escrever) é determinístico, e o agente principal não o contorna. Um `APPROVED` do revisor
   é uma opinião, e o plugin só conseguia conferir o formato e a coerência dele.
2. **Custava cerca do dobro e fazia cada delegação esperar um segundo modelo**, e cobria duas das
   formas pelas quais o DSH inicia filhos, não os agentes de um workflow.
3. **Exigia um segundo mecanismo.** O revisor precisava embrulhar as ferramentas `subagent`; o guarda de
   início sozinho já governa todo caminho (verificado ao vivo, com o embrulho fora do caminho), então
   manter os dois era manter dois jeitos de chegar ao mesmo resultado.

Os estudos, o protocolo do revisor e as decisões por trás dele ficam no repositório como história:
[docs/estudos/](docs/estudos/README.md), [docs/pesquisa/padrao-revisor.md](docs/pesquisa/padrao-revisor.md)
e a decisão D16 em [docs/estudos/decisoes.md](docs/estudos/decisoes.md). A versão 0.4.0 é a última que o tem.

## Verificado

A versão 0.8.0 foi validada de ponta a ponta num DSH 0.1.6-alpha.2 real, com todas as execuções no Mac mini de
testes do projeto, dentro de um DSH home isolado, só com GLM 5.3 (agente principal) e DeepSeek V4.1 Flash
(subagentes): 841 testes de unidade, integração e contrato, duas vezes (804 sem um checkout do DSH, o que o CI
roda), com rebuild byte-idêntico em duas máquinas; 127 verificações de navegador do diálogo e do checkbox da
skill, incluindo o comportamento de fio contra um host 0.7 e uma mensagem dirigida à conversa própria de um
subagente; 146 verificações das marcas da lista de subagentes em 20 páginas, com todos os estados conduzidos
pela rota do livro-razão e uma execução real de dois subagentes (do spinner ao check, livro-razão coerente com
os logs); as cinco fases de navegador anteriores voltaram verdes; e uma execução A/B com modelos reais medindo o
que a skill muda (o agente principal orquestrando dois escritores e um verificador independente em vez de fazer
o trabalho ele mesmo, a 39x o tempo e 12x os tokens numa tarefa de três arquivos). O texto da skill foi testado
sob pressão em quatro tarefas imaginadas e verificado afirmação a afirmação contra o código do DSH antes de sair,
e três revisões independentes de código corrigiram um bloqueio pré-existente do diálogo e diversos defeitos de
casamento, temporização e ficheiros hostis achados por experiências adversariais. Evidências e achados, inclusive
o que não foi coberto: [docs/validation/README.md](docs/validation/README.md) (em inglês).

## Desenvolvimento

```sh
pnpm install
pnpm run check          # typecheck + build + testes
pnpm run check:lib      # o lib/ commitado deve ser igual a um build novo (rode depois de commitar o lib/)
DSH_CHECKOUT=/caminho/do/deepseek-harness pnpm test   # também fixa os pontos do DSH que este plugin usa
```

A validação ao vivo contra um DSH real usa só os três modelos-alvo e falha se qualquer outro rodar:
`scripts/e2e/run-workflow.sh` (as ferramentas `workflow`, `subagent` e `subagent_fork` e o guarda de
início, por linha de comando), com `session-config.mjs` lendo de volta o que cada sessão foi instruída
a fazer, e `scripts/e2e/ui-e2e.mjs` (navegador). `scripts/e2e/setup-isolated-home.sh` monta o
`DSH_HOME` isolado que eles esperam e `scripts/e2e/with-keys.sh` os executa só com as duas chaves de
API de que os três modelos precisam. Veja [docs/validation/README.md](docs/validation/README.md).

Estrutura: `src/` (host), `src/client/` (navegador), `test/` (unitário, integração,
contrato), `scripts/e2e/` (execuções por linha de comando e no navegador contra um DSH real),
`docs/` (projeto, validação e `estudos/`: os estudos, a síntese deles e o registro de decisões).

## Licença

MIT
