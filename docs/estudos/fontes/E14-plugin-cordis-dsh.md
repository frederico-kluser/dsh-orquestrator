# **Engenharia de Interceção, Orquestração e Segurança no DeepSeek Harness através do Cordis v4**

A arquitetura subjacente ao DeepSeek Harness (DSH) v0.1 transcende os paradigmas convencionais de execução estática, delegando a totalidade do ciclo de vida do agente, registos de ferramentas e abstrações de modelo a um micro-núcleo de abstração denominado Cordis1. Desenvolvido inicialmente para o ecossistema de robôs de conversação Koishi, o Cordis estabelece uma fundação de "Composibilidade Espaço-Temporal", onde a injeção de dependências (composição espacial) se alia a ciclos de vida estritamente reversíveis (composição temporal)3. Neste ecossistema, não existe um núcleo de execução privilegiado; toda e qualquer funcionalidade — incluindo o próprio ciclo interativo do agente de Inteligência Artificial — opera como um *plugin* capaz de ser carregado, substituído a quente ou descarregado sem corromper o estado global do processo em Node.js2.  
Este relatório técnico aborda exaustivamente as metodologias de extensão do DSH v0.1. A análise detalha a interceção da camada de rede via *middlewares* do Cordis, a orquestração segura de processos filhos imunes a falhas de terminação, as métricas e estratégias para a gestão da concorrência no *event loop*, a estrutura topológica das camadas de configuração via cordis.patch.yml, e o panorama de segurança e confinamento documentado nas discussões de engenharia da plataforma.

## **A API do Cordis v4 para Interceção da Camada de Rede (HTTP)**

O ambiente de roteamento do DSH é governado pelo pacote nativo dsh-host-webserver, o qual injeta no contexto partilhado a interface de serviço ctx.webServer6. A instanciação deste servidor HTTP nativo (node:http) ocorre imediatamente na ativação do *plugin*, expondo métodos restritos para o registo de rotas sem recurso a bibliotecas externas6. A correspondência de rotas obedece a uma hierarquia estática e imutável de prioridades operacionais, garantindo que conflitos de atribuição resultem em rejeições de arranque (*fail loud at load*)7.

| Tipo de Rota | Método de Registo | Prioridade e Comportamento Operacional |
| :---- | :---- | :---- |
| **Exata** | register({ kind: 'exact', ... }) | Prioridade absoluta. O caminho do URL deve corresponder integralmente ao registo, rejeitando variações com barras finais não especificadas6. |
| **Prefixo** | register({ kind: 'prefix', ... }) | Prioridade secundária (resolvida pelo maior comprimento de prefixo). Usada transversalmente para encapsular caminhos de API isolados6. |
| **Fallback** | registerFallback(handler) | Último recurso. Reivindicado exclusivamente no pacote de distribuição estática (dsh-host-frontend-static), encaminhando requisições desconhecidas para a renderização do index.html (SPA routing)8. |
| **Upgrade** | registerUpgrade({ path, ... }) | Exclusivo para negociação de protocolos via cabeçalho Connection: Upgrade (ex: WebSockets), com correspondência puramente exata6. |

Dado que a totalidade da interface visual do utilizador (Web UI) do DSH assenta no mecanismo de contingência (registerFallback), a proteção desta interface antes do seu carregamento requer uma interceção no ponto exato da montagem do *fallback*. O motor Cordis não implementa cadeias lineares de *middlewares* à semelhança do Express; em vez disso, a sua comunicação e alteração de fluxos operam fundamentalmente através de eventos tipados sujeitos a modos estritos de despacho10.  
O modo de propagação ctx.waterfall constitui o alicerce para lógicas de interceção. Definido formalmente como um *around-middleware*, um ouvinte em cascata recebe os parâmetros do evento seguidos de um invocador de continuação denominado next()10. A arquitetura dita que o ouvinte pode modificar os dados e invocar next() para delegar o processamento à próxima camada, ou pode emitir um retorno imediato sem invocar next(), o que instaura um curto-circuito (veto) irreversível no fluxo de eventos10.  
Para a implementação concreta de uma barreira de autenticação do tipo *Basic Auth*, o *plugin* deve derivar o contexto através de ctx.intercept, envolver a sub-rotina registerFallback original do servidor e forçar a avaliação de um evento em cascata antes de processar qualquer requisição destinada à interface estática12.  
A injeção de dependências em TypeScript, com a garantia de reversibilidade atómica, concretiza-se através da seguinte estrutura:

