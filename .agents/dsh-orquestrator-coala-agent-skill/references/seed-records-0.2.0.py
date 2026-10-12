#!/usr/bin/env python3
"""Curated memory records for dsh-orquestrator 0.2.0: the knowledge from the studies and the WHY of every change.

The memory database is local and git-ignored (memory/coala.sqlite). To rebuild it on another checkout:

    python3 .agents/dsh-orquestrator-agent-skill/scripts/coala.py ingest
    python3 .agents/dsh-orquestrator-agent-skill/references/seed-records-0.2.0.py

Run both from the project root. Re-running is safe: a record with the same key supersedes the active one.
Every record: type, key (stable subject), tags, origin, source, content. No secrets."""
import subprocess, sys

COALA = ['python3', '.agents/dsh-orquestrator-agent-skill/scripts/coala.py']
SRC = 'sessão 2026-10-03 (estudos E01-E16; docs/estudos/decisoes.md)'

R = []
def rec(type_, key, tags, content, origin='agent', source=SRC, entities=None):
    R.append(dict(type=type_, key=key, tags=tags, content=content, origin=origin, source=source, entities=entities))

# ---------------------------------------------------------------- regra do dono
rec('semantic', 'regra/testes-so-com-os-3-modelos', 'owner,regra,testes,modelos',
    "Regra do dono (2026-10-03, em maiúsculas: 'RODE TESTES SO COM OS 3 MODELOS DEFINIDOS'): execuções reais do plugin só com os 3 modelos definidos. "
    "Interpretação adotada: GLM 5.3 = agente principal/orquestrador (openrouter/z-ai/glm-5.3), DeepSeek V4.1 Flash = subagente (azure-opencode/DeepSeek-V4.1-Flash), "
    "MiMo-V2.6-Pro = revisor (openrouter-extra/xiaomi/mimo-v2.6-pro), as três 'apostas' avaliadas em todos os estudos E01-E13. "
    "Nunca rodar Gemini, Haiku, Sonnet etc. em execução real (fixtures de teste unitário não contam). scripts/e2e/run-trio.sh sai com 3 se qualquer sessão rodar outro modelo. "
    "Se o dono quis outro trio: ORQ_WORKER_ROUTE, ORQ_REVIEWER_ROUTE e o agent-default-model do DSH_HOME isolado.",
    origin='owner', source='conversa 2026-10-03 (instrução do dono)', entities='dsh-orquestrator,GLM 5.3,DeepSeek V4.1 Flash,MiMo-V2.6-Pro')

# ---------------------------------------------------------------- DSH (costuras verificadas no código 0.1.6-alpha.2, ddefc45)
rec('semantic', 'dsh/resolucao-das-opcoes-do-filho', 'dsh,costura,esforco,causa-raiz',
    "DSH 0.1.6-alpha.2, packages/subagent/subagent/src/child-agent.ts: resolveChildAgentOptions parte das opções do pai (rota viva do cabeçalho de requisição, senão as de criação), aplica por cima o `agentOptions` pedido e, "
    "se a rota mudou e nenhum reasoningEffort foi pedido, APAGA o esforço do pai ('o modelo escolhido resolve o próprio padrão'). Nas rotas do usuário todo `reasoning` padrão é max, e o maxTokens vem do defaultMaxTokens declarado "
    "(131072 MiMo, 384000 DeepSeek Azure, 943718 DeepSeek OpenRouter). Logo, filhos re-roteados sem esforço rodavam em max com teto de saída enorme: a causa dos sintomas (trabalhador esgotando tokens; MiMo ~2 min/turno). "
    "Fixado em test/contract/dsh-source.test.ts. O plugin passa agora reasoningEffort e maxTokens explícitos (src/effort.ts).",
    source='packages/subagent/subagent/src/child-agent.ts; docs/estudos/sintese.md §6', entities='resolveChildAgentOptions,teto de esforço')
rec('semantic', 'dsh/saida-estruturada-do-subagente', 'dsh,costura,veredicto,structured_output',
    "O provedor `spawn` do DSH declara capacidades agentOptions, outputSchema, depthLimit, toolFilter, persona. Com outputSchema registra no filho a ferramenta cooperativa `structured_output` "
    "(sem forçar tool_choice, compatível com raciocínio ligado), valida os argumentos contra o esquema (ToolArgsError => o modelo tenta de novo no mesmo turno), devolve result.structured e encerra o turno (concludeTurn). "
    "Se o modelo termina com texto, a execução fecha como stopReason 'error' (completed vira error) com o texto disponível. Subconjunto de JSON Schema aceito: type, properties, required, additionalProperties(boolean), items, enum, const, oneOf + anotações; "
    "NÃO aceita minItems/maxLength/pattern. O plugin usa isso em REVIEW_SCHEMA e renderiza o relatório ele mesmo.",
    source='packages/subagent/subagent-in-process-driver/src/structured.ts; packages/core/tools/src/json-schema.ts', entities='structured_output,veredicto estruturado')
