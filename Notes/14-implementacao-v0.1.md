# Implementação v0.1 — fundação

Este documento descreve **o que existe no código hoje**. Ele complementa os
documentos conceituais: onde houver divergência entre uma proposta da fonte e o
que está aqui, o que está aqui é o estado real do repositório.

Marco entregue: fundação arquitetural + primeiro conjunto de checks seguros.
Fora deste marco: VS Code (UI), GitHub Action, `.setupguard.yml`, Quick Fixes,
níveis 3 e 4, IA, cloud, telemetria.

**Revisão pós-QA (2026-09-14, duas rodadas).** As duas primeiras versões desta
fundação afirmaram garantias que a implementação não cumpria. As correções estão
marcadas ao longo do documento; o resumo é:

Primeira rodada:

| Afirmação original | Realidade | Situação |
|---|---|---|
| "leitura confinada à raiz" | falsa para symlinks | corrigida, com testes |
| "um valor não pode vazar para um finding" | falsa por 3 canais | corrigida, com redaction central |
| "read errors viram inconclusive" | eram coletados e ignorados | corrigida, via escopos de lacuna |
| `READY` sem nada verificado | exit 0 silencioso | estado `INCOMPLETE`, exit 3 |
| "pipeline lint/typecheck/test passa" | `pnpm check` falhava antes de começar | corrigida no `pnpm-workspace.yaml` |
| "`runCli` é função pura" | exagero | reformulada abaixo |

Terceira rodada — auditoria adversarial encontrou o vazamento por outra forma de token:

| Afirmação | Realidade | Situação |
|---|---|---|
| "nenhum valor pode vazar" | `--otp=123456` passava inteiro; a regra decidia pelo delimitador | regras reescritas por **nome** da chave |
| script de outro workspace | `npm --prefix ./sub run build` virava `error` contra o manifesto raiz | referência descartada quando há flag de redirecionamento |
| fake secrets nas fixtures | usavam prefixos de provedor reais, que disparam scanners de segredo | trocados por valores sinteticos inertes (`QA-FAKE-*`) |
| "determinismo" | `walk()` não ordenava; era sorte do filesystem | `sort()` explícito, com teste |
| múltiplos lockfiles | `package-lock.json` + `npm-shrinkwrap.json` acusado como dois gerenciadores | modelado por gerenciador |
| `process.env` desestruturado | invisível ao scanner | detectado, inclusive multilinha |
| builtins de framework | `import.meta.env.MODE` cobrado como não documentado | ambiência por forma de acesso |

Segunda rodada — as correções da primeira estavam incompletas:

| Afirmação | Realidade | Situação |
|---|---|---|
| "leitura incompleta nunca passa por completa" | `pass + inconclusive` devolvia `READY` | precedência refeita |
| "falha interna leva a INCOMPLETE" | `warning + internal-error` devolvia `WARNINGS` | precedência refeita |
| "todo campo do report é sanitizado" | `Evidence.file` passava intacto | `redactPath`, segmento a segmento |
| "todo check dependente de lacuna devolve inconclusive" | `applies()` e um `notApplicable` precoce escondiam a lacuna | guardas em `applies()` e ordem corrigida em `run()` |
| "tudo que não pôde ser lido aparece em gaps" | `depthLimited` e o limite da busca de projetos aninhados eram ignorados | propagados |
| camadas de `.env` como contrato do Node | é convenção de framework | documentado como heurística e registrado em aberto |

## Estrutura do monorepo

```text
setupguard/
├─ packages/
│  ├─ core/           @setupguard/core          motor independente de ecossistema
│  ├─ adapter-node/   @setupguard/adapter-node  ecossistema Node/JS/TS
│  ├─ cli/            @setupguard/cli           comando `setupguard`
│  └─ vscode/         @setupguard/vscode        projeção report → diagnostics
├─ fixtures/          projetos reais usados pelos testes
├─ testing/           helpers de teste compartilhados
└─ Notes/             especificação e registro de decisões
```

Diferenças em relação ao layout ilustrativo de
[05-arquitetura.md](05-arquitetura.md):

- não existe a pasta `adapters/*` separada. Um adapter por ecossistema
  (`adapter-node`) já cobre npm/pnpm/Yarn/Bun/dotenv/Markdown, porque essas
  convenções compartilham o mesmo modelo de fatos. Dividir antes de haver um
  segundo ecossistema seria separação sem necessidade;
- `github-action/` ainda não existe.

## Decisões de ferramentas

