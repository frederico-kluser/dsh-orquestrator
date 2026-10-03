Protocolo de Descoberta e Verificação Autônoma para o Harness dsh-orquestradorA integração de agentes autônomos de revisão em harnesses de engenharia de software exige a convergência entre orquestração de modelos fundacionais e heurísticas determinísticas de validação de código. No ecossistema do dsh-orquestrador, o revisor independente atua como barreira estrita de contenção imediatamente após a conclusão do subagente de execução, garantindo que nenhum artefato de código seja promovido ao agente principal sem validação executável.Para que essa arquitetura funcione de maneira sustentável em repositórios corporativos reais, o harness deve conciliar a seleção de modelos com uma descoberta confiável de comandos de teste, análise de impacto de regressões e mitigação de ruídos estocásticos de infraestrutura.Auditoria dos Sintomas Observados e Avaliação Comparativa de ModelosA alocação criteriosa de modelos depende de métricas de vazão, latência e custo por milhão de tokens. A tabela abaixo sintetiza os dados operacionais coletados até outubro de 2026:ModeloPapel AvaliadoCusto / 1M Tokens (Entrada / Saída)Throughput & Latência TTFTEvidência Empírica & StatusRotulagem da AfirmaçãoXiaomi MiMo-V2.6-ProRevisor multimodal / visualUS$ 0,435 / US$ 0,870 (Hit cache: US$ 0,0036)45,5 t/s; TTFT p95 de 47,2s a 47,7s (endpoint padrão)MoE 1T total / 42B ativos. Índice Artificial Analysis: 46,3. Raciocínio consome 44,1s antes do primeiro token. Modo UltraSpeed atinge até 20x mais velocidade.[Medição independente] Artificial Analysis (24/09/2026); [Alegação do fornecedor] Xiaomi (22/09/2026).DeepSeek V4.1 FlashCodificador rápido (Worker)US$ 0,015 / US$ 0,677 (OpenRouter)211 t/s (máx); TTFT de 1,01s a 1,54sMoE 552B / 16B saída, arquitetura Causal Encoder-Decoder. SWA Bounded Replay reduz KV cache em 4x. Substituiu oficialmente o V4-Pro.[Alegação do fornecedor] DeepSeek (10/09/2026); [Medição independente] Artificial Analysis (Setembro/2026).DeepSeek V4-ProCodificador / FlagshipDescontinuado / Roteado[cite: 17, 18]Indisponível como endpoint isoladoDescontinuado pela DeepSeek em 14/09/2026; requisições são roteadas para o V4.1-Flash a preços de Flash.[Alegação do fornecedor] DeepSeek API Docs (10/09/2026).Z.ai GLM 5.3Orquestrador principalUS$ 1,00 / US$ 2,00 (referência API)~115 t/sÍndice de Inteligência Artificial Analysis: 45. Ganho de 50% sobre GLM 5.2 no Z.ai Code Bench privado.[Medição independente] Artificial Analysis (Agosto/2026); [Alegação do fornecedor] Z.ai Blog (Agosto/2026).Z.ai GLM 5.3 FlashOrquestrador leve / TriagemUS$ 0,026 / US$ 0,928~140 t/s320B total / 18B ativados. Índice de Inteligência Artificial Analysis: 42.[Alegação do fornecedor] Z.ai Guides (Setembro/2026); [Medição independente] OpenRouter (Setembro/2026).Google Gemini 3.8 FlashCodificador / Validador velozUS$ 0,75 / US$ 3,75 (Introdutório até 31/12/2026)305,1 t/s; TTFT de 13,30sDeepSWE v1.1: 73,7%. Terminal-Bench: 89,4%. Inteligência: 40,9. TTFT de 13,3s reflete raciocínio prévio.[Alegação do fornecedor] Google DeepMind (02/09/2026); [Medição independente] eesel AI / Artificial Analysis (Setembro/2026).Anthropic Claude Sonnet 5.5Orquestrador de Alta FidelidadeUS$ 3,00 / US$ 15,00 (referência base)Médio (~60–80 t/s)Raciocínio adaptativo com controle de esforço. Liderança consistente em tarefas complexas de engenharia de software.[Alegação do fornecedor] Anthropic (28/09/2026).Anthropic Claude Haiku 4.5Revisor Sintático / FormatadorUS$ 0,25 / US$ 1,25 (referência base)>150 t/sElevada aderência a instruções de formato estruturado e baixa alucinação sintática.[Alegação do fornecedor] Anthropic (Setembro/2026).Moonshot Kimi K3Raciocínio Lógico / AlgorítmicoUS$ 0,30 / US$ 1,00 (referência OpenRouter)~80 t/sMoE de pesos abertos com 2,8T parâmetros. Baseado em Kimi Delta Attention. Topo em finanças e lógica simbólica.[Alegação do fornecedor] Moonshot AI (2026); [Medição independente] Artificial Analysis (Setembro/2026).O diagnóstico empírico dos sintomas observados nos testes revela causas estruturais bem documentadas na literatura de sistemas de inferência. A latência prolongada de aproximadamente dois minutos por turno no MiMo-V2.6-Pro decorre da fase de raciocínio oculta no endpoint oficial da Xiaomi. Medições da Artificial Analysis apontam um Time to First Token (TTFT) de 47,2 a 47,7 segundos para entradas de 10 mil tokens, dos quais 44,1 segundos são consumidos exclusivamente no processamento do fluxo de pensamento prévio à emissão. Somando-se a isso uma vazão moderada de 45,5 tokens por segundo, uma resposta de revisão com 1.500 a 2.000 tokens consome mais de 40 segundos na fase de decodificação, consolidando o ciclo de dois minutos. Provedores serverless alternativos como PrimaLabs atingem 407 tokens por segundo com TTFT de 5,6 segundos, enquanto a Xiaomi disponibiliza a variante mimo-v2.6-pro-ultraspeed para fluxos sensíveis à latência.O esgotamento de limites de contexto decorrente de ciclos de "overthinking" em workers rápidos — como o DeepSeek V4.1 Flash — decorre da mecânica de raciocínio contínuo não calibrado. Na presença de condições de contorno numéricas complexas sem limites explícitos de profundidade analítica, o modelo reavalia hipóteses repetidamente, gerando cadeias autoregressivas redundantes até atingir a exaustão da janela de contexto. A solução consiste em restringir formalmente a propriedade reasoning_effort para níveis intermediários (entre 30 e 50 em uma escala de 100) para tarefas operacionais de codificação.A reprodução mecânica de etapas do prompt como títulos e a aprovação de saídas incorretas motivadas por restrições de estilo refletem uma patologia comum em modelos compactos denominada conflito de hierarquia de instruções (Instruction Conflict). Quando regras cosméticas ou diretrizes estruturais recebem proeminência no prompt do sistema ou do usuário, modelos com menor capacidade de abstração priorizam a conformidade com a apresentação visual em detrimento da verificação da lógica de programação. Para sanar essa falha, é necessário aplicar o padrão SysHint, encapsulando as exigências cosméticas em tags isoladas e declarando que a integridade semântica do código anula qualquer preferência estética.A validação crítica das premissas de arquitetura indica que o MiMo-V2.6-Pro não é viável para loops rápidos de revisão textual de código devido à sua latência de pensamento, mas se mostra adequado para auditoria visual de renderizações e interfaces de usuário. O GLM 5.3 sustenta-se como orquestrador competente para decomposição de tarefas, embora o Claude Sonnet 5.5 ofereça controle adaptativo superior para projetos densos e o GLM 5.3 Flash ofereça custo muito inferior para fluxos rotineiros. Por fim, o DeepSeek V4.1 Flash valida-se plenamente como codificador ágil devido ao custo mínimo de entrada e throughput de 211 tokens por segundo, consolidando a descontinuação definitiva do DeepSeek V4-Pro.Algoritmo Hierárquico de Descoberta de VerificaçõesA identificação autônoma de comandos de teste, análise estática e construção deve seguir uma ordem estrita de precedência baseada no nível de confiança do artefato de configuração. Sinais declarados explicitamente por humanos para consumo de agentes de inteligência artificial sobrepõem-se a scripts inferidos que possam disparar comandos interativos ou destrutivos.NívelFonte de ConfiguraçãoGrau de ConfiançaHeurística de Extração e ValidaçãoRiscos e Modos de Falha1Metadados para Agentes (AGENTS.md, CLAUDE.md, .claude/rules)Muito AltaLeitura direta de blocos que listam rotinas de build, teste, tipagem e formatação. O comando deve ser verificado contra manifestos locais antes do disparo.Desatualização semântica em repositórios antigos, onde instruções orientam comandos que não existem mais.2Workflows de CI (.github/workflows/*.yml, .gitlab-ci.yml)AltaVarrer declarações run: associadas a etapas de test, lint, typecheck e build, isolando variáveis de ambiente locais.Dependência de segredos indisponíveis, imagens Docker de infraestrutura remota ou acoplamento a matrizes de execução.3Orquestradores de Automação (Makefile, justfile, Taskfile)Média-AltaIdentificar alvos padronizados (make test, make check, make verify-all, make lint).Alvos que exigem interação no terminal (read -p) ou executam scripts com efeitos colaterais em infraestrutura compartilhada.4Manifestos Declarativos da Linguagem (package.json, pyproject.toml, Cargo.toml)MédiaExtração de chaves semânticas padrão (scripts.test, scripts.typecheck, scripts.lint ou seções [testenv] do tox).Scripts de modelo gerados por assistentes que apenas ecoam mensagens vazias (ex: echo "Error: no test specified" && exit 1).5Heurística Estrutural de Frameworks (pytest, vitest, cargo test, go test)BaixaDetecção de diretórios convencionais (tests/, spec/) e execução de binários padrão do ecossistema.Execução cega de suítes de ponta a ponta não preparadas para isolamento local, provocando timeouts ou sujeira de dados.Em estruturas monorepo operadas com ferramentas como Turborepo, Nx ou pnpm workspaces, invocar comandos de teste a partir da raiz costuma provocar falhas sistêmicas ou consumo desnecessário de recursos em pacotes não afetados. O revisor deve mapear as modificações geradas pelo subagente por meio de git diff --name-only, identificar o pacote de escopo e restringir a execução ao diretório correspondente via parâmetros declarativos (tais como pnpm --filter <pacote> test ou nx affected --target=test).Em projetos poliglotas, onde linguagens distintas convivem no mesmo repositório, o agente deve isolar os pipelines de cada stack, prevenindo que alterações restritas ao frontend em TypeScript acionem verificações pesadas de código Go ou Rust. Quando o repositório não dispõe de testes estruturados, o revisor deve interromper imediatamente a busca por harnesses e executar verificações de compilação estática, linters e checadores de tipos (tsc --noEmit, cargo clippy, flake8).Test Impact Analysis (TIA) vs. Execução Integral da SuíteA literatura em engenharia de software demonstra que a seleção de testes por impacto (Regression Test Selection - RTS) reduz o tempo de máquina em 50% a 80% nos ciclos de integração contínua. Contudo, essa economia introduz o risco tangível de que defeitos passem despercebidos (escaped regressions).Abordagem de SeleçãoRedução de Tempo / CustoTaxa de Regressões EscapadasVulnerabilidades Críticas de EscapeSuíte Integral (Full Run)0% (Base de custo máximo)0% (Determinístico na cobertura existente)Inviável em monorepos; frequentemente excede limites de tempo de sessão de agentes.TIA Dinâmica (Call Graphs em Runtime)[cite: 54, 56]50% a 80% de redução1% a 4% de escape em bases Java/PythonFalha em rastrear polimorfismo dinâmico, metaprogramação, injeção de dependência e triggers de banco de dados.TIA Estática Baseada em Arquivos[cite: 4]70% a 90% de redução6% a 15% de escapeIncapaz de detectar acoplamento indireto por contratos de tipos compartilhados ou variáveis de ambiente.TIA Assistida por Grafo (TDAD / GraphRAG)[cite: 3]60% a 75% de redução1,82% de falhas P2P (redução de 70% frente a 6,08% sem grafo)Evasão conservadora de agentes, gerando patches vazios ao detectar alto risco de regressão.Investigações recentes em agentes autônomos no benchmark SWE-bench Verified apontam o chamado "Paradoxo do Prompting TDD": instruir o agente a criar e validar testes sem fornecer um mapa de dependências em grafo eleva a taxa de regressão de 6,08% para 9,94%. Em contrapartida, quando técnicas de análise de impacto por grafos (como TDAD) orientam o agente sobre quais nós estão sob risco, a incidência de regressões cai para 1,82%.Para balancear agilidade e rigor, o dsh-orquestrador deve adotar uma política de verificação em duas etapas. Na etapa de triagem de impacto, executa-se exclusivamente o subconjunto de testes associado aos arquivos tocados no diff. Se qualquer teste falhar, o erro está provado mecanicamente, autorizando o ciclo de correção. Se a etapa de triagem for concluída com êxito, avança-se para a etapa de certificação de escopo: em repositórios pequenos a médios, executa-se a suíte completa antes de chancelar o veredicto APPROVED; em monorepos complexos, a validação é estendida apenas aos pacotes dependentes diretos identificados no grafo estrutural.Políticas Operacionais: Orçamento, Timeouts e Gestão de Testes InstáveisA operação contínua do revisor sem restrições de tempo compromete a responsividade da interface e pode acarretar custos operacionais imprevistos de inferência. A tabela a seguir estabelece as diretrizes de governança por porte de base de código:Porte do ProjetoEscopo de Linhas de Código / ArquivosTimeout por ComandoTeto de Tokens de Raciocínio por TurnoCusto Máximo Alocado por TarefaAção em Caso de TimeoutPequeno< 10k LOC / < 50 arquivos60 s (Máx. 3 min total)8.000 tokensUS$ 0,05Abortar via SIGKILL, emitir TIMED_OUT e concluir como NOT_RESOLVED.Médio10k–100k LOC / 50–500 arquivos180 s (Máx. 8 min total)16.000 tokensUS$ 0,25Encerrar suíte global e tentar execução focada no pacote modificado por mais 60 s.Grande / Monorepo> 100k LOC / > 500 arquivos300 s (Máx. 15 min total)32.000 tokensUS$ 0,80Bloquear suítes amplas e restringir a verificação exclusivamente ao pacote afetado.Testes instáveis (flaky tests) corroem a confiabilidade de harnesses autônomos. Para separar defeitos reais inseridos pelo subagente de oscilações estocásticas de temporização, rede ou concorrência, o revisor deve seguir um fluxo estrito de triagem e diagnóstico diferencial:Reexecução Isolada Local: Qualquer teste que falhe na primeira execução deve ser repetido isoladamente até duas vezes no mesmo ambiente de execução (runMode: 2). Se o teste for aprovado em qualquer uma das tentativas sem que o código tenha sido modificado, a falha é classificada como ruído de ambiente (FLAKY_CONCURRENCY ou FLAKY_TIMING) e não bloqueia a conclusão do subagente.Diagnóstico Diferencial no Commit Ancestral (Merge-Base): Se a falha persistir após as reexecuções locais, o revisor deve verificar se o teste já se encontrava quebrado na base branch:BashBASE_COMMIT=$(git merge-base HEAD origin/main)
git checkout $BASE_COMMIT -- <caminho_do_arquivo_de_teste>
<comando_de_teste_isolado>
git checkout HEAD -- <caminho_do_arquivo_de_teste>
Caso o teste também falhe no código-base limpo anterior à tarefa, a falha é comprovadamente preexistente (PRE_EXISTING_DEFECT), não devendo ser imputada ao trabalho do subagente. Se o teste passar no código ancestral e falhar de forma persistente no workspace de trabalho, comprova-se uma regressão legítima (GENUINE_REGRESSION), exigindo correção ou a emissão do veredicto NOT_RESOLVED.Limite Estatístico de Incerteza Residual: Assumindo um modelo binomial de taxa de falha constante, a probabilidade de falha oculta $p$ após $n$ sucessos consecutivos é dada por:
$$p_{\text{upper}} = 1 - 0{,}05^{1/n}$$
Mesmo após três sucessos em retries sucessivos, a incerteza residual permanece estatisticamente em 63,1%, o que demanda o registro preventivo do teste instável no relatório para análise futura.Ambientes Inoperantes, Síntese de Testes e Declaração HonestaA escrita autônoma de novos testes não deve ocorrer de maneira indiscriminada. O revisor está autorizado a sintetizar um teste unitário restrito (micro-test fixture) estritamente nas seguintes situações: ausência total de suíte de testes configurada no projeto, impedindo a verificação de regras de negócio puras; indisponibilidade de dependências externas complexas que inviabilizem a suíte integral; ou necessidade de isolar e comprovar um caso de borda numérico ou algorítmico específico. O teste sintetizado deve ser criado obrigatoriamente em diretórios temporários ou no scratchpad da sessão (/tmp/dsh_verify_*), sem acoplar mocks complexos que simulem a implementação do subagente, e deve ser destruído após o ciclo de validação, a menos que a própria tarefa exija a inclusão do teste na base de código.Quando um ambiente de execução falha em subir por falta de conectividade, carência de contêineres ou ausência de variáveis de ambiente obrigatórias, o revisor nunca deve conceder aprovação com base em plausibilidade visual ou estilística. Sob impossibilidade de validação executável, o veredicto na primeira linha deve ser compulsoriamente NOT_RESOLVED ou o estado explícito ABSTAINED_UNVERIFIED. O parecer deve detalhar formalmente a categoria do bloqueio:ENV_DEPENDENCY_RESOLUTION_FAILED: Falha na resolução de dependências por ferramentas de gerenciamento de pacotes (npm, pip, cargo).ENV_SERVICE_UNAVAILABLE: Indisponibilidade de serviços auxiliares locais (ex: portas de banco de dados inacessíveis).ENV_CREDENTIAL_MISSING: Inexistência de chaves de autenticação ou variáveis de ambiente exigidas pela inicialização da aplicação.SYNTAX_LINT_ONLY: Conclusão positiva de linters e validadores de tipo, mas com execução funcional bloqueada pela infraestrutura.Checklist de Relatório de VerificaçãoA comunicação do revisor com o agente principal deve seguir um esquema estruturado e auditável:[ ] Veredicto na Primeira Linha: Conter estritamente um dos seguintes estados válidos: APPROVED, APPROVED_WITH_FIXES ou NOT_RESOLVED.[ ] Metadados de Execução: Declarar o comando completo utilizado na descoberta, a ferramenta acionada e o diretório de trabalho.[ ] Sumário Quantitativo:Total de testes executados.Quantidade de testes aprovados (passed).Quantidade de testes reprovados (failed).Quantidade de testes descartados ou ignorados (skipped/quarantined).Tempo decorrido de execução em segundos.[ ] Matriz de Evidências Mecânicas:Identificação de arquivo e nome do teste exercitado.Resultado observado (PASSED, FAILED ou FLAKY_DISCARDED).Trecho de erro sanitizado (stderr, limitado a no máximo 15 linhas representativas).[ ] Declaração de Escopo Não Verificado:Identificação dos módulos modificados que não puderam ser exercitados e respectiva justificativa técnica padronizada.Recomendações Estruturadas para o dsh-orquestradorDecisões Recomendadas para o ProdutoAtualização da Tabela de Modelos: Descontinuar a opção DeepSeek V4-Pro no modal da interface web, considerando que a própria DeepSeek retirou o modelo de catálogo e redireciona suas chamadas ao DeepSeek V4.1 Flash. Consolidar o DeepSeek V4.1 Flash como opção padrão para workers rápidos de codificação.Segmentação de Papel para o MiMo-V2.6-Pro: Condicionar a invocação do MiMo-V2.6-Pro exclusivamente a tarefas que envolvam validação visual e componentes de interface (Three.js, Canvas, CSS, imagens de regressão visual do Playwright). Para revisões puramente textuais de código, evitar seu uso ou impor o roteamento para endpoints acelerados (mimo-v2.6-pro-ultraspeed ou provedores serverless otimizados) para mitigar o TTFT de 47 segundos.Integração do Gemini 3.8 Flash como Revisor Principal: Adotar o Gemini 3.8 Flash como motor de revisão rápida de suítes de teste de código devido ao throughput de 305 tokens por segundo e 73,7% de resolução no DeepSWE v1.1.Isolamento de Prompts com Precedência Funcional Obrigatória: Reestruturar os prompts de instrução do revisor subordinando qualquer diretriz de estilo à integridade lógica, prevenindo o fenômeno de aprovação indevida decorrente de conflito de regras.Travamento de Orçamento de Raciocínio (Overthinking Guard): Injetar compulsoriamente limites de esforço de raciocínio (reasoning_effort entre 30 e 50) e tetos fixos de tokens em modelos com suporte a pensamento autoregressivo para conter dispersões cognitivas em casos de borda.O que Continua IncertoReajuste de Preços do Gemini 3.8 Flash: A precificação introdutória de US$ 0,75 / US$ 3,75 encerra-se em 31 de dezembro de 2026, duplicando a partir de 1º de janeiro de 2027 para US$ 1,50 / US$ 7,50, o que alterará o equilíbrio de custo frente a soluções abertas como MiMo e DeepSeek.Estabilidade de Infraestruturas de Baixa Latência para o MiMo: Embora medições demonstrem redução expressiva do TTFT em infraestruturas especializadas, a disponibilidade consistente desses nós sob concorrência pública ainda não possui histórico operacional prolongado.Resolução de Dependências em Monorepos sem Manifestos Estruturados: Repositórios monorepo proprietários desprovidos de ferramentas como Nx ou Turborepo demandam heurísticas manuais, permanecendo suscetíveis a limites de tempo durante a análise de impacto.Três Experimentos de Validação Rápida (1 Dia de Execução)Calibração de Latência e Eficiência do MiMo-V2.6-Pro: Submeter um conjunto fixo de dez revisões de código com defeitos sintéticos conhecidos ao MiMo-V2.6-Pro, comparando o endpoint padrão com a flag mimo-v2.6-pro-ultraspeed, registrando latência por turno e taxa de acerto.Resistência ao Conflito de Estilo vs. Correção Funcional: Executar o GLM 5.3 Flash e o Claude Haiku 4.5 contra um desafio de código com falha lógica grave de estouro de limites, injetando instruções contraditórias de concisão estética. Avaliar se a inclusão da regra de precedência funcional elimina aprovações indevidas.Isolamento de Flaky Tests com Diagnóstico Diferencial: Simular um teste instável com falha estocástica no workspace de trabalho e executar o script de verificação contra o commit base (merge-base), validando se o sistema descarta o ruído e impede a rejeição incorreta do subagente.Bloco de Configuração Consolidado (YAML)YAMLdescoberta:
  - fonte: "AGENTS.md / CLAUDE.md"
    confianca: "muito_alta"
    caminho: [".claude/CLAUDE.md", "CLAUDE.md", "AGENTS.md"]
    acao: "extrair_comandos_declarados_test_lint_build"
  - fonte: "CI Workflows (.github/workflows, .gitlab-ci)"
    confianca: "alta"
    caminho: [".github/workflows/*.yml", ".gitlab-ci.yml"]
    acao: "parse_ast_steps_run_com_palavras_chave"
  - fonte: "Orquestradores Locais (Makefile, justfile)"
    confianca: "media_alta"
    caminho: ["Makefile", "Taskfile.yml", "justfile"]
    acao: "executar_targets_padrao_test_check_verify"
  - fonte: "Manifestos de Pacote (package.json, pyproject.toml, Cargo.toml)"
    confianca: "media"
    caminho: ["package.json", "pyproject.toml", "Cargo.toml", "tox.ini"]
    acao: "ler_campos_scripts_e_testenvs"
  - fonte: "Heuristica Estrutural de Diretorios"
    confianca: "baixa"
    caminho: ["tests/", "__tests__/", "spec/"]
    acao: "invocacao_direta_pytest_vitest_cargo_test"

politica_de_tempo:
  pequeno:
    max_loc: 10000
    timeout_por_comando_segundos: 60
    timeout_total_segundos: 180
    teto_tokens_raciocinio: 8000
    teto_custo_dolar: 0.05
    estrategia_timeout: "abortar_processo_sigkill_e_marcar_not_resolved"
  medio:
    max_loc: 100000
    timeout_por_comando_segundos: 180
    timeout_total_segundos: 480
    teto_tokens_raciocinio: 16000
    teto_custo_dolar: 0.25
    estrategia_timeout: "tentar_execucao_restrita_tia_60s"
  grande_monorepo:
    max_loc: 1000000
    timeout_por_comando_segundos: 300
    timeout_total_segundos: 900
    teto_tokens_raciocinio: 32000
    teto_custo_dolar: 0.80
    estrategia_timeout: "descartar_suite_global_restringir_a_pacotes_afetados"

flaky:
  max_reexecucoes_locais: 2
  verificacao_merge_base: true
  regras:
    - condicao: "passou_em_retry_subsequente"
      classificacao: "FLAKY_TRANSIENTE"
      bloqueia_aprovacao: false
      registrar_alerta: true
    - condicao: "falha_persistente_workspace_e_falha_no_merge_base"
      classificacao: "PRE_EXISTING_DEFECT"
      bloqueia_aprovacao: false
      registrar_alerta: true
    - condicao: "falha_persistente_workspace_mas_passa_no_merge_base"
      classificacao: "GENUINE_REGRESSION"
      bloqueia_aprovacao: true
      registrar_alerta: true
  modelo_risco: "binomial_constant_p_upper_formula"

relatorio:
  primeira_linha_obrigatoria: ["APPROVED", "APPROVED_WITH_FIXES", "NOT_RESOLVED"]
  campos_obrigatorios:
    - comando_executado: "string"
    - diretorio_base: "string"
    - total_executados: "inteiro"
    - total_passados: "inteiro"
    - total_falhados: "inteiro"
    - total_ignorados: "inteiro"
    - duracao_segundos: "float"
    - tabela_evidencias:
        - teste: "string"
          arquivo: "string"
          resultado: "PASSED | FAILED | FLAKY_DISCARDED"
          stderr_resumo: "string (max 15 linhas)"
    - status_nao_verificado:
        possui_abstencao: "boolean"
        motivo: "ENV_DEPENDENCY_RESOLUTION_FAILED | ENV_SERVICE_UNAVAILABLE | ENV_CREDENTIAL_MISSING | NONE"

riscos:
  - "Latencia excessiva do MiMo-V2.6-Pro (TTFT 47s+) caso utilizado em tarefas textuais iterativas"
  - "Risco de overthinking no DeepSeek V4.1 Flash em casos numericos sem teto de raciocinio"
  - "Subordinacao indevida de correcoes a restricoes de estilo em modelos pequenos por conflito instrucional"
  - "Aprovacao indevida por alucinacao de testes em ambientes que nao sobem dependencias"

fontes:
  - id: "xiaomi-mimo-v26-pro-model"
    tipo: "Alegacao do fornecedor"
    url: "https://mimo.mi.com/models/en-US/mimo-v2.6-pro"
    data: "2026-09-22"
  - id: "deepseek-v41-flash-release"
    tipo: "Alegacao do fornecedor"
    url: "https://api-docs.deepseek.com/news/news260910/"
    data: "2026-09-10"
  - id: "deepseek-v41-flash-openrouter"
    tipo: "Medicao independente"
    url: "https://openrouter.ai/deepseek/deepseek-v4.1-flash"
    data: "2026-09-20"
  - id: "artificial-analysis-mimo-v26-latency"
    tipo: "Medicao independente"
    url: "https://artificialanalysis.ai/models/mimo-v2-6-pro/providers"
    data: "2026-09-24"
  - id: "primalabs-mimo-speedup"
    tipo: "Medicao independente"
    url: "https://www.primalabs.ai/blog/mimo-v2-6-pro-faster-output"
    data: "2026-09-24"
  - id: "gemini-38-flash-deepmind"
    tipo: "Alegacao do fornecedor"
    url: "https://deepmind.google/models/model-cards/gemini-3-8-flash/"
    data: "2026-09-02"
  - id: "gemini-38-flash-review-eesel"
    tipo: "Medicao independente"
    url: "https://www.eesel.ai/blog/gemini-3-8-flash-review"
    data: "2026-10-01"
  - id: "anthropic-claude-sonnet-55"
    tipo: "Alegacao do fornecedor"
    url: "https://aws.amazon.com/about-aws/whats-new/2026/09/claude-sonnet-5-5-aws/"
    data: "2026-09-28"
  - id: "glm-53-flash-docs"
    tipo: "Alegacao do fornecedor"
    url: "https://docs.z.ai/guides/vlm/glm-5.3-flash"
    data: "2026-09-15"
  - id: "test-impact-analysis-tdad-arxiv"
    tipo: "Medicao independente"
    url: "https://arxiv.org/html/2603.17973v1"
    data: "2026-03-24"
  - id: "instruction-hierarchy-rlvr-arxiv"
    tipo: "Medicao independente"
    url: "https://arxiv.org/pdf/2511.04694"
    data: "2025-11-06"
  - id: "dsh-orquestrator-registry"
    tipo: "Medicao independente"
    url: "https://www.dsh.so/artifact/dsh-orquestrator/"
    data: "2026-10-01"
