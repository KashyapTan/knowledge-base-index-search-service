export interface GatewayProps {
  amount: number;
}

export function GatewayButton({ amount }: GatewayProps) {
  return <button type="button">Pay {amount}</button>;
}

export const retryPayment = async (id: string) => {
  return fetch(`/payments/${id}/retry`);
};

export class PaymentQueue {
  enqueue(id: string) {
    return id;
  }
}
