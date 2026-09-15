# Funcionamento e checks

## Fluxo geral

1. Descobrir a estrutura e os arquivos relevantes do workspace.
2. Ativar os adapters aplicáveis.
3. Extrair expectativas declaradas ou inferidas.
4. Executar automaticamente apenas checks seguros e apropriados ao nível atual.
5. Produzir resultados determinísticos com origem, severidade e confiança.
6. Agregar os resultados em estado geral e por categoria.
7. Expor os mesmos resultados na CLI, VS Code e CI.
8. Oferecer verificações mais profundas somente mediante ação ou configuração explícita.

## Fontes de evidência

Exemplos citados:

- `package.json` e lockfiles;
- `.nvmrc`, `.node-version`, Volta e `mise.toml`;
- `.env`, `.env.example` e variantes;
- Docker Compose;
- README e documentação de contribuição/agentes;
- Makefile, Taskfile, Turbo e Nx;
- comandos e ferramentas disponíveis no ambiente;
- variáveis de ambiente do processo;
- sockets, portas e serviços locais.

## Famílias de checks

### Ambiente e ferramentas

- runtime instalado e versão compatível;
- gerenciador de pacotes instalado e versão compatível;
- Git e Docker disponíveis quando requeridos;
- versão local diferente da declarada pelo projeto.

### Dependências e manifests

- dependências instaladas;
- lockfile presente e coerente;
- gerenciador escolhido compatível com o lockfile;
- scripts documentados realmente existentes.

O significado exato de “lockfile sincronizado” e o custo aceitável de sua verificação estão **Em aberto**.

### Configuração e variáveis

- variáveis obrigatórias presentes;
- divergência entre uso no código e `.env.example`;
- variáveis documentadas que não aparecem onde esperado;
- distinção entre variáveis obrigatórias, opcionais, inferidas e desconhecidas.

O core nunca deve revelar o valor de um segredo em um diagnóstico.

### Serviços e portas

- porta necessária disponível ou já ocupada;
- Docker daemon acessível;
- PostgreSQL, Redis e outros serviços declarados alcançáveis;
- portas descritas na documentação coerentes com configuração/Compose.

Descoberta de um serviço não autoriza iniciá-lo automaticamente.

### Projeto e comandos

- build;
- compilação TypeScript;
- lint;
- testes;
- existência/disponibilidade de migrações;
- comandos customizados.

Esses checks podem consumir recursos ou alterar estado e, em geral, pertencem à verificação profunda.

### Documentation Drift

- comando mencionado não existe;
- arquivo ou caminho mencionado não existe;
- nome do script mudou;
- variável de ambiente usada e não documentada;
- porta documentada diverge da configuração;
- instrução em `README.md`, `CONTRIBUTING.md`, `AGENTS.md` ou `CLAUDE.md` ficou obsoleta.

Parsers e critérios que distinguem exemplos ilustrativos de instruções executáveis estão **Em aberto**.

## Níveis de verificação

### Nível 1 — Static

Meta indicativa na fonte: menos de 100 ms.

Analisa arquivos como `package.json`, README, `.env.example`, lockfiles e configs. Deve evitar execução de comandos e efeitos colaterais.

### Nível 2 — Environment

Meta indicativa na fonte: menos de 2 segundos.

Consulta versões de Node, Docker e Git, portas e variáveis disponíveis. São inspeções locais curtas e sem mutação intencional.

**Decidido em v0.1**: níveis 1 e 2 são os padrões e **nenhum dos dois executa processo algum**. A versão do Node é lida do próprio runtime; disponibilidade de ferramenta é resolvida por busca no `PATH`, sem executar o binário — executar um shim de gerenciador de pacotes pode fazer o Corepack baixar um toolchain, o que é efeito colateral.

### Nível 3 — Connectivity

Testa conectividade com PostgreSQL, Redis, endpoints HTTP e Docker daemon. Pode depender de rede local, timeout e credenciais; por isso deve comunicar claramente o que foi ou não testado.

### Nível 4 — Verification

Executa build, testes, lint, typecheck ou comandos customizados. É potencialmente lento, intensivo ou mutável e não deve rodar escondido.

As metas de tempo são intenções de UX, não SLAs definidos.

## Modelo conceitual de check

O material propõe uma interface semelhante a:

```ts
interface Check {
  id: string
  name: string

  detect(project: Project): boolean
  run(context: Context): Promise<Result>
}
```

Isso expressa duas responsabilidades: saber quando um check se aplica e executá-lo com contexto controlado.

**Decidido em v0.1** (ver [14-implementacao-v0.1.md](14-implementacao-v0.1.md)): a detecção foi movida para o adapter e o check passou a operar sobre um modelo de fatos já coletado, para que vários checks não releiam os mesmos arquivos. O check também declara seu nível e sua classe de segurança:

```ts
interface Check<Facts> {
  id: string            // prefixado com `<adapterId>/`
  title: string
  category: Category
  level: VerificationLevel
  safety: 'read-only' | 'side-effects'
  applies(facts: Facts, context: CheckContext): boolean
  run(facts: Facts, context: CheckContext): Promise<CheckOutput> | CheckOutput
}
```