| Assunto | Decisão | Por quê |
|---|---|---|
| Gerenciador do monorepo | pnpm 11 workspaces | monorepo nativo, sem ferramenta extra de build |
| Build | `tsc -b` com project references | sem bundler; a saída é Node ESM legível |
| Módulos | ESM, `module`/`moduleResolution` = `NodeNext` | imports relativos com `.js`, compatível com Node 20+ |
| Runtime mínimo | Node >= 22.13.0 | Node 20 saiu de suporte em 2026-04-30; oferecer um runtime sem patches de segurança contradiria o próprio produto |
| Testes | Vitest 4.1.11+ | roda TypeScript direto do `src` via alias, sem build prévio; 4.1.11 é a primeira versão sem o advisory GHSA-82fw-gwwq-j7x9 |
| Lint | ESLint 9 flat config + typescript-eslint (`recommendedTypeChecked`) | regras com tipo detectam erros reais |
| Biblioteca de CLI | nenhuma; parser próprio | a superfície é pequena e o contrato de exit code importa mais que ergonomia |
| Parser de Markdown | nenhum; scanner de fences próprio | só precisamos de blocos shell e code spans; um parser completo traria ambiguidade sem ganho |
| Dependências de runtime | `semver` no adapter-node, `yaml` no core | comparação de ranges e parsing de YAML são fáceis de errar à mão; ambas sem dependências transitivas |
| Licença | MIT | opção mais permissiva entre as sugeridas |

Todos os pacotes estão marcados `"private": true`. Publicação é uma decisão
posterior e não deve acontecer por acidente.

### Scripts de build de dependências

`pnpm-workspace.yaml` precisa de:

```yaml
allowBuilds:
  esbuild: true
```

O esbuild (dependência do Vitest) baixa seu binário nativo em um postinstall. O
pnpm bloqueia **todo** comando até que esse script seja autorizado. Sem isso,
quem clonar o repositório não consegue rodar `pnpm check`.

O nome da chave depende da versão: `allowBuilds` no pnpm 11,
`onlyBuiltDependencies` no pnpm 10.

> **Correção pós-QA.** O piso de runtime e o gerenciador de pacotes estão
> acoplados: pnpm 11 exige Node >= 22.13. Enquanto o projeto declarava
> `>=20.11.0`, as três pernas de Node 20.11 do CI falhavam no passo de cache do
> `setup-node`, antes de instalar qualquer coisa. A saída não foi rebaixar o
> pnpm e sim subir o piso: Node 20 está EOL desde 2026-04-30, e sustentar um
> runtime sem patches seria uma contradição num produto que se vende por
> segurança e confiabilidade. Node 22 tem suporte até 2027-04-30.

> **Correção pós-QA.** Era exatamente esse o estado: o arquivo tinha o
> placeholder `esbuild: set this to true or false` que o próprio pnpm escreve, e
> `pnpm check` falhava com `ERR_PNPM_IGNORED_BUILDS` antes de chegar ao lint. Os
> comandos diretos (`eslint`, `tsc`, `vitest`) passavam, o que mascarou o
> problema no relatório anterior. Verificado agora com `rm -rf node_modules
> pnpm-lock.yaml && pnpm install && pnpm check`.

## Modelo de resultados (contrato comum)

Definido em `packages/core/src/model/types.ts`. `schemaVersion: 1`.

### Níveis de verificação

`static` → `environment` → `connectivity` → `verification`.

Padrão executado: `static` + `environment`. Ambos são **read-only**: não
executam processo algum. Os níveis 3 e 4 existem no enum, mas nenhum check os
usa ainda.

### Severidade

- `error` — quem seguir as instruções do próprio repositório fica bloqueado;
- `warning` — o contrato está degradado ou ambíguo, mas o projeto ainda roda;
- `info` — nota de contexto; não afeta o estado agregado (não usada ainda).

### Confiança

`high` (declaração explícita do repositório) · `medium` (convenção forte ou
inferência sobre o código-fonte) · `low` (heurística; reservada).

### Status de check

`pass` · `warning` · `error` descrevem o **projeto**.
`skipped` · `not-applicable` · `inconclusive` · `internal-error` descrevem o
**SetupGuard** e nunca são apresentados como prova de defeito do projeto.

Isso responde à questão em aberto de
[09-seguranca-e-confiabilidade.md](09-seguranca-e-confiabilidade.md) sobre os
nomes desses estados.

### Agregação

A ordem **é** a precedência, e corresponde linha a linha a
`packages/core/src/engine/aggregate.ts`:

