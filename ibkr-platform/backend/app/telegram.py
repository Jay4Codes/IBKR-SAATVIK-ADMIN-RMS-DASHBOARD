from __future__ import annotations

import logging
import secrets
from typing import Any

import httpx

from app.config import settings

log = logging.getLogger("ibkr-worker")

API = "https://api.telegram.org"
MAX_MESSAGE = 3900

def configured() -> bool:
    return bool(settings.telegram_bot_token)

def link_code() -> str:
    return secrets.token_urlsafe(9)

def deep_link(code: str) -> str | None:
    if not settings.telegram_bot_username:
        return None
    return f"https://t.me/{settings.telegram_bot_username}?start={code}"

def escape(text: str) -> str:
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

async def send(client: httpx.AsyncClient, chat_id: str, text: str) -> bool:
    if not configured() or not chat_id:
        return False
    body = text if len(text) <= MAX_MESSAGE else text[:MAX_MESSAGE] + "\n…truncated"
    try:
        response = await client.post(
            f"{API}/bot{settings.telegram_bot_token}/sendMessage",
            json={
                "chat_id": chat_id,
                "text": body,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
            timeout=15,
        )
    except httpx.HTTPError as exc:
        log.warning("telegram.send_failed chat=%s error=%s", chat_id, exc)
        return False
    if response.status_code == 200:
        return True
    log.warning(
        "telegram.send_rejected chat=%s status=%s body=%s",
        chat_id, response.status_code, response.text[:200],
    )
    return False

async def updates(client: httpx.AsyncClient, offset: int) -> list[dict[str, Any]]:
    if not configured():
        return []
    try:
        response = await client.get(
            f"{API}/bot{settings.telegram_bot_token}/getUpdates",
            params={
                "offset": offset,
                "timeout": 25,

                "allowed_updates": '["message","channel_post","my_chat_member"]',
            },
            timeout=40,
        )
        if response.status_code != 200:
            log.warning("telegram.updates_rejected status=%s", response.status_code)
            return []
        return response.json().get("result") or []
    except httpx.HTTPError as exc:
        log.warning("telegram.updates_failed error=%s", exc)
        return []

def group_chat(update: dict[str, Any]) -> tuple[str, str] | None:
\
\
\
\
\
\
\
\

    for key in ("message", "channel_post", "my_chat_member"):
        chat = (update.get(key) or {}).get("chat") or {}
        kind = str(chat.get("type") or "")
        chat_id = str(chat.get("id") or "")
        if chat_id and kind in ("group", "supergroup", "channel"):
            return chat_id, str(chat.get("title") or chat_id)
    return None

def started_with(update: dict[str, Any]) -> tuple[str, str, str] | None:
    message = update.get("message") or {}
    text = str(message.get("text") or "").strip()
    chat = message.get("chat") or {}
    chat_id = str(chat.get("id") or "")
    if not chat_id or not text.startswith("/start"):
        return None
    parts = text.split(maxsplit=1)
    if len(parts) != 2 or not parts[1].strip():
        return None

    if "@" in parts[0] and not parts[0].split("@", 1)[1]:
        return None
    name = chat.get("username") or " ".join(
        p for p in (chat.get("first_name"), chat.get("last_name")) if p
    )
    return parts[1].strip(), chat_id, str(name or chat_id)
