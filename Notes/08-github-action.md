# GitHub Action e CI

## Papel

A GitHub Action leva o mesmo contrato de readiness aos pull requests. Ela detecta regressões operacionais antes do merge, como mudança em scripts sem atualização da documentação ou variável usada que falta no exemplo de ambiente.

Uso conceitual proposto:

```yaml
- uses: setupguard/setupguard-action@v1
```

E execução conceitual:

```bash
setupguard check
```

Os nomes são propostas da fonte e ainda não constituem um contrato publicado.

## Comportamento esperado

- usar o mesmo core e as mesmas regras da CLI/extensão;
- rodar no runner e na conta de GitHub Actions do repositório consumidor;
- produzir resultado legível no job;
- sinalizar blockers como falha;
- permitir que o desenvolvedor corrija e valide novamente no commit seguinte;
- apresentar achados com caminho/linha quando possível.

Exemplo:

```text
SetupGuard / Repository Readiness

FAILED

- README references nonexistent `pnpm start`
- REDIS_URL missing from .env.example
```

## Verificações em CI

Checks estáticos são o encaixe inicial mais seguro. Checks de ambiente devem compreender que o runner não representa necessariamente a workstation. Serviços e comandos de nível 3/4 só podem ser exigidos se o workflow os preparar e o repositório os configurar explicitamente.

Não se deve inferir indiscriminadamente que uma falha específica do runner prova que o onboarding local está quebrado.

## Decisões em aberto

- nome/repositório definitivo da Action;
- se será JavaScript Action, composite action ou outra distribuição;
- comando oficial da CLI usado internamente;
- versão de Node do runner;
- cache e instalação da CLI;
- formato de inputs e outputs;
- annotations, job summary e eventual comentário em PR;
- política de warnings versus blockers;
- checks padrão em CI;
- suporte a monorepos/matriz;
- pinning, tags `v1` e política de releases;
- permissões mínimas do `GITHUB_TOKEN`;
- comportamento em PRs vindos de forks.

## Princípio de custos

SetupGuard fornece o software, mas o processamento ocorre na infraestrutura do repositório consumidor. Não é necessário manter runners ou backend próprios para o funcionamento básico.

