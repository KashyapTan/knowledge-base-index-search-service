# Payment retry policy

## Transient failures

Temporary processor failures should be attempted again with exponential backoff and randomized
jitter. Retry only timeouts, connection resets, and explicit retryable gateway responses. Permanent
declines must return immediately.

## Attempt budget

Use three total attempts. The first delay is 200 milliseconds and each later delay doubles. A
successful response or a permanent decline ends the schedule.

## Audit trail

Record attempt numbers and outcome categories without logging cardholder data.
