from __future__ import annotations


def format_duration(total_seconds: float) -> str:
    """Formata uma duração não negativa usando as unidades relevantes."""

    seconds = max(0, int(total_seconds))
    days, remainder = divmod(seconds, 86_400)
    hours, remainder = divmod(remainder, 3_600)
    minutes, seconds = divmod(remainder, 60)

    values = (
        (days, "dia", "dias"),
        (hours, "hora", "horas"),
        (minutes, "minuto", "minutos"),
    )
    parts = [
        f"{value} {singular if value == 1 else plural}"
        for value, singular, plural in values
        if value
    ]
    if not parts:
        return f"{seconds} {'segundo' if seconds == 1 else 'segundos'}"
    if len(parts) == 1:
        return parts[0]
    return f"{', '.join(parts[:-1])} e {parts[-1]}"
