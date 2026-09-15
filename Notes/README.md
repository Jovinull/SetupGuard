# SetupGuard — base de conhecimento

Esta pasta consolida o contexto de produto e as diretrizes técnicas extraídas de `ideia.txt`, que continua sendo a fonte primária. O objetivo é permitir que uma pessoa ou agente de IA entenda o projeto antes de propor ou implementar mudanças.

## Resumo em uma frase

SetupGuard é um diagnosticador local, contínuo e determinístico que verifica se o contrato de desenvolvimento de um repositório continua verdadeiro — isto é, se outra pessoa pode cloná-lo, preparar o ambiente e executá-lo seguindo o que o próprio repositório declara.

Slogans propostos no material de origem:

- **Clone. Open. Know what's broken.**
- **Your README says it works. SetupGuard proves it.**

## Ordem de leitura recomendada

1. [Visão do produto](01-visao-do-produto.md)
2. [Público e proposta de valor](02-publico-e-proposta-de-valor.md)
3. [Escopo, MVP e roadmap](03-escopo-mvp-e-roadmap.md)
4. [Funcionamento e checks](04-funcionamento-e-checks.md)
5. [Arquitetura sugerida](05-arquitetura.md)
6. [CLI](06-cli.md)
7. [Extensão VS Code](07-extensao-vscode.md)
8. [GitHub Action e CI](08-github-action.md)
9. [Segurança e confiabilidade](09-seguranca-e-confiabilidade.md)
10. [Adapters e configuração](10-adapters-e-configuracao.md)
11. [Mercado, concorrência e posicionamento](11-mercado-e-concorrencia.md)
12. [Distribuição, crescimento e custos](12-distribuicao-e-custos.md)
13. [Decisões e questões em aberto](13-decisoes-e-questoes-em-aberto.md)
14. [Implementação v0.1 — fundação](14-implementacao-v0.1.md)
15. [Configuração — `.setupguard.yml`](15-configuracao.md)

## Princípios que devem orientar qualquer implementação

- **Core independente de interface:** VS Code, CLI e CI devem consumir o mesmo motor.
- **Local-first:** a análise principal acontece na máquina do usuário ou no runner de CI.
- **Determinismo antes de IA:** regras verificáveis produzem os diagnósticos; IA é uma integração futura e opcional.
- **Confiança antes de quantidade:** poucos achados corretos valem mais do que dezenas de alertas ruidosos.
- **Zero-config primeiro:** detectar convenções automaticamente e permitir configuração explícita em projetos complexos.
- **Segurança por níveis:** verificações sem efeitos colaterais podem ser automáticas; comandos custosos ou mutáveis exigem ação explícita.
- **Escopo inicial estreito e polido:** começar por JavaScript/TypeScript e pelo ecossistema Node.
- **Não prometer ausência de bugs:** readiness é sobre pré-condições operacionais, não sobre a correção funcional do software.

## Estado atual

O material de origem é uma pesquisa e concepção inicial: define o problema, o posicionamento, o conjunto desejado de checks e uma arquitetura de alto nível, mas não continha implementação.

A partir de 2026-09-14 existe uma **fundação implementada** — monorepo TypeScript, motor `core`, adapter Node, CLI e nove checks seguros. O que o código de fato faz está em [Implementação v0.1](14-implementacao-v0.1.md), que é a referência quando um documento conceitual e o código divergirem.

Tudo que continua indefinido segue marcado nesta documentação como **Em aberto**. Exemplos e nomes de APIs extraídos da ideia devem ser tratados como propostas, não como contratos já estabilizados.

## Fonte e regra de manutenção

- Fonte principal: [`../ideia.txt`](../ideia.txt).
- Esta documentação reorganiza e explicita o conteúdo; não substitui a fonte histórica.
- Ao tomar uma nova decisão, atualizar o documento temático e o [registro de decisões e questões em aberto](13-decisoes-e-questoes-em-aberto.md).
- Não converter possibilidades futuras em requisitos do MVP sem uma decisão explícita.

