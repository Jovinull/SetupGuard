const token = process.env.API_TOKEN;
const stripe = process.env.STRIPE_SECRET_KEY || 'QA-FAKE-CREDENTIAL-0002';

export default { token, stripe };