rec('semantic', 'dsh/escada-de-esforco-e-info-do-modelo', 'dsh,costura,esforco,catalogo',
    "ctx.llm.resolveModelInfo(provider, model) devolve inputModalities, context, defaultMaxTokens e reasoning {efforts[] em ordem de escalada (off,minimal,low,medium,high,xhigh,max: o subconjunto do modelo), defaultEffort}. "
    "Modelo sem raciocínio não tem `reasoning`. resolveCallConfig NÃO faz clamp: esforço não suportado => LlmError UNSUPPORTED_REASONING_EFFORT. "
    "O catálogo do navegador (remote session.modelCatalog) carrega a mesma escada por modelo (ModelCatalogModel.reasoning), então o diálogo mostra o mesmo 'Recomendado' que o host usa.",
    source='packages/llm/llm/src/index.ts; packages/llm/llm-pi-ai/src/adapter.ts; packages/api/session-controller/src/catalog.ts', entities='resolveModelInfo')
rec('semantic', 'dsh/toolfilter-nomes-desconhecidos', 'dsh,costura,seguranca,adiado',
    "tools.restrict() lança erro para nomes de ferramenta desconhecidos ('names unknown global tool'), e as ferramentas do preset standard vivem no plano do agente; o plugin não consegue listar as do filho antes de criá-lo. "
    "Por isso NÃO há deny-list estática de ferramentas para o revisor (N11 em docs/estudos/decisoes.md). Reabrir se o DSH oferecer restrição tolerante.",
    source='packages/core/tools/src/index.ts (restrict)')
rec('semantic', 'dsh/openrouter-routing-withheld', 'dsh,openrouter,adiado',
    "No catálogo do llm-pi-ai, compat.openRouterRouting é 'withhold': o DSH não deixa um perfil enviar provider.order/allow_fallbacks/ZDR por requisição. A recomendação de E08 de fixar provedor/fallbacks "
    "não é implementável pelo plugin nem por settings.yaml hoje (N08). Sufixos virtuais como `:exacto` no id do modelo seriam possíveis mas NÃO foram testados.",
    source='packages/llm/llm-pi-ai/src/catalog.ts')
rec('semantic', 'dsh/catalogo-deepseek-oficial', 'dsh,modelos,deepseek',
    "O provedor oficial do DSH é `deepseek-official` e a tabela embutida (packages/llm/llm-deepseek/src/common/models.ts) ainda lista `deepseek-flash` (V4.1 Flash, texto+imagem) e `deepseek-v4-pro` (só texto). "
    "Na API oficial deepseek-v4-pro é servido pelo V4.1 Flash desde 2026-09-14. Sugestão para o DSH: deixar de listar o id aposentado.",
    source='packages/llm/llm-deepseek/src/common/models.ts', entities='DeepSeek V4.1 Flash')

# ---------------------------------------------------------------- modelos e dados públicos (2026-10-03)
rec('semantic', 'modelos/deepseek-v4-pro-aposentado', 'modelos,deepseek,verificado',
    "Aviso oficial da DeepSeek (api-docs.deepseek.com/news/news260910, lido em 2026-10-03): V4.1-Flash lançado em 2026-09-10 (id da API `deepseek-flash`); a partir de 2026-09-14 04:00 UTC toda chamada a deepseek-v4-pro roteia "
    "para o V4.1-Flash ao preço dele, até o V4.1-Pro; V4-Flash e V4-Flash-Vision-Exp aposentados (roteiam temporariamente). Confirma E05, E07, E08, E10, E11.",
    origin='untrusted', source='https://api-docs.deepseek.com/news/news260910/')
rec('semantic', 'modelos/openrouter-2026-10-03', 'modelos,openrouter,verificado',
    "OpenRouter /api/v1/models em 2026-10-03: z-ai/glm-5.3 entrada só texto; z-ai/glm-5.3-flash texto+imagem+vídeo; xiaomi/mimo-v2.6-pro texto+imagem+vídeo+áudio (US$0,435/0,87 por M); xiaomi/mimo-v2.6-pro-ultraspeed existe a ~10x o preço (US$4,35/8,70); "
    "deepseek/deepseek-v4.1-flash texto+imagem; todos aceitam reasoning, tools, tool_choice, structured_outputs. z-ai/glm-5.3 foi servido pelo provedor 'Mistral' numa chamada de teste (1 s para um prompt trivial). Preços divergem entre estudos e provedores: não usar no código.",
    origin='untrusted', source='https://openrouter.ai/api/v1/models')