```text
1. algum finding error         -> BLOCKED
2. algum check internal-error  -> INCOMPLETE
3. algum check inconclusive    -> INCOMPLETE
4. algum finding warning       -> WARNINGS
5. nenhum check conclusivo     -> INCOMPLETE
6. caso contrário              -> READY
```

`BLOCKED` vence tudo: um finding `error` é evidência coletada. Todo o resto cede
a `INCOMPLETE`, inclusive `warning`.

`READY` exige **evidência positiva e ausência de lacunas**:
`summary.conclusive > 0` e nenhum `inconclusive`/`internal-error`. `skipped` e
`not-applicable` não são evidência, mas não impedem `READY`.

> **Correção pós-QA (1ª).** A política anterior devolvia `READY` sempre que não
> houvesse achados: sucesso silencioso para diretório vazio, ecossistema não
> suportado, caminho errado no workflow e nível sem checks.
>
> **Correção pós-QA (2ª).** A primeira correção só consultava `internal-error`
> e "nenhum conclusivo", e o fazia *depois* de `warning`. Restavam
> `pass + inconclusive` → `READY` e `warning + internal-error` → `WARNINGS`, este
> último já trazendo um `incompleteReason` preenchido — o relatório contradizia
> a si mesmo. `packages/core/test/aggregate.test.ts` agora tabela todas as
> combinações.

`INCOMPLETE` não é veredito sobre o repositório: diz que o diagnóstico não
aconteceu. O report carrega `incompleteReason`, e a CLI o imprime junto ao estado.
O resumo do nível na CLI também deixou de derivar a cor só dos achados: um nível
cujos checks acabaram todos em `internal-error` ou `inconclusive` era pintado de
verde.

### Evidência

`{ file, line, column, endLine, endColumn, excerpt, detail }`, posições
**1-based**. O pacote `vscode` converte para 0-based.

## Contratos de extensão

```ts
interface Adapter<Facts> {
  id: string;
  name: string;
  detect(context: DiscoveryContext): Promise<boolean>;
  collect(context: DiscoveryContext): Promise<Facts>;  // uma vez por execução
  checks: readonly Check<Facts>[];
}

interface Check<Facts> {
  id: string;            // obrigatoriamente prefixado com `<adapterId>/`
  title: string;
  category: Category;
  level: VerificationLevel;
  safety: 'read-only' | 'side-effects';
  applies(facts: Facts, context: CheckContext): boolean;
  run(facts: Facts, context: CheckContext): Promise<CheckOutput> | CheckOutput;
}
```

Duas fases (`collect` e `run`) porque vários checks leem os mesmos arquivos; ler
uma vez por execução mantém o nível estático barato.

O `AdapterRegistry` valida, no registro, que todo check é namespaced pelo
adapter e que não há ids duplicados. Registro é **explícito**: não há descoberta
de plugins em disco — carregar código de terceiros exigiria um modelo de
confiança que ainda não existe.

## Isolamento e segurança implementados

- **`WorkspaceFs`** (`packages/core/src/fs/`): toda leitura passa por aqui.
  O confinamento tem **duas camadas**, e as duas são necessárias:

  1. **léxica** (`resolve`): recusa caminho absoluto e travessia com `..`;
  2. **física** (`realPath`): resolve symlinks com `realpath` e verifica que o
     alvo real continua sob a raiz real, **antes** de qualquer `stat` ou leitura.

  > **Correção pós-QA.** Só existia a camada léxica. `fs.stat` e `fs.readFile`
  > seguem symlinks, e apenas o walker recursivo os ignorava. Um `package.json`
  > commitado como link para `/etc/passwd` era detectado, lido, e parte do
  > conteúdo aparecia no report JSON — um caminho que nunca contém `..`. Há
  > testes para symlink de arquivo, symlink de diretório, cadeia de symlinks,
  > link quebrado e link interno legítimo (que continua funcionando).

  Também: arquivos acima de 2 MiB recusados, symlinks nunca percorridos pelo
  walker, e `node_modules`, `dist`, `.git` e afins nunca visitados.
  `walk()` devolve `{ files, truncated, depthLimited }` para que uma varredura
  parcial nunca seja apresentada como completa.
- **`EnvironmentProbe`** (`packages/core/src/env/`): interface deliberadamente
  estreita. Não existe API para **ler o valor** de uma variável de ambiente —
  só `hasEnvVar(name)` e `envVarNames()`. Um valor não pode vazar para um
  finding porque não há como obtê-lo.
