# Extensão VS Code — implementação

Registro do que a extensão faz, e por quê. O documento conceitual continua em
[07-extensao-vscode.md](07-extensao-vscode.md); quando os dois divergirem, **este
descreve o código**.

Data: 2026-09-15.

## Objetivo do marco

Instalar a extensão, abrir um projeto e receber os diagnósticos do SetupGuard
dentro do editor, sem rodar nada do projeto.

## Identidade do pacote

O pacote foi renomeado de `@setupguard/vscode` para **`setupguard`**.

Não foi preferência: o `name` de um manifesto de extensão precisa casar com
`^[a-z0-9][a-z0-9-]*$`, e nomes com escopo (`@org/nome`) são recusados pelo
empacotador. O identificador publicável passa a ser `jovinull.setupguard`.

Consequências: `tsconfig.check.json`, `vitest.config.ts` e os testes do pacote
importam `setupguard`. O pacote continua `private: true`.

## Camadas

```text
src/extension.ts        única a importar `vscode`; só fiação
   ↑
src/session.ts          ciclo de vida de um diagnóstico
src/status.ts           estado da status bar
src/diagnostics.ts      Report → diagnostics do editor
src/report-view.ts      Report → texto do relatório
src/watch-patterns.ts   o que observar, o que descartar
   ↑
@setupguard/core + @setupguard/adapter-node
```

A regra é a mesma do marco anterior invertida: onde há **decisão**, não há
`vscode`. Coalescer edições, descartar um resultado obsoleto, cancelar uma
execução que deixou de importar, escolher o texto da status bar, decidir se um
evento de arquivo vale uma nova análise — tudo isso é testável sem Extension
Host. `extension.ts` cria objetos do VS Code, entrega os resultados prontos e
descarta. Um teste garante que nenhum outro módulo importe `vscode`.

## Ciclo de vida (`DiagnosisSession`)

Três fases: `idle` → `running` → `settled`.

- `request()` agenda uma execução depois de um período de silêncio (**750 ms**).
  Chamadas repetidas cancelam a anterior: um `git checkout`, um `pnpm install`
  ou um find-and-replace tocam muitos arquivos observados de uma vez, e analisar
  o workspace uma vez por arquivo seria lento e inútil.
- `runNow()` pula o silêncio. É o que o comando explícito usa, e ele cancela um
  `request()` pendente para não executar duas vezes.
- Cada início incrementa uma **geração** e aborta a execução anterior. Quando uma
  execução termina, ela só publica se a geração ainda for a atual. Uma execução
  que termina depois de outra ter começado não tem nada de verdadeiro a dizer
  sobre o workspace como ele está agora.
- O último relatório bem-sucedido continua visível enquanto uma nova execução
  está em voo. O editor nunca fica em branco por estar pensando.
- `dispose()` aborta, cancela o agendamento e para de publicar.

O timer é **injetado**. Os testes o acionam à mão: nenhum `setTimeout` real,
nenhum fake timer, nenhuma espera. Toda asserção é sobre uma sequência que
realmente aconteceu.

## Status bar

Codicons apenas — nenhum emoji, nenhuma imagem.

| Estado | Texto | Fundo |
|---|---|---|
| nenhuma pasta aberta | `$(circle-slash) SetupGuard` | padrão |
| executando ou ainda não executado | `$(sync~spin) SetupGuard` | padrão |
| `READY` | `$(pass) SetupGuard: Ready` | padrão |
| `WARNINGS` | `$(warning) SetupGuard: Warnings` | aviso |
| `BLOCKED` | `$(error) SetupGuard: Blocked` | erro |
| `INCOMPLETE` | `$(question) SetupGuard: Incomplete` | aviso |
| falha da própria extensão | `$(question) SetupGuard: Incomplete` | aviso |

Duas decisões que valem a pena registrar:

- **`INCOMPLETE` não usa fundo de erro.** Nada foi provado errado no projeto;
  parte do diagnóstico é que não aconteceu. Usar vermelho seria acusar o
  repositório de um defeito que não foi demonstrado.
- **Falha da extensão é a própria extensão falando.** O tooltip diz
  `SetupGuard could not finish`, nunca um veredito sobre o projeto. Um erro do
  SetupGuard jamais é apresentado como um problema do repositório.

A regra que a status bar nunca pode violar: **ela não pode ser mais verde que o
relatório**.

## Multi-root