rec('semantic', 'modelos/openrouter-deepseek-max-aceito', 'modelos,openrouter,refutado',
    "Sonda de 2026-10-03: deepseek/deepseek-v4.1-flash no OpenRouter com reasoning.effort = max, xhigh e high respondeu HTTP 200 nas três. A alegação de E01 (max => HTTP 400, exige xhigh; fonte anedótica) NÃO se reproduz; "
    "não existe interceptor max->xhigh no plugin (N12).",
    source='chamada real ao OpenRouter, 2026-10-03')
rec('semantic', 'modelos/glm-5.3-principal-em-max-trava', 'modelos,glm,efeito-observado',
    "Observado em 2026-10-03: o GLM 5.3 como AGENTE PRINCIPAL em reasoningEffort max ficou mais de 8 minutos sem emitir a primeira chamada de ferramenta (tarefa de delegação de ~860 caracteres); com high a delegação saiu em ~10 s. "
    "Concorda com E01/E05/E08 (max do GLM 5.3 adiciona latência). O plugin não toca o agente principal por desenho; recomendação ao dono: GLM 5.3 como principal em high (E01). Os testes do plugin usam o principal em high.",
    source='validação local 2026-10-03', entities='GLM 5.3,orquestrador')
rec('semantic', 'modelos/tetos-de-esforco-por-modelo', 'modelos,esforco,config',
    "Tetos que o plugin escolhe sozinho (src/models.ts, verifiedAt 2026-10-03; usuário e config effort.* têm prioridade): DeepSeek V4.1 Flash trabalhador medium / revisor low; MiMo-V2.6-Pro (e ultraspeed) trabalhador low / revisor medium; "
    "GLM 5.3 e 5.3 Flash trabalhador high / revisor low; Claude Sonnet/Opus high/high; Haiku e Gemini 3.8 Flash medium/medium; qualquer outro medium/medium. Nenhum passa de high. A escada de cada modelo manda: GLM só oferece low/high/max. "
    "Escada nomeada do DSH (off..max), não numérica: 30-50 de 100 dos estudos ~ medium.",
    source='src/models.ts; docs/estudos/sintese.md §7', entities='teto de esforço,DeepSeek V4.1 Flash,MiMo-V2.6-Pro,GLM 5.3')

# ---------------------------------------------------------------- estudos
rec('semantic', 'estudos/indice-e01-e16', 'estudos,indice',
    "16 estudos em docs/estudos/fontes (bytes originais, sha256 em docs/estudos/README.md). E01 fichas de modelos; E02 limites da revisão por LLM/cross-family/quando não revisar; E03 orquestrador-trabalhadores e contexto limpo; E04 catálogo de 14 cargos; "
    "E05 playbook por família; E06 revisor visual; E07 roteamento preditivo/presets; E08 provedores e custo; E09 veredicto estruturado/hierarquia de instruções; E10 descoberta dos testes/triagem; E11 metadados de modelos; "
    "E12 modelo de ameaças do revisor; E13 UX (modal por envio, presets; 13.md e 14.md eram idênticos); E14 plugins Cordis no DSH; E15 modelos de subagentes no DSH; E16 visão geral do DSH. "
    "Origem: relatórios de pesquisa gerados fora do repo; tratados como conselho, nunca como verdade sem checagem.",
    origin='untrusted', source='docs/estudos/README.md', entities='estudos E01-E16')
rec('semantic', 'estudos/alegacoes-nao-reproduzidas', 'estudos,refutado,cuidado',
    "Não reproduzido/contradito: (1) max no OpenRouter dá 400 (E01) - 200 em 2026-10-03; (2) esforço em texto lido como 100 numa escala 1-100 (E05) - a sonda do usuário (settings.yaml, 2026-09-09) mostra o fio aceitando none|minimal|low|medium|high|xhigh|max; "
    "(3) max_thinking_tokens (E03, E05, E11, E13) - sem seam no DSH; (4) benchmarks (Terminal-Bench 4.0, DeepSWE v1.1, FrontierCode 1.1) não revalidados, só a direção do efeito foi usada; (5) preços divergem entre estudos.",
    source='docs/estudos/sintese.md §4')