- **Nenhuma execução de processo.** Disponibilidade de ferramenta é resolvida
  por busca no `PATH` (`which`), sem executar nada. Isso não é só preferência:
  executar `yarn --version` pode fazer o Corepack **baixar** um toolchain, ou
  seja, um efeito colateral em um diagnóstico que se declara read-only.
- **`safety: 'side-effects'`**: o motor recusa esses checks a menos que
  `allowSideEffects` seja passado explicitamente. O padrão é `false`.
- **Timeout e cancelamento**: 10 s por check, 30 s por adapter (`detect` +
  `collect`). O `DiscoveryContext` carrega um `AbortSignal` que dispara no
  timeout ou quando o chamador cancela a execução inteira.

  > **Correção pós-QA.** Antes era só `Promise.race`, que para de *esperar* mas
  > não para a tarefa, e `detect`/`collect` não tinham prazo nenhum. Com os nove
  > checks read-only atuais o risco era baixo; para os níveis 3 e 4 um build ou
  > uma conexão continuaria viva depois do SetupGuard já ter reportado. O sinal
  > existe agora, antes do primeiro check que precisa dele. `Promise.race`
  > continua sendo o que destrava o motor — o sinal é o que o check honra.

- **Falhas isoladas**: exceção em check ou adapter vira `internal-error`, nunca
  um finding contra o projeto — e nunca um `READY`.
- **Parser de `.env` só de chaves**: o valor é descartado no parse.
- **Sem trecho de código-fonte em evidência de variável de ambiente**: uma linha
  como `process.env.TOKEN ?? 'fallback'` colocaria uma credencial literal no
  report; arquivo + linha já bastam para navegar.
- **Redaction central** antes de serializar: ver a seção seguinte.

## Redaction central

`packages/core/src/util/redact.ts` + `packages/core/src/engine/sanitize.ts`.

Um único ponto de passagem, na saída de `runDiagnosis`
(`packages/core/src/engine/run.ts`):

```ts
const sanitized = results.map(sanitizeResult);
```

Fica ali, e não em `normalizeOutput`, porque `normalizeOutput` só vê o que um
check devolveu: um resultado `skipped`, uma falha de adapter ou uma exceção
nunca passam por ele. Um check que esquecer de ocultar algo continua seguro, e
um resultado que nunca chegou a rodar também.

O que é removido: atribuições `NOME=valor` (o nome fica, o valor vira `***`),
credenciais em URL (`postgres://user:pw@host` → `user:***@`), tokens opacos
longos após `bearer`/`token`/`api-key`, e caracteres de controle.

Os limites de tamanho não são um só (`MAX_FIELD_LENGTH` e `MAX_PATH_LENGTH` em
`packages/core/src/util/redact.ts`):

| Campo | Tratamento | Limite |
|---|---|---|
| `message`, `explanation`, `expected`, `actual`, `remediation`, `evidence.excerpt`, `evidence.detail`, e o `reason` do resultado | `redact` | 400 |
| `evidence.file` | `redactPath` | 200 |
| identificadores estruturais e `Report.root` | não passam pela sanitização | — |

**Caminhos de arquivo também.** `Evidence.file` passa por `redactPath`, que
redige **segmento a segmento**: a lookbehind de `redact` exclui `/`, então
`deep/dir/TOKEN=secret.js` ficaria intacto enquanto o `TOKEN=secret.js` de raiz
seria redigido. Um nome de arquivo é conteúdo do repositório.

O que **não** é sanitizado, de propósito: `checkId`, `code`, `title`,
`category`, `level`, `status` — identificadores estruturais escolhidos pelo
código do SetupGuard, nunca derivados do repositório (isso vale enquanto todos
os adapters forem de primeira parte, e precisa ser revisto antes de plugins de
terceiros); e `Report.root`, que é o diretório que o usuário pediu na linha de
comando — esconder *o que foi analisado* prejudicaria a confiança no relatório.

O que é preservado, com testes: `>=20`, `--filter=web`, `config.key=value` e
`DATABASE_URL=` vazio (a vacuidade é a informação).

Mensagens nativas de parser nunca são serializadas: `describeJsonParseError`
extrai só a posição.