Cada `WorkspaceFolder` é analisado isoladamente: um `NodeWorkspaceFs` próprio,
uma sessão própria, watchers próprios, relatório próprio. Recusar multi-root
teria sido mais simples e menos honesto — a pessoa que abre dois repositórios
quer saber dos dois.

- **Problems** mostra todos, cada achado ancorado no arquivo da sua pasta.
- **Status bar** mostra o **pior**, com a ordem
  `BLOCKED > INCOMPLETE > WARNINGS > READY`. `INCOMPLETE` fica acima de
  `WARNINGS` porque "não verificado" e "verificado, só avisos" não são a mesma
  afirmação.
- **Relatório** concatena as pastas, cada uma com seu cabeçalho. Com uma pasta
  só, o cabeçalho some.
- Pastas adicionadas ou removidas em tempo de execução criam e destroem a sessão
  correspondente, e a coleção de diagnósticos é reconstruída.

Pastas cujo `uri.scheme` não seja `file` são puladas com uma linha no log. O
manifesto declara `virtualWorkspaces: false`; fingir analisá-las seria pior do
que dizer que não foram analisadas.

## Problems

A coleção é **reconstruída inteira** a cada mudança de estado, em vez de
remendada. Um achado pode mudar de arquivo, sumir, ou pertencer a uma pasta que
acabou de ser removida; reconstruir a partir dos relatórios atuais é a única
forma de garantir que o painel nunca mostre uma entrada obsoleta. O volume de
dados é pequeno.

Mapeamento de severidade: `error → Error`, `warning → Warning`, `info →
Information`. Posições são convertidas de 1-based (SetupGuard) para 0-based
(editor) em `diagnostics.ts`, que já existia e continua puro.

Findings sem arquivo (`unplaced`) são ancorados em `package.json` na raiz da
pasta. Sem isso, uma status bar dizendo `Blocked` poderia apontar para um painel
vazio. Na prática são raros: mesmo o achado "não existe `package.json`" carrega
`package.json` como evidência.

### Configuração

Problemas do `.setupguard.yml` viram diagnósticos **no próprio
`.setupguard.yml`**, com `checkId` `setupguard/config`, separados dos achados do
projeto por uma função própria (`toConfigDiagnostics`). São sempre `Error`,
porque todo diagnóstico de configuração significa que o diagnóstico configurado
não aconteceu: a execução caiu para os padrões e o readiness virou `INCOMPLETE`.

Um `.setupguard.yml` quebrado nunca é apresentado como defeito do repositório.

## Relatório

`SetupGuard: Show Report` abre um **documento virtual somente-leitura**
(`setupguard-report:SetupGuard.txt`), não uma WebView.

O relatório já é um documento; um editor o renderiza com zero superfície nova, e
não há HTML onde errar o escaping. O `OutputChannel` existe em paralelo, mas só
para log de ciclo de vida — nunca para conteúdo de relatório, porque é mais um
lugar onde um valor poderia acabar citado.

O texto é montado só a partir do `Report`, que o motor já sanitizou na saída.
Nada é acrescentado que a CLI não imprimiria.

## Watchers

Duas falhas opostas: observar de menos faz a status bar envelhecer em silêncio;
observar demais transforma um `pnpm install` em milhares de acordadas.

Observados (`WATCH_GLOBS`, relativos à pasta):

- manifestos e lockfiles em qualquer profundidade — um `sub/package.json` novo
  muda uma fronteira de workspace;
- `.nvmrc`, `.node-version`, `tsconfig.json`, `pnpm-workspace.yaml`;
- todos os arquivos `.env*` que os checks conhecem;
- `.setupguard.yml` **e** os nomes errados que o loader avisa — renomear
  `.setupguard.yaml` para `.setupguard.yml` limpa o aviso sem pedir nada;
- `*.md`, `docs/**/*.md`, `docs/**/*.mdx`, `.github/CONTRIBUTING.md`;
- fontes `.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`, porque o contrato de ambiente é
  inferido de como o código lê `process.env`.

Observar as fontes é o que faz "adicione uma variável, veja o aviso" funcionar
sem pedir execução manual; o debounce é o que impede que uma rajada de saves
vire uma rajada de execuções.

