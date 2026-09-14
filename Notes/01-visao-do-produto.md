# Visão do produto

## A pergunta central

> Se outra pessoa clonar este repositório agora, ela consegue rodá-lo?

SetupGuard existe para responder essa pergunta de forma rápida, contínua e baseada em evidências encontradas no repositório e no ambiente local.

## Problema

O primeiro uso de um repositório frequentemente falha por razões operacionais previsíveis:

- documentação desatualizada;
- runtime ou gerenciador de pacotes na versão errada;
- dependências ausentes ou lockfile inconsistente;
- variáveis de ambiente necessárias não documentadas;
- serviços locais inacessíveis;
- portas ocupadas ou divergentes;
- scripts, arquivos e caminhos mencionados na documentação que não existem mais;
- conhecimento de setup que ficou apenas na cabeça de mantenedores.

Isso afeta tanto onboarding quanto a manutenção cotidiana. Mesmo depois do primeiro dia, mudanças no código e na configuração podem quebrar silenciosamente o contrato documentado do repositório.

## Definição do produto

SetupGuard é um **diagnosticador contínuo do ambiente de desenvolvimento e do contrato do repositório**. Ele lê declarações e convenções do projeto, inspeciona o ambiente e apresenta resultados acionáveis como `READY`, `WARNINGS` ou `BLOCKED`.

A analogia usada na fonte é um **ESLint para a operacionalidade do repositório**: ele localiza divergências concretas e as apresenta onde o desenvolvedor já trabalha.

## O que significa “contrato do repositório”

É o conjunto de condições que o próprio projeto declara ou implica como necessárias para desenvolvimento, por exemplo:

- versões de runtime e ferramentas;
- gerenciador de pacotes e lockfile;
- scripts de desenvolvimento, build, teste e validação;
- variáveis de ambiente;
- serviços, portas e conexões;
- arquivos e caminhos documentados;
- instruções em README e documentos de contribuição/agentes.

O produto deve verificar se essas declarações são coerentes entre si e, quando aplicável, se o ambiente atual as satisfaz.

## Limite da promessa

SetupGuard **não** promete que o software não tem bugs ou que todo comportamento de negócio funciona. A promessa adequada é:

> O ambiente de desenvolvimento atende às condições verificáveis necessárias para este repositório funcionar.

O grau de evidência depende dos níveis de verificação executados. Uma análise estática bem-sucedida não equivale a um build bem-sucedido; a interface deve deixar isso claro.

## O que o produto não é

- Não é um instalador de workstation.
- Não é um chatbot nem outro copiloto de IA.
- Não é inicialmente uma plataforma SaaS ou um dashboard corporativo.
- Não é apenas um gerenciador de `.env`, portas, dependências ou documentação.
- Não é uma garantia universal de correção do software.
- Não deve tentar consertar tudo automaticamente na primeira versão.

## Resultado desejado

Ao abrir ou verificar um projeto, o usuário deve entender em poucos segundos:

1. se o projeto está pronto;
2. quais são os bloqueios e avisos;
3. onde cada problema foi encontrado;
4. por que ele é considerado um problema;
5. qual ação segura pode resolvê-lo;
6. quais verificações mais profundas ainda não foram executadas.

## Categoria proposta

**Repository Development Readiness** — prontidão de desenvolvimento do repositório.

Essa categoria reúne problemas hoje tratados de forma fragmentada, sem posicionar o SetupGuard como “uma extensão com muitas ferramentas”. O foco permanece único: provar que o repositório ainda pode ser clonado e executado.

