# GitHub Action — implementação

Este documento descreve **o que a Action faz hoje**, por que foi feita assim e
qual evidência existe. Onde divergir de [08-github-action.md](08-github-action.md),
vale este.

Estado em 2026-11-02: implementada, testada localmente e validada contra a API
real do GitHub em pull requests públicos. **Sem tag de release**, fora do
GitHub Marketplace, e **ainda sem execução no próprio GitHub Actions** (exige
push, que depende do mantenedor).

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
(mover um parágrafo não cria problema) e **severidade não entra** (uma
configuração que promove um aviso antigo a erro não criou o problema).

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

## Evidência

### Testes (locais, Windows, Node 24)

- `acceptance.test.ts`: os sete casos da missão sobre `fixtures/pull-requests/*`
  (saudável, script removido, variável nova, problema preexistente com linha
  movida, conteúdo hostil, API indisponível, arquivos irrelevantes), mais
  rename/remoção, checkout head, checkout desconhecido, PR desatualizado,
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

### O que ainda não foi provado

- execução no GitHub Actions de verdade (runner aceitando `node24`, anotações
  renderizadas no diff, summary renderizado, PR de fork neste repositório);
- comportamento com `GITHUB_TOKEN` real (a validação foi anônima);
- fronteira de symlink no Windows (como no resto do projeto).

## Histórico de execuções no GitHub

| Commit | Resultado |
|---|---|
| — | ainda não houve push |
