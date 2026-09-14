const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env['REDIS_URL'];
const stripeKey = process.env.STRIPE_SECRET_KEY;

export const settings = { databaseUrl, redisUrl, stripeKey };