> **Correção pós-QA (2ª).** `sanitizeEvidence` cobria só `excerpt` e `detail`;
> `Evidence.file` passava intacto, então um arquivo chamado `TOKEN=valor.js`
> punha o próprio nome no JSON, no terminal e no painel Problems. A sanitização
> também virou um **único ponto de passagem** (`results.map(sanitizeResult)` na
> saída de `runDiagnosis`), cobrindo agora as razões de `skipped`,
> `not-applicable`, `inconclusive` e `internal-error`.
>
> **Correção pós-QA (1ª).** A afirmação "um valor não pode vazar porque não há
> como obtê-lo" era falsa. Três canais foram reproduzidos: (1) um comando documentado
> `TOKEN=QA-FAKE-CREDENTIAL-0005 npm run missing` ia inteiro para `message` e
> `evidence.excerpt`; (2) a mensagem nativa de `JSON.parse` repete o início do
> arquivo, então um `package.json` malformado começando por uma credencial punha
> a credencial no report; (3) qualquer `Error.message` lançado de um check. A
> mensagem do check de documentação também foi reescrita para nomear só o
> script, nunca a linha de comando crua.

## Lacunas de análise

`packages/adapter-node/src/facts/gaps.ts`.

Toda leitura que falha, e toda varredura truncada, vira um `FactGap` com um
**escopo**: `package.json`, `node-version`, `env-template`, `env-local`,
`source-scan` ou `documents`. Todo check que dependa de um escopo com lacuna
devolve `inconclusive` em vez de um resultado limpo.

Uma lacuna precisa ser consultada em **três** lugares, e faltar um deles já
basta para o buraco esconder o buraco:

1. em `applies()` — uma lacuna normalmente *remove* o fato que o check procura
   (um README ilegível deixa `documents` vazio), então um `applies()` que só
   olha os fatos devolve `false` e o check vira `not-applicable` sem nunca rodar;
2. em `run()`, **antes** de qualquer `return notApplicable(...)` precoce, pelo
   mesmo motivo;
3. na coleta, incluindo `truncated` **e** `depthLimited` de toda varredura.

> **Correção pós-QA (1ª).** As lacunas eram coletadas em `readErrors` e nenhum
> check as consultava. Um `.nvmrc` ilegível virava `node/node-version-undeclared`
> — uma afirmação sobre o projeto que nunca foi verificada.
>
> **Correção pós-QA (2ª).** Faltavam os três pontos acima. `applies()` não
> consultava lacunas; `envLocalFileCheck.run` devolvia `notApplicable` antes de
> chegar ao guard de lacuna; `collectDocuments` ignorava `depthLimited` e
> `findNestedProjectDirs` ignorava ambos — este último significando que uma
> fronteira de workspace não encontrada faz a varredura atribuir o código de um
> pacote filho ao projeto raiz.

## Checks implementados

Nove checks, todos `read-only`.

| id | nível | categoria | códigos emitidos |
|---|---|---|---|
| `node/package-json` | static | project | `package-json-missing` (error) · `package-json-invalid` (error) · `package-json-not-an-object` (error) · `package-json-unreadable` (warning) |
| `node/package-manager` | static | dependencies | `lockfile-missing` (warning) · `multiple-lockfiles` (warning) · `package-manager-lockfile-mismatch` (error) |
| `node/node-version-declaration` | static | project | `node-version-undeclared` (warning) · `node-version-unresolvable` (warning) · `node-version-declaration-conflict` (error) |
| `node/scripts` | static | project | `scripts-absent` (warning) · `script-empty` (warning) · `script-reference-missing` (error/warning) |
| `node/env-contract` | static | configuration | `env-example-missing` (warning) · `env-var-undocumented` (warning) |
| `node/docs-script-drift` | static | documentation | `docs-script-not-found` (error/warning) |
| `node/package-manager-available` | environment | environment | `package-manager-unavailable` (error) |
| `node/node-version-runtime` | environment | environment | `node-version-mismatch` (error) |
| `node/env-local-file` | environment | configuration | `env-file-missing` (warning) · `env-var-missing` (error/warning) · `env-var-empty` (error/warning) |

### Por que a divisão static/environment em três pares

`node-version`, `package-manager` e `env` têm uma metade que é fato do
repositório (igual em qualquer máquina) e uma metade que é fato da máquina. Em
CI, o runner não representa a workstation
([08-github-action.md](08-github-action.md)): rodar só `--level static` dá um
resultado correto e estável lá.

### Regras de precisão adotadas

- **Referência a script**: `npm run X` e os atalhos de ciclo de vida
  (`npm test`, `pnpm start`) têm confiança `high` → severidade `error`. A forma
  implícita (`pnpm X`) tem confiança `medium` → `warning`, porque poderia ser um
  sub-comando do gerenciador que ainda não conhecemos. `npm X` sem `run` é
  **ignorado**: npm não tem forma implícita, então reportar seria falso positivo.
- **Sub-comandos de gerenciador** (`install`, `add`, `dlx`, `store`, …) nunca
  são tratados como script.
