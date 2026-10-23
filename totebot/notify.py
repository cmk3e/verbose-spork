import logging

import httpx

from .config import Settings

log = logging.getLogger(__name__)


async def push(settings: Settings, title: str, body: str, race_id: str = "", priority: str = "high") -> None:
    """Send a push notification via ntfy (install the ntfy app on the iPad and subscribe to the topic)."""
    if not settings.ntfy_topic:
        return
    headers = {"Title": title.encode("utf-8").decode("latin-1", "ignore"), "Priority": priority, "Tags": "horse_racing"}
    if settings.public_url:
        headers["Click"] = f"{settings.public_url}/#{race_id}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(f"{settings.ntfy_server}/{settings.ntfy_topic}", content=body.encode(), headers=headers)
            resp.raise_for_status()
    except httpx.HTTPError:
        log.exception("Push notification failed")
