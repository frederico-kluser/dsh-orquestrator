# Estudos de 2026-10-03: o que o plugin aprendeu e por quê mudou

> **Nota da 0.5.0.** O revisor independente foi removido (decisão D16 em [`decisoes.md`](decisoes.md)).
> Os estudos e as decisões que tratam do revisor (protocolo, veredicto, contexto limpo, segurança do
> revisor) ficam aqui como história das versões 0.2.0 a 0.4.0. O que continua valendo para o plugin atual:
> os tetos de esforço e de tokens (D01, D02), o conhecimento de modelos no diálogo (D11, D13) e o guarda de
> início (D15).

Este diretório guarda os 16 estudos técnicos que orientaram a versão 0.2.0 do
`dsh-orquestrator`, o que foi **verificado** contra o código do DSH e contra dados
públicos, e o **porquê** de cada mudança (e de cada recomendação que não foi adotada).

| Arquivo | Para quê |
| --- | --- |
| [`sintese.md`](sintese.md) | O que os estudos concordam, onde discordam, o que não se reproduziu, e as fichas por modelo. Leia primeiro. |
| [`decisoes.md`](decisoes.md) | Registro de decisões: cada mudança (D01 a D14) e cada recomendação não adotada ou adiada (N01 a N14), com problema, evidência, motivo, arquivos e verificação. |
| [`fontes/`](fontes) | Os 16 estudos, **byte a byte como recebidos** (hashes abaixo). Não edite: citam-se por id (`E01` a `E16`). |

Relação com o que já existia: [`../pesquisa/padrao-revisor.md`](../pesquisa/padrao-revisor.md)
(dossiê de 2026-09-30, com verificação adversarial) justifica o **protocolo do revisor**;
estes estudos justificam o **roteamento, o esforço de raciocínio, o contrato do veredicto,
o isolamento do revisor e a segurança**. Onde os dois se contradizem, `decisoes.md` diz qual
prevaleceu e por quê. A tabela regra→evidência continua em [`../DESIGN.md`](../DESIGN.md).

## As fontes

Os estudos são relatórios de pesquisa gerados fora deste repositório, com datas até
2026-10-03. Cada afirmação deles traz um rótulo de proveniência (alegação do fornecedor,
medição independente, anedota da comunidade); nenhum foi tratado como verdade sem
checagem. O arquivo `14.md` recebido era **idêntico byte a byte** ao `13.md` (mesmo
sha256), então existe uma cópia só, `E13`.

