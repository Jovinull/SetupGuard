# monorepo-scripts

Build a single package:

```bash
pnpm --filter api run build
npm --prefix ./packages/web run build
```

Build everything with `pnpm -r build`.
