import type { Env as AppEnv } from '../../src/types';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      RUNTIME_TEST_SCHEMA: string;
    }

    interface GlobalProps {
      mainModule: typeof import('./worker');
      durableNamespaces: 'Automata';
    }
  }
}

export {};
