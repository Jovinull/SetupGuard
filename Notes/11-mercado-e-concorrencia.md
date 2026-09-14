# Mercado, concorrência e posicionamento

## Tese de mercado registrada na fonte

O material de origem, baseado em uma pesquisa do cenário 2025–2026, conclui que existe oportunidade maior em readiness de repositórios do que em criar outro copiloto de IA. A tese combina:

- VS Code ainda dominante;
- adoção ampla de IA, acompanhada por desconfiança na precisão;
- onboarding frequentemente atrasado por setup e documentação obsoleta;
- potencial de ferramentas simples crescerem ao eliminar uma fricção concreta;
- soluções atuais fragmentadas por `.env`, portas, documentação, scripts e workstation.

Os dados são temporais. Antes de decisões comerciais ou comunicações públicas, devem ser validados novamente nas fontes originais.

## Mapa competitivo da pesquisa original

| Categoria | Demanda percebida | Concorrência percebida | Avaliação registrada |
|---|---:|---:|---:|
| Novo AI Copilot/chat | enorme | absurda | baixa chance |
| Gerenciador de Claude/Codex/Cursor | alta | muito alta | média/baixa |
| Gerenciador de MCP | alta | muito alta | média/baixa |
| Segurança de MCP/agentes | alta | enorme | baixa |
| `.env` manager | alta | enorme | baixa |
| Dependency graph/architecture map | alta | enorme | média/baixa |
| API route explorer | boa | alta | média |
| Port/process manager | boa | alta | média |
| Repo/environment readiness | enorme | fragmentada | alta |

Essa tabela representa a opinião da pesquisa em `ideia.txt`, não uma medição contínua garantida.

## Concorrente direto

### CAssets DevReady

É o concorrente mais próximo encontrado. Sua métrica principal é reduzir o tempo entre clone e primeiro build, detectando ferramentas, comandos e capacidades ausentes.

Consequência estratégica: SetupGuard não deve ser apenas “uma versão própria do DevReady”.

Distinção proposta:

| CAssets DevReady, segundo a fonte | SetupGuard |
|---|---|
| prepara workstation e ajuda no setup | prova continuamente o contrato do repositório |
| forte no primeiro dia | útil no onboarding e meses depois |
| foco em ficar pronto para começar | foco em impedir e localizar drift operacional |

Essa comparação deve ser atualizada por análise direta antes de ser usada externamente.

## Concorrentes adjacentes citados

- Akashi e managers de Claude/Codex/Cursor/Gemini;
- MCP managers e marketplaces de skills;
- MCPShield, KERN, BoostSecurity e Cisco no espaço de segurança de agentes/MCP;
- CodeLayers, DepGraph, Impact Lens e Vestige em grafos/blast radius;
- Dotenv-diff, Env Manager, Env Guardman e Environment Variable Viewer;
- Context Check para arquivos de agentes;
- Drift para documentação.

Esses produtos validam dores parciais, mas também indicam mercados congestionados. SetupGuard deve integrá-las apenas quando contribuírem diretamente para readiness.

## Posicionamento recomendado

Categoria:

> Repository Development Readiness

Promessa:

> Garantir, por checks verificáveis, que as condições declaradas para desenvolver o repositório continuam coerentes e atendidas.

Mensagens:

- **Clone. Open. Know what's broken.**
- **Your README says it works. SetupGuard proves it.**
- “A extensão que garante que seu repositório ainda pode ser clonado e executado.”

## Diferenciação defensável

- diagnóstico contínuo de drift, não apenas bootstrap;
- cruzamento entre documentação, manifests, ambiente e serviços;
- evidência e confiança por achado;
- um único motor em editor, CLI e CI;
- operação local sem backend obrigatório;
- IA fora do caminho crítico;
- UX concisa, sem excesso de alertas ou gráficos.

## Referências originais

Os links e a bibliografia usados na pesquisa estão preservados no final de [`../ideia.txt`](../ideia.txt), incluindo Stack Overflow Survey, GitHub Octoverse, discussões do Reddit e páginas do VS Code Marketplace. Esta documentação não reexecutou nem atualizou a pesquisa.

