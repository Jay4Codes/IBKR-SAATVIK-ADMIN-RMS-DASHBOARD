import json
import logging
from datetime import UTC, datetime


class JsonFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps(
            {
                "level": record.levelname,
                "service": record.name,
                "event": record.getMessage(),
                "timestamp": datetime.now(UTC).isoformat(),
                "exception": self.formatException(record.exc_info) if record.exc_info else None,
            }
        )


def configure():
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    # httpx logs every request at INFO with the full URL, query string included.
    # Massive authenticates with an `apiKey` query parameter, so leaving this at
    # INFO would write the vendor key into the logs on every poll.
    logging.getLogger("httpx").setLevel(logging.WARNING)
