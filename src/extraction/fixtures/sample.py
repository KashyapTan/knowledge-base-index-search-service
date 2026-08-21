"""Gateway client module."""

DEFAULT_TIMEOUT = 30

class GatewayClient:
    """Sends card requests."""

    def authorize(self, amount: int) -> bool:
        # Keep this comment searchable.
        return amount > 0

async def settle(reference: str) -> None:
    """Settle one authorization."""
    return None