- **Documentação**: só blocos cercados com linguagem shell (ou sem linguagem) e
  code spans que começam com um gerenciador de pacotes contam como instrução.
  Blocos `json`, `ts`, `yaml` etc. são ignorados inteiros. Linhas de comentário
  e comandos com placeholders (`<...>`, `${...}`) são descartados.
- **Variáveis de ambiente**: nomes vindos de `process.env.X`,
  `process.env['X']` e `import.meta.env.X`. Variáveis ambientais (`NODE_ENV`,
  `CI`, `PATH`, …) nunca são cobradas da documentação.
- **Fronteira de projeto**: diretórios com `package.json` próprio são excluídos
  da varredura de código-fonte. Sem essa regra, o próprio repositório do
  SetupGuard reportava as variáveis das suas fixtures como não documentadas —
  falso positivo encontrado rodando a ferramenta nela mesma. É também a primeira
  peça do tratamento de monorepo.
- **Comentários não contam como uso**: `// process.env.GHOST` era reportado como
  leitura real. `maskComments` apaga comentários de linha e de bloco preservando
  os offsets, rastreando literais de string para não confundir `"http://x"` com
  um comentário.

### Semântica de ambiente

Uma variável é considerada **provida** quando tem valor em qualquer uma das três
fontes, e todas as três precisam ser consultadas:

1. um valor não vazio nos arquivos locais em camadas (`.env`, `.env.development`,
   `.env.local` — todos lidos e mesclados, não só o primeiro);
2. `DATABASE_URL=` vazio **não** conta: é um placeholder não preenchido;
3. exportada no ambiente do processo (`EnvironmentProbe.hasEnvVar`), que é como
   direnv, um perfil de shell ou um secret de CI realmente entregam configuração.

> **Correção pós-QA.** Os três estavam errados: valor vazio contava como
> presente (falso `READY`), o probe de ambiente nunca era consultado (falso
> positivo), e só o primeiro arquivo `.env` era lido (falso positivo).

### Versões de Node: política adotada

Fontes lidas: `engines.node`, `volta.node`, `.nvmrc`, `.node-version`.

**Não há precedência entre elas.** Toda declaração faz parte do contrato do
repositório, então uma contradição é **reportada**, não resolvida em silêncio.
Se as declarações não se interceptam, `node/node-version-runtime` devolve
`inconclusive`: não existe uma expectativa única contra a qual verificar.

Aliases que exigiriam rede (`lts/iron`, `latest`, `system`) são reportados como
não resolvíveis, e não comparados.

`mise` ainda não é lido — exigiria um parser de TOML. Continua **Em aberto**.

## CLI

```bash
setupguard [doctor|check] [caminho] [opções]
```

`doctor` é o comando padrão; `check` é alias. Sem argumentos, mostra o help.

| Opção | Efeito |
|---|---|
| `--level <lista>` | níveis a executar (padrão `static,environment`) |
| `--fail-on error\|warning\|never` | limiar de saída não-zero (padrão `error`) |
| `--json` | imprime o report serializado |
| `--verbose` | lista também checks que passaram, foram pulados ou não se aplicam |
| `--color` / `--no-color` | força cor (padrão: TTY, respeitando `NO_COLOR`) |

### Exit codes

| Código | Significado |
|---|---|
| 0 | nenhum finding no limiar configurado |
| 1 | findings no limiar ou acima |
| 2 | uso inválido ou caminho inutilizável |
| 3 | falha interna do SetupGuard; **diagnóstico incompleto**, não projeto quebrado |

Isso fecha a questão de exit codes de [06-cli.md](06-cli.md). Warnings **não**
falham por padrão; quem quiser rigor usa `--fail-on warning`.

`runCli(argv, io, version)` recebe argv e uma superfície de IO injetada, e
devolve um exit code; `bin.ts` é a única parte que toca `process`. Isso torna a
CLI testável sem subprocesso e reutilizável por um futuro runner de Action.

Não é uma função pura: ela resolve caminhos, lê o filesystem, constrói um
`NodeEnvironmentProbe` e usa o relógio. O que é injetável é o IO e o argv. O
motor (`runDiagnosis`) é que aceita `fs`, `environment`, `signal` e `now` por
parâmetro.

## VS Code

`packages/vscode` implementa **apenas** a projeção `Report → EditorDiagnostic[]`
(0-based, severidades no formato do editor, findings sem arquivo separados em
`unplaced`). O pacote **não** depende do módulo `vscode`, então é testável em
Node puro.

