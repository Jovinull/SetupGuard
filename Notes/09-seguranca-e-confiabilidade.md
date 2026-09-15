# Segurança e confiabilidade

## Modelo local-first

O core deve operar localmente, lendo arquivos e consultando ferramentas, sockets e serviços da própria máquina. Nenhum dado precisa sair da máquina para os checks principais.

Mensagem de produto sugerida:

> Local-first. No source code leaves your machine.

Essa afirmação só poderá ser usada sem ressalvas se telemetria, integrações e dependências futuras preservarem esse contrato ou forem claramente opcionais.

## Classes de execução

### Checks seguros para execução automática

Exemplos da fonte:

- existência de arquivo;
- ferramenta instalada;
- versão de ferramenta;
- porta ocupada;
- variável definida, sem revelar valor;
- script existente;
- Docker disponível;
- presença/coerência de lockfile.

Mesmo checks de leitura precisam de limites de tempo, tratamento de erro e cuidado com workspaces não confiáveis.

**Decidido em v0.1**: todos os nove checks implementados são `read-only` e **nenhum executa processo**. Disponibilidade de ferramenta é resolvida por busca no `PATH`, sem executar o binário: rodar `yarn --version` pode fazer o Corepack baixar um toolchain, ou seja, um efeito colateral em um diagnóstico que se declara read-only.

Limites implementados:

- **Confinamento à raiz, em duas camadas.** A camada léxica recusa caminho absoluto e `..`. A camada física resolve symlinks com `realpath` e verifica se o alvo real continua sob a raiz, **antes de qualquer leitura**.

  > **Correção pós-QA.** A primeira versão afirmava "symlinks não são seguidos" e isso era falso para leitura direta: `fs.stat`/`fs.readFile` seguem links, e só o walker recursivo os ignorava. Um `package.json` commitado como link para `/etc/passwd` era lido e parte do conteúdo externo aparecia no report. Corrigido; há testes para symlink de arquivo, de diretório, cadeia de symlinks, link quebrado e link interno legítimo.

- arquivos acima de 2 MiB recusados;
- symlinks nunca percorridos pelo walker e nunca lidos quando apontam para fora;
- diretórios gerados (`node_modules`, `dist`, `.git`, …) nunca percorridos;
- timeout de 10 s por check e 30 s por adapter, com `AbortSignal` propagado ao check.

### Checks profundos ou potencialmente mutáveis

Exemplos:

- `pnpm build`;
- `npm test`;
- `docker compose up`;
- `prisma migrate`;
- comandos customizados;
- conexões a bancos e serviços.

Não devem rodar escondidos. O usuário deve iniciá-los ou autorizá-los por configuração clara, sabendo o comando e o possível efeito.

**Decidido em v0.1**: o contrato `Check` tem um campo `safety: 'read-only' | 'side-effects'`, e o motor recusa executar um check `side-effects` a menos que `allowSideEffects` seja passado explicitamente. O padrão é `false`. Nenhum check com efeito colateral foi implementado ainda — a guarda existe antes do primeiro candidato, de propósito.

## Correções

Ordem de maturidade definida pela fonte:

1. detectar;
2. explicar;
3. localizar;
4. oferecer Quick Fixes seguros;
5. considerar remediação automatizada apenas posteriormente.

Toda ação destrutiva precisa de confirmação. Ações aparentemente simples, como liberar uma porta, podem encerrar processos de terceiros e devem receber tratamento especialmente conservador.

## Segredos e dados sensíveis

O produto pode precisar saber se uma variável existe ou testar uma conexão, mas não precisa expor seu conteúdo. Requisitos mínimos:

- nunca incluir valor de segredo em mensagens, logs ou telemetria;
- evitar persistir snapshots de ambiente;
- redigir stdout/stderr de processos quando puder conter credenciais;
- não ler arquivos além do necessário para o check;
- informar quando uma integração opcional enviar contexto a terceiros.

**Decidido em v0.1**: defesa em duas camadas — construção **e** redaction central.

### Camada 1 — não obter o valor

- `EnvironmentProbe` não expõe API alguma para ler o **valor** de uma variável de ambiente — só `hasEnvVar(name)` e `envVarNames()`.
- O parser de `.env` descarta o valor no momento do parse; só chaves, números de linha e "está vazio?" sobrevivem.
- Evidência de uso de variável **não** inclui trecho do código-fonte: uma linha como `process.env.TOKEN ?? 'fallback'` colocaria uma credencial literal no report.

### Camada 2 — sanitização central antes de serializar

> **Correção pós-QA.** A camada 1 sozinha era insuficiente, e a afirmação "um valor não pode vazar" era falsa. Três canais foram reproduzidos:
>
> 1. um comando documentado como `TOKEN=QA-FAKE-CREDENTIAL-0005 npm run missing` era citado literalmente em `message` e em `evidence.excerpt`;
> 2. a mensagem nativa de `JSON.parse` **repete um trecho da entrada** — um `package.json` malformado começando por uma credencial punha a credencial no report;
> 3. qualquer `Error.message` lançado de dentro de um check.

