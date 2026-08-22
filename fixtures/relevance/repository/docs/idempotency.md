# Safe request replay

## Duplicate suppression

Every charge request carries an idempotency token. Store the first completed response under that
token and return it when the caller repeats the operation. This prevents a customer from being
charged twice after a client timeout.

The public HTTP header is `Idempotency-Key`; its value is opaque and scoped to one merchant.
