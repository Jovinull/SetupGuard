const token = process.env.API_TOKEN;
const stripe = process.env.STRIPE_SECRET_KEY || 'sk_test_INLINE_FALLBACK_SECRET';

export default { token, stripe };