A solução não depende de cada check lembrar de ocultar dados. Há **um único ponto de passagem**, na saída de `runDiagnosis`:

```ts
const sanitized = results.map(sanitizeResult);
```

Ele fica em `packages/core/src/engine/run.ts`, depois de todos os checks rodarem e antes de qualquer serialização ou renderização (`packages/core/src/util/redact.ts` e `engine/sanitize.ts`). Ficar aqui, e não em `normalizeOutput`, é o que faz a sanitização alcançar também os resultados que nunca passam por um check: `skipped`, falhas de adapter e exceções.

O que é removido:

As regras são escritas contra a **classe** do problema, e a decisão é sempre do *nome* da chave, nunca do delimitador:

| Forma | Regra |
|---|---|
| `NOME=valor` | sempre redigido — o lado direito de uma atribuição é um valor de ambiente |
| `--flag=valor` e `--flag valor` | redigido quando o nome da flag tem forma de credencial |
| `Chave: valor` e `chave:valor` | redigido quando a chave tem forma de credencial |
| `user:senha@host` em URL | sempre redigido |
| `Bearer <token>` solto | sempre redigido |
| caracteres de controle | sempre removidos |

"Forma de credencial" é decidida por `isSensitiveKey`, que quebra a chave em palavras (camelCase, kebab, snake, pontos) e testa contra uma lista curta — então `--api-key`, `apiKey`, `API_KEY` e `X-Api-Key` são todos cobertos por uma única entrada, enquanto `--keyword` continua intacto. Estender a cobertura é acrescentar uma palavra.

> **Correção pós-QA (3ª rodada).** A versão anterior decidia pelo **delimitador**: recusava-se a tocar em qualquer coisa precedida de `-`, para não estragar `--filter=web`. Resultado: `--otp=123456` passava inteiro para `evidence.excerpt` e para `evidence.detail`, enquanto `OTP=123456` era redigido. Delimitador não carrega significado; nome carrega.

O que passa por isso, e com que limite:

| Campo | Tratamento |
|---|---|
| `message`, `explanation`, `expected`, `actual`, `remediation`, `evidence.excerpt`, `evidence.detail`, `reason` do resultado | `redact`, máximo 400 caracteres |
| `evidence.file` | `redactPath` (segmento a segmento), máximo 200 caracteres |
| `checkId`, `code`, `title`, `category`, `level`, `status` | não passam: são identificadores estruturais do próprio SetupGuard, não conteúdo do repositório |
| `Report.root` | não passa: é o caminho que o usuário pediu na linha de comando; escondê-lo esconderia *o que foi analisado* |

A isenção dos identificadores estruturais vale enquanto todos os adapters forem de primeira parte, e precisa ser revista antes de aceitar plugins de terceiros.

Guardas contra sobre-redaction, com testes: `>=20`, `--filter=web`, `config.key=value` e `DATABASE_URL=` (vazio, cuja vacuidade é a informação) passam intactos.

Mensagens nativas de parser **nunca** são serializadas: `describeJsonParseError` extrai apenas a posição e descarta o resto.

Testes de segurança cobrem os quatro canais (Markdown, parser, symlink, dotenv) como reproduções, não como testes unitários do conserto.

Não há telemetria de nenhum tipo. A política formal continua **Em aberto**, mas não há o que politicar enquanto nada é coletado.

## Threat model

Escrito explicitamente para que a documentação não prometa mais do que o código entrega.

**Atacante considerado:** quem controla o *conteúdo do repositório* que você está diagnosticando — um pull request de terceiro, um repositório clonado de origem desconhecida, um template gerado.

**Objetivo do atacante:** fazer o SetupGuard ler algo fora do workspace, ou colocar um segredo dentro do report (que vai para o terminal, para o JSON de CI e para o painel do editor).

| Vetor | Situação |
|---|---|
| `..` no caminho | **Bloqueado** — guard léxico em `resolve()` |
| Caminho absoluto | **Bloqueado** — mesmo guard |
| Symlink de arquivo apontando para fora | **Bloqueado** — `realpath` + verificação da raiz real |
| Symlink de diretório apontando para fora | **Bloqueado** — idem, e o walker nunca percorre symlink |
| Cadeia de symlinks | **Bloqueado** — `realpath` resolve a cadeia inteira |
| Arquivo gigante / bomba de leitura | **Limitado** — 2 MiB por arquivo, aferido no mesmo file handle da leitura |
| Varredura infinita | **Limitado** — teto de arquivos e de profundidade, ambos reportados como lacuna |
| Execução de código do projeto | **Impossível** — nenhum comando é executado em nenhum nível implementado |
| Segredo em conteúdo do repositório | **Mitigado** — sanitização central; ver acima |
| **Hardlink apontando para fora** | **NÃO bloqueado** — ver abaixo |

### Hardlinks: limite conhecido e assumido

Um hardlink não tem "alvo": ele é uma segunda entrada de diretório para o mesmo inode. `realpath` devolve o caminho de dentro do workspace, porque é isso que o caminho é. Não existe checagem portátil que distinga um hardlink malicioso de um legítimo:

