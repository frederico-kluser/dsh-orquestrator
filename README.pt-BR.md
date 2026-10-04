# dsh-orquestrator

[![ci](https://github.com/frederico-kluser/dsh-orquestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/frederico-kluser/dsh-orquestrator/actions/workflows/ci.yml)
[![licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg)](LICENSE)

Plugin para o [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). Quando você envia
uma nova tarefa, um diálogo no visual padrão do DSH pergunta duas coisas:

1. Os **subagentes devem usar outro modelo** que não o selecionado para o agente principal?
2. Um **revisor independente deve validar o trabalho de cada subagente**, e em qual modelo?

Com o revisor ligado, ele começa assim que o subagente termina. O subagente **não**
entrega o trabalho ao agente principal; quem entrega é o revisor. Ele executa ou
cria testes para validar o trabalho, corrige apenas o que estiver realmente quebrado e
entrega o relatório final.

**Cancelar, Esc e o botão de fechar enviam a tarefa exatamente como o DSH sempre fez.**
Nada mais no DSH muda.

A escolha vale para **todo filho que o DSH inicia naquela sessão**, não só para as ferramentas
`subagent`: os agentes que um `workflow` inicia, as rodadas do `ralph`, jobs `subagent` one-shot em
segundo plano e times de agentes também rodam no modelo dos subagentes, sob os mesmos tetos. O
revisor atua nas delegações de `subagent` e `subagent_fork`. Veja
[Quais delegações são cobertas](#quais-delegações-são-cobertas).

Todo filho governado desse jeito também recebe um **teto de esforço de raciocínio** e um limite de
tokens de saída, porque o DSH, por padrão, roda um filho re-roteado no padrão da rota dele (`max`
em muitas configurações): a causa de trabalhadores que queimam o orçamento inteiro num caso de
borda e de revisores que levam minutos por turno. Veja [Esforço de raciocínio](#esforço-de-raciocínio).

| Escuro | Claro |
| --- | --- |
| ![Diálogo, tema escuro](docs/img/modal-dark.png) | ![Diálogo, tema claro](docs/img/modal-light.png) |

As duas seções abertas, com os modelos escolhidos na lista do próprio compositor:

![Diálogo com modelo de subagente e de revisor escolhidos](docs/img/modal-filled.png)

> English: [README.md](README.md)

## Instalação

```sh
dsh plugin --profile web add github:frederico-kluser/dsh-orquestrator
dsh --profile web            # reinicie para servir o bundle do navegador
```

A partir de um clone local: `dsh plugin --profile web add /caminho/para/dsh-orquestrator`.

Testado no **DSH 0.1.6-alpha.2** (Node 24, pnpm 11). O `lib/` commitado é a saída do
build, então a instalação não precisa compilar nada.

## Uso

Digite uma tarefa no compositor e envie. O diálogo aparece uma vez por tarefa nova:

- **Modelo dos subagentes**: ligue e escolha um modelo na mesma lista agrupada por
  provedor que o seletor de modelo do compositor usa. Vale para todo subagente, inclusive os
  agentes que um workflow inicia. Desligado, os subagentes mantêm o modelo do agente principal.
- **Revisor independente**: ligue e escolha o modelo dele (padrão: o do subagente).
  Ele revisa as delegações de `subagent` e `subagent_fork`; os agentes que um workflow inicia
  usam o modelo dos subagentes, mas não são revisados, porque o script do workflow consome os
  resultados deles (o diálogo avisa). Um revisor de outra família de modelos tende a pegar erros diferentes, e o diálogo
  avisa quando os dois são o mesmo modelo (com qualquer grafia de provedor) ou da mesma
  família de fornecedor. Também mostra notas curtas e datadas para modelos que precisam
  delas (por exemplo: a API própria da DeepSeek agora serve o `deepseek-v4-pro` com o V4.1
  Flash; o MiMo-V2.6-Pro pode levar minutos por turno em esforço alto; o GLM 5.3 só lê texto).
- **Esforço de raciocínio** (recolhido): quanto cada modelo pode pensar. O padrão é o nível
  recomendado para o modelo; abra para ver ou mudar.
- **Não existe "não perguntar de novo"**: o modal aparece em TODA a tarefa nova e nada
  o silencia — uma resposta nunca o esconde da próxima tarefa nem de outra conversa.
  A última escolha confirmada apenas pré-preenche o diálogo.
- **Cancelar / Esc / ✕**: envia a tarefa com o comportamento padrão e esquece qualquer
  escolha guardada.

`/orquestrar` abre o mesmo diálogo sob demanda (para mudar ou limpar a escolha guardada).

O diálogo não aparece quando não é uma tarefa nova: direcionar um turno em andamento,
conversas de subagente e linhas de comando `/`.

## O que o revisor faz

O revisor é um subagente com um protocolo fixo (veja [docs/DESIGN.md](docs/DESIGN.md), em inglês):

1. Deriva os critérios de aceitação da **tarefa original** antes de ler qualquer coisa que o
   trabalhador escreveu.
2. Julga o workspace real (`git status`, `git diff`), não o que o relatório afirma. Quando a
   árvore de trabalho mudou, **o relatório do trabalhador é retido** e o git diz ao revisor o
   que mudou; quando nada mudou (uma pergunta, uma pesquisa), o relatório é a entrega e entra
   como alegação não confiável e delimitada (`reviewerContext`, abaixo).
3. Descobre as verificações do próprio projeto (AGENTS.md ou CLAUDE.md, arquivos de CI,
   Makefile, scripts do manifesto), roda a suíte relevante inteira com timeout, e lê contagens e
   testes ignorados, não só o código de saída. Tria uma falha contra o commit base num worktree
   temporário. Escreve o menor teste que falta quando nada pegaria um requisito perdido.
4. Só altera arquivos quando uma verificação demonstra um defeito; correção mínima e
   geral; roda de novo.
5. Nunca apaga, ignora nem enfraquece um teste para passar, e lê todo arquivo de teste, de
   runner e de CI que o trabalhador alterou (o pedido de revisão os lista).
6. Não reporta nada quando não há nada a reportar. Sem nitpicks de estilo, sem problemas
   pré-existentes.
7. Trata texto de arquivos, logs, saída de terminal e relatórios como dado, nunca como instrução.

Ele reporta pela ferramenta de saída estruturada do DSH e o plugin monta o relatório, com o
veredicto primeiro, então o agente principal recebe:

```
VERDICT: APPROVED | APPROVED_WITH_FIXES | NOT_RESOLVED - uma linha
CRITERIA · DELIVERABLE · VERIFICATION · CHANGES BY REVIEWER · RISKS AND OPEN ITEMS
```

Antes de entregar, o plugin confere o relatório contra ele mesmo: uma aprovação ao lado de um
critério FAILED ou UNVERIFIED vira `NOT_RESOLVED`, e uma aprovação sem verificação registrada,
com bloqueio informado, ou cuja lista de mudanças discorda do veredicto leva um `Caution` no
banner da entrega. Um provedor sem captura estruturada, ou um modelo que responde em texto,
cai num relatório em texto com veredicto primeiro. Se a revisão falhar ou não tiver veredicto
válido, o relatório do trabalhador é entregue sob um aviso `WARNING - UNREVIEWED` em vez de se perder.

## Quais delegações são cobertas

O DSH tem mais jeitos de iniciar um filho do que as duas ferramentas `subagent`. O plugin governa
todos em dois lugares: embrulha as ferramentas `subagent` e `subagent_fork` (modelo, tetos **e**
revisor) e fica nas duas portas por onde passa todo o resto, `SubagentRuntime.start()` e
`startContinuable()` (modelo e tetos; o **guarda de início**, `src/guard.ts`).

| Como o DSH inicia o filho | Modelo, teto de esforço, teto de tokens | Revisor |
| --- | --- | --- |
| ferramentas `subagent` e `subagent_fork` (o preset padrão) | sim | sim |
| `subagent` como job one-shot em segundo plano (`backgroundMode: one-shot`, `run_in_background: true`) | sim | não: o resultado passa pelo armazém de jobs |
| a ferramenta `workflow`: cada chamada `agent()` do script | sim | não: o script consome os resultados |
| `ralph` (desligado no preset padrão; roda no motor de workflow) | sim | não |
| times de agentes (experimental) | sim | não |
| provedores `codex`, `claude-code` e ACP | não: rodam os próprios agentes nos próprios modelos e não aceitam opções de agente (o plugin registra um aviso, uma vez por provedor) | não |
| o provedor SDK do DSH (um runtime-filho DSH separado) | sim quando um modelo de subagente é escolhido (aceita a rota, o esforço e o limite de tokens); com só um revisor escolhido, o filho dele mantém o modelo próprio do provedor | não |

O que foi executado ao vivo, nos três modelos-alvo: a ferramenta `subagent` (em primeiro plano, com o
revisor, e em segundo plano) e a ferramenta `workflow` (com o `override` padrão, com `keep` e com o
guarda desligado). As outras linhas decorrem das portas que elas usam, que os testes de contrato fixam
contra o código-fonte do DSH (o `ralph` roda no motor de workflow, um job one-shot e o time chamam
`start` / `startContinuable`, o provedor SDK aceita opções de agente); nenhuma execução ao vivo usou um
job one-shot em segundo plano, o `ralph`, um time de agentes, o provedor SDK nem `codex` / `claude-code` / ACP.

Por que um segundo mecanismo: o embrulho das ferramentas nunca via os agentes de uma chamada
`workflow`, porque o motor os inicia pelo próprio serviço. Na sessão que expôs o problema, 34
agentes de workflow rodaram no Claude Sonnet 5.5 em `max` (cerca de 7,2 milhões de tokens de saída e
1,26 bilhão de tokens de leitura de cache), embora o DeepSeek V4.1 Flash estivesse confirmado para
os subagentes. As versões 0.3 e anteriores têm esse furo; [a página de validação](docs/validation/README.md)
(em inglês) o reproduz num DSH isolado e mostra o furo fechado.

O que um filho governado recebe é o que a ferramenta `subagent` dá aos seus trabalhadores: o modelo
que o usuário escolheu, o esforço que o usuário escolheu (ou o teto do modelo) e o limite de tokens
de saída. O agente principal nunca é tocado, e uma sessão sem escolha confirmada também não.

Se o modelo que você confirmou deixou de existir (renomeado ou removido das configurações do DSH depois
de confirmado), o início do filho é rejeitado com uma mensagem que diz isso e o que fazer (`/orquestrar`,
ou cancelar o diálogo). As alternativas são piores: rodar o filho no modelo do agente principal é o bug
que esta versão corrige, e forçar a rota morta faz todo agente do workflow falhar num `null` silencioso.

Um modelo que o próprio chamador nomeia (`agent({ provider, model })` num script de workflow) perde
para a escolha do usuário por padrão (`children.explicitModel: override`): o diálogo é a instrução
explícita do usuário. `keep` deixa o modelo do chamador valer, sob os mesmos tetos. Quando o usuário
escolheu só um revisor (nenhum modelo de subagente), os filhos ficam no modelo do agente principal,
sob os tetos, e um modelo que o script nomeia vale.

## Configuração

Tudo é opcional; sem configuração o plugin não faz nada até um usuário confirmar o
diálogo. Ajustes vão no `cordis.patch.yml` do seu perfil (um patch substitui o `config`
inteiro da linha):

```yaml
- id: orquestrator
  config:
    # Sessões headless/TUI/SDK não têm diálogo: aplique isto a toda sessão.
    defaults:
      subagentModel: { provider: azure-opencode, model: DeepSeek-V4.1-Flash }
      workerEffort: medium           # opcional; ausente = o nível recomendado para o modelo
      reviewer:
        enabled: true
        model: { provider: openrouter-extra, model: xiaomi/mimo-v2.6-pro }
        effort: medium               # opcional
    reviewerProvider: spawn        # provedor de subagente que roda o revisor
    reviewerContext: auto          # auto | isolated | claims  (veja abaixo)
    structuredVerdict: true        # reporta pela saída estruturada do DSH quando o provedor tem
    effort:                        # teto de esforço de raciocínio por papel; false desliga
      worker: medium
      reviewer: medium
    limits:                        # tokens de saída por requisição, raciocínio incluído; false = sem teto
      workerMaxTokens: 64000
      reviewerMaxTokens: 32000
    retryOnTokenLimit: true        # repete o trabalhador uma vez, um nível abaixo, após parar por tokens
    workspaceChecks: true          # tira impressões da árvore com git em torno de delegações revisadas
    sensitivePaths: ['db/migrations/**']   # arquivos extras que o revisor deve examinar quando mudarem
    workerHandoff: true            # pede ao trabalhador um relatório curto (a entrega de reserva o usa)
    maxWorkerReportChars: 60000    # relatório do trabalhador mantido íntegro no pacote
    persist: true                  # lembra escolhas entre reinícios
    stateDir: ~/.dsh/dsh-orquestrator
    maxSessions: 500               # sessões guardadas antes de podar as mais antigas
    tools:                         # quais ferramentas de delegação são orquestradas (modelo, tetos e revisor)
      - { name: subagent,      provider: spawn, mode: continuable }
      - { name: subagent_fork, provider: fork,  mode: continuable }
    children:                      # todo outro filho que o DSH inicia (workflow, ralph, jobs, times); false governa só `tools`
      explicitModel: override      # override | keep: modelo que o próprio chamador nomeia, ex.: agent({ model }) num script de workflow
```

### Esforço de raciocínio

O DSH resolve as opções de um filho a partir do pai e, quando a rota muda sem um esforço, apaga o
nível do pai para que o novo modelo "resolva o próprio padrão". Em configurações cujas rotas dizem
`reasoning: max`, isso significa que todo filho re-roteado pensa em `max`, com o teto de saída
declarado da rota (de 131 mil a 943 mil tokens nas rotas em que isto foi construído) como limite.

Por isso o plugin pergunta ao DSH a escada do próprio modelo e aplica um **teto**, nunca um valor:
uma rota que já está no teto ou abaixo fica como está, e uma escada que pula degraus (o GLM 5.3
oferece `low`, `high`, `max`) recebe o degrau mais alto que não passa do teto. `off` nunca é
escolhido sozinho. O teto vem, em ordem: do nível escolhido no diálogo (pode ficar acima do teto),
de `effort.worker` / `effort.reviewer`, da linha do modelo em [`src/models.ts`](src/models.ts)
(datada, com as fontes) e de `medium`.

| Modelo | Teto do subagente | Teto do revisor |
| --- | --- | --- |
| DeepSeek V4.1 Flash | `medium` | `low` |
| MiMo-V2.6-Pro | `low` | `medium` |
| GLM 5.3 / GLM 5.3 Flash | `high` | `low` |
| Claude Sonnet / Opus | `high` | `high` |
| Qualquer outro | `medium` | `medium` |

`limits` limita os tokens de saída de uma única requisição (raciocínio incluído) e só reduz um
teto que o modelo comprovadamente tem. Por que esses números, e quais recomendações dos estudos
ficaram de fora e por quê: [docs/estudos/](docs/estudos/README.md).

### O que o revisor vê (`reviewerContext`)

| Modo | Comportamento |
| --- | --- |
| `auto` (padrão) | A árvore de trabalho é fotografada com git antes e depois do trabalhador. Se mudou, o revisor recebe a tarefa e os fatos medidos e **não** o relatório do trabalhador. Se não mudou, ou o git não sabe dizer, recebe o relatório como alegação não confiável. |
| `isolated` | O relatório do trabalhador nunca é entregue. |
| `claims` | O relatório é sempre entregue, delimitado como dado não confiável. |

## Limites

- **O revisor não atua nos agentes que um workflow inicia, nem em jobs `subagent` one-shot em
  segundo plano.** Um script de workflow consome os resultados dos agentes dele (muitas vezes como
  dados validados por esquema) e um job entrega pelo armazém de jobs, então trocar por um relatório
  quebraria os dois. Esses filhos recebem o modelo e os tetos; mantenha uma fase de verificação no
  workflow, ou rode a checagem como uma chamada `subagent`.
- Provedores que não aceitam opções de agente (`codex`, `claude-code`, ACP) mantêm os modelos em
  que rodam; o plugin registra um aviso (uma vez por provedor) e não toca nos filhos deles. Um provedor
  que roda uma rota padrão própria (o provedor SDK) é deixado em paz quando nenhum modelo de subagente
  é escolhido, porque o plugin não sabe em que o filho dele roda.
- **O teto de tokens de saída não é durável para filhos `continuable`.** Quando o DSH retoma depois um
  filho já terminado (uma mensagem de acompanhamento depois que ele liberou o filho, ou após um
  reinício), ele reconstrói as opções do filho a partir do descritor gravado, que guarda provedor,
  modelo e esforço, mas não o limite de tokens. O teto de esforço sobrevive; o limite vale só para a
  primeira execução. Corrigir pede outra costura (veja [decisoes.md](docs/estudos/decisoes.md), N21).
- Um modelo que o agente principal nomeia numa chamada `subagent` (a seleção de modelo do DSH, ligada
  no preset padrão) é ignorado enquanto houver escolha confirmada, como sempre foi; o `override` aplica
  a mesma regra a todo outro chamador. Um limite de tokens que o chamador define (a linha de ferramenta
  de um operador, a lista de um time) nunca é elevado: vale o menor entre o do chamador e o do plugin.
- Campos de configuração de nível superior desconhecidos são ignorados com um aviso no log do DSH (um
  `explicitModel: keep` mal indentado rodaria, em silêncio, como `override`).
- O DSH não tem gancho em volta do início de um filho (`subagent/start` dispara depois que o filho
  existe), então o guarda de início instala `start` e `startContinuable` próprios na instância do
  serviço. Os testes de contrato (`test/contract/`) fixam essa premissa contra um checkout do DSH e
  um `SubagentRuntime` real, e falham primeiro quando o DSH a muda. Se o serviço não puder ser
  embrulhado, o plugin falha ao carregar; nunca funciona pela metade. `children: false` retira o guarda.
- O teto de esforço e o limite de tokens valem para os filhos que o plugin governa, nunca para o
  agente principal. Um modelo que o runtime de LLM não consegue descrever, mas consegue chamar,
  mantém exatamente as opções que o usuário escolheu (o log avisa); um que ele não consegue chamar
  é rejeitado, como descrito acima.
- A revisão em contexto limpo precisa de `git` e de um repositório. Dois trabalhadores editando a
  mesma árvore ao mesmo tempo podem borrar a lista de mudanças um do outro; o plugin então erra
  para o lado de entregar o relatório, que é o que a versão 0.1 sempre fez.
- A nova tentativa após parar por tokens cobre os caminhos em primeiro plano (uma delegação
  revisada, ou uma chamada one-shot só de modelo). Um filho `continuable` só de modelo é
  conduzido pelo DSH, não pelo plugin.
- Relatórios estruturados precisam de um provedor de subagente com a capacidade `outputSchema` do
  DSH (o `spawn` tem). Sem ela, o revisor responde em texto com veredicto primeiro.
- O revisor precisa de um provedor de subagente com modelo e persona por filho (o `spawn`
  tem). Caso contrário a revisão é pulada e o relatório do trabalhador é entregue como
  `UNREVIEWED`.
- As notas do diálogo sobre modelos (notas, tetos) são dados datados de estudos de setembro e
  outubro de 2026 e envelhecem em semanas; um modelo que ela não conhece recebe o teto genérico
  e nenhuma nota.
- Português e chinês vão como dicionários. Aparecem quando o DSH (ou outro plugin) já
  registrou o idioma; este plugin nunca registra um idioma sozinho, para não colidir com
  o plugin que o possui.
- A pesquisa por trás do revisor cobre estudos de 2022 a 2026, em sua maioria com modelos
  de 2023 e 2024, e nenhum estudo mede um revisor posterior que teste e corrija ao mesmo
  tempo. O protocolo é informado por evidência, não uma receita validada:
  [docs/pesquisa/padrao-revisor.md](docs/pesquisa/padrao-revisor.md).

## Modelo de segurança

O revisor **executa o código do trabalhador** (testes, build, scripts) com o preset de permissão
da sessão. É assim que ele verifica o trabalho, e também o principal risco do desenho: um hook do
runner de testes, um log envenenado ou um script de dependência roda com os seus direitos.

O que o plugin faz: delimita e higieniza tudo o que põe no pedido de revisão (sequências de escape
de terminal, caracteres de controle e de sobreposição bidirecional são removidos; as próprias tags
dele não podem ser forjadas), lista os arquivos de teste, de runner e de CI que o trabalhador
alterou, manda o revisor tratar a saída de terminal como hostil e nunca ler nem enviar variáveis de
ambiente, credenciais ou arquivos fora do workspace, monta o veredicto ele mesmo a partir de um
relatório validado por esquema, guarda o estado num arquivo só do dono, sem credenciais, e serve a
única rota atrás da cerca de confiança do DSH com validação estrita.

O que **não** faz: não oferece sandbox, não filtra rede e não controla o ambiente do processo.
`APPROVED` quer dizer "as verificações que o revisor achou e rodou passaram onde ele as rodou", não
"seguro". Para qualquer coisa crítica (migrações, deploys, credenciais) mantenha uma decisão humana
depois da revisão, e dê às sessões de revisão um preset de permissão sem rede nem segredos. O modelo
de ameaças por trás disso está em
[docs/estudos/fontes/E12-modelo-de-ameacas-do-revisor.md](docs/estudos/fontes/E12-modelo-de-ameacas-do-revisor.md);
o que o plugin respondeu e recusou está em [docs/estudos/decisoes.md](docs/estudos/decisoes.md)
(D07 a D09, D14, N02 a N04).

## Por que a versão 0.2 mudou

Dezesseis estudos (setembro a outubro de 2026) foram lidos contra o código do DSH, dados públicos e as
execuções do próprio plugin. [docs/estudos/](docs/estudos/README.md) guarda os estudos byte a byte, a
leitura cruzada ([sintese.md](docs/estudos/sintese.md)) e o registro de decisões, com o porquê de
cada mudança e de cada recomendação **não** adotada ([decisoes.md](docs/estudos/decisoes.md)).

## Verificado

A versão 0.2.0 foi validada num DSH 0.1.6-alpha.2 real com **apenas três modelos**: GLM 5.3
(agente principal), DeepSeek V4.1 Flash (subagente) e MiMo-V2.6-Pro (revisor), em modo headless e
pelo diálogo num navegador real (57 de 57 verificações de navegador; 259 de 259 testes, 17 deles
fixando internos do DSH). Os logs de sessão mostram os tetos chegando ao fio (DeepSeek `medium` com
64 000 tokens de saída e MiMo `medium` com 32 000, contra `max` com 384 000 e 131 072 quando os tetos
estão desligados), o revisor pegando uma contradição na tarefa e um erro de conta no próprio prompt
do agente principal, e o `reviewerContext: auto` escolhendo o modo certo nos dois sentidos. A página
também diz o que não cobriu (nenhuma parada por limite de tokens foi provocada num modelo real, uma
amostra por condição, só Linux) e que nenhum ganho de velocidade foi medido numa tarefa pequena.
Evidências e achados: [docs/validation/README.md](docs/validation/README.md) (em inglês). A validação
da 0.1.0 num Mac mini continua na mesma página.

## Desenvolvimento

```sh
pnpm install
pnpm run check          # typecheck + build + testes
pnpm run check:lib      # o lib/ commitado deve ser igual a um build novo (rode depois de commitar o lib/)
DSH_CHECKOUT=/caminho/deepseek-harness pnpm test   # também fixa as costuras do DSH usadas
```

A validação ao vivo contra um DSH real usa somente os três modelos-alvo e falha se outro rodar:
`scripts/e2e/run-trio.sh` (a ferramenta `subagent` e o revisor) e `scripts/e2e/run-workflow.sh` (a
ferramenta `workflow` e o guarda de início), ambos headless, com `session-config.mjs` lendo de volta
o que cada sessão recebeu, e `scripts/e2e/ui-e2e.mjs` (navegador). `scripts/e2e/setup-isolated-home.sh`
monta o `DSH_HOME` isolado que eles esperam e `scripts/e2e/with-keys.sh` os executa só com as duas
chaves de API que os três modelos precisam. Veja [docs/validation/README.md](docs/validation/README.md)
(em inglês).

Estrutura: `src/` (host), `src/client/` (navegador), `test/` (unitários, integração,
contrato), `scripts/e2e/` (execuções headless e de navegador contra um DSH real), `docs/` (design,
validação e `estudos/`: os estudos, a síntese deles e o registro de decisões).

## Licença

MIT
