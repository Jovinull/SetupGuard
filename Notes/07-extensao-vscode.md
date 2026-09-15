# Extensão VS Code

## Papel

A extensão é a principal experiência visual e o canal inicial de distribuição, mas não contém a lógica de negócio exclusiva. Ela consome o core e traduz os resultados para convenções nativas do editor.

## Estado atual

A extensão existe e é instalável. O que ela faz está descrito em
[16-extensao-vscode-implementada.md](16-extensao-vscode-implementada.md), que é
a referência quando este documento e o código divergirem.

Em resumo: análise automática por pasta de workspace, status bar com os quatro
estados de readiness, integração com o painel Problems, comandos
`SetupGuard: Run Diagnosis` e `SetupGuard: Show Report`, relatório em documento
virtual somente-leitura, re-análise com debounce a partir de watchers, suporte
declarado a workspaces não confiáveis e VSIX construído localmente.

Não existem ainda: Quick Fixes, view própria na barra lateral e testes dentro do
Extension Host. A extensão **não foi publicada** em nenhum marketplace.

## Experiência proposta

O dashboard deve ser deliberadamente simples:

- estado geral `READY`, `WARNINGS` ou `BLOCKED`;
- percentual de readiness aparece em um exemplo da ideia, mas sua adoção está **Em aberto**;
- categorias como ambiente, dependências, configuração, serviços, projeto e documentação;
- contagem de blockers e warnings;
- ações como `Explain` e `Verify Setup`;
- Quick Fix somente quando seguro e bem definido.

A fonte rejeita dashboards com dezenas de gráficos. O valor deve ser compreensível quase imediatamente.

## Integração nativa

Problemas devem aparecer no painel **Problems** como Diagnostics, à semelhança de TypeScript e ESLint. Quando houver posição conhecida, o usuário deve conseguir navegar diretamente ao arquivo e à linha que originaram o achado.

Exemplo de documentation drift:

```text
README.md:47

Command does not exist: pnpm dev
package.json defines: pnpm web
```

## Atualização contínua

A extensão deve acompanhar mudanças do repositório e atualizar checks aplicáveis. Para preservar a UX:

- checks rápidos e sem efeitos colaterais podem ser automáticos;
- checks de conectividade precisam de timeouts e política clara;
- build, teste e outros comandos profundos devem ser iniciados explicitamente;
- resultados precisam indicar quando estão desatualizados ou quando um nível não foi executado.

Debounce e watchers foram decididos (750 ms, lista de globs explícita); ver o documento 16. Cache e execução incremental continuam **Em aberto**.

## Quick Fixes sugeridos

- criar `.env` a partir de `.env.example`;
- orientar o uso da versão correta do Node;
- liberar uma porta;
- instalar dependências;
- corrigir um comando no README.

Esses itens vieram da visão inicial, mas não têm todos o mesmo risco. “Liberar porta”, instalar pacotes e editar documentação podem alterar estado. A lista do MVP e o fluxo de confirmação estão **Em aberto**; a prioridade posterior declarada é detectar, explicar e localizar antes de automatizar correções.

## Ações destrutivas ou mutáveis

Qualquer ação destrutiva exige confirmação. Além disso, a extensão não deve executar escondida:

- build e testes;
- migrações;
- subida/remoção de containers;
- encerramento de processos;
- instalação ou troca de ferramentas;
- edições de arquivos que não sejam claramente apresentadas.

## Distribuição

A intenção continua sendo publicar em VS Code Marketplace e Open VSX. **Nada foi
publicado até agora.**

Decidido: identificador `jovinull.setupguard`, requisito mínimo VS Code 1.90,
`extensionKind: ["workspace"]`. Política de atualização e processo de publicação
continuam **Em aberto**.