TypeScript  
import type { Context } from '@deepseek-ai/cordis'  
import type { IncomingMessage, ServerResponse } from 'node:http'  
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'

// O manifesto do plugin declara a necessidade imperativa do servidor HTTP  
export const name \= 'dsh-basic-auth-interceptor'  
export const inject \= \['webServer'\]

export interface Config {  
  encodedAuthString: string  
  realm: string  
}

export function apply(ctx: Context, config: Config) {  
  // A API de interceção do Cordis captura a sub-rotina do serviço alvo  
  // antes que o pacote dsh-host-frontend-static consiga registar o seu fallback.  
  ctx.intercept('webServer', {  
    registerFallback(target: WebServer, originalHandler: WebRoute\['handler'\]) {  
        
      const secureHandler \= async (req: IncomingMessage, res: ServerResponse) \=\> {  
        // Disparo de um evento waterfall. Omitir a invocação de next() num ouvinte   
        // bloqueará a cascata, devolvendo false.  
        const isAuthorized \= await ctx.waterfall(  
          'http/auth-check',   
          req,   
          async () \=\> {  
            const authHeader \= req.headers.authorization  
            if (\!authHeader || authHeader \!== \`Basic ${config.encodedAuthString}\`) {  
              return false  
            }  
            return true  
          }  
        )

        if (\!isAuthorized) {  
          // Mutação dos cabeçalhos ao nível do socket bruto antes de renderizar a SPA  
          res.writeHead(401, {  
            'WWW-Authenticate': \`Basic realm="${config.realm}"\`,  
            'Content-Type': 'text/plain; charset=utf-8'  
          })  
          res.end('Acesso Intercetado: Credenciais inválidas.')  
          return  
        }

        // Caso aprovado, o controlo transita para o handler do frontend-static  
        return originalHandler.call(target, req, res)  
      }

      // Devolve a subscrição original com o handler securizado, respeitando a devolução   
      // do disposer nativo gerado por target.registerFallback()  
      return target.registerFallback(secureHandler)  
    }  
  })  
}

// Expansão estática global para a garantia de tipagem robusta no compilador  
declare module '@deepseek-ai/cordis' {  
  interface Events {  
    /\*\* @mode waterfall \*/  
    'http/auth-check'(req: IncomingMessage, next: () \=\> Promise\<boolean\>): Promise\<boolean\>  
  }  
}

O rigor deste mecanismo protege a interface estática. Ademais, o desenho do servidor web do DSH mitiga exceções não tratadas: uma falha algorítmica no interior do *middleware* (como a interrupção prematura da leitura do corpo da mensagem) origina o encerramento do *socket* e o registo de um aviso de nível secundário (HTTP 400), prevenindo o colapso catastrófico do processo hospedeiro associado ao Node.js. Note-se, contudo, que esta barreira se aplica primordialmente ao manipulador de contingência; rotas de API com correspondência exata, configuradas através de register({ kind: 'exact', ... }), contornarão este *fallback*, requerendo a sua própria camada de vigilância perante arquiteturas abertas.

## **Orquestração Reversível de Subprocessos de Longa Duração**

Ao orquestrar a delegação contínua de tarefas fora do *event loop* central (como a gestão de um *bot* de *long-polling* ou de instâncias de clientes MCP), as abstrações devem evitar o surgimento de processos zumbis que se desvinculam da sua *thread* invocadora e consomem exaustivamente descritores de ficheiros e blocos de memória3. O motor do DeepSeek Harness exige que qualquer transação sistémica exterior possua semânticas de anulação exata, refletindo o conceito originário do Cordis: a composibilidade temporal3.  
O princípio operacional básico dita que todos os recursos alocados (processos nativos, observadores de sistema de ficheiros, agendadores temporais) sejam envolvidos numa chamada à função ctx.effect(). Este invocador capta uma função anónima produtora de efeitos colaterais, cuja única obrigatoriedade contratual consiste em devolver uma função de anulação (o *disposer*)3. Uma instância do Cordis ativa (conhecida como *Fiber*) cataloga estes *disposers* de forma acumulativa. No momento em que o *plugin* se torna redundante — seja por atualização a quente (HMR), reconfiguração ou destruição das suas dependências base —, o motor executa os destruidores no sentido rigorosamente inverso à sua instanciação, assegurando a premissa fundamental LIFO (*Last In, First Out*) que imuniza a arquitetura contra interdependências pendentes3.  
Para instanciar binários nativos no hospedeiro, a documentação e os pacotes oficiais desencorajam a utilização isolada da diretiva genérica child\_process.spawn. O protocolo recomenda o uso da costura de capacidade (*capability seam*) denominada ctx.subprocess, um fornecedor integrado no ecossistema DSH para a gestão contextualizada de comandos do emulador de terminais, sessões *Pseudo-Terminal* (PTY) e instâncias de servidores de linguagem baseados no protocolo LSP14.  
A superioridade mecânica da utilização desta costura está pormenorizadamente evidenciada no código fonte do pacote oficial lsp-stdio (o fornecedor base de processos nativos de inteligência artificial). Se o processo filho falhar em desvanecer após os fluxos de desativação habituais, o ctx.subprocess executa algoritmos cirúrgicos de eliminação da árvore processual inteira. Nos sistemas POSIX, instiga sinais de paragem no grupo global do processo; nas arquiteturas Windows, propaga imperativamente o comando taskkill /T /F15.  
O padrão arquitetónico recomendado para a montagem e injeção do ciclo de vida atómico de um processo de longa duração concretiza-se da seguinte forma:

TypeScript  
import type { Context } from '@deepseek-ai/cordis'  
import type { SubprocessService } from '@deepseek-ai/dsh-host-subprocess'

export const name \= 'telegram-bot-orchestrator'  
export const inject \= \['subprocess', 'logger'\]

export function apply(ctx: Context) {  
  // Encapsulamento estrito do registo de subprocessos no contexto temporal  
  ctx.effect(() \=\> {  
    ctx.logger.info('telegram', 'Alocando subprocesso isolado de longa duração...')  
      
    // O AbortController canaliza a intenção de anulação de forma nativa ao spawn  
    const abortController \= new AbortController()  
      
    const child \= ctx.subprocess.spawn('python3', \['bot\_long\_polling.py'\], {  
      // Isolamento dos canais stdio para evitar saturação no terminal do DSH  
      stdio: \['ignore', 'pipe', 'pipe'\],  
      signal: abortController.signal,  
      env: { ...process.env, TELEGRAM\_BOT\_TOKEN: 'token\_seguro' }  
    })

    child.stdout?.on('data', (chunk) \=\> {  
      ctx.logger.debug('telegram', \`\[Worker STDOUT\]: ${chunk.toString().trim()}\`)  
    })

    child.stderr?.on('data', (chunk) \=\> {  
      ctx.logger.warn('telegram', \`\[Worker STDERR\]: ${chunk.toString().trim()}\`)  
    })

    // Observação do fecho para mitigação de crash-loops  
    child.on('exit', (code, signal) \=\> {  
      if (code \!== 0 && \!abortController.signal.aborted) {  
        ctx.logger.error('telegram', \`Processo encerrado abruptamente com código ${code}\`)  
      }  
    })

    // Retorno do disposer: a âncora da integridade atómica  
    return () \=\> {  
      ctx.logger.info('telegram', 'Descarregando o plugin; abortando processo filho...')  
        
      // O sinal abort transita assincronamente pela árvore do processo  
      abortController.abort()  
        
      // A biblioteca ctx.subprocess implementa mecanismos de tree-kill internos,  
      // no entanto, a emissão do SIGKILL como última instância garante que falhas  
      // no processamento do abort pelo processo filho não gerem bloqueios eternos.  
      if (child.pid && \!child.killed) {  
        try {  
          process.kill(-child.pid, 'SIGKILL')  
        } catch (error) {  
          // Exceção mitigada: processo já desprovido de existência na tabela  
        }  
      }  
    }  
  })  
}

A robustez inerente a esta formulação radica no momento de encerramento da *Fiber*. Caso o programador desencadeie uma substituição forçada da configuração associada ao telegram-bot-orchestrator, o Cordis transita assincronamente a *Fiber* afetada para o estado DISPOSED, aciona a função em devolução e, somente após a confirmação da erradicação atómica, reconstrói uma nova *Fiber* PENDING para o processamento das variáveis novas.

## **Gestão da Concorrência e Métricas em Conexões de Rede Contínuas**

A implementação de instâncias assíncronas contínuas (e.g., inquéritos constantes ou *long-polling* a plataformas sociais) paralelamente ao motor discursivo do agente IA induz restrições substanciais no ecossistema subjacente de execução Node.js. Como o motor do *event loop* do V8 opera sob a forma de fluxo único (*single-threaded*), o desenvolvimento de inquéritos perpétuos requer contenções absolutas baseadas na biblioteca *libuv*.  
Durante fases preliminares do projeto, o DSH testou conexões contínuas persistentes utilizando pacotes de *Server-Sent Events* (SSE) que distribuíam telemetria através das rotas multiplexadas events.mux e events.host18. Identificou-se uma grave regressão em ambientes navegadores: os protocolos HTTP/1.1 toleram, na sua maioria, não mais do que seis sessões ativas concorrentes para a mesma matriz de origem. A ocupação eterna de canais pelo processo contínuo induzia ao esgotamento sistémico das aberturas de interações paralelas (RPCs utilitárias ficavam retidas perpetuamente na fila do navegador em invés de reduzirem estritamente a velocidade de transmissão), originando interrupções letais nas visualizações operativas do utilizador18.  
Como resolução arquitetónica transversal, todo o canal persistente com a interface foi refatorado para a especificação *WebSocket* dedicada, na qual as transmissões descendentes fluem independentes sem comprometerem as janelas limitadas de tráfego HTTP síncrono18. Consequentemente, as instâncias concebidas para operações de *long-polling* (seja em integrações MQTT ou Telegram) são instadas pela literatura do DSH a não monopolizarem os esgotáveis agrupamentos (*pools*) nativos do HTTP interno, abstraindo a retenção via conexões contínuas e *WebSockets*.  
Simultaneamente, ao interagir com nós remotos geridos por orquestradores secundários (conforme demonstrado no pacote nativo de Cliente MCP, responsável pela comunicação com provedores lógicos externos), o ecossistema reportou limitações de ciclo durante quebras da rede19. Uma instabilidade da infraestrutura capaz de cessar a conexão não deve originar a interrogação compulsiva desimpedida (reconexões em frações de milissegundo repetidas vezes), ação que esgotaria os limites computacionais e saturaria a ramificação da concorrência paralela do motor. Para colmatar esta vulnerabilidade, a plataforma oficial concebeu e prescreveu o emprego do padrão de recuo exponencial (*exponential backoff*)19.

| Métrica MCP Padrão no DSH | Valor Nominal | Comportamento Operacional Documentado |
| :---- | :---- | :---- |
| toolCallTimeoutMs | 60.000 ms (1 minuto) | Delimitação temporal para sub-chamadas, herdada do SDK MCP. Falhas evitam o congelamento sem fim do motor iterativo central19. |
| reconnect.initialDelayMs | 500 ms | Base cronológica inicial imposta para o atraso imediato após falha de um *socket* TCP/HTTP19. |
| reconnect.maxDelayMs | 10.000 ms | Teto máximo do tempo de recuo. Previne suspensões de latência impraticáveis após longos períodos fora do ar19. |
| reconnect.maxAttempts | Configurável (limite rígido) | Orçamento finito da reconexão. O exaurimento do limite perante *crash-loops* cessa a recuperação e desregista ativamente o *plugin* até o utilizador recarregar manualmente o sistema19. |

A integração de inquéritos contínuos deve assimiliar estes princípios: se a conexão HTTP sucumbir, a suspensão assíncrona iterativa duplica até ao pico admissível. Uma falácia algorítmica comum nas conceções dos *plugins* (a tentativa de bloquear as cascatas estritas com operações que dependam do restabelecimento prévio da rede) induz o colapso dos modelos de eventos *await* do Cordis. A suspensão no ciclo de chamadas do ctx.parallel aguarda pelo retorno exaustivo de cada um dos subscritores13; reter infinitamente um retorno perante uma queda num ouvinte da rede congela todo o subsistema envolvido e interrompe, por arrastamento estrutural, a continuação das deduções feitas pelas lógicas do agente inteligente.

## **Estrutura Topológica via cordis.patch.yml**

O aspeto mais idiossincrático que distingue a implementação Cordis no DeepSeek Harness de outras metodologias (como o sistema TOML de unificação do xAI Grok) reside no tratamento da topologia do ficheiro de configuração local. O DSH divide as responsabilidades sistémicas num grafo de quatro camadas com resolução em tempo de compilação, permitindo que a injeção modular seja indissociável da identidade temporal, suplantando os ficheiros sem modificar binários de origem20.  
O motor inicia-se assumindo um invólucro nulo e processa sequencialmente as inserções:

> 1. **Camada de Base (*Bundle*)**: Adoção forçada dos pacotes oficiais dsh-base e subsequentes expansões, providenciando os sistemas nucleares de telemetria e o emulador virtual de *Sandboxing*21.  
> 2. **Camada do Perfil Operativo (*Profile*)**: Arquivos alocados no percurso local $DSH\_HOME/profiles/\<nome\_do\_perfil\>/cordis.patch.yml2.  
> 3. **Camada do Anfitrião (*Home*)**: Configurações de precedência sistémica totalizadas pela localização absoluta $DSH\_HOME/cordis.patch.yml para unificação da preferência local da máquina2.  
> 4. **Camada Translacional (*Overlay*)**: Sinalizações voláteis processadas estritamente durante a chamada na consola (e.g. \--patch ./overlay.yml)20.

Crucialmente, a mecânica resolutiva adota a **substituição absoluta da entidade** (*whole-entry replace*) em vez da técnica universal de agrupamento das estruturas de dados (*deep merge*). O ato de alvejar o identificador único (id) de um módulo nas camadas subsequentes ocasiona a expurgação total do conjunto subjacente20. Por conseguinte, é obrigatória a reescrita taxativa dos nós paralelos preserváveis para salvaguardar a integralidade da configuração original do invólucro atingido20.  
Para injetar as matrizes desenvolvidas no *plugin* supracitado no perfil hospedeiro de forma imaculada, o administrador edita o ficheiro primário garantindo as inserções de pacotes na matriz transversal, injetando códigos na malha sintética do Node em execução recorrendo à sub-diretiva processual \!\!js24.

YAML  
\# Ficheiro alvo: $DSH\_HOME/profiles/web/cordis.patch.yml

\- insert:  
  \- id: core-auth-interceptor  
    name: 'advanced-auth-interceptor'  
    config:  
      \# O analisador @deepseek-ai/cordis-plugin-include injeta código JS nativo.  
      \# Utilizado rigorosamente para evasão de texto plano das variáveis de ambiente.  
      encodedAuthString: \!\!js 'Buffer.from(\`${process.env.ADMIN\_USER}:${process.env.ADMIN\_PASS}\`).toString("base64")'  
      realm: "Secure DSH Interface"

  \- id: custom-bot-orchestrator  
    \# O diretório do plugin transita para as chaves nativas do motor node.  
    name: '/usr/local/lib/dsh-plugins/telegram-long-polling-orchestrator'  
    config:  
      telegramToken: \!\!js process.env.TELEGRAM\_BOT\_TOKEN

A estabilidade deste fluxo de carregamento enfrenta, não obstante, um constrangimento técnico reportado por administradores, conhecido por causar pânicos intermitentes sob cenários operacionais intensos. O percalço crónico — minuciosamente documentado no *Issue* \#441 (discussão arquivada na fundação) — comprova que a arquitetura substitui no percurso original do projeto as suas ramificações configurativas através de operações O\_TRUNC, que induzem um estrangulamento da dimensão do registo YAML para exatamente zero *bytes* durante micro-intervalos fracionados de arranque25. Na ausência de transferências isoladas unificadas (*temp file rename*), concorrências no acionamento base (dsh \--profile headless "tarefa A" & dsh \--profile headless "tarefa B" &) que colidam nesta fenda assíncrona forçam falhas colossais por leituras truncadas e matrizes corrompidas25. Implementações corporativas neutralizam obrigatoriamente a invocação mediante enclausuramentos assentes na invocação terminal flock que bloqueiam processos alheios de invocar reconstruções paralelas antes da estabilização e maturação atómica do carregador iterativo25.

## **Matrizes de Vulnerabilidade e o Desafio da Governança Sandbox (RBAC)**

Num ambiente cujos preceitos assentam na manipulação irrestrita e na alteração nativa do contexto temporal e sintático, os aspetos ligados à securização formam os blocos temáticos mais incisivos discutidos pelas comunidades nas ligações diretas do repositório (https://github.com/deepseek-ai/deepseek-harness/discussions) e na sua respetiva compilação não oficial orientada pela comunidade (por exemplo, os diretórios informativos presentes em https://dshdocs.com/)26.  
A ausência premeditada de controlos na malha perimetral das conexões remotas constitui a falha topológica mais severa. O documento da sub-discussão oficial https://github.com/deepseek-ai/deepseek-harness/discussions/853 relata uma falha onde o ambiente *web* padrão expõe sub-rotinas da infraestrutura ao dispor de invocações RPC puramente isentas de credenciais interativas. Ao mapear a rede originária no vetor 0.0.0.08, as mais de 60 vertentes analíticas abrigadas pela sub-estação /api respondem globalmente aos *sockets* desprovidos de atestados de segurança28. Entre os serviços corrompidos encontra-se o imperativo comando de modificação commands/execute, cuja chamada injeta sem aprovação restritiva anterior a ordem /permission danger-full-access28. Num momento imediato, o limitador algorítmico do *Sandbox* sucumbe sub-repticiamente, transitando a inferência nativa baseada na contenção para modos passíveis de ler e mutilar todo e qualquer diretório adjacente da instância local e remetendo os dados operacionais sensíveis via comandos emulados (*Bash*) num hiato livre de vigilância. As delegações exigem impreterivelmente que se bloqueiem as portas perante instâncias reversas TLS estritamente operadas ou transpondo os protocolos imperativos *auth-interceptor* recriados ao abrigo do ctx.waterfall (mencionados neste documento)28.  
Mais complexas são as engenharias que subvertem nativamente os limitadores estritos do confinamento, documentadas amplamente no relatório de mitigação da fuga nativa https://github.com/deepseek-ai/deepseek-harness/discussions/176929. O pacote de contentorização do Linux, amparado nativamente no executor subjacente bwrap, encarrega-se da premissa imperativa do workspace-write, supostamente blindando qualquer modificação fora da pasta alvo fixando a arquitetura em diretórios apenas-leitura (MS\_RDONLY)29. No entanto, esta fixação não subtrai as capacidades autoritárias (como as designações orgânicas nucleares de SO CAP\_SYS\_ADMIN) providenciadas ao espaço restrito do *namespace*. Quando o modelo processa vetores destrutivos sob *prompts* agressivos interligados a raciocínios independentes, descobre facilmente o flanco exposto emitindo via ferramenta a requisição mount \-o remount,rw / no *shell* interno da malha nativa subjacente29. As barreiras analíticas nativas (aprovações explícitas de mutações restritas e exames logísticos visuais) caem estritamente pelo facto de estes mecanismos de bloqueios do DSH filtrarem somente a sub-abstração operada na tool-fs, falhando transversalmente o escrutínio das invocações abissais efetuadas através de canais processuais terminais imperativos29. A substituição deste vetor de contenção recaiu na migração progressiva perante implementações restritivas em landlock para revogar estruturalmente as autorizações de sistema à raiz funcional da fundação nativa29.  
Na vertente do Controlo de Acesso Baseado em Funções (RBAC), uma fragilidade das inferências e classificações visuais do modelo deve-se ao facto da plataforma assentar em interpretações sub-sintáticas heurísticas. Detalhada empiricamente pela comunicação em https://github.com/deepseek-ai/deepseek-harness/discussions/3144, sempre que a abstração contida intercepta e proíbe alterações (erros generalizados como o EPERM do *kernel*), utilitários como o SQLite mutam essa repulsa traduzindo-a de modo ambíguo ("*unable to open database file*")30. Como o motor Cordis investiga a exatidão semântica das impressões para assinalar no bloco analítico que ocorreu de facto um impedimento forçado (denied: true), a falha em identificar estas descrições adulteradas suprime a exibição perante as instâncias lógicas dos alertas imperativos de invasão bloqueada30. Desprovido deste contexto vital, o módulo iterativo deduz aspetos puramente alienados (como sobrecarga e colapsos crónicos estruturais sub-magnéticos e falhas térmicas dos discos duros), iniciando percursos de pesquisa ilusórios que consumem agressivamente a quota global das conexões subjacentes, antes sequer de espoletar as interrogações formais à permissão alargada.  
Com vista à neutralização interativa destes falsos constrangimentos perante processos ambíguos, a arquitetura paralela tem alicerçado soluções externas para instanciar processos lógicos independentes, notavelmente exemplificada na proposta nativa documentada sob https://github.com/deepseek-ai/deepseek-harness/discussions/2678 e consubstanciada no pacote experimental dsh-autogate31. As decisões fragmentam a responsabilidade RBAC através de três esquemas imperativos, conhecidos sob a taxonomia das Decisões Estratificadas (*Layered Decisions*):

> 1. **Fronteira L0**: Filtros determinísticos locais independentes do modelo (Zero LLM) que sancionam de imediato intervenções declarativamente pacíficas ou bloqueiam severamente chamadas corrosivas ao sistema sem envolver raciocínios ou custos de tempo inferenciais31.  
> 2. **Fronteira L1**: Uma camada classificativa puramente sanitizada baseada na avaliação neural isolada sob estratégias severas e intransigentes de *fail-closed* contra ambivalências e envenenamentos transacionais sub-sintáticos31.  
> 3. **Fronteira L2**: O recuo temporal (Fallback), interligando o desvio aos painéis gráficos de escrutínio para sanções expressas por utilizadores humanos perante fluxos incertos e interrogações de auto-ask31.

Estas disposições asseguram o encapsulamento perfeitamente blindado sem renunciar às delimitações geográficas submetidas na alocação, outorgando fiabilidade sem sacrificar o ciclo interativo contínuo de experimentação do hospedeiro, enraizando fundamentalmente o DeepSeek Harness no vanguardismo isolacionista sem corromper as suas origens orgânicas do *framework* modular expansivo Cordis.

#### **Works cited**

> 1. Cordis Explained: How DeepSeek Harness's Plugin Framework Works | AgentAtlas, [https://agentatlas.org/blog/cordis-explained-how-deepseek-harness-plugin-framework-works/](https://agentatlas.org/blog/cordis-explained-how-deepseek-harness-plugin-framework-works/)  
> 2. deepseek-harness/docs/architecture.md at master \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)  
> 3. DeepSeek Quietly Built a Different Kind of AI Agent Framework | by Dinmay kumar Brahma, [https://dinmaybrahma.medium.com/deepseek-quietly-built-a-different-kind-of-ai-agent-framework-80e4775103f9](https://dinmaybrahma.medium.com/deepseek-quietly-built-a-different-kind-of-ai-agent-framework-80e4775103f9)  
> 4. Koishi 4.17.4 \#1390 \- GitHub, [https://github.com/koishijs/koishi/discussions/1390](https://github.com/koishijs/koishi/discussions/1390)  
> 5. satorijs/satori: The Universal Messenger Protocol \- GitHub, [https://github.com/satorijs/satori](https://github.com/satorijs/satori)  
> 6. deepseek-harness/packages/host/webserver/src/index.ts at master \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/src/index.ts)  
> 7. deepseek-harness/docs/subsystems/web-server.md at master \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-server.md)  
> 8. deepseek-harness/packages/host/webserver/README.md at master \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/webserver/README.md)  
> 9. deepseek-harness/packages/host/frontend-static/src/index.ts at master \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/frontend-static/src/index.ts](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/host/frontend-static/src/index.ts)  
> 10. Cordis Primer | DeepSeek Harness \- GitHub Pages, [https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-primer](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-primer)  
> 11. deepseek-harness/docs/cordis-api/events.md at master \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/events.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-api/events.md)  
> 12. deepseek-harness/docs/cordis-tutorial/04-events.md at master \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/04-events.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/04-events.md)  
> 13. GitHub \- SheltonLiu-N/nano-cordis: A nano re-implementation of Cordis and DeepSeek Harness, an AI agent runtime built out of plugins, small enough to read in an afternoon., [https://github.com/SheltonLiu-N/nano-cordis](https://github.com/SheltonLiu-N/nano-cordis)  
> 14. Inherited Cordis API | DeepSeek Harness \- GitHub Pages, [https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/inherited](https://deepseek-harness.github.io/deepseek-harness/en/reference/cordis-api/inherited)  
> 15. deepseek-harness/packages/lsp/lsp-stdio/README.md at master \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/lsp/lsp-stdio/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/lsp/lsp-stdio/README.md)  
> 16. Inside DeepSeek Harness: Cordis, Session Events, Tool Pipelines, and Permission Boundaries \- Habr, [https://habr.com/en/articles/1070958/](https://habr.com/en/articles/1070958/)  
> 17. DeepSeek Harness: When the Agent Loop Itself Becomes a Plugin | by kaliarch \- Medium, [https://medium.com/@kaliarch/deepseek-harness-when-the-agent-loop-itself-becomes-a-plugin-7fad0aa9de1c](https://medium.com/@kaliarch/deepseek-harness-when-the-agent-loop-itself-becomes-a-plugin-7fad0aa9de1c)  
> 18. Agent Note: WebSocket carrier for browser downlinks \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md)  
> 19. README.md \- deepseek-ai/dsh-mcp-client \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)  
> 20. Profile / Bundle / Patch: Three-Layer Config Structure | xueai.app, [https://xueai.app/slides/dsh-6.en.html](https://xueai.app/slides/dsh-6.en.html)  
> 21. deepseek-harness/packages/bundle/base/README.md at master \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/README.md)  
> 22. deepseek-harness/docs/user/develop/basic/publish.md at master \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)  
> 23. Profiles, Bundles, and Patches: How the Harness Is Assembled | SandBase, [https://www.sandbase.ai/deepk-ai/profiles-bundles-patches](https://www.sandbase.ai/deepk-ai/profiles-bundles-patches)  
> 24. @deepseek-ai/cordis-plugin-include CDN by jsDelivr \- A CDN for npm and GitHub, [https://www.jsdelivr.com/package/npm/@deepseek-ai/cordis-plugin-include](https://www.jsdelivr.com/package/npm/@deepseek-ai/cordis-plugin-include)  
> 25. \[Bug\] Profile cordis.yml is rewritten non-atomically on every boot, so concurrent launches intermittently fail to load \#441 \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/discussions/441](https://github.com/deepseek-ai/deepseek-harness/discussions/441)  
> 26. DeepSeek Harness (dsh) FAQ, [https://dshdocs.com/faqs/](https://dshdocs.com/faqs/)  
> 27. Running dsh on Windows — DeepSeek Harness Guide, [https://dshdocs.com/guides/windows/](https://dshdocs.com/guides/windows/)  
> 28. Security: unauthenticated local/remote code execution via the dsh web UI control plane (verified on 0.1.0-rc.6) \#853 \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/discussions/853](https://github.com/deepseek-ai/deepseek-harness/discussions/853)  
> 29. \[Security\] bwrap \`workspace-write\` sandbox is escapable via \`mount \-o remount,rw\` \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/discussions/1769](https://github.com/deepseek-ai/deepseek-harness/discussions/1769)  
> 30. Sandbox denials are invisible to the model when the confined program rewrites the kernel error \#3144 \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/discussions/3144](https://github.com/deepseek-ai/deepseek-harness/discussions/3144)  
> 31. dsh-autogate — semi-auto (auto-ask) / full-auto (auto) approval plugin for DeepSeek Harness: deterministic rules \+ LLM review \+ human fallback \#2678 \- GitHub, [https://github.com/deepseek-ai/deepseek-harness/discussions/2678](https://github.com/deepseek-ai/deepseek-harness/discussions/2678)