# Extensão VS Code

## Papel

A extensão é a principal experiência visual e o canal inicial de distribuição, mas não contém a lógica de negócio exclusiva. Ela consome o core e traduz os resultados para convenções nativas do editor.

## Estado em v0.1

Existe `packages/vscode` com **apenas** a projeção `Report → EditorDiagnostic[]`: conversão de posições 1-based para 0-based, mapeamento de severidade para a escala do editor, e separação dos findings que não têm arquivo (`unplaced`). O pacote **não** depende do módulo `vscode`, então roda e é testado em Node puro.

Não existem ainda: manifest da extensão, activation events, views, comandos, status bar, Quick Fixes nem tratamento de Workspace Trust. Tudo isso é o próximo marco.

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

Debounce, watchers, cache e frequência estão **Em aberto**.

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

Publicar desde o início em:

- VS Code Marketplace;
- Open VSX.

Identificador da extensão, publisher, requisitos mínimos de VS Code, política de atualização e processo de publicação estão **Em aberto**.

