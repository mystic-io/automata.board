import { Automata } from '../../src/do/automata';
import { createApp } from '../../src/index';
import { SimulatedFacilitator, withFacilitatorTimeout } from '../../src/services/facilitator';
import { createX402PaymentMiddleware } from '../../src/services/x402';

const TEST_PAY_TO = '0x0000000000000000000000000000000000000001';

const app = createApp({
  createPaymentMiddleware: async (env, correlationId) =>
    createX402PaymentMiddleware(
      withFacilitatorTimeout(new SimulatedFacilitator(env.DB), 25, correlationId),
      TEST_PAY_TO
    ),
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Cloudflare.Env>;

export { Automata };