Manifest da extensão, activation events, views, comandos e Quick Fixes não
existem — são o próximo marco.

## Testes

Vitest, 366 testes em 20 arquivos, executando contra o `src` (sem build prévio).

Fixtures são **diretórios de projeto reais** em `fixtures/`, não mocks:

| fixture | representa |
|---|---|
| `healthy-npm` | projeto npm coerente → `READY` |
| `healthy-pnpm` | projeto pnpm coerente → `READY` |
| `broken-node-project` | sete defeitos plantados → `BLOCKED` |
| `docs-drift-project` | só drift de documentação → `BLOCKED` |
| `no-package-json` | lockfile sem manifesto |
| `warnings-only` | sem lockfile, sem versão declarada → `WARNINGS` |
| `secret-env` | `.env` com segredo, para provar que não vaza |
| `monorepo-root` | pacote aninhado, para a fronteira de projeto |
| `monorepo-scripts` | scripts e docs que apontam para outro workspace |
| `empty-dir` | nada; nenhum adapter detectado → `INCOMPLETE` |

Além das fixtures versionadas, alguns testes constroem workspaces temporários em
disco — necessário para symlinks, arquivos ilegíveis e permissões, que não se
versionam bem.

### Testes adicionados após o QA

- escape por symlink: arquivo, diretório, cadeia, link quebrado, link interno válido;
- segredo em comando de Markdown, em mensagem de parser, em `.env`, via symlink;
- guardas contra sobre-redaction (`>=20`, `--filter=web`, `KEY=` vazio);
- zero adapters detectados; nível solicitado sem checks; todos os checks inconclusivos;
- fonte ilegível e varredura truncada → `inconclusive`, não `READY`;
- `.env` com valor vazio; variável só no ambiente do processo; múltiplos `.env` em camadas;
- `process.env` em comentário de linha e de bloco;
- cancelamento real: o check recebe o `AbortSignal` e o observa disparar;
- timeout de `collect` do adapter.

Os testes de symlink são pulados no Windows, onde criar links exige elevação ou
Developer Mode. Isso significa que uma matriz de CI verde **não** valida essa
fronteira de segurança no Windows.

### Testes adicionados após o terceiro QA

- `packages/core/test/redact-adversarial.test.ts`: 27 formas de credencial que
  **devem** ser redigidas e 15 comandos ordinários que **devem** sobreviver;
  as três suítes novas somam 61 testes;
- `packages/cli/test/leak-surfaces.test.ts`: workspace hostil com sete segredos
  distintos, verificando JSON, saída humana e saída colorida — cada marcador é
  único, então a falha diz qual canal vazou;
- `packages/adapter-node/test/check-coverage.test.ts`: um caso por código de
  finding que nenhuma outra suíte exercitava, mais a fixture `monorepo-scripts`;
- determinismo do `walk`, incluindo qual subconjunto sobrevive ao truncamento;
- desestruturação de `process.env`, inclusive multilinha, com negativos;
- ambiência por forma de acesso (`import.meta.env.MODE` vs `process.env.MODE`).

### Testes adicionados após o segundo QA

- `packages/core/test/aggregate.test.ts`: tabela com todas as combinações de
  status e o estado agregado esperado, incluindo `pass + inconclusive`,
  `warning + internal-error` e `error + internal-error`;
- sanitização de `Evidence.file`, incluindo o caso aninhado `a/b/TOKEN=x.js`;
- sanitização da razão de um resultado não conclusivo;
- `packages/adapter-node/test/gaps.test.ts`: `.nvmrc`, README, `.env.example` e
  `package.json` ilegíveis, cada um verificando **o status do check e o
  `readiness` agregado**;
- truncamento real de `scanEnvUsage` e de `findNestedProjectDirs`;
- `docs/` mais profundo que o limite de varredura.

O único duplo de teste é `stubEnvironment()`, que implementa `EnvironmentProbe`
com versão de Node e `PATH` fixos — sem isso, checks de ambiente dependeriam da
máquina de quem roda os testes. Há também um teste que usa o
`NodeEnvironmentProbe` real no nível estático.

## Integração contínua

`.github/workflows/ci.yml` roda `lint`, `typecheck`, `test` e o auto-diagnóstico
em uma matriz `ubuntu × macos × windows` por `node 22.13.0 × 24`, com
`pnpm install --frozen-lockfile` (que é o que prova que um clone limpo instala),
mais um job de `pnpm audit`.

O workflow roda em `ubuntu × macos × windows` por `node 22.13.0 × 24`, com
`pnpm install --frozen-lockfile`, mais um job separado de `pnpm audit`.

