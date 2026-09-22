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
    logging.getLogger("httpx").setLevel(logging.WARNING)
