const port = process.env.PORT ?? 3000;
const databaseUrl = process.env.DATABASE_URL;

export function config() {
  return { port, databaseUrl };
}
