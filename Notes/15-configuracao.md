# Configuração — `.setupguard.yml`

Este documento é a referência do arquivo de configuração. O que existe no código
hoje está aqui; o que foi deliberadamente deixado de fora está no final.

## Por que ele existe

Uma única razão: **permitir que um repositório declare uma exceção legítima sem
desligar uma categoria inteira pela linha de comando.**

Todo repositório real tem um achado que ele considera aceitável — uma variável
opcional, um comando ilustrativo no README, uma pasta gerada. Antes disso, as
únicas saídas eram `--level` e `--fail-on`, que desligam demais. Sem supressão,
o primeiro falso positivo faz a pessoa desinstalar.

Não é um sistema de políticas. A superfície é pequena de propósito, e cresce só
quando um caso real provar que precisa.

## Schema suportado

```yaml
version: 1

checks:
  node/docs-script-drift:
    severity: warning
  node/env-contract:
    severity: off

env:
  optional:
    - SENTRY_DSN
    - ANALYTICS_KEY

ignore:
  - docs/generated/**
  - examples/**
```

Nada além dessas quatro chaves é aceito. O arquivo é opcional; sem ele o
comportamento é exatamente o de antes deste marco.

### `version`

Obrigatório quando o arquivo existe. Único valor aceito: `1`.

Ausente, inválido ou futuro → erro de configuração. **Não há fallback
silencioso**: um arquivo escrito para uma versão que este binário não entende
seria aplicado pela metade, e metade de uma supressão é pior que nenhuma.

### `checks.<id>.severity`

| Valor | Efeito |
|---|---|
| `error` | todo finding daquele check passa a `error` |
| `warning` | todo finding daquele check passa a `warning` |
| `off` | o check **não roda**; status `skipped` |

Sem entrada para um check, o comportamento dele é exatamente o padrão.

Regras:

- **ID desconhecido é erro de configuração**, não é ignorado. Um `node/docs-drift`
  digitado errado faria o autor acreditar que silenciou algo que continua
  disparando. A mensagem lista os ids conhecidos.
- O override só alcança **findings**. Os estados que descrevem o SetupGuard —
  `skipped`, `not-applicable`, `inconclusive`, `internal-error` — são
  intocáveis. Configuração não pode transformar uma limitação da ferramenta em
  afirmação sobre o projeto.
- `off` pula a execução em vez de descartar os findings depois. É mais barato e
  mais honesto: o relatório diz `skipped`, não `pass`. Se **todos** os checks
  forem desligados, não há evidência positiva e o resultado é `INCOMPLETE` — o
  que está correto, porque nada foi verificado.

### `env.optional`

Nomes exatos de variáveis que o projeto funciona sem. Sem regex nesta versão:
um padrão que silencia mais do que o autor imaginava é o oposto do objetivo.

Uma variável listada aqui **nunca produz finding de ambiente**: nem por estar
ausente do `.env`, nem por estar vazia, nem por não constar do `.env.example`, e
não conta para o total de "N variáveis" de `node/env-example-missing`.

Listar um nome que o projeto não usa é aceito em silêncio. É uma declaração de
intenção, e punir quem se antecipou seria ruído.

> Declarar uma variável como opcional **não** dá ao SetupGuard acesso ao valor
> dela. A garantia de [09](09-seguranca-e-confiabilidade.md) continua inteira: a
> ferramenta manipula nomes, nunca valores.

Nomes devem casar `^[A-Za-z_][A-Za-z0-9_]*$`. Duplicata é erro.

### `ignore`

Padrões relativos à raiz do workspace.

**Onde se aplica — exatamente dois lugares:**

| Varredura | Aplica? |
|---|---|
| Varredura de código-fonte (`scanEnvUsage`) | **sim** |
| Varredura de documentação (`docs/**` + arquivos de doc na raiz) | **sim** |
| Leituras estruturais (`package.json`, lockfiles, `.nvmrc`, `.env*`) | **não** |
| Busca de fronteira de monorepo (`findNestedProjectDirs`) | **não** |

As duas exclusões são deliberadas:

- **Arquivos estruturais nunca são escondidos.** São lidos por nome, nunca via
  `walk`. Nenhum padrão pode fazer um projeto parecer inexistente — `ignore` não
  é um interruptor geral disfarçado.
- **Fronteira de monorepo não é configurável.** É um mecanismo de precisão:
  deixar de detectar um pacote aninhado só pode *criar* falso positivo,
  atribuindo o código do filho à raiz.

**Forma canônica obrigatória.** Um padrão é aceito exatamente como deve ser
escrito: sem prefixo `./`, sem separador `\`, sem segmento vazio ou `.`, sem
barra final, sem espaços em volta, sem caractere de controle. Escrever de outra
forma é erro, e a mensagem diz qual é a forma canônica.

A razão é paridade: reescrever em silêncio fazia `docs` e `./docs` colidirem
como duplicata **depois** da normalização, enquanto o `uniqueItems` do JSON
Schema via duas strings diferentes. Unicidade pós-normalização não é expressável
em JSON Schema; exigir a forma canônica torna as duas iguais. E como
`.setupguard.yml` é commitado e compartilhado entre plataformas, `docs\generated`
é um erro de digitação venha de onde vier — não uma variante regional.

**Dialeto suportado:**

| Padrão | Casa com |
|---|---|
| `examples` | o diretório e tudo abaixo dele |
| `examples/**` | o diretório e tudo abaixo dele |
| `docs/*.md` | Markdown direto em `docs`, não em subpastas |
| `docs/**/*.md` | Markdown em qualquer profundidade sob `docs` |
| `build?` | `build1`, `buildX` — um caractere, nunca separador |

Não suportado de propósito: chaves (`{a,b}`), classes (`[ab]`), negação (`!`) e
caminho absoluto. Cada um adiciona uma forma de escrever um padrão que significa
algo diferente do que aparenta.

**Guardas de caminho**, todas testadas:

- `../` em qualquer posição → erro;
- caminho absoluto Unix (`/etc/...`) → erro;
- caminho absoluto Windows (`C:\...`, `C:/...`) → erro;
- separadores `\` normalizados para `/`, então um padrão escrito no Windows casa
  com a saída POSIX do `walk`;
- padrões ordenados na normalização, para que duas execuções da mesma
  configuração produzam a mesma ordem;
- o confinamento físico de [09](09-seguranca-e-confiabilidade.md) continua
  valendo: symlink para fora nunca é percorrido, com ou sem `ignore`.

## Arquitetura

Uma fase só, antes de qualquer check rodar:

```text
discover (.setupguard.yml)
      ↓
parse (yaml)
      ↓
validate (diagnósticos com linha/coluna/campo)
      ↓
normalize
      ↓
ResolvedConfig
      ↓