`shouldTriggerRun()` é a última linha de defesa: eventos vindos de
`DEFAULT_IGNORED_DIRS` (`node_modules`, `.git`, `dist`, `build`, …) são
descartados. O VS Code aplica `files.watcherExclude`, mas isso é uma
configuração do usuário, e um `pnpm install` escrevendo dezenas de milhares de
arquivos é exatamente quando menos queremos ser acordados. O motor ignora esses
diretórios de qualquer forma, então um evento vindo de lá não pode mudar o
relatório. A função distingue diretório de arquivo: `build/main.js` é
descartado, um arquivo chamado `build` não.

## Activation

```json
"activationEvents": [
  "workspaceContains:package.json",
  "workspaceContains:.setupguard.yml"
]
```

Sem `*` e sem `onStartupFinished`: o SetupGuard não deve rodar em janelas sobre
as quais não tem nada a dizer. Os comandos ativam a extensão sozinhos, pela
declaração em `contributes.commands`.

**Nada do projeto é executado durante a activation.** Os níveis implementados
(`static` e `environment`) leem arquivos e inspecionam a máquina local; nenhum
deles cria processo. `NodeEnvironmentProbe.which()` percorre o `PATH` com
`fs.access`, não executa o binário.

## Workspace Trust

```json
"untrustedWorkspaces": { "supported": true, "description": "..." }
```

Declarado com suporte porque a afirmação é verificável: os níveis implementados
não executam nada. A descrição no manifesto diz isso por escrito, onde um
revisor lê. Quando os níveis 3 e 4 existirem, eles exigirão workspace confiável —
e a declaração terá de mudar junto.

`extensionKind: ["workspace"]`: a extensão precisa do sistema de arquivos do
projeto, então roda do lado onde os arquivos estão.

## Configuração: nenhuma em `settings.json`

A extensão **não contribui nenhuma configuração**. Um teste garante isso.

O que vale configurar vale para o time inteiro e pertence ao `.setupguard.yml`
versionado, não ao `settings.json` de uma pessoa. Duas fontes de verdade sobre a
mesma decisão produziriam diagnósticos diferentes na mesma máquina de duas
pessoas, que é o problema que o SetupGuard existe para eliminar.

## O que a extensão consome do core

Nenhuma API nova foi adicionada ao `core` ou ao `adapter-node` para este marco.
A extensão usa exatamente o que a CLI já usava, mais os nomes de arquivo que a
configuração já expunha:

| Export | Onde | Para quê |
|---|---|---|
| `runDiagnosis` | `extension.ts` | executar um diagnóstico |
| `loadConfig` | `extension.ts` | uma passagem de configuração por execução |
| `AdapterRegistry`, `nodeAdapter` | `extension.ts` | o mesmo registro da CLI |
| `NodeWorkspaceFs` | `extension.ts` | raiz confinada por pasta |
| `NodeEnvironmentProbe` | `extension.ts` | nível `environment` |
| `describeError` | `extension.ts` | toda mensagem de erro exibida |
| `allFindings` | `diagnostics.ts` | achatar os achados |
| `CONFIG_FILE_NAME`, `MISNAMED_CONFIG_FILES` | `watch-patterns.ts` | o que observar |
| `DEFAULT_IGNORED_DIRS` | `watch-patterns.ts` | o que descartar |
| `Report`, `Finding`, `Severity`, `Readiness`, `ConfigDiagnostic` | vários | tipos |

A única API que a extensão gostaria de ter e não tem é um `AbortSignal` em
`loadConfig`; hoje o cancelamento só chega ao `runDiagnosis`. A leitura de
configuração é um arquivo pequeno, então na prática não é um problema.

## Empacotamento

- **esbuild** gera `out/extension.cjs`: CJS porque o Extension Host carrega o
  ponto de entrada com `require`, e extensão `.cjs` explícita em vez de depender
  do `package.json` mais próximo, que diz `module`.
- Empacotar não é otimização: um VSIX não tem `node_modules`, então
  `@setupguard/core`, `@setupguard/adapter-node` e `yaml` precisam estar
  embutidos ou a extensão não sobe.
- `external: ['vscode']` — fornecido pelo host.
- **Sem source map e sem minificação.** O VSIX não leva fontes, então um mapa
  apontaria para arquivos que ninguém tem; e o artefato distribuído fica
  legível, que é o que permite auditá-lo. Custo: 449 kB de bundle, 98 kB de
  VSIX.
- `.vscodeignore` é uma **allow-list** (`**` e depois `!` para o que entra). É a
  única forma que não vaza um diretório que alguém adicionar depois.