| Id | Arquivo | Tema | sha256 | Bytes |
| --- | --- | --- | --- | ---: |
| E01 | [`E01-relatorio-operacional-modelos.md`](fontes/E01-relatorio-operacional-modelos.md) | Fichas de MiMo-V2.6-Pro, GLM 5.3, GLM 5.3 Flash, DeepSeek V4.1 Flash; esforço por cargo; sintomas observados | `261279bb420630ca881c91fe1206e724dd8d086fa0c56d6dc9f6d6095b1568be` | 47405 |
| E02 | [`E02-arquiteturas-de-verificacao.md`](fontes/E02-arquiteturas-de-verificacao.md) | Limites da revisão por LLM, ancoragem, cross-family, quando não revisar, ranking de revisores | `7377c2d9816f1cda21870ef285c7c653e1f713593cc615c8cb7eb5ed3a4bf131` | 24439 |
| E03 | [`E03-orquestracao-multiagente-e-selecao.md`](fontes/E03-orquestracao-multiagente-e-selecao.md) | Orquestrador-trabalhadores versus agente único, contexto limpo, árvore de decisão, limites operacionais | `cab8c96be3d39433fe0a62d8882b28b5da4791988494508a86721a941c94d636` | 32102 |
| E04 | [`E04-catalogo-de-papeis.md`](fontes/E04-catalogo-de-papeis.md) | Catálogo de 14 cargos agênticos e priorização | `4c805da04f4ba75d737e7e98cde1946b73875c705a924753a53702a8bcbd2a22` | 41285 |
| E05 | [`E05-playbook-por-familia-de-modelos.md`](fontes/E05-playbook-por-familia-de-modelos.md) | Playbook por família, armadilhas por frequência, ciclo de vida do V4-Pro | `c27134ed85a18fe4390a7fcf41923e7a7451499ff509cef1c2609e038718d543` | 26700 |
| E06 | [`E06-revisor-visual.md`](fontes/E06-revisor-visual.md) | Revisor visual: entrada híbrida, captura, rubrica, custo | `d7bee0f79e741281a07e75a9270fd61ea5ba41171279abcbde3f01d42504f195` | 25669 |
| E07 | [`E07-roteamento-preditivo.md`](fontes/E07-roteamento-preditivo.md) | Roteamento preditivo, perfis Rápido/Equilibrado/Rigoroso, sinais estáticos, escalonamento | `a84c985db64fac1200d3ddcbf424e1738f4d846fe80feef49d914b30cb64fb1b` | 32210 |
| E08 | [`E08-provedores-e-fallbacks.md`](fontes/E08-provedores-e-fallbacks.md) | Provedores, latência por nó, custo com e sem revisor, fallbacks, ZDR | `5fd57ae683ee1f15a1a70393ebd78eea1446a6a3d02150a161379b6bf1e2827b` | 31176 |
| E09 | [`E09-confiabilidade-estrutural-do-veredicto.md`](fontes/E09-confiabilidade-estrutural-do-veredicto.md) | Veredicto estruturado, hierarquia de instruções, artefatos não confiáveis, antídotos ao carimbo de aprovação | `1ae6c488f571b651aabdbf0cec4a4c13c0deffa40c1bbd410e76cef63a916d34` | 28863 |
| E10 | [`E10-descoberta-e-verificacao-autonoma.md`](fontes/E10-descoberta-e-verificacao-autonoma.md) | Como descobrir os comandos de verificação, orçamentos, testes instáveis, relatório | `2b7bc3e568764a92ba083087c48815306ffc2bf3d5bc56a94f3c8105e87b105c` | 27217 |
| E11 | [`E11-metadados-e-catalogo-de-modelos.md`](fontes/E11-metadados-e-catalogo-de-modelos.md) | Fontes de metadados de modelos, licenças, ciclo de vida, pipeline de CI | `d47d5c83d179667d06d98a42a14a9385f7d675f4ddab47ff10bf4b938f5c7d46` | 27959 |
| E12 | [`E12-modelo-de-ameacas-do-revisor.md`](fontes/E12-modelo-de-ameacas-do-revisor.md) | Modelo de ameaças do revisor que executa testes, isolamento, avisos para o README | `6fadd3306e604c16ce4098fe05aa1045ebe35c53745b5adefc3ab8adab7fbc33` | 23563 |
| E13 | [`E13-ux-de-selecao-e-presets.md`](fontes/E13-ux-de-selecao-e-presets.md) | UX: modal por envio, presets, transparência de custo (recebido como `13.md` e `14.md`) | `914be02818e563a47766f0358aa6c944a8ffc3d9f0b20f9935f3236cd3595856` | 25627 |
| E14 | [`E14-plugin-cordis-dsh.md`](fontes/E14-plugin-cordis-dsh.md) | Engenharia de plugins Cordis no DSH: rotas, efeitos, camadas de patch, segurança | `eedf5d8df64005dc02319f3909afeb1c04cfc4820dc1b1b656f8431314032dc2` | 35502 |
| E15 | [`E15-modelos-de-subagentes-dsh.md`](fontes/E15-modelos-de-subagentes-dsh.md) | Modelos de subagentes no DSH: camadas, capacidades, seleção, bugs conhecidos | `7419e695920f61a456ae93258c239f3548845398e947836c7c119bd5a10e9e5b` | 36361 |
| E16 | [`E16-analise-do-dsh.md`](fontes/E16-analise-do-dsh.md) | Visão geral da arquitetura do DSH e do ecossistema | `7afcd396a7f83ed8e595ccd1e8044e74939aa8db1278d2f314ec90a01c4b1c3a` | 29215 |

Os arquivos têm parágrafos inteiros em uma única linha (é assim que foram recebidos).
Para ler no terminal: `fold -s -w 110 docs/estudos/fontes/E05-*.md | less`.

## Como foram usados

Cada estudo passou por três tratamentos, nesta ordem:

1. **Checado contra o código do DSH 0.1.6-alpha.2** (checkout `ddefc45`, o mesmo das
   validações): quando um estudo descreve um comportamento do DSH, ele foi lido no código e
   fixado em [`../../test/contract/dsh-source.test.ts`](../../test/contract/dsh-source.test.ts).
2. **Checado contra dados públicos em 2026-10-03**: o aviso oficial da DeepSeek de
   2026-09-10 (`api-docs.deepseek.com/news/news260910`), a lista pública de modelos do
   OpenRouter (`/api/v1/models`: modalidades, parâmetros e preços de 11 modelos citados) e uma
   chamada real ao OpenRouter com `reasoning.effort` em `max`, `xhigh` e `high`.
3. **Tratado como conselho** quando nenhuma das duas checagens se aplica; nesse caso a decisão
   explica o risco aceito, e a recomendação só virou código se vários estudos independentes
   convergiam e o custo de errar era baixo.

O resultado está em [`decisoes.md`](decisoes.md): 14 mudanças adotadas, D01 a D14 (algumas
adaptadas, com o motivo da adaptação), e 16 recomendações não adotadas ou adiadas, N01 a N16 (com o
motivo, para que ninguém as reabra sem o contexto).

## Como atualizar

Os estudos envelhecem em semanas (preços, ids de modelo, aposentadorias). Ao receber um novo:
copie-o para `fontes/` com o próximo id, registre o hash aqui, e só então mexa em
[`../../src/models.ts`](../../src/models.ts), cujas linhas trazem `verifiedAt` e as fontes
(`E01` a `E16`) de cada conselho. Um conselho de modelo sem data e sem fonte não entra.