runDiagnosis ──► DiscoveryContext.config ──► adapters e checks
```

`packages/core/src/config/` é o **único** lugar que toca YAML. Adapters e checks
recebem `ResolvedConfig` já validado; nenhum deles vê um valor cru.

Divisão de trabalho:

- **O motor** aplica `checks.<id>.severity`. Nenhum check sabe que foi
  re-nivelado ou desligado — é um cuidado a menos para cada check futuro.
- **Os adapters** consomem o que muda *o que eles coletam*: `ignore` estreita as
  varreduras, `optionalEnvVars` estreita o que reportam.

### Fronteira core ↔ ecossistema

`version`, `checks` e `ignore` são genéricos e pertencem ao core.

`env.optional` também ficou no core, e a razão é específica: **variáveis de
ambiente já são um conceito do core** — `EnvironmentProbe` expõe
`hasEnvVar(name)` e `envVarNames()`. O core sabe que variáveis de ambiente
existem; continua sem saber o que é `package.json`, npm ou pnpm.

Uma opção genuinamente específica de ecossistema (algo como
`node.lockfile.strict`) **não** entraria assim. Precisaria de um namespace por
adapter e de composição de schema, e isso está registrado como em aberto.

### Mudança nos contratos

A menor possível: `DiscoveryContext` (e por herança `CheckContext`) ganhou um
campo `config: ResolvedConfig`. Nada foi removido nem renomeado.

## Configuração inválida

Um `.setupguard.yml` quebrado **não** é um achado sobre o projeto. Ele não
impede ninguém de clonar e rodar o repositório; ele impede que o diagnóstico
configurado aconteça.

Semântica, usando os estados que já existiam:

- readiness = **`INCOMPLETE`**, com **precedência sobre tudo, inclusive
  `BLOCKED`**;
- exit code **3**, o mesmo de qualquer diagnóstico incompleto — nenhum código
  novo;
- a execução continua **com os padrões**, então o usuário ainda recebe
  informação;
- os diagnósticos saem em uma seção própria, antes de qualquer coisa sobre o
  projeto.

Por que precedência total? Se a configuração não foi aplicada, não sabemos o que
o autor queria. Um `BLOCKED` produzido com padrões pode ser exatamente o achado
que a configuração rebaixaria. Dizer "incompleto" é a única afirmação honesta.

### Códigos de diagnóstico

| Código | Quando |
|---|---|
| `config/unreadable` | arquivo existe mas não pôde ser lido, ou o filesystem falhou ao ser consultado |
| `config/not-a-file` | o caminho existe mas não é arquivo regular utilizável: diretório, symlink quebrado, ou symlink para fora do workspace |
| `config/invalid-yaml` | sintaxe inválida, ou chave duplicada |
| `config/unsupported-syntax` | alias/âncora YAML, ou tag desconhecida |
| `config/not-an-object` | documento não é um mapeamento |
| `config/version-missing` | sem `version`, ou arquivo vazio |
| `config/version-unsupported` | `version` diferente de `1` |
| `config/unknown-key` | chave fora do schema |
| `config/wrong-type` | tipo errado para uma chave conhecida |
| `config/unknown-check` | id de check inexistente |
| `config/invalid-severity` | severity fora de `error`/`warning`/`off` |
| `config/invalid-env-name` | nome que não parece variável de ambiente |
| `config/duplicate-entry` | entrada repetida em `env.optional` ou `ignore` |
| `config/invalid-ignore-pattern` | absoluto, `../`, negação, sintaxe não suportada, caractere de controle, ou forma não canônica |
| `config/misnamed-file` | existe `.setupguard.yaml` (ou similar) e nenhum `.setupguard.yml` |

Cada diagnóstico aponta arquivo, linha, coluna e o campo (`checks.node/x.severity`)
quando a posição é conhecida. **Todos os campos livres passam pelo mesmo redactor
dos findings** — a mensagem cita conteúdo do repositório, e uma chave chamada
`API_TOKEN=<valor>` colocaria o valor no campo `path`. Isso foi encontrado por
teste durante a implementação.

O arquivo é lido pelo `WorkspaceFs`, então herda o limite de 2 MiB e o
confinamento à raiz.

**Presença e usabilidade são perguntas separadas.** Colapsá-las em `isFile()`
fazia um `.setupguard.yml` que fosse diretório, symlink quebrado ou symlink para
fora do workspace parecer exatamente igual a "nenhum arquivo" — e uma
configuração que elevasse um warning a error sumia em silêncio, com exit 0. A
descoberta usa `listDir` para saber se a entrada existe e `isFile` para saber se
serve; existir sem servir é `config/not-a-file`.

`loadConfig` **nunca lança**, e isso é contrato exportado: todo o corpo está
dentro de uma barreira de erro, porque uma implementação de `WorkspaceFs` que
rejeite não pode derrubar a execução.

## Segurança do YAML

Configuração é dado, nunca código.

- Biblioteca: **`yaml` 2.9.x**. Escolhida sobre `js-yaml` por: **zero
  dependências transitivas** (js-yaml carrega `argparse`), ESM nativo, metade do
  tamanho (670 KiB contra 1.5 MiB), licença ISC, manutenção ativa, e — decisivo
  — expõe posição de linha/coluna por nó, que é o que permite apontar o campo
  problemático.
- Schema YAML 1.2 core: `off` continua a string `"off"`, sem a armadilha de
  booleano do YAML 1.1.
- **Tags desconhecidas são rejeitadas.** O parser as reporta como aviso e degrada
  o valor; aceitar seria aceitar um documento que não entendemos.
- **Âncoras e aliases são rejeitados** — os dois, e não só os aliases. Uma
  âncora é como um alias se escreve; declarar "sem âncoras" e procurar apenas
  por aliases deixava `version: &release 1` passar em silêncio. Configuração não
  precisa de nenhum dos dois, e expansão de alias é a única parte do YAML que
  transforma um documento pequeno em um muito grande.
- `uniqueKeys` liga: chave repetida é erro, em vez de a última vencer em
  silêncio.
- Merge keys (`<<`) desligadas.

## JSON Schema

`schemas/setupguard.schema.json`, gerado — nunca editado à mão.

**Fonte de verdade: o TypeScript.** As constantes em
`packages/core/src/config/schema.ts` (versão aceita, severidades, chaves
permitidas, regex de nome de variável) alimentam **tanto** o validador **quanto**
`configJsonSchema()`. O arquivo é produzido por `pnpm run schema`, e um teste
compara byte a byte o arquivo em disco com a saída da função.

Divergir exige alterar a constante e não regenerar — e isso quebra o CI.

### Até onde o schema valida

A paridade é verificada de duas formas. Um **corpus** de 42 configurações roda
contra o schema e contra o loader exigindo o mesmo veredito, e um teste
**diferencial exaustivo** enumera todas as 7.380 strings de 1 a 4 caracteres
sobre um alfabeto escolhido para tocar cada regra (separadores, pontos,
curingas, negação, espaço, raiz de drive) e exige zero divergência nas duas
direções. O schema
expressa: tipos, chaves permitidas, `version`, severidades, nomes de variável,
duplicatas (`uniqueItems`) e a gramática completa de `ignore` — `../`, caminho
absoluto (Unix e Windows, inclusive atrás de espaço), negação, sintaxe não
suportada, caractere de controle e **forma não canônica**.

A gramática de `ignore` está escrita duas vezes: como asserções nomeadas em
`IGNORE_PATTERN_RULES` (que geram o `pattern` do schema) e como código em
`normalizeIgnorePattern`. As duas precisam aceitar o mesmo conjunto, e o corpus
é o que prova isso.

Há **uma** divergência conhecida, registrada no próprio teste com o motivo:
**ids de check**. Quais existem depende dos adapters carregados em tempo de
execução, e enumerá-los no schema publicado pelo core faria o core conhecer o
ecossistema. Para esse campo o schema é **estrutural**; o loader é a autoridade.

O que isso significa no editor: de tudo que o schema aceita, só um id de check
inexistente pode parecer válido e ainda assim produzir `INCOMPLETE` na execução.

A garantia continua sendo sobre o que é testado, não uma prova de equivalência:
o diferencial cobre exaustivamente até 4 caracteres, não strings arbitrárias.
Qualquer regra nova precisa entrar nos dois lados e no corpus. Foi exatamente
esse teste que pegou `...` — um nome de arquivo legítimo — sendo aceito pelo
loader e rejeitado pelo schema, porque a regex exigia um caractere que não fosse
ponto nem separador, mais estrito do que a regra que deveria espelhar.

Ainda não é distribuído por URL. Serve como contrato verificável e base para
autocomplete no editor mais adiante.

## Limitações conhecidas

- Uma configuração por workspace. Monorepo com config por pacote não existe.
- Sem `extends`, presets ou herança.
- Sem regex/glob em `env.optional`.
- Sem configuração global do usuário nem remota.
- Sem supressão por achado individual ou por linha — o grão é o check.
- `ignore` não alcança as leituras estruturais, de propósito (ver acima).
- Sem `--config <path>` na CLI; a descoberta é só na raiz do workspace.

## Registrado para depois

Surgiu durante a implementação e foi deliberadamente **não** feito:

- namespace de configuração por adapter, com composição de schema — necessário
  no primeiro segundo ecossistema;
- `--config <path>` e `--no-config` na CLI;
- publicação do JSON Schema em URL estável, para `# yaml-language-server:`;
- supressão por achado (`code`) além de por check;
- `env.required`, para o caso inverso.
