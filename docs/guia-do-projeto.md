# Guia completo do projeto — DeepSeek Harness, o plugin `dsh-orquestrator`, como foi feito e limitações

> **Escopo deste documento.** Esta é a referência completa para quem vai trabalhar neste repositório:
> o que é o DeepSeek Harness, o que é este plugin, como foi construído (arquitetura, decisões, testes,
> validação) e o que ele **não** faz. A última seção traz a especificação proposta do **Modo
> Coordenador Puro** (o checkbox que injeta uma instrução no orquestrador) e as limitações inerentes
> desse modo — é para preparar essa implementação que este guia existe.
>
> Status: o Modo Coordenador Puro foi **implementado na 0.8.0**, na forma de uma *skill global*
> (`orchestrate-subagents`) com um checkbox no diálogo — ver a [seção 6](#6-modo-coordenador-puro-checkbox-especificação-proposta),
> que mantém a especificação original e diz o que mudou. As seções 2 a 5 descrevem o código até a 0.5.1; o que
> entrou depois (0.6.0, 0.7.0, 0.8.0) está na tabela de versões da [3.3](#33-história-em-versões) e no
> [CHANGELOG](../CHANGELOG.md). Fontes primárias: [README.md](../README.md), [DESIGN.md](DESIGN.md),
> [CHANGELOG.md](../CHANGELOG.md), [estudos/](estudos/README.md), [validation/README.md](validation/README.md).

## Índice

1. [Sumário executivo](#1-sumário-executivo)
2. [O DeepSeek Harness (DSH)](#2-o-deepseek-harness-dsh)
3. [O projeto `dsh-orquestrator`](#3-o-projeto-dsh-orquestrator)
4. [Como o plugin foi feito](#4-como-o-plugin-foi-feito)
5. [Limitações do plugin](#5-limitações-do-plugin)
6. [Modo Coordenador Puro (checkbox) — especificação proposta](#6-modo-coordenador-puro-checkbox-especificação-proposta)
7. [Mapa do repositório](#7-mapa-do-repositório)
8. [Referências internas](#8-referências-internas)

---

## 1. Sumário executivo

- **DeepSeek Harness (DSH)** é um *harness* de agente de código aberto da DeepSeek AI, construído
  sobre o Cordis com uma arquitetura "tudo é plugin". É ele que roda o agente principal, as
  ferramentas, os subagentes e a interface web. Está em *developer preview*: mudanças incompatíveis
  entre versões são esperadas.
- **`dsh-orquestrator`** é um plugin para o DSH. Quando o utilizador envia uma nova tarefa, um
  diálogo no aspeto nativo do DSH pergunta: *"os subagentes devem rodar num modelo diferente do
  agente principal?"*. Se sim, o plugin **impõe em código** — não por instrução ao modelo — que
  todo filho que o DSH iniciar use o modelo escolhido, com um **teto de esforço de raciocínio** e um
  **teto de tokens de saída**.
- A imposição vale para **todas as portas** por onde o DSH inicia filhos: as ferramentas `subagent`
  e `subagent_fork`, os agentes que um `workflow` inicia, `ralph`, *jobs* de fundo de uma só
  execução e equipas de agentes. O agente principal não consegue contornar: é a guarda que está nas
  portas (`SubagentRuntime.start()` / `startContinuable()`).
- O plugin **não verifica o conteúdo** do trabalho dos subagentes e **não muda o agente principal**.
  Cancelar o diálogo envia a tarefa exatamente como o DSH sempre fez.
- **Modo Coordenador Puro (feito na 0.8.0, como skill global):** um checkbox no diálogo, marcado por
  padrão, cuja única ação é **pôr o token `/orchestrate-subagents` na mensagem**; o DSH então injeta a skill
  global do plugin, que manda o orquestrador não ler nem escrever código, dividir o trabalho em partes
  pequenas em paralelo, delegar a leitura e a verificação (verificadores à parte) e apenas coordenar.
  Diferente da guarda, isto é **instrução ao modelo** (adesiva por natureza) — ver
  [seção 6](#6-modo-coordenador-puro-checkbox-especificação-proposta). A 0.8.0 também mostra, na lista de
  subagentes da página da tarefa, o modelo de cada um e um ícone de estado (rodando, concluído, falhou).

---

## 2. O DeepSeek Harness (DSH)

### 2.1 O que é

O DeepSeek Harness (`dsh`) é o *harness* de agente open-source da DeepSeek AI. Ele fornece o que o
modelo sozinho não tem: sessões, ferramentas (bash, edição de ficheiros, busca, delegação), gestão
de contexto, presets de permissão, interface web e o motor de execução de agentes. A arquitetura é
**"tudo é plugin"**, construída sobre o [Cordis](https://github.com/cordiverse/cordis) (o design está
descrito em [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)).

Pontos práticos (verificados no checkout desta máquina e no [README do DSH](https://github.com/deepseek-ai/deepseek-harness)):

| Facto | Detalhe |
| --- | --- |
| Versão alvo deste plugin | **0.1.6-alpha.2** (Node 24, pnpm 11) |
| Executar | `npx @deepseek-ai/dsh web` → `http://127.0.0.1:3080`; a partir de fonte: `pnpm install && pnpm run build && pnpm dsh web` |
| Estado | *developer preview*: **haverá mudanças incompatíveis** — daí os *contract tests* deste plugin (ver [4.7](#47-build-testes-e-validação)) |
| Perfis | `web`, `headless`, `tui`, `sdk` — o mesmo plugin pode funcionar em todos ([4.2](#42-metade-host)) |
| Estado do utilizador | `$DSH_HOME` (por omissão `~/.dsh`): sessões, perfis, configuração, `cordis.patch.yml` |

### 2.2 Conceitos que este plugin usa

- **Sessão e agente principal.** Cada conversa é uma sessão; o agente principal ("orquestrador") é o
  modelo que o utilizador escolheu no *composer* e que conduz o trabalho.
- **Delegação / subagentes.** O agente principal pode começar agentes filhos. Os filhos têm as suas
  próprias opções (`AgentOptions`: provider, modelo, esforço, limite de tokens) e o seu próprio
  contexto.
- **`SubagentRuntime.start()` / `startContinuable()`.** As **duas únicas portas** por onde um filho é
  iniciado (um provider só arranca a partir de `start`; um agente filho só é criado por estes dois
  caminhos — fixado no código do DSH pelos *contract tests*). Todas as ferramentas de delegação
  passam por aqui.
- **Presets de permissão.** O que um subagente pode fazer (bash, rede, escrita) é decidido pelo
  preset de permissão da sessão — o plugin não mexe nisso.
- **Trust fence.** As rotas HTTP expostas pelos plugins ficam atrás da barreira de confiança do DSH
  (cerca de Host/Origem + autenticação do browser). Rotas de plugin devem pedir confiança primeiro,
  validar o fio em segundo, e só então executar lógica.

### 2.3 As formas de o DSH começar um filho

| Porta | Quem a usa | Governada pela guarda deste plugin |
| --- | --- | --- |
| `subagent` / `subagent_fork` (ferramentas) | delegação padrão do agente principal | sim |
| `subagent` como *job* de fundo de uma só execução | `run_in_background: true` | sim |
| `workflow` (script com `agent()`) | o motor de *workflow* | sim (todas as chamadas `agent()`) |
| `ralph` | motor de *workflow* (fora do preset padrão) | sim |
| equipas de agentes (experimental) | `start` / `startContinuable` | sim |
| providers `codex`, `claude-code`, ACP | agentes próprios, com modelos próprios | **não** (não aceitam *agent options*) |
| provider SDK (runtime de filho DSH separado) | SDK | sim quando há modelo escolhido |

### 2.4 Plugins no DSH (Cordis)

Um plugin DSH é um pacote com **duas metades**:

- **Metade host** (`lib/index.js`): carrega quando o `dsh` arranca, dentro do processo do host. Tem
  acesso aos serviços Cordis (`subagents`, `webServer`, `connection`, `llm`, `agents`, `logger`),
  declara `inject` (serviços de que precisa), regista rotas e instala efeitos (`ctx.effect`).
- **Metade browser** (`lib/client.cjs`): carrega quando a página abre; injeta-se em *slots* da UI
  (`conversation.input.overlay`, no caso deste plugin) e usa os primitivos de UI e os *tokens* do DSH.

A instalação é feita com `dsh plugin --profile web add <github:…|/caminho>`, que aplica a camada
`dsh.bundle.patch` do pacote (`cordis.patch.yml`) à composição do perfil. **Importante:** depois de
instalar ou atualizar é preciso **reiniciar o `dsh`**, não só recarregar a página — a metade host
antiga continua em memória (é exatamente isto que causou o bug da 0.5.1, ver [3.3](#33-história-em-versões)).

### 2.5 O que o DSH não resolve sozinho (o espaço deste plugin)

- O DSH **não pergunta, por tarefa**, se os subagentes devem rodar noutro modelo; o modelo do filho é
  resolvido a partir do pai e da rota.
- Quando a rota do filho muda sem esforço explícito, o DSH **limpa o esforço do pai** para o novo
  modelo "resolver o seu próprio default" — nas rotas alvo isso significava `max` de raciocínio e o
  teto de saída completo da rota (131K a 943K tokens) por pedido. Foi isto que produziu subagentes
  que gastavam o orçamento inteiro num caso limite e modelos lentos a demorar minutos por turno.
- Não há *hook* oficial à volta do início de um filho (`subagent/start` é uma notificação **depois**
  de o filho existir). Daí a abordagem da guarda ([4.4](#44-a-guarda-de-início-em-detalhe)).

---

## 3. O projeto `dsh-orquestrator`

### 3.1 O problema que resolve

Por volta de 2026-09/10, delegar em subagentes no DSH tinha dois problemas por tarefa:

1. **Modelo:** não havia como dizer "nesta tarefa, os subagentes correm no modelo X" sem mudar o
   agente principal ou editar configuração global.
2. **Custo/latência:** um filho re-roteado corria no default da rota (`max` muitas vezes), com o teto
   de saída da rota. O caso que motivou o projeto: **34 agentes de um `workflow` a correr em Claude
   Sonnet 5.5 a `max`** (~7,2 milhões de tokens de saída e ~1,26 mil milhões de tokens de leitura de
   cache), quando o utilizador tinha confirmado DeepSeek V4.1 Flash para subagentes.

A resposta foi um plugin que **pergunta uma vez** (no envio de cada mensagem do compositor) e **aplica a
resposta em código**, em todas as portas de início de filhos.

### 3.2 O que o plugin faz hoje (0.6.0)

- **Diálogo por mensagem enviada** (aspeto nativo, só primitivos e *tokens* do DSH): um *switch*
  "modelo de subagentes" com seletor de modelo (a mesma lista agrupada por *provider* do *composer*),
  notas curtas e datadas por modelo, e um bloco de **esforço de raciocínio** recolhido (aparece
  depois de escolher modelo; por omissão o nível recomendado).
- **Sem "não perguntar mais":** o modal apareme em **toda** a mensagem enviada (texto, `@ficheiro`
  ou `/skill` — não importa); a última escolha confirmada apenas pré-preenche. Cancelar / Esc / ✕
  envia a mensagem como stock e esquece a escolha.
- **`/orquestrar`** abre o mesmo diálogo a pedido (mudar ou limpar a escolha guardada).
- **Imposição em código** (a *guarda de início*) para cada filho: o modelo escolhido, o teto de
  esforço (o que o utilizador pediu ou o teto do modelo) e o teto de tokens de saída.
- **Sem escolha confirmada e sem `defaults`, o plugin é inerte.** O agente principal nunca é tocado.

### 3.3 História em versões

| Versão | O que mudou |
| --- | --- |
| 0.1.0 | Primeira versão: diálogo no envio (modelo de subagentes + revisor independente + "não perguntar mais"), *wrapper* de `tools/execute` para `subagent`/`subagent_fork`, protocolo do revisor derivado de um dossiê de pesquisa (`docs/pesquisa/`, 120 fontes, verificação adversarial em duas fases), loja de escolhas por sessão, rota atrás da trust fence. |
| 0.2.0 | Construída sobre **16 estudos** lidos contra o código do DSH e dados públicos ([estudos/](estudos/README.md)): teto de esforço e teto de tokens por filho, veredicto estruturado do revisor (`structured_output`), retry a um nível mais baixo no limite de tokens, transparência de custo no diálogo. |
| 0.2.1 / 0.3.0 | A saga do "não perguntar mais": primeiro preso à conversa (0.2.1), depois removido de todo (0.3.0) — porque o DSH reutiliza a sessão vazia de um *workspace* (`connectWorkspace`) e uma resposta silenciava o modal em todas as conversas. |
| 0.4.0 | **Guarda de início** (`src/guard.ts`): o modelo/esforço/teto confirmados passam a chegar a **todos** os filhos, não só aos das ferramentas `subagent`. Fecha o buraco do `workflow` (reproduzido num DSH isolado com 0.3.0 e verificado fechado com 0.4.0). Um modelo confirmado que já não existe **rejeita o início** com mensagem clara. |
| 0.5.0 | **O revisor independente é removido** (decisão [D16](estudos/decisoes.md)); a guarda passa a ser o **único mecanismo** do plugin. Foram removidos ~1 250 de ~3 430 linhas do host (`pipeline.ts`, `reviewer-protocol.ts`, `workspace.ts`, `tool-wrapper.ts`, seção do revisor no diálogo). |
| 0.5.1 | **Compatibilidade de fio** entre metades de versões diferentes: ambas as metades mantêm um bloco `reviewer` desativado na mensagem (`LEGACY_REVIEWER` em `src/shared.ts`), porque um host 0.2–0.4 recusava uma configuração sem ele ("config does not match the expected shape") e uma página antiga morria na resposta novo-host. Fixado por um *fixture* do parser antigo (`test/legacy-wire.ts`). |
| 0.6.0 | **O diálogo pergunta antes de toda mensagem enviada**: nenhum envio é classificado fora da pergunta (linhas `/`, mensagens com um turno a correr, conversas de subagentes); uma rota de host que não responde ainda pergunta; o *gate* anexa-se assim que a sessão existe. |
| 0.7.0 | **Um chip sob o compositor** (`conversation.composer.dock`) mostra a orquestração desta conversa e abre o diálogo ao clicar. |
| 0.8.0 | **A skill global `orchestrate-subagents` e o checkbox** (a skill é registrada em `ctx.skills`; com o checkbox marcado a mensagem sai com `/orchestrate-subagents` e o DSH injeta as instruções), e **o modelo e o estado de cada subagente na lista do cabeçalho** (livro-razão no host a partir de `subagent/start` e `subagent/end`; marcas nas linhas do menu do DSH, por fora, *fail-open*). Decisões D18 e D19 em [estudos/decisoes.md](estudos/decisoes.md). |

**Lição da 0.5.1 para o futuro:** o plugin tem duas metades que atualizam em momentos diferentes;
qualquer campo novo no fio precisa de um plano de compatibilidade com metades antigas (ver
[6.5](#65-restrições-de-implementação-já-conhecidas)).

### 3.4 O revisor e porquê saiu: a lição que importa para o novo modo

As versões 0.2–0.4 tinham um **revisor independente**: um segundo modelo que verificava o trabalho
de cada subagente, corrigia o que estava errado e entregava o resultado ao agente principal no lugar
do subagente. Foi removido em 0.5.0 por três motivos (decisão D16):

1. **Era um LLM a julgar um LLM.** O que o plugin impõe em código (que modelo corre, com que esforço,
   com que teto) é determinístico e o agente principal não contorna; um `APPROVED` do revisor é uma
   opinião — o plugin só conseguia validar o formato e a coerência do relatório.
2. **Custava cerca do dobro** e fazia cada delegação esperar por um segundo modelo; e cobria duas das
   portas de início, nunca os agentes de um `workflow`.
3. **Precisava de um segundo mecanismo** (*wrapper* das ferramentas) que a guarda tornou
   desnecessário.

Esta distinção — **imposição determinística em código vs. comportamento adesivo por instrução** — é a
bússola do projeto e é exatamente o eixo sobre o qual o Modo Coordenador Puro será avaliado
([6.4](#64-porquê-é-só-uma-instrução-e-porquê-isso-é-proposital)).

---

## 4. Como o plugin foi feito

### 4.1 Arquitetura

Um pacote, duas metades (`lib/index.js` para o host, `lib/client.cjs` para o browser):

```
 browser                                          host (processo do DSH)
 ┌──────────────────────────────────────┐        ┌───────────────────────────────────────────┐
 │ composer ─ send ─▶ SessionFace.prompt │        │                                           │
 │        (prototype da classe, envolto) │        │  /dsh-orquestrator/config  (GET / POST)   │
 │   PromptGate ─ toda tarefa? ─▶ modal  │◀──────▶│   trust fence ─▶ validar ─▶ ConfigStore   │
 │   confirmar ─ POST config ────────────┼───────▶│                        (sessions.json)    │
 │   cancelar  ─ POST null  ─────────────┼───────▶│                                           │
 │   depois o prompt ORIGINAL é enviado  │        │  SubagentRuntime.start / startContinuable │
 └──────────────────────────────────────┘        │   (guarda de início: wrappers próprios na  │
                                                  │    instância do serviço)                  │
                                                  │   qualquer filho: subagent, workflow,     │
                                                  │   ralph, job, team                        │
                                                  │   ├ sem escolha guardada ─▶ stock         │
                                                  │   └ planear ─▶ agentOptions               │
                                                  │      (rota, teto de esforço, teto tokens) │
                                                  └───────────────────────────────────────────┘
```

Os pedaços web-only (a rota e a sua trust fence) ligam-se por um `ctx.inject` aninhado, por isso a
guarda também funciona nos perfis headless, TUI e SDK, dirigida pela configuração `defaults`.

### 4.2 Metade host

| Ficheiro | Papel |
| --- | --- |
| `src/index.ts` | Corpo do plugin: configuração validada *fail-loud*, `inject = ['subagents']`, efeitos para a rota (só onde há web server) e para a guarda. |
| `src/guard.ts` | **A guarda de início — o único mecanismo do plugin.** Instala `start` e `startContinuable` próprios na instância do `SubagentRuntime` e planeia cada filho de uma sessão com escolha confirmada. |
| `src/effort.ts` | `planChild()`: rota, esforço de raciocínio e teto de saída de um filho, planeados contra o que o DSH realmente faz *merge*. |
| `src/models.ts` | Partilhado com o browser: tetos de esforço e notas do diálogo, **por modelo e com data** (`verifiedAt`, fontes `E01`–`E16`), e `chooseEffort()`. |
| `src/config.ts` | Configuração validada (`defaults`, `effort`, `limits`, `children`, opções de estado); campos do revisor removido são ignorados com aviso. |
| `src/store.ts` | Escolha por sessão, persistida atomicamente em JSON só-do-dono (`0600`), com *pruning* LRU e resolução através da linhagem da sessão. |
| `src/routes.ts` | A rota de configuração: trust fence primeiro, corpo limitado (64 KiB), validação estrita, rota de modelo resolvida no runtime de LLM ao vivo antes de guardar. |
| `src/shared.ts` | Contrato de fio com o browser: a escolha por sessão (modelo + esforço), o *parser* tolerante e os caminhos das rotas; `LEGACY_REVIEWER` (compatibilidade 0.2–0.4). |
| `src/host-services.ts` | Tipos das interfaces dos serviços Cordis usados (para não depender de detalhes internos no resto do código). |

### 4.3 Metade browser

| Ficheiro | Papel |
| --- | --- |
| `src/client/gate.ts` | Envolve `prompt` no **prototype da classe** da sessão (com *refcount*, restaurado exatamente; *fallback* para instância). Só interceta **novas tarefas**; *fail-open*: qualquer erro envia a tarefa como stock. Pode atrasar um envio, nunca perdê-lo. |
| `src/client/dialogs.ts` | Um diálogo de cada vez, fila, registo de *presenter*, tratamento de abort. |
| `src/client/OrchestratorOverlay.tsx` | Ocupante do *slot* `conversation.input.overlay`, sem visual próprio: regista-se como *presenter*, liga a *gate* e renderiza o diálogo. |
| `src/client/OrchestratorDialog.tsx`, `ModelPicker.tsx`, `EffortPicker.tsx` | O diálogo, só com primitivos do DSH (`Modal`, `Switch`, `Button`, `Menu`) e *tokens* do DSH. |
| `src/client/focus-trap.ts` | Mantém o Tab dentro do diálogo (o `Modal` do host declara `aria-modal` mas não contém o foco). |
| `src/client/config-client.ts`, `host-types.ts`, `observable.ts`, `locales.ts`, `styles.ts` | Cliente HTTP da rota, tipos do fio, estado reativo, dicionários en/pt/zh e estilos. |

### 4.4 A guarda de início em detalhe

- **Porquê uma guarda e não um *wrapper* de ferramentas:** um *wrapper* nunca vê os agentes de um
  `workflow` — o motor inicia-os através do próprio serviço. Foi o que a sessão dos 34 agentes
  demonstrou. As duas portas de `SubagentRuntime` são o único caminho (fixado em
  `test/contract/dsh-source.test.ts` contra o código do DSH), por isso uma guarda aí cobre todo
  chamador presente e futuro (decisão D15).
- **Como se agarra à porta:** o DSH não tem *hook* à volta do início de um filho, então a guarda
  instala os seus próprios `start`/`startContinuable` **na instância do serviço**, alcançada através
  do *proxy* Cordis pelo símbolo global registado `Symbol.for('cordis.original')`. Se o serviço não
  puder ser envolvido, **o plugin falha ao carregar** — nunca funciona a meio.
- **O que entrega ao DSH:** `agentOptions` (rota escolhida, esforço, teto de tokens) calculados por
  `planChild()`. O pedido planeado é **marcado** com uma propriedade-símbolo enumerável própria (uma
  cópia do objeto por *spread* a transporta), para que duas cópias vivas do plugin planeiem cada
  filho uma só vez — e o objeto do chamador nunca é marcado.
- **Modelo confirmado que já não existe:** o início é **rejeitado** com uma mensagem que nomeia o
  modelo e diz o que fazer. *Fail-open* seria pôr o filho no modelo do agente principal (o bug que a
  guarda existe para prevenir); forçar a rota morta faz cada agente de *workflow* falhar num `null`
  silencioso.
- **O que a guarda nunca faz:** quebrar um início por problemas seus (vira uma linha de log e deixa o
  DSH começar); tocar no agente principal; tocar em sessões sem escolha confirmada.

### 4.5 Esforço de raciocínio e teto de tokens

- O teto é um **teto, não uma definição**: uma rota já abaixo dele não é tocada; uma escada que
  salta degraus (GLM 5.3 oferece `low`, `high`, `max`) recebe o degrau mais alto não acima do teto;
  `off` nunca é escolhido sozinho.
- Ordem do teto: o nível escolhido no diálogo (pode exceder o teto) → `effort.worker` → a linha do
  modelo em `src/models.ts` (datada, com fontes) → `medium`.
- Tetos por modelo: DeepSeek V4.1 Flash `medium`; MiMo-V2.6-Pro `low`; GLM 5.3 / 5.3 Flash `high`;
  Claude Sonnet/Opus `high`; o resto `medium`.
- `limits` limita os tokens de saída de um único pedido de modelo (raciocínio incluído) e só **baixa**
  um teto que se saiba que o modelo tem. Um limite que o chamador definiu nunca é **aumentado**:
  vale o menor.

### 4.6 Fio, persistência e compatibilidade

- O contrato de fio vive em `src/shared.ts` e é partilhado pelas duas metades; o *parser* é
  **tolerante**: um registo da 0.4 que ainda traz o bloco do revisor carrega e o bloco é descartado.
- `sessions.json` (por omissão `~/.dsh/dsh-orquestrator/`): JSON atómico, modo `0600`, só rotas e
  níveis de esforço — **nunca credenciais**. Cada processo escreve a sua visão (*last writer wins*);
  dois processos DSH com o mesmo `stateDir` podem apagar entradas um do outro — dê um `stateDir` a
  cada um. Os `defaults` de headless nunca são escritos no ficheiro.
- A rota de configuração aceita um corpo de até 64 KiB, valida tipos/conteúdo estritamente e ignora
  campos desconhecidos com aviso.

### 4.7 Build, testes e validação

- **Build:** TypeScript + [tsdown](https://github.com/rolldown/tsdown) → `lib/index.js` e
  `lib/client.cjs` **commitados** (instalar não exige build). `scripts/check-lib.mjs` garante que o
  `lib/` commitado é igual a um build fresco. `pnpm run check` = *typecheck* + build + testes.
- **Testes** (`test/`, `node --test`): *unit* (planner, configuração, loja, contrato de fio),
  *integration* (rota, guarda), **contract** (`test/contract/dsh-source.test.ts` fixa as *seams* do
  DSH usadas contra um checkout real — `DSH_CHECKOUT=/path/to/deepseek-harness pnpm test`) e
  `test/legacy-wire.ts` (o *parser* estrito da 0.4, para a compatibilidade de fio não cair por
  acidente). 253 testes com checkout do DSH, 228 sem (o que o CI corre).
- **Validação ao vivo** (`scripts/e2e/`, contra um DSH real, com as três modelos-alvo — GLM 5.3 como
  agente principal, DeepSeek V4.1 Flash para subagentes, MiMo-V2.6-Pro só onde um *script* o nomeia —
  e falha se qualquer outro modelo correr):
  - `run-workflow.sh` + `session-config.mjs`: cenários headless lidos de volta dos registos de sessão
    (agentes de *workflow* no modelo escolhido com o teto e o limite de tokens; `override` e `keep`;
    imposição desligada; `subagent` em fundo e `subagent_fork` sem *wrapper* nenhum; modelo morto
    rejeitado através de *workflow* e da ferramenta).
  - `ui-e2e.mjs`: 65 verificações num browser real, incluindo uma delegação e um *workflow* reais.
  - `setup-isolated-home.sh` constrói o `DSH_HOME` isolado; `with-keys.sh` corre tudo só com as duas
    chaves de API dos modelos-alvo.
  - Evidência, achados e o que **não** foi coberto: [validation/README.md](validation/README.md).

### 4.8 Modelo de segurança

- A rota fica atrás da trust fence do DSH e rejeita antes de ler um byte do corpo; corpos limitados,
  *content-type* verificado, *parsing* estrito, campos desconhecidos descartados.
- Estado persistido sem credenciais (`0600`); o plugin **não lê, não escreve e não reencaminha**
  chaves de API.
- O plugin **não corre código** dos subagentes e **não inicia processos**: muda apenas as opções com
  que o DSH inicia um filho. Não há *sandbox*, nem filtro de rede, nem controlo de ambiente — o que
  os subagentes podem fazer é o preset de permissão da sessão, exatamente como sem o plugin.
- Consequência para o futuro: qualquer funcionalidade nova que "impeça" comportamentos do agente
  principal terá de ser, ou imposição em código nas portas do DSH, ou instrução (adesiva) — o plugin
  não ganha um terceiro poder pelo caminho.

---

## 5. Limitações do plugin

Todas documentadas no [README](../README.md) e no [DESIGN.md](DESIGN.md); resumidas aqui com o
impacto para quem vai estender o projeto.

1. **Não verifica o conteúdo do trabalho.** O plugin controla *que modelo corre e com que esforço*;
   não audita o que o subagente produz. Quem quiser verificação tem de pedir ao agente principal ou
   correr os testes do projeto. (O revisor fazia isto e foi removido — ver [3.4](#34-o-revisor-e-porquê-saiu-a-lição-que-importa-para-o-novo-modo).)
2. **Providers que não aceitam *agent options* ficam de fora.** `codex`, `claude-code` e ACP correm
   nos modelos próprios; o plugin regista um aviso (um por *provider*) e não toca nos seus filhos. O
   provider SDK é deixado em paz quando não há modelo escolhido.
3. **O teto de tokens não é duradouro para filhos `continuable`.** Quando o DSH retoma um filho
   terminado, reconstrói as opções do descritor gravado, que traz *provider*, modelo e esforço, mas
   **não** o limite de tokens: o teto de esforço sobrevive, o *cap* só vale na primeira execução.
   Corrigir exige outra *seam* (N21 em [decisoes.md](estudos/decisoes.md)). Documentado, não
   corrigido.
4. **Modelo confirmado que desaparece** (renomeado/removido das definições do DSH) **rejeita o
   início** do filho — por decisão: é preferível uma falha ruidosa a correr no modelo errado. Quem
   usa nomes de modelo instáveis vai sentir isto.
5. **Dados de modelo datados.** As notas e tetos do diálogo vêm de estudos de setembro/outubro de
   2026 e envelhecem em semanas; um modelo desconhecido recebe o teto genérico e nenhuma nota.
6. **Estado com um só escritor.** Dois processos DSH a usar o mesmo `stateDir` podem apagar escolhas
   um do outro (last writer wins).
7. ***Seams* não oficiais.** Não há *hook* de início de filho no DSH; a guarda envolve a instância do
   `SubagentRuntime`. Os *contract tests* apanham mudanças do DSH primeiro, mas correm numa máquina
   com checkout (`DSH_CHECKOUT`), não no CI. O DSH está em *developer preview*: mudanças
   incompatíveis são esperadas e o plugin falha ao carregar (nunca a meio) quando a *seam* muda.
8. **Compatibilidade de fio entre metades.** Host e browser atualizam em momentos diferentes; campos
   novos no fio precisam de plano de compatibilidade (a lição da 0.5.1). Há um *fixture* do parser
   antigo para o que existe hoje.
9. **i18n por dicionário.** As traduções pt/zh aparecem quando o DSH (ou outro plugin) regista o
   idioma; este plugin nunca regista um idioma, para não colidir com quem o detém.
10. **Escopo estreito por escolha.** O plugin governa *opções de agente dos filhos*. Não muda o agente
    principal, não muda ferramentas, não muda presets de permissão — e é assim que deve continuar,
    exceto quando uma extensão nova o disser explicitamente (como o modo da [seção 6](#6-modo-coordenador-puro-checkbox-especificação-proposta)).

---

## 6. Modo Coordenador Puro (checkbox): especificação proposta

> Estado: **implementado na 0.8.0, de outra forma.** Esta seção é a especificação original (mantida
> porque as limitações da [6.6](#66-limitações-inerentes-do-modo) continuam valendo). O que mudou na
> implementação, e porquê ([D18](estudos/decisoes.md)):
>
> - Em vez de um "modo" com texto injetado pelo *gate* (candidata A) ou por uma *seam* do host (B), a instrução
>   é uma **skill do DSH** (`orchestrate-subagents`, em `skills/orchestrate-subagents/SKILL.md`), registrada em
>   `ctx.skills` quando o plugin carrega. O checkbox só põe o token `/orchestrate-subagents` na mensagem
>   (numa linha própria, no fim do último texto do envio); o gesto `/nome` do `dsh-tool-skill` injeta o corpo da skill no passo, o mais perto
>   da resposta do modelo, e a transcrição mostra o token. Nada do texto da skill viaja no fio nem no pacote do
>   navegador.
> - O checkbox é **marcado por padrão** e lembra a última resposta; só aparece quando o host diz que a skill está
>   registrada (a rota de configuração passou a responder `skill: { name, available }`). Cancelar, Esc e ✕ enviam
>   a mensagem sem token. Não há campo novo na configuração guardada por sessão, então não há plano de
>   compatibilidade de fio a manter além do campo opcional `skill` da resposta.
> - O conteúdo do contrato da [6.2](#62-contrato-pretendido-da-instrução) ficou na skill, com acréscimos que
>   quatro ensaios de pensamento expuseram: partes que rodam em paralelo dividem **uma só árvore de trabalho** (um
>   dono por arquivo, uma linha de base dos testes antes de mudar código, nada de `commit` nem de mudança de
>   dependências sem pedido), uma descoberta só de leitura também ganha um leitor que tenta refutá-la, e o
>   verificador roda só as verificações que a mudança pode afetar.
> - É **instrução, não imposição**, como a 6.4 antecipava: a skill não bloqueia ferramenta nenhuma.

### 6.1 Intenção

Um **checkbox** no diálogo do orquestrador (e em `/orquestrar`) que ativa um modo cuja **única ação**
é **injetar uma instrução no orquestrador** (o agente principal). Com o modo ligado, o agente
principal deve:

- **não ler código**;
- **não escrever código**;
- **mandar os subagentes analisar o *diff*** do que eles próprios fizeram;
- **mandar corrigir** o que estiver errado, ou **mandar repetir** o trabalho;
- **apenas coordenar** todo o processo, com foco puro em subagentes.

Ou seja: o agente principal vira um **coordenador/gerente**; toda a leitura, escrita e verificação de
código passa a acontecer dentro de subagentes. O modelo do agente principal continua a ser o do
*composer*; o modelo dos subagentes continua a ser governado pela guarda (as duas funcionalidades
**compõem**: a instrução diz *como* trabalhar, a guarda impõe *com o quê* os filhos trabalham).

### 6.2 Contrato pretendido da instrução

A instrução injetada (texto a definir na implementação, mas com estes mandamentos) deve dizer ao
orquestrador, por cada tarefa:

1. **Proibição de código:** não usar ferramentas de leitura/edição de ficheiros de código nem
   executar alterações; o trabalho técnico é todo dos subagentes.
2. **Dividir e delegar:** decompor a tarefa em unidades e despachá-las a subagentes com um
   *brief* completo (objetivo, restrições, critérios de aceitação).
3. **Ciclo de verificação por *diff*:** após cada subagente entregar, despachar **outro** (ou o mesmo,
   a critério do *brief*) para **analisar o *diff*** resultante contra os critérios; o verificador
   relata defeitos, não decide sozinho.
4. **Corrigir ou repetir:** havendo defeitos, o coordenador despacha **correções pontuais** ou
   **repete a unidade** — com limite de rondas e critério de paragem (para não entrar em *loop*).
5. **Só coordenar:** o resultado final do coordenador é a síntese do estado do processo (o que foi
   feito, o que foi verificado, o que ficou) — nunca código.

### 6.3 Onde a instrução seria injetada (*seams* candidatas)

A decidir na implementação; as candidatas honestas, do mais simples ao mais robusto:

| Candidata | Como | Prós | Contras |
| --- | --- | --- | --- |
| **A. *Gate* do browser** (`src/client/gate.ts`) | O *gate* já envolve `SessionFace.prompt` e interceta novas tarefas; com o checkbox ligado acrescenta a instrução ao envio. | Usa a *seam* que o plugin já domina; só atua em novas tarefas. | A instrução aparece como parte da mensagem do utilizador (ruído na conversa); contexto do utilizador mistura-se com o mandamento. |
| **B. Metade host, ao nível da sessão** | Injetar como instrução de sistema/prompt da sessão através de uma *seam* do DSH (se existir para o perfil em uso). | Não polui a conversa; vale para headless/TUI. | O DSH não documenta uma *seam* deste tipo para plugins; a experiência da guarda mostra que *seams* não oficiais exigem *contract tests*. |
| **C. Híbrida** | Instrução na primeira mensagem + eco curto em cada novo envio da mesma sessão. | Mais resistente a esquecimento em sessões longas. | Repetição gasta contexto; risco de o modelo "habituarse" e perder força a instrução. |

Recomendação inicial: começar por **A** (a *seam* já é do plugin, *fail-open* por construção) e medir;
considerar **B** se a instrução se perder no ruído.

### 6.4 Porquê é só uma instrução, e porquê isso é proposital

O projeto aprendeu uma lição cara ([3.4](#34-o-revisor-e-porquê-saiu-a-lição-que-importa-para-o-novo-modo)):
**o que é imposição vive em código; o que é comportamento do modelo é instrução e é frágil.** O pedido
é explicitamente de um modo "que a única coisa que faz é injetar uma instrução" — e isso é coerente:

- impor "não ler/ não escrever código" **em código** exigiria bloquear ferramentas, o que é território
  do preset de permissão da sessão (e mudaria o contrato do DSH, não o deste plugin);
- injetar a instrução mantém o plugin no seu lugar (opções de agente + conveniência de UX), sem criar
  um segundo mecanismo que precise de ser mantido — o erro que o revisor representou.

Mas a consequência tem de ser assumida: **uma instrução não é garantia** ([6.6](#66-limitações-inerentes-do-modo)).

### 6.5 Restrições de implementação já conhecidas

- **Compatibilidade de fio.** A escolha viaja em `src/shared.ts`; um campo novo (ex. `coordinatorMode`)
  precisa de plano para metades antigas — um host 0.5.1 ignora campos desconhecidos com aviso (bom),
  mas uma página antiga não envia o campo (o modo fica desligado nessa sessão; aceitável se
  documentado). Seguir o exemplo do `LEGACY_REVIEWER` da 0.5.1.
- **Persistência.** A escolha por sessão vive em `src/store.ts`; o novo campo entra no mesmo registo,
  com o mesmo *pruning* LRU e o mesmo *parser* tolerante (a escolha do modo não deve rejeitar
  registos antigos).
- **UI.** O checkbox entra em `OrchestratorDialog.tsx` (um `Switch` extra, com texto curto em en/pt/zh
  em `locales.ts`), visível sem depender de haver modelo escolhido — o modo é útil também sem
  re-roteamento. Respeitar a regra "não há *não perguntar mais*": o modo liga-se por tarefa.
- **`/orquestrar`** deve poder ligar/desligar o modo a meio da sessão.
- **Testes.** Unidade para o fio/persistência/UI; cenário e2e novo (headless via injeção + browser)
  contando as ferramentas usadas pelo agente principal.

### 6.6 Limitações inerentes do modo

1. **É adesivo, não impositivo.** O modelo pode ignorar a instrução — sobretudo em contexto longo, no
   fim de uma sessão, em tarefas triviais ("é só mudar uma linha") ou com esforço baixo. Não há
   recurso em código: é a diferença central para a guarda.
2. **Não bloqueia ferramentas.** "Não ler/ não escrever código" será um mandamento; o agente principal
   continua fisicamente capaz de usar `read`/`edit`/`bash`. Um bloqueio real seria outro produto
   (preset de permissão), não este modo.
3. **Só o orquestrador recebe a instrução.** Os subagentes não sabem que o modo existe; cada *brief*
   tem de carregar as direções relevantes (analisar *diff*, relatar defeitos). Um subagente a quem se
   pede "corrige isto" pode, ele próprio, tentar ser coordenador — os *briefs* têm de ser explícitos.
4. **Análise de *diff* é um problema difícil por natureza.** Os estudos do projeto mostram os riscos:
   ancoragem no código do autor, aprovação superficial, "carimbo de aprovação" (E02, E09). Um
   verificador que só lê o *diff* sem a especificação original e sem os testes aprova ruído; o *brief*
   do verificador deve exigir defeitos concretos (arquivo/linha/sintoma), nunca um veredito vago.
5. **Depende do estado de trabalho.** *Diff* pressupõe git/working tree (ou comparação explícita de
   versões); em sessões sem repositório o modo degrada para comparação por relatório.
6. **Ciclos custam.** Cada rodada "analisar → corrigir/repetir" são mais delegações, mais tokens e
   mais latência — e os filhos já carregam o teto de esforço/tokens da guarda. Sem limite de rondas na
   instrução, o risco é *loop* de correções.
7. **O *workflow* também cai no modo.** Se o orquestrador escrever um *script* de *workflow*, a
   proibição de código aplica-se à escrita do *script*; os agentes do *workflow* recebem *briefs*
   como quaisquer outros. (Os filhos de *workflow* continuam governados pela guarda desde a 0.4.0.)
8. **Não muda o que o plugin impõe.** Modelo, teto de esforço e teto de tokens seguem exatamente como
   hoje; o modo é uma camada de comportamento, não uma nova imposição.
9. **Medir é obrigatório.** Sem métrica (ferramentas usadas pelo agente principal por sessão, rondas
   de correção, taxa de defeitos apanhados), é impossível saber se a instrução está a ser seguida — a
   validação da [6.7](#67-como-validar-a-fazer) existe para isso.

### 6.7 Como validar (a fazer)

No espírito da [validação atual](validation/README.md) (DSH isolado, modelos-alvo, leitura de volta
dos registos):

- **Headless:** sessão com o modo ligado; verificar nos registos que o agente principal fez **0**
  chamadas de leitura/edição de código e **N** delegações, e que houve pelo menos uma ronda de
  verificação de *diff*; sessão com o modo desligado como linha de base.
- **Browser:** o checkbox aparece, liga/desliga, sobrevive a `/orquestrar`, e a instrução chega à
  sessão certa (e só a essa).
- **Robustez:** uma tarefa trivial (onde o modelo tem mais tendência a "fazer logo") e uma tarefa
  longa (onde a instrução se perde) — as duas devem mostrar o comportamento, ou o modo tem de dizer
  onde falha.
- **Regressão:** tudo o que a guarda faz hoje continua a fazer (as suites existentes não podem
  amarelar).

---

## 7. Mapa do repositório

| Caminho | O que é |
| --- | --- |
| `src/` | Metade host: `index.ts`, `guard.ts`, `effort.ts`, `models.ts`, `config.ts`, `store.ts`, `routes.ts`, `shared.ts`, `host-services.ts` |
| `src/client/` | Metade browser: *gate*, diálogos, overlay, seletores, foco, estilos, *locales* |
| `lib/` | Build commitado (`index.js`, `client.cjs`) — o que o DSH carrega |
| `test/` | `unit/`, `integration/`, `contract/` (seams do DSH), `legacy-wire.ts` (parser 0.4) |
| `scripts/e2e/` | Validação ao vivo: `run-workflow.sh`, `ui-e2e.mjs`, `session-config.mjs`, `setup-isolated-home.sh`, `with-keys.sh`, `summarize-run.mjs` |
| `docs/DESIGN.md` | Porquê da arquitetura, tabela decisão→evidência, modelo de segurança |
| `docs/estudos/` | Os 16 estudos (`fontes/`, E01–E16), a síntese e o registro de decisões (D01–D14, N01–N22) |
| `docs/pesquisa/padrao-revisor.md` | Dossiê do protocolo do revisor (histórico 0.2–0.4) |
| `docs/validation/` | Evidência das validações ao vivo, achados e lacunas |
| `cordis.patch.yml` | Camada de composição do plugin (inserção do plugin na composição do perfil) |
| `CHANGELOG.md` | História detalhada por versão |

---

## 8. Referências internas

- [README.md](../README.md) — instalação, uso, cobertura de delegações, limitações, segurança.
- [README.pt-BR.md](../README.pt-BR.md) — o mesmo, em português.
- [DESIGN.md](DESIGN.md) — arquitetura e a tabela de decisões com a evidência de cada uma.
- [estudos/README.md](estudos/README.md) — os 16 estudos, como foram verificados e como atualizar.
- [estudos/decisoes.md](estudos/decisoes.md) — decisões adotadas (D01–D14) e não adotadas (N01–N22),
  com o motivo de cada uma.
- [pesquisa/padrao-revisor.md](pesquisa/padrao-revisor.md) — o protocolo do revisor removido (histórico).
- [validation/README.md](validation/README.md) — o que foi validado ao vivo e o que não foi.
- [CHANGELOG.md](../CHANGELOG.md) — a história completa, versão a versão.
