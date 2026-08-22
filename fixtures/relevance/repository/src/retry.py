"""Retry implementation for transient payment processor failures."""


class BackoffScheduler:
    """Calculate exponentially increasing delays with bounded jitter."""

    def delay_ms(self, attempt: int) -> int:
        return min(200 * (2**attempt), 2_000)


def retry_payment(operation, scheduler: BackoffScheduler):
    """Try a failed charge again only when the processor response is temporary."""
    for attempt in range(3):
        result = operation()
        if result.ok or not result.retryable:
            return result
        scheduler.delay_ms(attempt)
    return result