rec('semantic', 'estudos/conflitos-e-resolucoes', 'estudos,decisao',
    "Conflitos entre estudos e a resolução: extinguir APPROVED_WITH_FIXES (E02) x manter (E03,E05,E07,E09,E10,E12) => MANTIDO, apertado; veredicto texto x ferramenta/JSON => ferramenta nativa do DSH com texto de reserva, sem nonce; "
    "revisor vê o relatório do trabalhador (dossiê) x nunca (E02,E03) => auto (contexto limpo quando a árvore mudou); esforço do revisor Rigoroso max (E07) x nunca max (E02,E04) => nunca max por conta própria; "
    "orquestrador GLM 5.3 x Sonnet 5.5 => fora do escopo do plugin.",
    source='docs/estudos/sintese.md §3')

# ---------------------------------------------------------------- decisões D01-D14 (episódicas, datadas)
D = [
 ('D01', 'Teto de esforço de raciocínio por papel e por modelo', "Porquê: o DSH apaga o esforço do pai quando a rota do filho muda e o padrão das rotas é max (ver dsh/resolucao-das-opcoes-do-filho). É TETO, não valor: rota já abaixo não é tocada; vem da escada do modelo (resolveModelInfo); escolha explícita do usuário vence; sem LLM/descrição, o filho segue como o usuário escolheu. Estudos: E01-E05, E07-E13. Código: src/models.ts, src/effort.ts."),
 ('D02', 'Teto de tokens de saída por requisição (trabalhador 64000, revisor 32000)', "Porquê: maxTokens padrão = declarado da rota (131k-943k) e um laço só acaba quando o orçamento acaba. Só REDUZ um teto conhecido (nunca aumenta; se o DSH não informa o teto do modelo, nada é enviado: provedor rejeitaria valor acima do máximo). 64k cobre uma chamada de ferramenta grande; 32k basta ao relatório. Operador: limits (false desliga). Estudos pedem max_thinking_tokens (sem seam)."),
 ('D03', 'Nova tentativa única, um nível abaixo, quando o trabalhador bate no limite de tokens', "Porquê: recuperar o sintoma do cenário D2 sem trocar de modelo (E07 sugere trocar; mudaria família/custo sem aviso). Mesmo modelo, um degrau abaixo na própria escada, nota de 'inspecione o estado e termine direto', banner avisa; só caminhos em primeiro plano; retryOnTokenLimit."),
 ('D04', 'Veredicto estruturado pela ferramenta structured_output do DSH', "Porquê: texto na 1ª linha é frágil em modelos pequenos (achado 4 da validação 0.1.0) e pode ser imitado por texto da área de trabalho (E12); o seam do DSH é cooperativo, sem tool_choice forçado (que dá 400 com raciocínio ligado, E09). O plugin renderiza o relatório (verdict-first por construção); texto verdict-first como reserva; sem veredicto válido => UNREVIEWED com as notas do revisor."),
 ('D05', 'Reconciliação do veredicto (o relatório não contradiz a si mesmo)', "Porquê: cenário F da 0.1.0 (revisor aprovou comportamento falho). Aprovação ao lado de critério FAILED/UNVERIFIED => NOT_RESOLVED (contradição, não julgamento); sem verificação registrada, com bloqueio ou lista de mudanças discordante => mantém e leva Caution. Só as contradições rígidas mudam o veredicto, para não repetir a falsa rejeição que E02 mede."),
 ('D06', 'Revisão em contexto limpo (reviewerContext auto|isolated|claims)', "Porquê: E02/E03/E09 (ancoragem na narrativa do autor) x dossiê 2026-09-30 (evidência disputada). auto: impressão git (caminho->hash do conteúdo) antes/depois do trabalhador; árvore mudou => revisor recebe a tarefa + fatos medidos, SEM o relatório; não mudou (pergunta/pesquisa) => relatório como alegação não confiável. Sem git/erro => claims. Permite o A/B de ancoragem que os estudos propõem."),
 ('D07', 'Pacote do revisor delimitado, defanged e higienizado', "Porquê: o pacote alimenta uma decisão de aprovação. Tags <task>, <workspace_facts>, <untrusted_worker_report>; ocorrências dentro de texto não confiável são desarmadas; sanitize remove ANSI/OSC, controle, zero-width e bidi override (E09, E05, E12: incidente ANSI jqwik). Também no relatório da entrega UNREVIEWED."),
 ('D08', 'Persona 2.0 (~9,3k caracteres)', "Porquê: regras novas com fonte: ordem de autoridade (E09); descoberta dos comandos AGENTS.md>CI>Makefile>manifesto>diretórios (E10); timeout e sem mascarar código de saída (E10,E12); triagem de falha contra o commit base em worktree temporário, nunca stash/reset (E10,E12); vigiar testes/runner/CI enfraquecidos (E12); verificado vence estilo (E05,E07,E08,E10); parar quando os checks decisivos passaram e não reverter o que já passa (E01,E05); saída hostil e sem segredos (E12); negação de sandbox disfarçada (E14, DSH issue 3144). Persona 'compacta' por tamanho de modelo ficou para experimento."),
 ('D09', 'Sinalização de arquivos de teste, runner e CI alterados', "Porquê: o trabalhador pode 'passar' enfraquecendo o verificador (E12). A medição de D06 lista no pacote os arquivos de teste/runner/CI mudados e a persona manda ler cada diff; sensitivePaths acrescenta globs. Não se rejeita o patch (N03) porque quebraria 'adicione testes'."),
 ('D10', 'Contrato de handoff do trabalhador em até 400 palavras', "Porquê: E03. Continua sendo a entrega no caso UNREVIEWED e o insumo do modo claims."),
 ('D11', 'Conhecimento de modelos no diálogo (alias, família, notas)', "Porquê: deepseek-v4-pro na API oficial executa o V4.1 Flash desde 2026-09-14 (aviso oficial), então V4-Pro de trabalhador + V4.1 Flash de revisor é falsa segunda opinião. O diálogo ANOTA, não esconde (o catálogo é do usuário): mesma linhagem entre grafias de provedor, mesma família como dica (nunca bloqueio), até 2 notas datadas por modelo/papel. Linhas de MODEL_PROFILES com verifiedAt e fontes."),
 ('D12', 'Custo e espera da revisão visíveis', "Porquê: E02,E07,E08,E13 (previsibilidade). Linha fixa 'cerca do dobro de custo e espera por delegação'; números dos estudos não são reproduzíveis e o DSH zera a metadata de custo do pi-ai."),
 ('D13', 'Bloco de esforço recolhido; escolha explícita chega ao host', "Porquê: E07/E13 (escolhas demais no envio geram reflexo de dispensa). 'Recomendado: Medium' vem do mesmo cálculo do host (adviseEffort/planChild -> chooseEffort/capFor) com a escada do catálogo do navegador. workerEffort e reviewer.effort viajam no fio (opcionais, configs da 0.1.0 continuam carregando)."),
 ('D14', 'Modelo de segurança e limites documentados', "Porquê: o revisor EXECUTA código não confiável com o preset da sessão (E12; DSH 853/1769/3144 em E14). README/DESIGN dizem o que o plugin faz e o que NÃO faz (sem sandbox, sem filtro de rede, sem controle do ambiente), que APPROVED não é garantia e que operações críticas pedem decisão humana depois."),
]
for did, title, why in D:
    rec('episodic', f'decisao/{did}', f'decisao,{did.lower()},0.2.0,porque',
        f"2026-10-03 {did} (adotada, versão 0.2.0): {title}. {why} Detalhe completo em docs/estudos/decisoes.md#{did.lower()}.",
        source='docs/estudos/decisoes.md')

