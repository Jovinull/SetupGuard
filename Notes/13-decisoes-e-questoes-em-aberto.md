# Decisões e questões em aberto

Este documento separa decisões já orientadas pela fonte de escolhas que ainda não devem ser presumidas por quem continuar o projeto.

Decisões tomadas durante a implementação da fundação estão na seção [Decisões tomadas na v0.1](#decisões-tomadas-na-v01); os itens correspondentes foram removidos das listas de "Em aberto". O que o código faz está em [14-implementacao-v0.1.md](14-implementacao-v0.1.md).

## Decisões/direções estabelecidas

- O produto se chama provisoriamente **SetupGuard**.
- A categoria proposta é **Repository Development Readiness**.
- O problema central é validar se um repositório clonado pode ser preparado e executado conforme seu contrato declarado.
- O produto é um diagnosticador contínuo, não apenas uma ferramenta de primeiro setup.
- O core é determinístico, local-first e independente do editor.
- VS Code, CLI e GitHub Action usam o mesmo motor.
- IA não fica no centro nem é requisito de funcionamento.
- O primeiro ecossistema é JavaScript/TypeScript/Node.
- Zero-config é a primeira experiência; `.setupguard.yml` é opcional.
- Checks são separados por níveis de risco/profundidade.
- Builds, testes, migrações e ações mutáveis não rodam escondidos.
- Precisão e baixo ruído têm prioridade sobre quantidade de warnings.
- Detecção, explicação e localização vêm antes de remediação ampla.
- O core não promete ausência de bugs.
- Não haverá backend obrigatório no início.
- Publicação desejada no VS Code Marketplace e Open VSX.
- Suporte futuro deve crescer por adapters.

## Decisões tomadas na v0.1

Tomadas durante a implementação da fundação em 2026-09-14. Cada uma está detalhada no documento temático correspondente e em [14-implementacao-v0.1.md](14-implementacao-v0.1.md).

### Produto

- **Critérios de estado agregado — quatro estados, com esta precedência exata:**

  | # | Condição | Estado |
  |---|---|---|
  | 0 | `.setupguard.yml` não pôde ser aplicado | `INCOMPLETE` |
  | 1 | algum finding `error` | `BLOCKED` |
  | 2 | algum check `internal-error` | `INCOMPLETE` |
  | 3 | algum check `inconclusive` | `INCOMPLETE` |
  | 4 | algum finding `warning` | `WARNINGS` |
  | 5 | nenhum check conclusivo | `INCOMPLETE` |
  | 6 | caso contrário | `READY` |

  `BLOCKED` vence todo o resto porque um finding `error` é evidência que **foi** coletada: um diagnóstico parcial que já achou um bloqueio continua bloqueado. `warning` cede a `INCOMPLETE` — um aviso não pode mascarar que parte do diagnóstico não aconteceu.

  A única coisa acima de `BLOCKED` é uma configuração que não pôde ser aplicada (linha 0): aí não sabemos o que o autor pediu, e o `BLOCKED` produzido com padrões pode ser exatamente o achado que a configuração rebaixaria. Ver [15-configuracao.md](15-configuracao.md).

- **`READY` exige evidência positiva e ausência de lacunas:** ao menos um check conclusivo (`pass`/`warning`/`error`) e nenhum `inconclusive` ou `internal-error`. `skipped` e `not-applicable` não contam como evidência, mas também não impedem `READY`: são estados normais de um check que legitimamente não se aplica.
- Toda interface imprime contra quais níveis o resultado vale.
- **Quick Fix não entra nesta etapa.** O produto apenas detecta, explica e localiza; cada achado traz um texto de remediação que o usuário aplica. A contradição registrada na fonte foi resolvida no lado conservador.
- **Sem percentual de readiness.** Contagem de blockers e warnings basta.
- **Sem telemetria de nenhum tipo.**

### Arquitetura

- **Estado agregado `INCOMPLETE`** além de `READY`/`WARNINGS`/`BLOCKED`: `READY` exige evidência positiva (ao menos um check concluído). Exit code 3.
- **Redaction central** no motor, antes de qualquer serialização — não delegada a cada check.
- **Confinamento físico ao workspace** via `realpath`, além do guard léxico.
- **Lacunas de análise com escopo**: leitura falha ou varredura truncada torna os checks dependentes `inconclusive`. A lacuna é consultada tanto em `applies()` quanto em `run()`, e antes de qualquer retorno `not-applicable` — caso contrário o próprio buraco esconde o buraco.
- **Sanitização central cobre também caminhos de arquivo** (`Evidence.file`), segmento a segmento. Ficam de fora, deliberadamente: `checkId`, `code`, `title`, `category`, `level`, `status` (identificadores estruturais escolhidos pelo código do SetupGuard) e `Report.root` (o caminho que o usuário pediu, não conteúdo do repositório).
- **`AbortSignal` no contexto** de adapters e checks, com timeout por check e por adapter.
- **Monorepo:** pnpm workspaces com `packages/{core,adapter-node,cli,vscode}`; sem a pasta `adapters/*` separada. Todos os pacotes `"private": true`.
- **Build:** `tsc -b` com project references, ESM `NodeNext`, sem bundler. Runtime mínimo Node >= 22.13.0.
- **Contratos TypeScript** de `Adapter`, `Check`, `Finding`, `CheckResult`, `Evidence` e `Report` definidos, com `schemaVersion: 1`.
- **Status de check:** `pass`, `warning`, `error`, `skipped`, `not-applicable`, `inconclusive`, `internal-error`.
- **Severidade:** `error`, `warning`, `info`. **Confiança:** `high`, `medium`, `low`.
- **Execução de processos:** nenhuma. Os níveis 1 e 2 são inteiramente read-only; disponibilidade de ferramenta usa busca no `PATH`. Timeout de 10 s por check; exceções viram `internal-error`.
- **Segredos:** resolvidos por construção — não existe API para ler o valor de uma variável de ambiente.
- **Testes:** Vitest, fixtures como diretórios de projeto reais versionados.
- **Registro de adapters:** explícito; sem descoberta de plugins em disco.
- **Licença:** MIT.
- **Configuração:** `.setupguard.yml` com `version`, `checks`, `env.optional` e `ignore`; uma fase única de discover/parse/validate/normalize no core; biblioteca `yaml` (zero dependências transitivas); TypeScript como fonte de verdade do JSON Schema; configuração inválida produz `INCOMPLETE` com precedência total. Detalhes em [15-configuracao.md](15-configuracao.md).

### Detecção

- **Precedência entre declarações de versão de Node:** não há. Contradição é reportada como `error`, não resolvida em silêncio.
- **Camadas de `.env`:** `.env`, `.env.development` e `.env.local` são lidos e mesclados. Isto é **heurística**, não contrato do ecossistema — ver "Em aberto — detecção e configuração".
- **Múltiplos lockfiles:** `warning`. Lockfile que contradiz `packageManager`: `error`.
- **Documentação:** só blocos cercados shell (ou sem linguagem) e code spans iniciados por um gerenciador de pacotes contam como instrução executável. Sub-comandos do gerenciador nunca viram referência a script. `npm X` sem `run` é ignorado.
- **Variáveis inferidas:** uso no código dá confiança `medium`; variáveis ambientais (`NODE_ENV`, `CI`, `PATH`, …) nunca são cobradas da documentação.
- **Fronteira de projeto:** diretórios com `package.json` próprio são excluídos das varreduras de código-fonte.

### CLI

- **Comandos:** `doctor` (padrão) e `check` (alias).
- **Flags:** `--level`, `--fail-on`, `--json`, `--verbose`, `--color`/`--no-color`.
- **Níveis padrão:** `static` + `environment`.
- **Exit codes:** 0 sem achados no limiar · 1 com achados · 2 uso inválido · 3 `INCOMPLETE` — o diagnóstico é parcial: algo não pôde ser verificado, ou nenhum check chegou a uma conclusão. Nem aprovação nem reprovação do projeto. `--fail-on never` não suprime o 3.
- **Output estruturado:** JSON versionado por `schemaVersion`.

## Em aberto — produto e escopo

- nome definitivo, domínio, marca e slogans finais;
- definição de pronto da v0.1 completa (a fundação existe; VS Code e Action não);
- matriz exata de arquivos, ferramentas e frameworks do MVP;
- quais Quick Fixes, se houver, entram depois;
- métricas de sucesso;
- supressão por achado individual ou por linha (o grão hoje é o check).

## Em aberto — arquitetura e implementação

- cache, watchers, debounce e eventual daemon;
- política de execução de processos para os níveis 3 e 4 (timeout, cancelamento e redaction de stdout/stderr);
- arquitetura e segurança do SDK de plugins;
- versionamento da API de adapters;
- metas de cobertura e orçamento de performance (não há benchmark);
- compatibilidade entre sistemas operacionais: **verificada** no commit `7b52b63` — Ubuntu, macOS e Windows, Node 22.13 e 24, sete jobs verdes. Continua em aberto apenas a fronteira de symlink no Windows, cujos testes se pulam lá por exigirem elevação;
- cancelamento não cooperativo (um laço síncrono que ignore o `AbortSignal` não é interrompido);
- redaction é baseada em forma: um segredo sem `=`, sem URL e sem prefixo de token passa;
- namespace de configuração por adapter, necessário no primeiro segundo ecossistema.

## Em aberto — detecção e configuração

- **quais arquivos `.env` valem para um projeto.** A fusão de `.env` + `.env.development` + `.env.local` é uma convenção de frameworks (Next.js, Vite), não do Node. O `dotenv` puro carrega só `.env`. O padrão atual evita o falso positivo mais comum, mas aceita o inverso: uma variável presente só em `.env.development` é tratada como provida mesmo que o processo carregue apenas `.env`. Precisa virar configuração por projeto ou detecção por framework;
- suporte a `mise` (exige parser de TOML);
- definição verificável de lockfile sincronizado, e verificação de `node_modules` instalado;
- verificação da **versão** do gerenciador de pacotes declarada em `packageManager` (hoje só a presença no `PATH`);
- distinção formal entre variáveis `REQUIRED`, `OPTIONAL`, `INFERRED` e `UNKNOWN`;
- drift de documentação além de scripts (arquivos, caminhos, portas);
- `extends`, presets e herança de `.setupguard.yml`;
- herança/configuração por monorepo;
- readiness global versus por workspace;
- ordem e resolução de conflito entre adapters, quando houver mais de um.

## Em aberto — CLI

- comportamento em monorepos e seleção de workspace;
- modo interativo e confirmações;
- modo watch;
- política de compatibilidade da saída humana;
- configuração por variável de ambiente.

## Em aberto — VS Code

- publisher e extension ID;
- versão mínima do editor;
- UI definitiva (view, status bar, tree, webview ou combinação);
- gatilhos/frequência de análise;
- comportamento com Workspace Trust;
- comandos e Quick Fixes publicados;
- forma de apresentar resultados desatualizados/inconclusivos;
- pipeline de publicação e atualização.

## Em aberto — GitHub Action

- repositório/nome oficial e tecnologia da Action;
- inputs, outputs, logs, annotations e summary;
- permissões mínimas;
- checks executados por padrão;
- warning versus falha do job;
- PRs de forks e segurança;
- suporte a monorepos;
- política de versões/tags.

## Em aberto — segurança, privacidade e governança

- redaction de stdout/stderr, quando existirem níveis que executam comandos;
- threat model escrito;
- sandbox/isolamento para comandos e plugins;
- processo de reporte de vulnerabilidade;
- modelo de contribuição e manutenção;
- assinatura/proveniência de releases.

Resolvidos na v0.1: licença (MIT), telemetria (não existe) e proteção de segredos (resolvida por construção — ver [09-seguranca-e-confiabilidade.md](09-seguranca-e-confiabilidade.md)).

## Em aberto — roadmap e negócio

- momento e escopo da expansão para Python;
- prioridade entre Go, Rust, Java e .NET;
- cronograma para MCP e IA opcional;
- necessidade real de Cloud/Teams/Enterprise;
- modelo de monetização, se existir;
- estratégia de lançamento e manutenção de comunidade;
- validação competitiva atualizada antes do lançamento.

## Contradição/nuance que deve ser preservada

A proposta inicial lista Quick Fix no MVP, inclusive ações como instalar dependências ou liberar porta. Mais adiante, a fonte afirma que o produto não deve tentar consertar tudo inicialmente e define a progressão `detectar → explicar → localizar → quick fixes seguros → automated remediation`.

**Resolvido para a v0.1, no lado conservador:** a fundação implementa apenas `detectar → explicar → localizar`. Cada achado carrega um campo `remediation` em texto, que descreve a ação segura; o SetupGuard não a executa. Nenhum arquivo é escrito, nenhum processo é iniciado.

A linha para os marcos seguintes continua em aberto: adicionar uma correção exigirá demonstrar que é segura, explícita e adequada ao escopo aprovado.

## Perguntas prioritárias antes da implementação ampla

| # | Pergunta | Estado |
|---|---|---|
| 1 | Qual é o menor conjunto de checks Node/TypeScript que prova valor com alta precisão? | **Respondida** — nove checks, listados em [14-implementacao-v0.1.md](14-implementacao-v0.1.md) |
| 2 | Qual é o modelo de resultado comum a CLI, VS Code e CI? | **Respondida** — `Report` com `schemaVersion: 1` |
| 3 | O que exatamente cada estado agregado garante? | **Respondida** — ver [04-funcionamento-e-checks.md](04-funcionamento-e-checks.md) |
| 4 | Quais comandos rodam automaticamente, sob demanda ou nunca? | **Respondida** — nenhum roda automaticamente; os níveis 1 e 2 não executam processo algum |
| 5 | Qual é o schema mínimo de configuração necessário para reduzir falsos positivos? | **Respondida** — `version`, `checks.<id>.severity`, `env.optional`, `ignore`; ver [15-configuracao.md](15-configuracao.md) |
| 6 | Como monorepos são representados e agregados? | **Parcial** — só a fronteira de projeto; agregação por workspace continua em aberto |
| 7 | Quais Quick Fixes, se houver, entram na v0.1? | **Respondida** — nenhum |