Conteúdo do VSIX, verificado: `extension.cjs`, `package.json`, `readme.md`,
`changelog.md`, `LICENSE.txt` e os dois arquivos do formato. Sete arquivos.
Nenhuma fonte, nenhum teste, nenhuma fixture, nenhuma `Notes/`, nenhum
`node_modules`.

`out/` e `*.vsix` estão no `.gitignore`.

## Publicação

**Nada foi publicado.** Não há publisher registrado, não há token, e nenhum
script do repositório chama `vsce publish`, `ovsx` ou `npm publish` — há um teste
que verifica isso. O VSIX é construído localmente e instalado por
`code --install-extension`.

## Correções no core feitas neste marco

Duas encontradas ao olhar o que o painel Problems realmente mostrava:

1. **Diagnóstico de chave desconhecida apontava para a linha errada.**
   `doc.getIn(path, true)` resolve para o nó de **valor**, então
   `cheks:\n  a: b` era reportado na linha 3 (o mapa aninhado) em vez da linha 2
   (a chave). Num terminal a diferença é cosmética; num editor, o sublinhado cai
   no lugar errado. Adicionado `locateKey`, usado por `config/unknown-key` e
   `config/unknown-check`.

2. **A remediação mais útil vinha vazia.** `Known keys: version, checks, env,
   ignore.` tem a forma `<nome>: <valor>`, e `keys` é um nome sensível, então o
   redator substituía a lista inteira por `***` — a orientação dizia nada.
   Reescrito como `Valid keys are …`. A redaction não foi enfraquecida: o texto
   é que deixou de ter forma de atribuição.

Ambas com teste de regressão em `packages/core/test/config.test.ts`.

## Testes

458 testes em 27 arquivos. O pacote da extensão contribui com 74:

| arquivo | o que cobre |
|---|---|
| `session.test.ts` (11) | debounce, coalescência, geração vencedora, abort, erro, dispose |
| `status.test.ts` (15) | os seis estados, agregação multi-root, tooltip, só Codicons |
| `report-view.test.ts` (10) | veredito, inconclusivos, configuração, multi-root, nada vazado |
| `watch-patterns.test.ts` (11) | cobertura dos globs, descarte de `node_modules`, separadores Windows |
| `manifest.test.ts` (13) | manifesto ↔ código, activation, trust, `.vscodeignore`, sem publicação |
| `diagnostics.test.ts` (5) | projeção de findings (pré-existente) |
| `config-diagnostics.test.ts` (5) | problemas de configuração, separados dos do projeto |
| `bundle.test.ts` (4) | o artefato empacotado carrega, ativa e não requer módulo perigoso |

`bundle.test.ts` é o único que carrega `out/extension.cjs`. Ele se pula quando
não existe bundle — o que é o caso nos jobs da matriz — e roda no job que
empacota. O módulo `vscode` é substituído pelo menor objeto que permite a
ativação terminar.

Esse substituto **não** representa o editor e não prova nada sobre renderização.
O que ele prova é mais estreito e vale ter: o bundle carrega como CommonJS, a
ativação e o descarte não lançam, um diagnóstico real de uma fixture percorre o
caminho inteiro, e nada nesse caminho requer `child_process`, `http`, `https`,
`net`, `tls`, `dgram`, `worker_threads`, `vm`, `cluster`, `http2` ou `inspector`
— a verificação de "não executa processo, não abre socket" feita sobre o
artefato distribuído, não sobre as fontes.

O que **não** é testado automaticamente: o comportamento real dentro do
Extension Host — renderização, atalhos, navegação a partir do painel Problems,
integração com Workspace Trust. Isso é verificado instalando o `.vsix`.

## Limitações conhecidas

- Sem Quick Fixes. Detectar, explicar e localizar antes de automatizar.
- Sem view própria na barra lateral; Problems e o documento de relatório bastam.
- O relatório é texto puro, sem links clicáveis para arquivo e linha (o painel
  Problems já oferece navegação).
- O debounce é fixo em 750 ms e não é configurável — ver a decisão sobre
  `settings.json`.
- Um repositório muito grande é reanalisado inteiro a cada mudança relevante:
  não há análise incremental nem cache entre execuções.
- Não há teste automatizado dentro do Extension Host
  (`@vscode/test-electron`); a verificação é manual.