N = [
 ('N01', 'Extinguir APPROVED_WITH_FIXES (revisor só lê)', 'E02 (E04/E11 só para o MiMo). Mantido: o conserto de defeito provado é requisito do produto e seis estudos o admitem com limites; a evidência de E02 pede contenção (regras 7-8, lista de arquivos, D09). Reabrir com reviewerMayFix:false se houver edição fora de escopo.'),
 ('N02', 'Veredicto JSON com nonce de sessão', 'E12. structured_output já fecha o vetor "veredicto copiado de arquivo"; contra injeção obedecida o nonce não ajuda (está no contexto do modelo).'),
 ('N03', 'Rejeitar/congelar diffs em diretórios de teste', 'E12. Quebraria "adicione testes"; adaptado em D09 (sinalizar e exigir leitura). Mount read-only dos testes é do host.'),
 ('N04', 'Isolamento de SO (microVM/gVisor, rede negada, segredos intermediados)', 'E12. Fora da autoridade de um plugin; documentado em D14. Reabrir com provedor de subagente isolado no DSH.'),
 ('N05', 'Revisor visual (Playwright, marcas numeradas, árvore de acessibilidade, diff perceptual) e roteamento por imagem', 'E06,E05,E07. Exige ferramenta de navegador e revisor multimodal: funcionalidade nova, não correção. O diálogo informa GLM 5.3 só texto, MiMo ultraspeed, Gemini 3.8 Flash multimodal rápido.'),
 ('N06', 'Trocar o modal por barra de chips e presets', 'E13,E07. Slot de barra no compositor não verificado na 0.1.6-alpha.2; presets exigem resolver ids no catálogo de cada usuário. Mitigações: Recomendado por padrão, escolha lembrada, /orquestrar.'),
 ('N07', 'Roteamento preditivo por sinais do repositório e perguntar só quando vale', 'E07,E13. Sem dados de custo/telemetria para validar heurística.'),
 ('N08', 'Fixar provedor do OpenRouter/desligar fallbacks/ZDR/:exacto', 'E08. DSH marca openRouterRouting como withhold; é configuração de settings.yaml e depende do DSH.'),
 ('N09', 'Pipeline de catálogo de modelos (OpenRouter, models.dev, LiteLLM, Epoch, LMArena)', 'E11. Infraestrutura de CI, não do plugin; MODEL_PROFILES é pequeno, datado e com fontes.'),
 ('N10', 'Catálogo de 14 cargos, topologia de 4 estágios, enxame de leitura', 'E03,E04. O plugin embrulha a delegação existente; planejar decomposição é do agente principal ou de outro plugin.'),
 ('N11', 'Deny-list estática de ferramentas para o revisor', 'E12,E15. tools.restrict falha com nomes desconhecidos (ver dsh/toolfilter-nomes-desconhecidos).'),
 ('N12', 'Interceptor max->xhigh no OpenRouter', 'E01. Não reproduzido (HTTP 200 para max em 2026-10-03).'),
 ('N13', 'Escala numérica 1-100 e max_thinking_tokens', 'E01,E03,E05,E11,E13. DSH usa escada nomeada; sem max_thinking_tokens; equivalentes D01/D02.'),
 ('N14', 'Cross-family obrigatório e comitê de revisores baratos', 'E02. Cross-family é dica (ambientes de um fornecedor só); comitê nunca foi o desenho.'),
 ('N15', 'Suprimir a revisão automaticamente (diff pequeno, só doc, oráculo determinístico) e revisar em duas passagens', 'E02,E03,E09. O usuário liga a revisão; a dica de custo orienta; duas passagens pedem medição.'),
 ('N16', 'Escolher o modelo do orquestrador e editar a configuração do usuário', 'E01-E12 divergem GLM 5.3 x Sonnet 5.5. Plugin entrega inerte; ~/.dsh/settings.yaml é do usuário e não foi tocado. Observação: agent-default-model com reasoningEffort max em modelos que E02 mede melhor em high/xhigh; GLM 5.3 principal travou >8 min em max.'),
]
for nid, title, why in N:
    rec('semantic', f'decisao/{nid}-nao-adotada', f'decisao,{nid.lower()},0.2.0,nao-adotada',
        f"{nid} NÃO adotada/adiada (2026-10-03): {title}. Estudos e motivo: {why} Detalhe em docs/estudos/decisoes.md#{nid.lower()}.",
        source='docs/estudos/decisoes.md')

