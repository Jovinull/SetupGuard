# GitHub Action — implementação

Este documento descreve **o que a Action faz hoje**, por que foi feita assim e
qual evidência existe. Onde divergir de [08-github-action.md](08-github-action.md),
vale este.

Estado em 2026-11-02: implementada; testada localmente; validada contra a API
real do GitHub em pull requests públicos; e **executada no GitHub Actions** no
próprio PR #1 deste repositório (caso positivo, `GITHUB_TOKEN` real) e num PR
temporário (caso negativo). Distribuída por GitHub Releases a partir de
`v0.1.0` (procedimento em `RELEASING.md`), referenciada por SHA; fora do GitHub
Marketplace. O que ainda não foi provado está listado ao fim.

## Decisões

| Assunto | Decisão | Por quê |
|---|---|---|
| Tecnologia | JavaScript Action, `runs.using: node24` | roda o mesmo core em processo; sem Docker, sem instalação em tempo de execução. `node24` é o runtime da documentação atual do GitHub |
| Distribuição | `action.yml` na raiz; `packages/github-action/dist/index.cjs` versionado | uso como `Jovinull/SetupGuard@<sha>`. Bundle esbuild (já dependência do repositório), CommonJS `.cjs` porque o `package.json` raiz é `"type": "module"` |
| Correspondência código ↔ artefato | CI reconstrói o bundle e roda `git diff --exit-code` | o bundle é byte-a-byte reprodutível (verificado: dois builds, mesmo SHA-256; só `\n`; caminhos relativos ao repositório) |
| Motor | `runDiagnosis` + `nodeAdapter`, os mesmos da CLI e da extensão | nenhuma regra duplicada. Verificado: CLI e Action produzem o mesmo conjunto de achados na mesma árvore |
| Nível | só `static` | o runner não é a estação de trabalho ([08](08-github-action.md)); o probe de ambiente é construído com `env: {}` |
| Evento | `pull_request`; `pull_request_target` é **recusado** | em fork o token é só leitura e sem segredos. `pull_request_target` faz checkout da base, não do PR, e tem token privilegiado — a análise descreveria a árvore errada |
| Permissões | `contents: read`, `pull-requests: read` | nenhuma escrita: sem `checks: write`, sem comentário no PR, sem PAT |
| Cliente HTTP | `fetch` global, sem Octokit | seis endpoints GET; menos dependência, tudo validado à mão |
| Outros eventos | `push`, `workflow_dispatch` etc. diagnosticam o checkout inteiro | mesmo veredito da CLI |

## Análise diferencial

### Qual é a base

- Checkout padrão de `pull_request` = **merge commit** (`refs/pull/N/merge`) =
  ponta da base + mudanças do PR. A base é o **primeiro pai** desse commit,
  obtido por `GET /repos/{o}/{r}/git/commits/{sha}`; exige-se que o segundo pai
  seja o head do PR.
- Checkout do head do PR → a base é o **merge base**, via
  `GET /repos/{o}/{r}/compare/{base}...{head}`.
- Qualquer outro commit → `incomplete`.

O commit em checkout é lido de `.git/HEAD` (e `packed-refs`) como arquivo —
**nenhum processo `git` é executado**.

