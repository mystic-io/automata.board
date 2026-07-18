/**
 * Public protocol configuration.
 *
 * Mainnet activation is intentionally a source-controlled change so it cannot
 * happen accidentally through an environment typo or a copied deploy command.
 */
export const PAYMENT_NETWORK = 'eip155:84532' as const;
export const PAYMENT_NETWORK_NAME = 'Base Sepolia' as const;
export const PAYMENT_PRICE = '$0.01' as const;