# ---------------------------------------------------------------- procedimentos
rec('procedural', 'proc/validar-no-trio', 'procedimento,validacao,e2e,modelos',
    "Validar o plugin ao vivo SÓ com os 3 modelos definidos (GLM 5.3 principal, DeepSeek V4.1 Flash subagente, MiMo-V2.6-Pro revisor): (1) DSH_HOME isolado com cópia do settings.yaml (só nomes de variável, chaves vêm do ambiente via `. ~/.zshenv`), "
    "agent-default-model = openrouter z-ai/glm-5.3 com reasoningEffort high (em max o principal travou >8 min); (2) `dsh plugin --profile headless add link:<repo>` e o mesmo para web; (3) ORQ_VALIDATION_ROOT=/tmp/orq-validation-local scripts/e2e/run-trio.sh T1 T2 T3 [T4] "
    "(guarda: exit 3 se algum modelo fora do trio aparecer); (4) cada run grava summary.md e sessions.md (scripts/e2e/session-config.mjs lê o cabeçalho de requisição de cada sessão: rota, esforço, maxTokens, structured_output, modo do pacote); "
    "(5) navegador: dsh web --port 0 --no-open, DSH_URL com token só no ambiente, `PHASE=effort|command|small|light|cancel|confirm node ui-e2e.mjs` com playwright-core (ex.: ~/Projects/demovid/node_modules) e Chrome do sistema. "
    "NUNCA rodar run-trio e fases de navegador ao mesmo tempo: a GUI usa o último workspace registrado e compartilha a árvore (contaminou o T4 uma vez).",
    source='scripts/e2e/run-trio.sh; scripts/e2e/ui-e2e.mjs', entities='dsh-orquestrator')