**As sete jobs passam.** 366 testes, três sistemas operacionais, duas versões
de Node. Histórico das execuções abaixo.

Histórico das execuções:

| Commit | Resultado |
|---|---|
| `21b2b72` | Node 24 passou nos três sistemas; Node 20.11 falhou nos três |
| `f880217` | Node 24 passou; Node 22.13 falhou só no auto-diagnóstico |
| `7b52b63` | tudo verde |

A falha em `21b2b72` foi de configuração: o repositório fixava pnpm 11.18, que
exige Node >= 22.13, então o passo de cache do `setup-node` quebrava antes de
instalar qualquer coisa. A correção foi **subir o piso**, não rebaixar o pnpm —
Node 20 está EOL desde 2026-04-30.

A falha em `f880217` foi mais interessante: install, lint, typecheck e os 252
testes passaram nas três plataformas com Node 22.13, e só o auto-diagnóstico
falhou, com o próprio SetupGuard reportando

```
error  Node.js 22.13.0 does not satisfy "24" from .nvmrc
```

O achado estava **correto**: o runner de fato não estava na versão que o
`.nvmrc` recomenda. Apagar o `.nvmrc` deixaria tudo verde ao custo de remover
uma declaração que contribuidores usam — exatamente o drift que esta ferramenta
existe para pegar. O passo de auto-diagnóstico foi restrito ao runtime
recomendado em vez disso.

Uma ressalva que a matriz verde não remove:

- os testes de symlink se pulam no Windows (criar link exige elevação), então
  essa fronteira segue não verificada lá.

O auto-diagnóstico estático roda em todas as pernas, inclusive no piso Node
22.13, provando que o binário compilado inicia e analisa o repositório em todo
runtime suportado. O auto-diagnóstico completo, que inclui o ambiente do runner,
roda apenas com Node 24: na perna 22.13 ele apontaria corretamente o conflito
com o runtime recomendado por `.nvmrc`.

## Limitações conhecidas

- Só nível 1 e 2. Conectividade, Docker, portas e serviços não existem.
- Um único adapter (Node). Nenhuma descoberta de plugins.
- Monorepo: apenas a fronteira de projeto. Não há readiness por workspace nem
  agregação entre pacotes.
- Sem `.setupguard.yml`: não há como suprimir um achado nem marcar uma variável
  como opcional.
- `node/package-manager-available` verifica só a presença no `PATH`, não a
  versão declarada em `packageManager` (verificar a versão exigiria executar o
  binário).
- Dependências instaladas (`node_modules` coerente com o lockfile) não são
  verificadas.
- Drift de documentação cobre só scripts; arquivos, caminhos e portas citados
  ainda não.
- Sem cache, watcher ou execução incremental.
- **Node 22.13 e 24 verificados em Ubuntu, macOS e Windows.** A fronteira de
  symlink continua não verificada no Windows, onde os testes se pulam.
- O cancelamento é cooperativo: `Promise.race` destrava o motor e o `AbortSignal`
  avisa o check, mas um laço síncrono que ignore o sinal não é interrompido.
- A máscara de comentários não rastreia literais de expressão regular. Um `//`
  dentro de um regex faz o resto da linha ser tratado como comentário.
- Literais de string ainda são varridos por `process.env.X`: mascarar o conteúdo
  de strings quebraria a forma `process.env['NOME']`, cujo nome vive dentro de
  uma string.
- A redaction é baseada em forma, não em conhecimento do que é segredo. Um valor
  passado por posição (`mycli deploy <token>`) ou atrás de uma flag curta
  anônima (`-p senha`) não tem sinal para ser reconhecido e passa.
- Hardlinks apontando para fora do workspace não são bloqueados; ver o threat
  model em [09-seguranca-e-confiabilidade.md](09-seguranca-e-confiabilidade.md).
- Blocos de código indentados com 4 espaços não são varridos pelo scanner de
  documentação.
- `run-s`, `npm-run-all` e wrappers como `cross-env` interrompem o parse de
  referências de script (falso negativo deliberado).
- `Report.root` não é sanitizado (é o caminho que o usuário passou).
- Identificadores de check não são sanitizados; isso precisa mudar antes de
  aceitar adapters de terceiros.
- As camadas de `.env` são uma heurística de framework, não um contrato do Node.
- O auto-diagnóstico estático roda em toda a matriz; o completo roda apenas com
  Node 24, que corresponde ao `.nvmrc` (ver integração contínua).