Exemplos de checks nomeados na fonte:

- `NodeVersionCheck`;
- `PackageManagerCheck`;
- `DependenciesCheck`;
- `EnvironmentVariablesCheck`;
- `PortCheck`;
- `DockerCheck`;
- `PostgresCheck`;
- `RedisCheck`;
- `BuildCheck`;
- `READMECommandCheck`;
- `LockfileCheck`;
- `GitCheck`.

## Resultado de um check

Para sustentar localização, explicação e controle de falsos positivos, um resultado provavelmente precisará representar:

- identificador estável do check;
- status;
- severidade (`blocker`, `warning` ou equivalente);
- mensagem curta e explicação;
- fonte/evidência, incluindo arquivo e posição quando possível;
- expectativa versus valor encontrado;
- nível de confiança;
- nível de verificação executado;
- ação segura disponível, se houver.

**Decidido em v0.1**: o schema está em `packages/core/src/model/types.ts` com `schemaVersion: 1`. Severidade é `error | warning | info`; confiança é `high | medium | low`; evidência é `{ file, line, column, endLine, endColumn, excerpt, detail }` com posições 1-based. Serialização é o próprio objeto em JSON, sem campos específicos de interface.

Todo campo de texto passa por sanitização central no motor antes de ser serializado — ver [09-seguranca-e-confiabilidade.md](09-seguranca-e-confiabilidade.md). Detalhes em [14-implementacao-v0.1.md](14-implementacao-v0.1.md).

## Estado agregado

A experiência proposta usa:

- `READY`: nenhuma condição bloqueante detectada nos checks executados;
- `WARNINGS`: há alertas, mas nenhum bloqueio;
- `BLOCKED`: há pelo menos um blocker.

`READY` precisa sempre ser interpretado em relação ao conjunto de checks executado.

**Decidido em v0.1** — quatro estados, com esta precedência exata (a ordem importa e corresponde linha a linha ao agregador em `packages/core/src/engine/aggregate.ts`):

```text
0. .setupguard.yml não pôde ser aplicado -> INCOMPLETE
1. algum finding error                   -> BLOCKED
2. algum check internal-error            -> INCOMPLETE
3. algum check inconclusive              -> INCOMPLETE
4. algum finding warning                 -> WARNINGS
5. nenhum check conclusivo               -> INCOMPLETE
6. caso contrário                        -> READY
```

A linha 0 é aplicada por `runDiagnosis`, antes de consultar o agregador; as
linhas 1 a 6 são `aggregateReadiness`. A separação é proposital: o agregador
raciocina sobre resultados de check, e uma configuração quebrada não é um
resultado de check — ver [15-configuracao.md](15-configuracao.md).

`BLOCKED` vence tudo: um finding `error` é evidência que **foi** coletada, então um diagnóstico parcial que já encontrou um bloqueio continua bloqueado. Todo o resto cede a `INCOMPLETE` — inclusive `warning`, porque um aviso não pode mascarar que parte do diagnóstico não aconteceu.

`READY` exige **evidência positiva e ausência de lacunas**: ao menos um check que chegou a uma conclusão (`pass`, `warning`, `error`), e nenhum `inconclusive` ou `internal-error`. `skipped` e `not-applicable` não contam como evidência, mas não impedem `READY`: são o resultado normal de um check que legitimamente não se aplica ao projeto.

> **Correção pós-QA (1ª rodada).** A política original devolvia `READY` e exit 0 sempre que não houvesse achados: sucesso silencioso para diretório vazio, ecossistema não suportado, caminho errado no workflow, nível sem checks aplicáveis e todos os checks em `internal-error`.
>
> **Correção pós-QA (2ª rodada).** A primeira correção só olhava "nenhum check conclusivo" e "algum internal-error", e olhava *depois* de `warning`. Restavam dois falsos verdes: `pass + inconclusive` devolvia `READY`, e `warning + internal-error` devolvia `WARNINGS` — com `incompleteReason` preenchido, contradizendo o próprio relatório. A precedência acima é agora a única fonte da decisão, e há um teste tabelado cobrindo cada combinação.

`INCOMPLETE` **não** é um veredito sobre o repositório: diz que o diagnóstico é parcial. Cobre tanto "nada rodou" quanto "quase tudo rodou, mas algo não pôde ser verificado" — `incompleteReason` diz qual dos dois, nomeando sempre o status que de fato decidiu o estado. Toda interface deve mostrá-lo em vez de sugerir sucesso.

Status de check: `pass`, `warning`, `error` descrevem o projeto; `skipped`, `not-applicable`, `inconclusive` e `internal-error` descrevem o SetupGuard. Nenhum destes últimos produz `BLOCKED`, e nenhum deles conta como evidência positiva para `READY`. O `summary` traz `conclusive` (quantos checks concluíram) além dos contadores por status.

## Atualização contínua

A extensão deve reavaliar os diagnósticos conforme arquivos relevantes mudam. O uso futuro de cache, watchers, debouncing ou daemon incremental é sugerido, mas a estratégia está **Em aberto**.

