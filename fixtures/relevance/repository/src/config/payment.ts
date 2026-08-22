export const PAYMENT_TIMEOUT_MS = 5_000;
export const PAYMENT_MAX_ATTEMPTS = 3;

export interface PaymentGatewayConfig {
  timeoutMs: number;
  maximumAttempts: number;
}

export const paymentGatewayConfig: PaymentGatewayConfig = {
  timeoutMs: PAYMENT_TIMEOUT_MS,
  maximumAttempts: PAYMENT_MAX_ATTEMPTS,
};
