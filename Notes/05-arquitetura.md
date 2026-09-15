# Arquitetura sugerida

## Direção principal

O motor de análise não deve ficar preso ao VS Code. A extensão, a CLI e a GitHub Action são interfaces/adapters de execução sobre um core compartilhado.

```text
Arquivos + ambiente + serviços
             │
             ▼
      descoberta/adapters
             │
             ▼
        SetupGuard Core
    checks + resultados + política
       /          |          \
      ▼           ▼           ▼
     CLI       VS Code    GitHub Action
```

O processamento principal ocorre na máquina do usuário ou no runner do repositório.

## Monorepo proposto

A fonte sugere algo próximo de:

```text
setupguard/
├─ packages/
│  ├─ core/
│  ├─ cli/
│  ├─ vscode/
│  ├─ adapters-node/
│  └─ github-action/
└─ adapters/
   ├─ npm/
   ├─ pnpm/
   ├─ yarn/
   ├─ bun/
   ├─ docker/
   ├─ dotenv/
   ├─ next/
   ├─ nest/
   ├─ adonis/
   └─ turbo/
```

Esse layout é ilustrativo.

**Decidido em v0.1** — layout efetivamente adotado:

```text
setupguard/
├─ packages/
│  ├─ core/           @setupguard/core
│  ├─ adapter-node/   @setupguard/adapter-node
│  ├─ cli/            @setupguard/cli
│  └─ vscode/         @setupguard/vscode
├─ fixtures/
├─ testing/
└─ Notes/
```

A pasta `adapters/*` separada **não** foi criada: npm, pnpm, Yarn, Bun, dotenv e Markdown compartilham o mesmo modelo de fatos Node e vivem em um único adapter. Dividir antes de existir um segundo ecossistema seria separação sem necessidade. `github-action/` ainda não existe.

Os nomes publicados continuam **Em aberto**; por isso todos os pacotes estão marcados `"private": true`.

## Responsabilidades sugeridas

### Core

- representar projeto/workspace e contexto de execução;
- coordenar descoberta e seleção de adapters;
- executar checks por nível e política;
- normalizar resultados, severidade e confiança;
- agregar readiness;
- oferecer API estável a todas as interfaces;
- permanecer independente de VS Code e GitHub.

### Adapters

- detectar tecnologias e convenções específicas;
- extrair fatos e expectativas de manifests/configs;
- registrar checks especializados;
- evitar que detalhes de ecossistema contaminem o core genérico.

### CLI

- resolver caminho/workspace e configuração;
- invocar o core;
- renderizar saída humana e, futuramente, saída estruturada;
- mapear o resultado para exit code.

### Extensão VS Code

- observar mudanças relevantes;
- apresentar status e detalhes;
- publicar Diagnostics;
- navegar até a evidência;
- pedir confirmação para verificações/ações apropriadas.

### GitHub Action

- instalar/invocar a versão definida do motor;
- produzir logs/anotações e status de job;
- usar os minutos e a infraestrutura do próprio repositório.

## Pipeline conceitual

```text
discover workspace
      ↓
collect facts and declared expectations
      ↓
select applicable adapters/checks
      ↓
run allowed verification levels
      ↓
normalize evidence/results
      ↓
aggregate READY/WARNINGS/BLOCKED
      ↓
render for CLI/editor/CI
```

## Qualidades arquiteturais

- **Testabilidade:** checks devem poder rodar contra fixtures sem VS Code.
- **Explicabilidade:** cada resultado deve apontar sua evidência e raciocínio determinístico.
- **Extensibilidade:** novos ecossistemas entram por adapters, preservando o core.
- **Consistência:** interfaces diferentes devem concordar sobre o resultado.
- **Desempenho:** checks estáticos e de ambiente devem oferecer feedback rápido.
- **Isolamento:** execução de comandos precisa de política explícita, timeout e captura segura. Em v0.1 isso é trivialmente satisfeito: **nenhum comando é executado**. O motor já recusa checks marcados `side-effects` a menos que sejam autorizados explicitamente.
- **Privacidade:** nenhuma dependência necessária de backend remoto.

## Fixtures, testes e benchmarks

A fonte pede fixtures de projetos reais e benchmarks desde a fundação. A suíte deverá, no mínimo, representar combinações de gerenciadores, versões, env, documentação divergente, Docker e monorepos. Projetos reais não devem ser incorporados sem observar licença e dados sensíveis.

**Decidido em v0.1**: framework de testes é Vitest, rodando contra o `src` via alias (sem build prévio). Fixtures são **diretórios de projeto reais** em `fixtures/`, versionados, cada um representando um estado nomeado (saudável, quebrado, só avisos, monorepo, segredo). Não há mocks de sistema de arquivos: os testes de integração leem o disco.

Metas de cobertura e orçamento de performance continuam **Em aberto**; ainda não há benchmark.

## Daemon incremental

É uma possibilidade futura para evitar recomputação e atender várias interfaces. Não há evidência de que seja necessário no MVP; começar sem daemon reduz complexidade até que medições justifiquem sua introdução.

## Dependências técnicas

### Decididas em v0.1

| Assunto | Decisão |
|---|---|
| Runtime mínimo | Node >= 22.13.0 |
| Formato do monorepo | pnpm workspaces + `tsc -b` com project references |
| Módulos | ESM, `NodeNext` |
| Biblioteca de CLI | nenhuma; parser próprio (superfície pequena, contrato de exit code é o que importa) |
| Parser de Markdown | nenhum; scanner de fences próprio (só precisamos de blocos shell e code spans) |
| Dependências de runtime | `semver` (adapter-node) e `yaml` (core, para `.setupguard.yml`) — ambas sem dependências transitivas |
| Protocolo extensão ↔ core | chamada de função em processo; `@setupguard/vscode` projeta `Report` em diagnostics puros, sem depender do módulo `vscode` |
| Licença | MIT |

### Ainda não decididas

- cache e invalidação;
- SDK e isolamento de plugins;
- estratégia de distribuição da Action;
- namespace de configuração por adapter, necessário no primeiro segundo ecossistema.