rec('procedural', 'proc/atualizar-model-profiles', 'procedimento,modelos,estudos',
    "Atualizar o conhecimento de modelos: (1) copiar o novo estudo para docs/estudos/fontes/E<nn>-<slug>.md com os bytes originais e registrar o sha256 em docs/estudos/README.md; (2) checar o que ele afirma contra o código do DSH e contra dados públicos "
    "(aviso do fornecedor, OpenRouter /api/v1/models, uma chamada real barata); (3) só então editar src/models.ts: linha nova ou ajustada com verifiedAt (ISO) e sources; teto <= high; nota nova => chave note.<id> nos 3 idiomas (src/client/locales.ts; "
    "test/unit/locales.test.ts falha se faltar); (4) tests: models.test.ts, effort.test.ts, catalog.test.ts; (5) registrar a decisão em docs/estudos/decisoes.md e na memória. Conselho sem data e sem fonte não entra.",
    source='src/models.ts; docs/estudos/README.md')
rec('procedural', 'proc/portoes-de-qualidade', 'procedimento,build,testes',
    "Portões: `pnpm run typecheck`; `pnpm test` (node --test, sem DSH_CHECKOUT pula 17 contratos); `DSH_CHECKOUT=$HOME/Projects/deepseek-harness pnpm test` inclui os contratos que fixam as costuras do DSH 0.1.6-alpha.x; `pnpm run build` regenera lib/ (commitado de propósito: instalação por git não compila). "
    "`pnpm run check:lib` compara lib/ com o git HEAD depois de um build novo, então só passa depois do commit; antes do commit prove a reprodutibilidade construindo duas vezes e comparando sha256 (o build é determinístico).",
    source='package.json; scripts/check-lib.mjs')
rec('procedural', 'proc/ler-sessoes-do-dsh', 'procedimento,dsh,sessoes',
    "Sessões do DSH ficam em $DSH_HOME/sessions/<cwd com / virando ->/session-<uuid>/session.v3.jsonl.zstd (zstd -dc). Eventos úteis: `request/header` (data.header.config = provider, model, reasoningEffort, maxTokens; data.header.tools = nomes das ferramentas, inclui structured_output no revisor), "
    "`tool/call` (arguments como string JSON), `agent/inbox/spliced` (primeiro prompt de um filho: é o pacote de revisão), `session` (primeira linha: parentSession/origin). Filhos têm parentSession = id da principal. Nunca imprimir chaves; as sessões só têm prompts e chamadas.",
    source='scripts/e2e/session-config.mjs')

# ---------------------------------------------------------------- eventos
rec('episodic', 'evento/2026-10-03-estudos-recebidos', 'evento,estudos,0.2.0',
    "2026-10-03: o dono pediu 'analise todas as documentações e faça todos os fix seguindo os estudos para esse plugin do dsh' e 'documente no plugin e na memória o conhecimento e o porquê das mudanças'. "
    "Recebidos 16 estudos (13.md e 14.md idênticos). Resultado: versão 0.2.0 com D01-D14 adotadas e N01-N16 não adotadas, docs/estudos/ (README, sintese, decisoes, fontes), README en/pt-BR, DESIGN, CHANGELOG, memória CoALA local. "
    "Ordem de trabalho: ler tudo -> checar contra o código do DSH e dados públicos -> decidir -> implementar com testes -> validar ao vivo -> documentar.",
    source='conversa 2026-10-03')
rec('episodic', 'evento/2026-10-03-execucoes-fora-do-trio-descartadas', 'evento,validacao,descartado',
    "2026-10-03: antes da regra do dono, execuções exploratórias usaram outros modelos (principal DeepSeek V4.1 Flash no Azure, subagente Gemini 3.8 Flash, revisor Claude Haiku 4.5; fase confirm do navegador também). "
    "Foram descartadas (evidência apagada e NÃO citada): só contam as execuções com o trio. Lição: restringir os modelos no script (run-trio.sh) e não só na intenção.",
    source='conversa 2026-10-03')
rec('episodic', 'evento/2026-10-03-t4-contaminado-e-refeito', 'evento,validacao,licao',
    "2026-10-03: o T4 (política desligada) foi contaminado porque a fase `confirm` do navegador rodou ao mesmo tempo: a GUI usa o último workspace registrado em $DSH_HOME/storages e criou wordcount.* na árvore do T4. "
    "Refeito sozinho. Regra: nunca misturar execuções headless e do navegador no mesmo DSH_HOME ao mesmo tempo; session-config.mjs agora filtra pela sessão principal.",
    source='conversa 2026-10-03')

