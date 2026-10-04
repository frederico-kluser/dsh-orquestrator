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

**Cancelar, Esc e o botão de fechar enviam a tarefa exatamente como o DSH sempre fez.**
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

Digite uma tarefa no compositor e envie. O diálogo aparece uma vez por tarefa nova:

- **Modelo dos subagentes**: ligue e escolha um modelo na mesma lista agrupada por
  provedor que o seletor de modelo do compositor usa. Vale para todo subagente, inclusive os
  agentes que um workflow inicia. Desligado, os subagentes mantêm o modelo do agente principal. O
  diálogo mostra notas curtas e datadas para os modelos que precisam delas (por exemplo: o
  MiMo-V2.6-Pro pode levar minutos por turno em esforço alto; o GLM 5.3 é só texto).
- **Esforço de raciocínio** (recolhido, aparece depois de escolher um modelo): quanto o modelo pode
  pensar. O padrão é o nível recomendado para o modelo; abra para ver ou mudar.
- **Não existe "não perguntar de novo"**: o modal aparece em toda tarefa nova e nada o silencia.
  Uma resposta nunca o esconde de uma tarefa seguinte nem de outra conversa. A última escolha
  confirmada só pré-preenche o diálogo.
- **Cancelar / Esc / ✕**: envia a tarefa com o comportamento padrão e esquece qualquer escolha guardada.

`/orquestrar` abre o mesmo diálogo sob demanda (para mudar ou limpar a escolha guardada).

O diálogo não aparece para o que não é tarefa nova: conduzir um turno em andamento, conversas
de subagentes e linhas de comando com `/`.

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
    persist: true                  # lembrar as escolhas entre reinícios
    stateDir: ~/.dsh/dsh-orquestrator
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

- **O plugin controla qual modelo roda e o quanto ele pensa. Não confere o que um subagente
  produz.** O agente principal lê o resultado como o DSH sempre entregou; se você quer uma conferência,
  peça ao agente principal que verifique, ou rode os testes do próprio projeto. (Um revisor independente
  fazia isso; veja [abaixo](#por-que-o-revisor-foi-removido).)
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
com que o DSH inicia um filho. O que faz: serve a única rota atrás da cerca de confiança do DSH (cerca
de Host/Origin e autenticação do navegador) com validação estrita do formato, guarda o estado num
arquivo só do dono, que contém ids de provedor e de modelo e nenhuma credencial, e nunca lê, grava nem
repassa chaves de API. O que **não** faz: não oferece sandbox, não filtra rede e não controla o
ambiente dos processos. O que os subagentes podem fazer é decidido pelo preset de permissão da
sessão, exatamente como sem o plugin.

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

A versão 0.5.0 foi validada num DSH 0.1.6-alpha.2 real, só com os três modelos-alvo: GLM 5.3 (agente
principal), DeepSeek V4.1 Flash (subagentes) e MiMo-V2.6-Pro (o modelo que um script de workflow
nomeia). Por linha de comando, oito cenários lidos de volta dos logs de sessão: os agentes do workflow
no modelo escolhido, no teto do modelo, com limite de 64 000 tokens; `explicitModel: override` e `keep`;
o enforcement desligado; a ferramenta `subagent` em segundo plano e o `subagent_fork` governados sem
nenhum embrulho de ferramenta; e um modelo confirmado que não existe mais rejeitado com uma mensagem que
o nomeia, num workflow e na ferramenta. Pelo diálogo num navegador real: 65 verificações, incluindo uma
delegação real e um workflow real cujos filhos foram lidos de volta dos logs. Uma escolha guardada pela
0.4.0 (com o bloco do revisor) foi carregada e regravada no formato novo. Evidências e achados,
inclusive o que não foi coberto: [docs/validation/README.md](docs/validation/README.md) (em inglês).

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