- `stat().nlink > 1` acusa qualquer arquivo com múltiplas entradas — e gerenciadores de pacote com store por hardlink (pnpm), caches de CI e filesystems com deduplicação produzem isso o tempo todo. Seria um falso positivo constante.
- No Windows `nlink` frequentemente vem 1 mesmo quando há hardlinks.
- Comparar `dev`/`ino` com a árvore inteira custaria uma varredura completa do sistema de arquivos.

Como não há mitigação confiável e barata, **nenhuma foi implementada**: inventar uma proteção parcial seria pior do que declarar o limite.

O que **contém** o risco na prática: Git não versiona hardlinks. Um repositório clonado não pode carregar um — o vetor exige acesso de escrita local ao diretório, e quem tem isso já pode simplesmente ler os arquivos diretamente. Por isso o limite é aceitável para o modelo de ameaça acima, e está documentado em vez de silenciado.

## Workspaces não confiáveis

Arquivos do repositório e comandos declarados devem ser tratados como conteúdo não confiável. Analisar texto e manifests não equivale a autorizar a execução de scripts. A extensão deve respeitar o modelo de Workspace Trust do VS Code; o comportamento exato está **Em aberto**.

## Conectividade

- preferir testes mínimos (handshake/ping) em vez de operações de dados;
- usar timeout curto e cancelamento;
- não fazer migrações ou escritas para “testar” banco;
- distinguir serviço inacessível, credencial inválida e teste não executado quando possível;
- não presumir acesso à internet.

## Falsos positivos e confiança

A credibilidade do SetupGuard depende de estar certo na maioria das vezes. Variáveis e requisitos inferidos devem distinguir:

- `REQUIRED`;
- `OPTIONAL`;
- `INFERRED`;
- `UNKNOWN`.

Exemplo: uma variável acessada obrigatoriamente pelo código pode ter confiança alta; uma variável que aparece apenas em `.env.example` pode ser opcional e ter confiança menor.

Cada achado inferido deve informar:

- fonte;
- confiança;
- razão da classificação;
- forma de silenciar/configurar quando a inferência não se aplica.

**Decidido em v0.1**: a escala de confiança é `high | medium | low`.

- `high` — derivado de uma declaração explícita do repositório;
- `medium` — derivado de convenção forte ou de inferência sobre o código-fonte;
- `low` — heurística (reservado; ainda não emitido).

A confiança governa a severidade nos casos ambíguos: `npm run X` (explícito) é `error`; `pnpm X` (implícito, poderia ser um sub-comando desconhecido) é `warning`.

Sintaxe de supressão continua **Em aberto** — depende de `.setupguard.yml`, que não existe ainda. Hoje o único controle é `--level` e `--fail-on`.

## Falhas do próprio SetupGuard

Erros de parser, timeout e exceções internas não devem ser reportados como se provassem uma falha no projeto. O produto precisa distinguir pelo menos:

- check aprovado;
- problema encontrado;
- check não aplicável;
- check não executado;
- check inconclusivo;
- erro interno.

**Decidido em v0.1** — os nomes são:

| Estado | Nome |
|---|---|
| check aprovado | `pass` |
| problema encontrado | `warning` / `error` (pela severidade do achado) |
| check não aplicável | `not-applicable` |
| check não executado | `skipped` |
| check inconclusivo | `inconclusive` |
| erro interno | `internal-error` |

Os quatro últimos descrevem o SetupGuard, não o projeto, e nenhum deles produz `BLOCKED`. Quanto a `READY`, eles se dividem em dois grupos — ver [04-funcionamento-e-checks.md](04-funcionamento-e-checks.md):

- `inconclusive` e `internal-error` **impedem** `READY`: significam que algo deveria ter sido verificado e não foi, então o estado agregado é `INCOMPLETE`;
- `skipped` e `not-applicable` **não impedem** `READY`: não contam como evidência positiva, mas são o resultado normal de um check que legitimamente não se aplica ao projeto ou cujo nível não foi pedido. Um `pass` ao lado deles continua `READY`.

Exceções e timeouts viram `internal-error`; a CLI os imprime em uma seção "Not verified" e usa o exit code 3 (diagnóstico parcial), nunca o 1 (projeto com achados).

> **Correção pós-QA.** Achados de leitura eram coletados e nunca consultados: um `.nvmrc` ilegível virava "versão não declarada", e uma varredura truncada virava "tudo documentado" — ambos falsos `READY`. Agora cada lacuna tem um **escopo** (`package.json`, `node-version`, `env-template`, `env-local`, `source-scan`, `documents`) e todo check que dependa de um escopo com lacuna devolve `inconclusive`. O `walk` também informa se foi truncado.

## Dependências e plugins

Uma futura API comunitária aumenta a superfície de risco. Assinatura, revisão, permissões, isolamento de processo e confiança em adapters externos ainda estão **Em aberto** e não devem ser presumidos no MVP.