rec('episodic', 'evento/2026-10-03-validacao-no-trio', 'evento,validacao,trio,0.2.0',
    "2026-10-03 validação ao vivo da 0.2.0 SÓ com GLM 5.3 (principal, high), DeepSeek V4.1 Flash (subagente) e MiMo-V2.6-Pro (revisor), DSH 0.1.6-alpha.2 ddefc45, build lib/index.js sha256 e0e707bf..., 259/259 testes. "
    "T1 (7 regras): trabalhador medium/64000 28 s, revisor medium/32000 169 s, contexto limpo, APPROVED, 255 s total. T2 (requisitos conflitantes): NOT_RESOLVED nomeando o conflito, 112 s. T3 (pergunta só de leitura): árvore inalterada => relatório como alegação, APPROVED, 135 s. "
    "T4 (T1 com effort:false e limits:false): trabalhador max/384000 63 s, revisor max/131072 128 s, APPROVED, 259 s: a causa-raiz medida. Navegador: effort 19/19, command 6/6, small 3/3, light 5/5, cancel 11/11, confirm 13/13 (delegação real GLM->DeepSeek->MiMo: trabalhador medium/64000 15 s, revisor medium/32000 42 s). "
    "Não se mediu ganho de velocidade (255 s x 259 s; amostra única); o teto protege a cauda. Não cobertos: parada por limite de tokens (retry só em teste unitário), fallback de texto, fork, TUI/SDK, macOS. Evidência em docs/validation/README.md.",
    source='docs/validation/README.md; docs/validation/runs/T1..T4', entities='dsh-orquestrator,GLM 5.3,DeepSeek V4.1 Flash,MiMo-V2.6-Pro')
rec('episodic', 'evento/2026-10-03-revisor-pegou-erro-no-prompt-do-principal', 'evento,validacao,revisor,licao',
    "2026-10-03, T1 primeira rodada: o GLM 5.3 (principal) escreveu no PRÓPRIO prompt de delegação `parseDuration('1d 2h 30m 45s') -> 97545` (a tabela de unidades dá 95445). O revisor MiMo-V2.6-Pro, em contexto limpo, verificou tudo (16/16 testes) e devolveu NOT_RESOLVED com a contradição na linha do veredicto "
    "para o principal/usuário decidir. É o tipo de erro que a revisão independente existe para pegar; o principal pode errar na própria tarefa. Na segunda rodada o principal não repetiu o erro (variação entre execuções).",
    source='docs/validation/runs/T1-first-build.md')
rec('semantic', 'validacao/limites-honestos', 'validacao,limites,cuidado',
    "Ao citar a validação da 0.2.0: não alegar ganho de velocidade (T1 255 s x T4 259 s; trabalhador mais rápido em medium 28 s x 63 s, revisor mais lento 169 s x 128 s; amostra única; tarefa pequena não provoca laço). O valor do teto é limitar a cauda (laço de raciocínio, orçamento esgotado), "
    "e o que se provou foi o valor chegando ao fio (cabeçalho de requisição). Retry por limite de tokens e fallback de texto só têm teste unitário. Máquina: Linux; rota DeepSeek oficial não usada (Azure serviu o V4.1 Flash).",
    source='docs/validation/README.md')
rec('semantic', 'validacao/principal-glm-em-max-travou', 'validacao,glm,config',
    "Para validar com o GLM 5.3 como agente principal use reasoningEffort high: em max a primeira chamada de ferramenta não saiu em 8,4 min (execução interrompida); em high saiu em ~10 s. O plugin não altera o principal; vale como recomendação de configuração ao dono (E01 recomenda high).",
    source='validação local 2026-10-03')

# ---------------------------------------------------------------- executar
def main():
    import os
    failures = 0
    for r in R:
        cmd = COALA + ['add', '--type', r['type'], '--content', r['content'], '--key', r['key'], '--tags', r['tags'],
                       '--origin', r['origin'], '--source', r['source']]
        if r.get('entities'):
            cmd += ['--entities', r['entities']]
        out = subprocess.run(cmd, capture_output=True, text=True)
        if out.returncode != 0:
            failures += 1
            sys.stderr.write(f"FALHOU {r['key']}: {out.stderr.strip()[:300]}\n")
    print(f"{len(R) - failures}/{len(R)} registos gravados")
    sys.exit(1 if failures else 0)

if __name__ == '__main__':
    main()
