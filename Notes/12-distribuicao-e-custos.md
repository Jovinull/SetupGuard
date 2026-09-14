# Distribuição, crescimento e custos

## Modelo operacional

O produto principal pode funcionar sem servidor próprio:

- extensão roda na máquina do usuário;
- CLI roda localmente;
- GitHub Action roda na infraestrutura do repositório consumidor;
- regras determinísticas não exigem API de IA;
- arquivos e resultados não precisam ser armazenados remotamente.

Por isso, o custo marginal de processamento não cresce linearmente com o número de usuários.

## Custos previstos no início

A estimativa da fonte é aproximadamente R$ 0/mês para a operação central, usando:

- GitHub;
- VS Code Marketplace;
- Open VSX;
- npm público;
- GitHub Actions nos limites aplicáveis a open source ou na conta do consumidor.

Podem existir custos opcionais de domínio, landing page, serviços administrativos e tempo de manutenção. Preços, limites e regras das plataformas mudam e devem ser conferidos antes de compromissos financeiros.

## O que não é necessário para o core

- AWS ou VPS;
- banco de dados hospedado;
- Redis/fila/workers próprios;
- API/backend;
- S3/storage;
- login;
- Firebase ou Supabase.

## Aquisição orgânica embutida

### Recomendação de extensão pelo repositório

Um projeto pode incluir, conceitualmente:

```json
{
  "recommendations": [
    "setupguard.setupguard"
  ]
}
```

Assim, pessoas que clonam o repositório recebem a recomendação no editor. O identificador acima é ilustrativo e está **Em aberto**.

### GitHub Action

O uso de `setupguard/action@v1` em workflows torna o projeto visível a contribuidores e outros mantenedores.

### Badge

Um badge como `SetupGuard: passing ✓` transforma readiness em sinal público e facilita descoberta. Serviço/URL de badge e prevenção de resultados enganosos estão **Em aberto**.

### Demonstração visual

GIF sugerida:

```text
git clone projeto
↓
code projeto
↓
SetupGuard: 3 blockers
↓
Fix
↓
SetupGuard: READY ✓
```

## Canais

- VS Code Marketplace;
- Open VSX;
- npm para CLI/pacotes públicos;
- GitHub para código, Action e adoção open source;
- Hacker News e Reddit são mencionados como possíveis canais de lançamento futuro.

## Licença e monetização

Modelo sugerido, ainda não decidido:

```text
Core              MIT ou Apache-2.0
VS Code extension grátis
CLI               grátis
GitHub Action     grátis
Plugin SDK        grátis
```

O projeto pode permanecer gratuito indefinidamente e gerar reputação/adoção. Se houver tração, produtos opcionais poderiam existir:

- SetupGuard Cloud;
- SetupGuard Teams;
- SetupGuard Enterprise.

Possibilidades de Cloud incluem dashboard por organização e histórico de health/readiness. Isso exigiria API, autenticação, banco, storage, workers e hosting, portanto fica explicitamente fora da fase inicial.

## IA e custos

IA não é requisito do core. Uma integração futura pode permitir que o usuário use Codex, Claude, Copilot, Gemini, Ollama ou outro modelo já disponível por MCP. Nesse modelo, SetupGuard produz o diagnóstico e a IA do usuário explica ou ajuda a corrigir; o projeto não precisa pagar tokens.

Termos de integração, privacidade, suporte e responsabilidade por custo estão **Em aberto**.