Não se usa `pull_request.base.sha` do payload como base: na validação real
(expressjs/express #7578) o primeiro pai do merge commit era `bcc0551c`,
enquanto o payload dizia `1c6f1b0f`. A base tinha avançado e o GitHub
recalculou o merge sobre a ponta nova. Comparar com o payload estaria errado.

### Como a base é reconstruída

`BaseWorkspaceFs` implementa o mesmo `WorkspaceFs` do motor:

- caminho **não alterado** pelo PR → lido do disco (é idêntico na base);
- caminho **alterado** (os dois lados de um rename) → buscado na base por
  `GET /repos/{o}/{r}/contents/{path}?ref={base}`, **sob demanda**, só quando
  um check pede. Um PR que muda 400 imagens e um README custa uma requisição.

O status da API (`added`, `removed`…) **não** decide nada: para o merge
commit, um arquivo "added" pode existir na ponta da base (adicionado igual dos
dois lados). Todo caminho alterado é consultado; 404 = ausente.

Fidelidade: `walk` reproduz a ordem do walker em disco (DFS, irmãos por code
unit — não é ordem de string), os filtros, `ignore`, profundidade, `truncated`
e `depthLimited`. Arquivos > 2 MiB viram `FileTooLargeError` sem baixar o
conteúdo; entre 1 MB e 2 MiB o conteúdo vem pela Blob API. Symlink na base
lido diretamente → recusa explícita (não há como reproduzir a semântica de
link via API) e a comparação vira `incomplete`.

O teste de paridade (`test/base-fs.test.ts`) compara, para cada par de
fixtures, a visão reconstruída com um `NodeWorkspaceFs` aberto sobre a base
real: relatório inteiro, oito variações de `walk`, e `isFile`/`exists`/
`readText`/`listDir` em todo caminho. Duas mutações deliberadas no overlay
foram detectadas (32 e 4 falhas), então o teste tem dentes.

Limite conhecido da laziness: `loadConfig` lista a raiz (`listDir('.')`), e
listar um diretório exige saber se cada entrada alterada **diretamente nele**
existia na base. Arquivos alterados na raiz são consultados mesmo que nenhum
check os leia.

### O que é regressão

Identidade de um achado = `checkId + code + message`. **Linha não entra**
(mover um parágrafo não cria problema). **Severidade não entra na identidade,
mas é comparada** depois que duas ocorrências são casadas: se a base tinha o
problema com severidade **menor**, foi o PR que o elevou, e o achado conta
como novo na severidade nova, marcado `escalatedFrom` ("raised to error" na
anotação). Severidade reduzida continua preexistente.

> **Correção (revisão do PR).** A primeira versão ignorava a severidade por
> completo. O motor dá a mesma mensagem para `pnpm dev` (forma implícita →
> aviso) e `pnpm run dev` (explícita → erro), então um PR que reescrevia um
> aviso antigo como erro levava o repositório de `WARNINGS` a `BLOCKED` e o
> job **passava**. Reproduzido com a fixture `severity-raised` antes da
> correção; coberto por testes de aceitação e unitários.

Com múltiplas ocorrências, só o excedente é novo, e as ocorrências cuja
evidência (arquivo + trecho) bate com a base são casadas primeiro.

Check que na base terminou `inconclusive`, `internal-error` ou `skipped` →
seus achados no PR ficam **não classificados**. Config inválida na base →
tudo não classificado.

### Veredito (ordem de precedência)

1. erro novo → `fail`
2. PR não analisado por inteiro (check inconclusivo, config inválida,
   nada detectado) → `incomplete`
3. erro não classificado (ou aviso, com `fail-on: warning`) → `incomplete`
4. aviso novo com `fail-on: warning` → `fail`
5. caso contrário → `pass`

Qualquer falha de API, checkout desconhecido, PR que mudou durante a execução
(`head.sha` lido antes e depois da listagem), lista de arquivos inconsistente
com `changed_files`, PR com mais de 3000 arquivos, ou caminho perigoso vindo da
API → `incomplete`. Exit code 1 para `fail` e `incomplete`; só `pass` sai 0.
O output `result` distingue os dois.

## Segurança

- Conteúdo do PR é dado. Anotações escapadas como no `@actions/core`
  (`%`, `\r`, `\n`; e `:`, `,` nas propriedades); log humano dentro de
  `::stop-commands::<token aleatório por execução>`; summary com entidades
  HTML para todo caractere que HTML/Markdown interpretam e colapso de espaços
  (uma linha em branco encerraria o bloco HTML); outputs restritos a
  `[A-Za-z0-9_.-]`.
- Caminhos da API com `..`, `.git`, `/` inicial, `\`, caracteres de controle ou
  segmento vazio → `incomplete`. Git não produz esses caminhos; uma resposta
  que os contenha não é confiável.
- Token: só no header `Authorization`; nunca em mensagens de erro (que também
  não repetem o corpo da resposta nem o texto do erro de rede, que pode conter
  a URL). Teste verifica que não aparece em log nem summary.
- Orçamento: 400 requisições por execução; 2 retentativas (1 s, 3 s) só para
  5xx e erro de rede; rate limit (403/429 com `x-ratelimit-remaining: 0` ou
  `retry-after`) falha na hora com o horário de reset.

### A Action versus o CI deste repositório

São duas garantias diferentes, e só a primeira é da Action:

- **A Action** não executa nada do repositório analisado: lê arquivos, chama a
  API com GETs, e não tem nenhuma API de execução de processo ou `eval` no
  core, no adapter nem no próprio pacote (verificado por busca no código).
- **O CI deste repositório** (`ci.yml`) roda `pnpm install`, lint, testes e build
  **no checkout do PR**, ou seja, executa código do PR, como qualquer CI. E
  `setupguard.yml` usa `uses: ./`: a Action que analisa um PR é a versão
  daquele PR, que um fork pode alterar.

O que limita esse código vindo de fork (revisão de 2026-11-02):

- `pull_request`, nunca `pull_request_target`, nos dois workflows;
- `permissions:` declarado nos dois; token observado nas execuções reais:
  `Contents: read`, `Metadata: read` (CI) e `+ PullRequests: read` (Action);
- nenhum `secrets.*` referenciado em workflow algum;
- `persist-credentials: false` em todos os checkouts (no `ci.yml` desde esta
  revisão): o token não fica em `.git/config` para o código do PR ler;
- `allowBuilds` do pnpm só autoriza o postinstall do esbuild — mas um PR pode
  alterar esse arquivo também; o limite real é o token só leitura e sem
  segredos, que expira com o job.

Isto **não** torna o CI imune a um fork: um PR malicioso pode consumir minutos
de runner ou falhar os próprios jobs. Não pode escrever no repositório nem ler
segredos por esses workflows. Consumidores que fixam
`Jovinull/SetupGuard@<sha>` não executam código do PR na Action.

## Evidência

### Testes (locais, Windows, Node 24; e na matriz do CI)

613 testes no repositório (162 do pacote da Action).

- `acceptance.test.ts`: os sete casos da missão sobre `fixtures/pull-requests/*`
  (saudável, script removido, variável nova, problema preexistente com linha
  movida, conteúdo hostil, API indisponível, arquivos irrelevantes), mais
  severidade elevada pelo PR, rename/remoção, checkout head, checkout desconhecido, PR desatualizado,
  `pull_request_target`, sem token, >3000 arquivos, paginação (250 arquivos,
  3 páginas), seis caminhos hostis, determinismo, `push`, diretório sem
  projeto, `path` fora do workspace, limite de varredura e seu remédio. A API
  falsa deriva a lista de arquivos **do diff real** entre `base/` e `head/`.
- `base-fs.test.ts`: paridade (acima).
- `compare.test.ts`: política de regressão em relatórios construídos à mão.
- `output.test.ts`: escape de comandos (ida e volta exata), stop-commands,
  outputs, summary.
- `bundle.test.ts`: o `dist/index.cjs` **copiado para fora do repositório**
  (sem `node_modules` alcançável) executado como processo filho.

### API real (anônima, repositórios públicos, 2026-11-02)

Executado com o bundle, `INPUT_TOKEN` vazio (sem credencial alguma), sobre o
merge ref real buscado com `git fetch --depth=1 refs/pull/N/merge`:

| PR | Origem | Requisições | Tempo | Resultado |
|---|---|---|---|---|
| expressjs/express #7578 (2 arquivos de código) | fork | 6 (2 `contents`) | 4,4 s | `pass`; 3 achados preexistentes, nenhum atribuído ao PR |
| expressjs/express #7573 (1 workflow) | fork | 4 (0 `contents`) | 3,0 s | `pass` |
| vitejs/vite #23964 (3 docs, 2916 arquivos) | fork | 7 (3 `contents`) | 4,0 s | `incomplete`: `docs/` tem mais de 50 arquivos e a árvore passa da profundidade 8 |

A CLI, na mesma árvore, deu o mesmo conjunto de achados nos dois repositórios.

Achados da validação real:

1. **Falso positivo corrigido no motor**: `process.env.NO_DEPRECATION = '...'`
   (setup de testes do Express) era cobrado em `.env.example`. Escrever,
   `??=`, `||=` e `delete` não são dependência; corrigido em
   `adapter-node/src/facts/env-usage.ts`, com teste de regressão. Vale para
   CLI, extensão e Action.
2. **Falso positivo conhecido, não corrigido**: o README do Express manda rodar
   `npm start` num app **gerado** em `/tmp/foo` (`cd` em um bloco anterior). O
   scanner atribui o comando ao `package.json` da raiz. Seguir `cd` entre
   blocos é heurística com risco de falso negativo; fica em aberto.
3. **Relato de `incomplete` melhorado**: no Vite a primeira versão dizia só "2
   checks could not reach a conclusion". Agora cada check inconclusivo aparece
   com o motivo do motor, e o summary aponta `ignore:` como remédio (teste
   cobre o caso e prova que o remédio funciona).

### Primeiro consumidor: o próprio repositório

Num clone limpo, o auto-diagnóstico do CI acusou `BLOCKED`: a nova introdução
do README citava `` `npm run dev` `` como exemplo de drift, e este repositório
não tem script `dev`. A frase foi reescrita; o check não foi afrouxado. CLI
(estático e completo) e a Action em modo `push` sobre o repositório dão
`READY`/`pass`.

De novo na revisão de segurança: a primeira versão de
`scripts/check-audit-exceptions.mjs` lia a data de teste de
`process.env.SETUPGUARD_AUDIT_TODAY`, e o auto-diagnóstico passou a `WARNINGS`
(variável lida pelo código, sem `.env.example`). Como isso não faz o CI falhar
(avisos saem com 0), teria passado despercebido. A data virou o argumento
`--today=`; o diagnóstico voltou a `READY`.

### Demonstração dos três vereditos com a API real

Reproduzível, sem credencial (API anônima), com o bundle versionado, sobre o
merge ref real de expressjs/express #7578 (PR de fork que altera
`lib/response.js` e `test/res.links.js`), buscado com
`git fetch --depth=2 https://github.com/expressjs/express.git refs/pull/7578/merge`
e um payload de evento com o número e o `head.sha` do PR:

| Cenário | Exit | `result` | Requisições reais |
|---|---|---|---|
| A. PR sem alteração (`fail-on: warning`) | 0 | `pass` (problemas preexistentes listados, não atribuídos) | 6 |
| B. mesmo checkout + `process.env.SETUPGUARD_DEMO_URL` lido em `lib/response.js` | **1** | `fail`, anotação `::warning` em `lib/response.js:1056`, a linha acrescentada | 6 |
| C. `.git/HEAD` apontando para o commit da base | **1** | `incomplete`, recusado após `GET git/commits/{sha}` real | 2 |

Ressalva sobre B: a linha foi acrescentada à árvore de trabalho por cima do
merge commit real. Isso exercita o mesmo caminho de um PR que a introduzisse
(o arquivo está na lista de alterados, então a base veio da API) e demonstra
uma premissa documentada: a Action analisa a árvore de trabalho como a
encontra. O erro (`fail` por blocker) no fluxo completo está coberto pelos
testes de aceitação; no GitHub Actions ainda não foi observado.

### Teste negativo e positivo no GitHub Actions (2026-11-03)

Um PR temporário (#2, rascunho, **contra `feat/github-action`**, nunca contra
`main`) a partir de `5e8be85`, com dois commits:

| Commit | O que fez | Execução do SetupGuard | Resultado |
|---|---|---|---|
| `f7d18a1` | o bloco "Development" do README passou a mandar rodar `pnpm run serve`, script inexistente | [41636249068](https://github.com/Jovinull/SetupGuard/actions/runs/41636249068) | **falhou**: `Result: FAIL — This pull request introduces 1 blocking problem(s)`; base `5e8be85` (primeiro pai do merge commit), 1 arquivo, 5 requisições |
| `aa93898` | removeu a linha (árvore idêntica a `feat/github-action`) | [41636459753](https://github.com/Jovinull/SetupGuard/actions/runs/41636459753) | **passou**: `Result: PASS`; 0 arquivos no diff líquido, 4 requisições; os 10 checks do PR verdes |

Evidência observada:

- **anotação gravada pelo GitHub**, lida pela API de check runs
  (`GET /repos/Jovinull/SetupGuard/check-runs/125918082481/annotations`):
  `failure README.md:251 [SetupGuard: new · node/docs-script-drift] README.md
  tells the reader to run "pnpm serve", which is not a declared script`. Na
  execução positiva, nenhuma anotação do SetupGuard (só o aviso do próprio
  GitHub sobre o rótulo `ubuntu-latest`);
- **log** de cada execução com veredito, base e requisições;
- **concordância independente**: no commit com regressão, todas as pernas da
  matriz do `ci.yml` que terminaram falharam no auto-diagnóstico da CLI
  (`BLOCKED`, o mesmo achado); uma perna aparece `cancelled` porque o push
  seguinte a substituiu (`cancel-in-progress`).

**Não observado por mim:** o *job summary* renderizado. A API REST não o expõe,
a página pública da execução não o carrega sem login e a extensão do Chrome
não estava conectada. O conteúdo do summary é coberto pelos testes de
aceitação; a renderização pode ser vista nos links acima.

O PR #2 foi fechado e só a branch `tmp/negative-action-test` foi apagada;
`main` e `feat/github-action` não foram alteradas pelo teste.

### O que está provado e o que não está

Provado no GitHub Actions:

- o runner aceita `node24` e executa `packages/github-action/dist/index.cjs`
  via `action.yml`; o job `github action bundle` prova, na mesma execução, que
  esse arquivo é idêntico ao reconstruído a partir das fontes;
- chamadas reais à API com o `GITHUB_TOKEN` (só leitura), paginação real,
  base correta;
- um PR sem regressões passa (PR #1, 131 arquivos; PR #2 após a correção);
- **um PR que introduz um blocker falha**, com anotação no arquivo e linha
  (PR #2, acima).

Provado localmente com a API real: uma análise incompleta não passa (exit 1).

**Não provado ainda:**

- PR vindo de **fork** neste repositório (aprovação de primeira contribuição,
  token só leitura). Exige uma conta que o mantenedor controle fora deste
  repositório; não foi simulado. Nota: aqui o workflow usa `uses: ./`, então o
  código da Action que roda num PR é o do próprio PR — um fork pode alterá-lo.
  Roda com token só leitura e sem segredos, a mesma exposição do `ci.yml`, que
  já executa código do PR. Consumidores que fixam `Jovinull/SetupGuard@<sha>`
  não têm isso;
- a renderização do *job summary* (ver acima);
- fronteira de symlink no Windows (como no resto do projeto).

## Limitações atuais

- só nível `static`;
- checkout precisa ser o padrão (merge commit) ou o head do PR;
- PR com mais de 3000 arquivos → `incomplete` (limite do endpoint); orçamento
  de 400 requisições por execução;
- repositórios que excedem os limites de varredura do motor (50 arquivos em
  `docs/`, profundidade 8) → `incomplete` até configurar `ignore:`;
- custo de requisições: arquivos em projetos aninhados são consultados na base
  mesmo sendo descartados depois (71 requisições para 131 arquivos no PR #1);
- symlink alterado e lido diretamente → `incomplete`;
- a Action confia que a árvore de trabalho é o commit em checkout: um passo
  anterior do workflow que altere arquivos altera o que é analisado;
- falso positivo conhecido do motor: `cd` entre blocos de documentação;
- o bundle da extensão VS Code usa o `dist/` compilado dos pacotes do
  workspace: é preciso `pnpm run build` antes de empacotar (o CI e o
  `RELEASING.md` fazem isso).

## Bugs corrigidos neste PR

- motor: escrita em `process.env` tratada como leitura (Express);
- Action: severidade elevada pelo PR classificada como preexistente;
- Action: relato de `incomplete` sem dizer qual check nem por quê (Vite);
- build: bundle dependia de `dist/` compilado (falha do CI em `2cf8751`);
- docs: README disparava o auto-diagnóstico (clone limpo);
- distribuição: o bundle da Action e o VSIX embutiam `semver` e `yaml` (ISC)
  sem os avisos de licença que a ISC exige "in all copies"; agora cada
  artefato leva `THIRD_PARTY_NOTICES.txt`, gerado a partir do metafile do
  esbuild (só o que foi de fato embutido), e o build falha se um pacote
  embutido não tiver arquivo de licença.

## Backlog (fora do escopo do primeiro marco)

- excluir projetos aninhados dentro do `walk` (menos requisições à API);
- seguir `cd` na documentação; mais formas de drift (arquivos, portas);
- várias raízes por job; suporte melhor a repositórios grandes sem `ignore:`;
- bundle da extensão a partir do `src/` (como o da Action), eliminando a
  dependência de um build prévio;
- PR de fork real; repositório de distribuição para o Marketplace.

## Histórico de execuções no GitHub

> **SHAs desta seção.** Em 2026-11-03 o histórico desde `c7807e7` foi
> reescrito só para editar mensagens de commit; as árvores são idênticas. Os
> SHAs abaixo são os dos commits onde o CI de fato rodou, e continuam visíveis
> no PR #1. Correspondência para os commits atuais: `2cf8751`→`b8bf3f8`,
> `8d14be5`→`c459dd5`, `94af336`→`4bd3c73`, `5d2250c`→`f851a67`,
> `42d62e2`→`4f19589`, `13c4b67`→`393017b`, `110158b`→`032c14b`,
> `5e8be85`→`b4ad086`, `13d80d9`→`5b73c3f`, `202230e`→`32c0387`; o commit da
> release `v0.1.0` passou de `58250c8` a `36a1e3a`.

| Commit | Resultado |
|---|---|
| `2cf8751` (PR #1) | matriz 6/6 e VSIX verdes; **`repository readiness` verde** (primeira execução real da Action, sobre o próprio PR); job do bundle falhou; audit falhou |
| `8d14be5` (PR #1) | 9 de 10 verdes: matriz 6/6, VSIX, **bundle** e `repository readiness`; só o audit falhou (preexistente, ver abaixo) |
| `5d2250c` (PR #1) | idem: 9 de 10; só o audit |
| `42d62e2` (PR #1) | 9 de 10; o audit agora falha **só** pelo `minimatch` GHSA-g3hv-75wg-m249 (1 moderate, eram 18); Action: 129 arquivos, 69 requisições, `pass` |
| `13c4b67` (PR #1) | idem: 9 de 10; só o audit, pelo mesmo advisory |
| `110158b` (PR #1) | **10 de 10**. Audit: guard de exceções executado ("accepted until 2026-11-30"), `pnpm audit` completo com `1 moderate (1 ignored)`; checkouts com `persist-credentials: false`; Action: 131 arquivos, 71 requisições, `pass` |

Evidência da execução real em `8d14be5`, com `GITHUB_TOKEN` (permissões
`Contents: read`, `PullRequests: read`, `Metadata: read`): 118 arquivos
listados em 2 páginas, base `c7807e7` (o primeiro pai do merge commit, que é
`main`), 64 requisições, veredito `pass` sem anotações. O runner mascarou o
token de `stop-commands` (a linha de retomada aparece como `::***::`), e a
retomada funcionou.

Custo observado: boa parte das 64 requisições são 404 para arquivos dentro de
projetos aninhados (`fixtures/*/src/index.js`). A varredura de fontes do
motor lista esses arquivos e só **depois** descarta os projetos aninhados, então
a visão da base precisa perguntar por eles. O resultado está correto, mas
gasta requisições; passar a exclusão de projetos aninhados para dentro do
`walk` reduziria o custo. Fica em aberto.

A falha do bundle foi um defeito real: o esbuild resolvia `@setupguard/core`
pelo `exports` do pacote, que aponta para `dist/`, inexistente sem `tsc -b`.
A verificação em clone limpo feita antes do push não pegou isso porque rodou
`pnpm check` (que compila) **antes** do bundle — ordem diferente da do job.
Corrigido em `94af336`: o script agora aponta os pacotes do workspace para o
`src/` TypeScript, então o bundle não depende do estado do build (mesmos bytes
com ou sem `dist/`). Reproduzido em clone limpo na ordem exata do job.

O audit falhou com 18 advisories (1 low, 10 moderate, 7 high), todos em
ferramentas de desenvolvimento. `pnpm audit --prod` não reporta nenhum: as
dependências de execução (`yaml`, `semver`) e os bundles estão limpos. Era
preexistente: o lockfile de `main` (`c7807e7`) dá o mesmo resultado.

## Dependências e auditoria (revisão do PR)

Resolvidos 17 dos 18, sem upgrade major de nada declarado e sem override:

| Advisory | Antes → depois | Como |
|---|---|---|
| `@vitest/mocker` (2) | 4.1.11 → 4.1.12 | `vitest ^4.1.12` (patch) |
| `vite` (6), `source-map-js` (1) | 8.3.0 → 8.3.5; 1.2.1 → 1.2.2 | `vite ^8.3.5` declarado na raiz: é peer dependency do Vitest, que o pnpm fixa na resolução de peers e não atualiza sozinho |
| `brace-expansion` (6) | 1.1.18 → 1.1.21; 5.0.9 → 5.0.12 | atualização do lockfile dentro das faixas |
| `qs` (1) | 6.16.0 → 6.17.1 | idem (via `@vscode/vsce`) |
| `@azure/msal-node` (1) | 5.6.0 → 7.1.2 | `@azure/identity` 4.14.1, permitido pelo `^4.13.2` do `@vscode/vsce` |

esbuild não mudou; o bundle da Action ficou idêntico byte a byte; o VSIX
continua com os mesmos sete arquivos.

## Exceção de segurança: GHSA-g3hv-75wg-m249 (`minimatch`)

**Decisão (2026-11-02): risco aceito temporariamente, com revisão obrigatória
até 2026-11-30.** Isto **não** corrige a vulnerabilidade: o pacote vulnerável
continua instalado. Autorizada pelo mantenedor sob a condição de a auditoria
demonstrar exposição baixa e nenhum caminho explorável no uso suportado; a
evidência abaixo é o que sustenta essa condição.

### O advisory

DoS por amplificação de `globParts` (moderate, publicado em 2026-10-30, faixa
`<11.0.1`, corrigido em 11.0.1 de 2026-10-27). Em `firstPhasePreProcess()`, a
transformação `**/../` clona entradas dentro de um laço de ponto fixo, e
`secondPhasePreProcess()` as compara par a par: um **padrão glob** escolhido por
atacante consome CPU e memória.

### Onde está e quem usa (`pnpm why minimatch -r`)

| Versão | Consumidores | Contém o código vulnerável? |
|---|---|---|
| 3.1.5 | `eslint` 9.39.5, `@eslint/config-array` 0.21.2, `@eslint/eslintrc` 3.3.7 | **não**: o arquivo não tem `firstPhasePreProcess`, `secondPhasePreProcess`, `partsMatch` nem `optimizationLevel` (só uma propriedade `globParts`). A faixa `<11.0.1` do advisory é ampla demais para a linha 3.x; o aviso aqui é um casamento de faixa, não exposição |
| 10.2.6 | `@typescript-eslint/typescript-estree` 8.70.0, `@vscode/vsce` 4.0.0 | **sim**, mas só alcançável com `optimizationLevel >= 2`; o padrão é `1` (`dist/commonjs/index.js`, `const { optimizationLevel = 1 } = this.options`) |

### Os consumidores da 10.2.6 alcançam o código?

- `@typescript-eslint/typescript-estree`: uma única chamada,
  `minimatch(filePath, pattern, { dot: true })` em
  `useProgramFromProjectService.js`, usada só com a opção `projectService` +
  `allowDefaultProject`. Este repositório usa `parserOptions.project`: o
  caminho nem é executado. E, se fosse, roda no nível 1.
- `@vscode/vsce`: chamadas em `out/package.js` com
  `const minimatchOptions = { dot: true }` — nível 1.
- Busca em **todo** `node_modules/.pnpm`: nenhum pacote além do próprio
  minimatch menciona `optimizationLevel`. `glob` (que usaria o nível 2 para
  percorrer o disco) não está na árvore.

Conclusão: **no uso instalado, nenhuma chamada alcança `firstPhasePreProcess`**.
A afirmação vale para estas versões; muda se um consumidor passar a usar o
nível 2 ou `glob` entrar na árvore — por isso a revisão tem data.

### Quem controla os padrões

| Entrada | Vira padrão glob? | Observação |
|---|---|---|
| arquivos alterados num PR | não; caminhos são o **dado** comparado (`minimatch(arquivo, padrão)`) | o custo do advisory depende do padrão, não do caminho |
| configuração alterada num fork (`eslint.config.js`, `.vscodeignore`, `package.json#files`) | **sim** | mas um PR de fork já executa código próprio no CI (`pnpm install`, testes); controlar um padrão não dá a ele nada além disso, e o caminho vulnerável não é alcançado no nível 1. O efeito máximo seria lentidão do próprio job, limitado por `timeout-minutes` |
| nomes de arquivo não confiáveis | não; dado | |
| entradas externas / argumentos do GitHub Actions | não chegam a nenhum consumidor de minimatch | a Action do SetupGuard não usa minimatch; `ignore:` de `.setupguard.yml` usa o casador próprio do core, com gramática canônica restrita ([15](15-configuracao.md)), fora do escopo deste advisory |

### O que é distribuído

Nem `packages/github-action/dist/index.cjs` nem o `extension.cjs` do VSIX
contêm minimatch ou brace-expansion: os únicos módulos de terceiros
embutidos são `semver` e `yaml`. `pnpm audit --prod`: nenhuma vulnerabilidade.

### Por que não corrigir de verdade

Nenhum consumidor publicou versão com minimatch 11 (verificado em 2026-11-02:
eslint 10.14.0 `^10.2.6`, `@eslint/config-array` 0.23.5 `^10.2.4`,
`@eslint/eslintrc` 3.3.7 `^3.1.5`, typescript-estree 8.72.1 `^10.2.2`, vsce
4.1.0 `^10.2.6`), e não há backport (3.1.5 e 10.2.6 seguem as últimas de suas
linhas). Mesmo um override comprovadamente compatível da 10.x para 11 **não**
zeraria o audit, porque a 3.1.5 do ESLint 9 continuaria dentro da faixa — e a
3.x não pode ir para 11 (API incompatível). Forçar a 11 sem validar os
consumidores foi descartado.

### Como a exceção foi aplicada

- `audit.ignore` em `pnpm-workspace.yaml` (chave atual do pnpm 11; verificada na
  documentação 11.x e no código do pnpm 11.18.0), com **só** esta GHSA e um
  comentário com a justificativa. Sem `--audit-level`, sem
  `--ignore-unfixable`, sem `auditConfig` (nome obsoleto, que o script recusa).
- **Escopo provado**: com a mesma configuração sobre o lockfile antigo
  (`5d2250c`, 18 advisories), `pnpm audit` continua saindo com 1 e reportando
  os outros 17; só este aparece como "(1 ignored)".
- **Prazo**: `scripts/check-audit-exceptions.mjs` roda no job de audit antes de
  `pnpm audit` e falha se a exceção passar de 2026-11-30, se uma GHSA for
  ignorada sem registro, ou se um registro ficar sem GHSA correspondente.
  Testado: válido até 2026-11-30, falha em 2026-12-01, falha para exceção não
  documentada, registro obsoleto e data inválida.
- Limite do prazo: o `ci.yml` só roda em push/PR. Por isso
  `.github/workflows/audit.yml` repete o guard e o `pnpm audit` toda segunda
  às 06:17 UTC (e sob demanda), só com `contents: read`, sem matriz e com
  `pnpm install --ignore-scripts`. O GitHub só agenda e só permite o disparo
  manual de workflows do branch padrão: o agendamento começa a valer **depois
  do merge**. Até lá, o mesmo workflow roda em PRs que alterem os arquivos da
  política (ele próprio, o script, `pnpm-workspace.yaml`, o lockfile), que é
  como ele é exercitado antes do merge. Ressalvas do GitHub: falha de execução
  agendada é notificada a quem alterou o cron por último, e workflows
  agendados são desativados após 60 dias sem atividade num repositório
  público.

### Na revisão

Verificar se algum consumidor adotou minimatch >= 11.0.1; se sim, atualizar e
remover a exceção. Se não, repetir esta análise com as versões então
instaladas antes de renovar a data.
