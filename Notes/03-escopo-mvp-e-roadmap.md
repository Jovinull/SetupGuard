# Escopo, MVP e roadmap

## Estratégia de escopo

Começar exclusivamente por JavaScript/TypeScript e pelo ecossistema Node, com qualidade alta e arquitetura extensível. A fonte recomenda não construir um protótipo descartável: desde o início, o core deve ser independente do editor e preparado para adapters, fixtures, benchmarks, CLI e CI.

## MVP proposto

### 1. Detecção automática de projeto

Reconhecer inicialmente:

- `package.json`;
- lockfiles de npm, pnpm, Yarn e Bun;
- `.nvmrc`, `.node-version`, Volta e `mise.toml`;
- arquivos `.env*`;
- Docker Compose;
- Makefile e Taskfile;
- Turbo e Nx;
- monorepos;
- sinais de frameworks Node selecionados.

**Implementado na fundação**: `package.json`; lockfiles de npm, pnpm, Yarn e Bun; `.nvmrc`, `.node-version` e Volta; `.env*`; fronteira de monorepo por `package.json` aninhado.

**Não implementado**: `mise.toml`, Docker Compose, Makefile, Taskfile, Turbo, Nx e sinais de frameworks. O suporte exato de cada um continua **Em aberto**.

### 2. Checks determinísticos de readiness

Cobrir os checks essenciais de runtime, gerenciador de pacotes, dependências, lockfile, scripts, variáveis, portas, Docker e serviços declarados. A taxonomia completa está em [Funcionamento e checks](04-funcionamento-e-checks.md).

### 3. Documentation Drift

Validar comandos, arquivos, caminhos, scripts, variáveis e portas mencionados em:

- `README.md`;
- `CONTRIBUTING.md`;
- `AGENTS.md`;
- `CLAUDE.md`;
- demais documentos do projeto, conforme regras ainda a definir.

### 4. Experiência simples

- estados principais `READY`, `WARNINGS` e `BLOCKED`;
- quantidade de blockers e warnings;
- origem e explicação de cada achado;
- diagnósticos nativos no painel Problems do VS Code;
- comando explícito para verificação.

### 5. CLI

Disponibilizar o motor fora do editor, com pelo menos uma experiência equivalente a `setupguard doctor`.

### 6. GitHub Action

Executar o mesmo motor em pull requests e falhar quando o contrato definido pelo projeto for violado.

### 7. Configuração opcional

Oferecer `.setupguard.yml` para projetos que não possam ser modelados apenas por convenção, mantendo zero-config como primeira experiência.

### 8. Correções seguras, com limite conservador

A fonte primeiro inclui Quick Fix no MVP, mas depois prioriza `detectar → explicar → localizar`, seguido de quick fixes seguros, e só mais tarde remediação automática.

**Decidido para a fundação**: nenhum Quick Fix. Cada achado carrega um texto de remediação; o SetupGuard não escreve arquivo nem inicia processo. Quais correções entram depois continua **Em aberto**.

## Fora do MVP

- suporte amplo a Python, Go, Rust, Java e .NET;
- MCP;
- explicações obrigatoriamente geradas por IA;
- SetupGuard Cloud, dashboards organizacionais e histórico hospedado;
- correção automática irrestrita;
- execução escondida de builds, testes, migrações ou subida de containers;
- infraestrutura própria obrigatória, contas de usuário ou telemetria remota necessária ao core.

## Roadmap conceitual

### Fase 0 — Especificação e fundação · **concluída**

- fechar escopo exato da v0.1 — feito para a fundação;
- escolher licença (MIT), nome de pacotes (`@setupguard/*`, todos privados por enquanto) e identificadores;
- definir modelo de resultados, severidade e confiança — feito;
- montar monorepo, fixtures e testes de contrato — feito.

Identificadores públicos (nome no npm, publisher da extensão, repositório) continuam **Em aberto**.

### Fase 1 — Núcleo Node/TypeScript · **em andamento**

- descoberta do projeto — feito (adapter Node);
- checks estáticos e de ambiente de alta confiança — nove implementados;
- CLI inicial — feito (`setupguard doctor`);
- documentação e fixtures representativas — feito (nove fixtures).

Falta para fechar a fase: dependências instaladas versus lockfile, portas, Docker e `.setupguard.yml`.

Ver [14-implementacao-v0.1.md](14-implementacao-v0.1.md).

### Fase 2 — VS Code polido

- dashboard simples;
- Problems/Diagnostics;
- navegação para origem;
- verificações sob demanda;
- primeiros Quick Fixes seguros, se aprovados.

### Fase 3 — CI e adoção em repositórios

- GitHub Action;
- formato estável para execução automatizada;
- badge `SetupGuard: passing`;
- publicação no VS Code Marketplace, Open VSX e npm.

### Fase 4 — Profundidade no ecossistema Node

- adapters e checks mais ricos para Docker, bancos, Redis, frameworks e monorepos;
- API/SDK de adapters;
- plugins comunitários;
- desempenho incremental e, se necessário, daemon.

### Fase 5 — Novos ecossistemas

- Python é sugerido como próxima expansão provável;
- Rust, Go, Java e .NET são possibilidades posteriores;
- ordem e escopo estão **Em aberto**.

### Fase 6 — Integrações opcionais

- MCP com operações como `setupguard_doctor`, `setupguard_explain` e `setupguard_verify`;
- uso de Codex, Claude, Copilot, Gemini ou modelos locais para consumir os resultados;
- eventual produto Cloud/Teams/Enterprise, apenas se houver necessidade real.

## Ideias futuras registradas, não comprometidas

- daemon incremental;
- adapters/plugins comunitários;
- benchmarks de análise;
- dashboard de saúde por organização;
- histórico de readiness por repositório;
- integrações com agentes por MCP;
- explicação com a IA que o usuário já possui;
- monitoramento competitivo e estratégia de lançamento em Marketplace, GitHub, Hacker News e Reddit.

