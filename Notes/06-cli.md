# CLI

## Papel

A CLI torna o motor independente do editor e serve como base para uso local, scripts e CI. A operação explicitamente proposta é:

```bash
setupguard doctor
```

Ela deve produzir o mesmo diagnóstico fundamental que a extensão, respeitando configuração e níveis de verificação.

## Experiência esperada

Saída humana conceitual:

```text
SetupGuard

Static          ✓
Environment     ✓
Services        !
Build           ○ not run

2 blockers · 1 warning
PROJECT BLOCKED
```

Cada achado deve mostrar causa, evidência e expectativa, sem imprimir valores secretos.

## Possíveis responsabilidades já implícitas

- aceitar um diretório de projeto ou usar o diretório atual;
- detectar o projeto automaticamente;
- carregar `.setupguard.yml`, quando presente;
- executar checks seguros por padrão;
- permitir que o usuário peça verificações profundas;
- fornecer saída adequada para automação;
- retornar exit code coerente com o estado.

## Contrato decidido em v0.1

```bash
setupguard [doctor|check] [caminho] [opções]
```

`doctor` é o comando padrão e `check` é alias dele. Sem argumentos, a CLI mostra o help.

| Opção | Efeito |
|---|---|
| `--level <lista>` | níveis a executar; padrão `static,environment` |
| `--fail-on error\|warning\|never` | limiar de saída não-zero; padrão `error` |
| `--json` | imprime o report serializado (`schemaVersion: 1`) |
| `--verbose` | lista também checks que passaram, foram pulados ou não se aplicam |
| `--color` / `--no-color` | força cor; padrão é auto (TTY, respeitando `NO_COLOR`) |

### Exit codes

| Código | Significado |
|---|---|
| 0 | o projeto foi verificado e nada atingiu o limiar de `--fail-on` |
| 1 | findings no limiar ou acima |
| 2 | uso inválido ou caminho inutilizável |
| 3 | `INCOMPLETE`: o diagnóstico é parcial — algo não pôde ser verificado, ou nenhum check chegou a uma conclusão. Não é aprovação nem reprovação do projeto |

Warnings não falham por padrão. Quem quiser rigor em CI usa `--fail-on warning`.

O código 3 cobre os dois casos: "nada rodou" (projeto não suportado, nenhum check para os níveis pedidos) e "quase tudo rodou, mas algo não pôde ser verificado" (um check `inconclusive` ou `internal-error` ao lado de vários `pass`). O campo `incompleteReason` do report diz qual dos dois.

`--fail-on never` suprime falha por **findings**, que o usuário escolheu tolerar. Ele deliberadamente **não** suprime o código 3: "não consegui verificar isto" não é um achado tolerado, e um zero silencioso ali é um falso verde em CI.

## Ainda em aberto

- comportamento em monorepos e seleção de workspace;
- política interativa e confirmações;
- modo watch;
- política de estabilidade/versionamento da saída humana (a saída JSON é versionada por `schemaVersion`);
- configuração por variável de ambiente.

## Restrições de segurança

- não executar build, teste, migração ou `docker compose up` implicitamente;
- não registrar valores de variáveis ou credenciais;
- aplicar timeouts a processos e conexões;
- deixar explícito quando uma verificação foi pulada ou não pôde ser concluída;
- não tratar falha interna do SetupGuard como se fosse falha comprovada do projeto.

