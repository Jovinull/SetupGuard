# Adapters e configuração

## Por que adapters

O produto deve começar estreito sem bloquear expansão. Adapters encapsulam como cada ecossistema detecta projetos, extrai expectativas e oferece checks, enquanto o core mantém um modelo comum de readiness.

## Escopo inicial

### Runtime/ecossistema

- JavaScript/TypeScript;
- Node.js;
- Bun.

### Gerenciadores de pacotes

- npm;
- pnpm;
- Yarn;
- Bun.

### Infraestrutura/configuração

- Docker/Compose;
- dotenv;
- portas;
- PostgreSQL;
- Redis;
- possivelmente MySQL, citado na taxonomia de expansão.

### Frameworks e ferramentas citados

- Next.js;
- NestJS;
- AdonisJS;
- Express;
- Turbo;
- Nx;
- Makefile;
- Taskfile;
- Volta;
- mise.

**Implementado em v0.1**: JavaScript/TypeScript sobre Node.js; detecção de npm, pnpm, Yarn e Bun por lockfile e pelo campo `packageManager`; dotenv; versões de Node via `engines.node`, `volta.node`, `.nvmrc` e `.node-version`; documentação Markdown.

**Não implementado**: Bun como runtime, Docker/Compose, portas, PostgreSQL, Redis, MySQL, Next.js, NestJS, AdonisJS, Express, Turbo, Nx, Makefile, Taskfile e `mise` (exigiria um parser de TOML). A matriz completa continua **Em aberto**.

## Responsabilidades de um adapter

- detectar se a tecnologia está presente;
- ler manifests/configs relevantes;
- transformar convenções específicas em fatos/expectativas comuns;
- registrar checks aplicáveis;
- produzir evidência rastreável;
- não executar ações além da política autorizada pelo core.

## API de adapters

A fonte pede uma API de adapters desde o primeiro commit e prevê plugins comunitários. Ainda faltam decisões sobre:

- interface e ciclo de vida;
- descoberta/registro;
- dependências entre adapters;
- conflitos e precedência;
- versão da API;
- isolamento e permissões;
- adapters embutidos versus pacotes externos;
- testes de compatibilidade.

Até isso ser definido, “plugin SDK” é direção de arquitetura, não requisito funcional da primeira entrega.

## Zero-config primeiro

SetupGuard deve funcionar em projetos convencionais sem exigir arquivo próprio. A detecção pode usar manifests e arquivos existentes como fonte de verdade.

Riscos a controlar:

- múltiplos lockfiles;
- versões declaradas em mais de uma ferramenta;
- monorepos heterogêneos;
- serviços opcionais;
- documentação com exemplos não executáveis;
- scripts condicionais por sistema operacional.

**Decidido em v0.1** para versão de Node: **não há precedência**. `engines.node`, `volta.node`, `.nvmrc` e `.node-version` são todas parte do contrato do repositório, então uma contradição entre elas é **reportada** (`node/node-version-declaration-conflict`, severidade `error`), não resolvida em silêncio. Quando as declarações não se interceptam, a verificação contra o runtime local devolve `inconclusive`: não existe uma expectativa única a verificar.

**Decidido em v0.1** para múltiplos lockfiles: presença de mais de um é `warning` (`node/multiple-lockfiles`). Um lockfile que contradiz o campo `packageManager` é `error`, porque seguir o gerenciador declarado ignora o lockfile commitado.

Precedência entre outras fontes (portas, serviços) continua **Em aberto**.

## `.setupguard.yml`

Configuração explícita é proposta para projetos complexos. Possíveis necessidades implícitas incluem:

- marcar requisito como obrigatório ou opcional;
- habilitar/desabilitar checks;
- definir comandos de verificação;
- declarar serviços/portas;
- ajustar severidade ou confiança;
- selecionar workspaces;
- suprimir um achado justificado.

Essas capacidades não são schema aprovado. Nome final, formato, campos, herança e validação estão **Em aberto**.

**Implementado**: `.setupguard.yml` existe, com `version`, `checks.<id>.severity`, `env.optional` e `ignore`. A referência completa — schema, precedência, onde `ignore` se aplica, tratamento de arquivo inválido e limitações — está em [15-configuracao.md](15-configuracao.md).

Continuam **Em aberto**: herança, `extends`, presets, configuração por workspace de monorepo, namespace por adapter e supressão por achado individual.

## Monorepos

Monorepos fazem parte da detecção desejada no MVP, mas seu modelo ainda não está definido.

**Decidido em v0.1** — apenas a fronteira de projeto: um diretório com `package.json` próprio pertence a **outro** projeto, e varreduras de código-fonte param ali. Sem essa regra, o `.env.example` da raiz seria cobrado a documentar variáveis lidas por um pacote aninhado. O bug foi encontrado rodando o SetupGuard no próprio repositório dele, que reportava as variáveis das suas fixtures como não documentadas.

Isso resolve o falso positivo, mas **não** é suporte a monorepo: pacotes aninhados hoje são apenas excluídos, não diagnosticados. Questões pendentes:

- readiness global versus por pacote;
- compartilhamento de runtime, lockfile e serviços;
- execução parcial por mudanças;
- apresentação na UI/CLI;
- agregação de blockers;
- Nx/Turbo versus workspaces genéricos.

## Expansão futura

Python é a próxima expansão sugerida. Go, Rust, Java e .NET aparecem como possibilidades posteriores. Cada novo ecossistema deve entrar sem enfraquecer a precisão e a experiência do suporte Node inicial.

