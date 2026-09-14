# Público e proposta de valor

## Públicos mencionados ou implícitos

### Novos contribuidores e pessoas em onboarding

Precisam descobrir rapidamente por que o ambiente não funciona, sem depender de tentativa e erro ou de conhecimento tribal.

### Mantenedores de projetos open source

Precisam garantir que instruções públicas, exemplos de configuração e comandos continuem válidos para novos contribuidores.

### Times de desenvolvimento

Precisam reduzir tempo perdido em setup, padronizar expectativas e detectar drift operacional em pull requests.

### Desenvolvedores solo

Precisam reencontrar rapidamente os requisitos de projetos antigos e impedir que documentação/configuração fiquem divergentes.

### Estudantes

Precisam de diagnósticos simples, localizados e explicáveis ao trabalhar com projetos que exigem ferramentas e serviços variados.

### Usuários de VS Code e editores compatíveis

O canal inicial é VS Code, com publicação também no Open VSX para VSCodium e parte do ecossistema compatível.

## Proposta de valor

SetupGuard reduz o intervalo entre `git clone` e um ambiente de desenvolvimento utilizável. Ele transforma falhas difusas de setup em diagnósticos objetivos, localizados e acionáveis.

Valor por contexto:

- **Local:** revela incompatibilidades entre máquina e projeto.
- **Repositório:** encontra contradições entre manifests, exemplos, configuração e documentação.
- **Editor:** mostra o problema no painel nativo e próximo de sua origem.
- **CI:** impede que um pull request introduza drift operacional.
- **Longo prazo:** continua útil após o onboarding, porque acompanha mudanças do repositório.

## Diferenciais centrais

### Verificação contínua, não apenas preparação inicial

O concorrente direto citado, CAssets DevReady, é descrito como orientado a preparar a workstation e reduzir o tempo até o primeiro build. O posicionamento proposto para SetupGuard é verificar continuamente se o contrato do repositório permanece verdadeiro.

### Um problema claro, explicado em segundos

Os slogans e a experiência `clone → open → blockers → fix → READY` tornam o produto fácil de demonstrar e recomendar.

### Motor determinístico

O diagnóstico não depende de respostas probabilísticas de um modelo. A fonte de cada achado e sua confiança devem ser explicáveis.

### Core reutilizável

A extensão é uma interface. O mesmo motor atende CLI, GitHub Action e, futuramente, integrações MCP.

### Local-first e privacidade

O funcionamento principal não exige enviar código-fonte ou segredos a um serviço externo.

### Abrangência com coesão

O produto pode verificar runtime, pacotes, env, serviços e documentação, mas tudo é subordinado a uma pergunta única: o repositório está operacional?

## Métricas de produto sugeridas pela visão

A fonte não define métricas formais. As seguintes áreas de medição são coerentes, mas seus indicadores exatos estão **Em aberto**:

- tempo entre clone e primeiro build/execução bem-sucedida;
- precisão dos diagnósticos e taxa de falsos positivos;
- tempo até o usuário compreender e resolver um bloqueio;
- número de repositórios que adotam extensão, CLI ou Action;
- retenção da extensão após o onboarding.

