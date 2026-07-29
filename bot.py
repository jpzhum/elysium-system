from __future__ import annotations

import logging
import sys

from elysium.application import create_bot
from elysium.config import ConfigError, ElysiumConfig
from elysium.logging_setup import configure_logging


def main() -> int:
    configure_logging()
    logger = logging.getLogger("elysium")

    try:
        config = ElysiumConfig.from_env()
        bot = create_bot(config)
        bot.run(config.discord_token, log_handler=None)
    except KeyboardInterrupt:
        logger.info("Bot encerrado pelo usuário.")
    except ConfigError as error:
        logger.error("%s", error)
        return 1
    except Exception:
        logger.exception("O bot foi encerrado por um erro fatal.")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
