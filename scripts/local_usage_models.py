"""Private China-day model totals from the existing activity collector's events."""

import re
from collections import defaultdict

FIELDS = ("input", "output", "cacheRead")
MAX_DAILY_MODELS = 24
PROVIDERS = {"codex", "copilot", "hermes", "pi"}
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+-]*(?:/[A-Za-z0-9][A-Za-z0-9_.+-]*)?")
MAX_COUNT = 2**53 - 1


def eligible_machines(collector, machines, at):
    if at is None:
        return machines
    return [{**machine, "tokens": [row for row in machine.get("tokens", [])
              if (timestamp := collector.instant(row.get("at"))) is not None and timestamp < at]}
            for machine in machines]


def model_label(provider, model):
    return (isinstance(provider, str) and provider in PROVIDERS and isinstance(model, str)
            and len(model) <= 120 and model.lower() != "unknown" and MODEL.fullmatch(model))


def daily_models(collector, machines, snapshot):
    days = {row["day"] for source in (snapshot.get("localHistory", {}).get("daily", []), snapshot["daily"])
            for row in source if "day" in row and row.get("tokenStatus") != "unavailable"}
    if not days:
        return {}
    groups = defaultdict(dict)
    seen = set()
    for machine in machines:
        for record in machine.get("tokens", []):
            key = record["key"]
            if key in seen:
                continue
            seen.add(key)
            day = collector.day(collector.instant(record["at"]))
            model, provider = record.get("model"), record.get("provider")
            counts = {field: collector.count(record.get(field)) for field in FIELDS}
            if day not in days or not model_label(provider, model) or not any(counts.values()):
                continue
            row = groups[day].setdefault((provider, model), {"provider": provider, "model": model, **dict.fromkeys(FIELDS, 0)})
            for field in FIELDS:
                row[field] += counts[field]
    return {day: sorted(rows.values(), key=lambda row: (
        -sum(row[field] for field in FIELDS), row["model"], row["provider"]))[:MAX_DAILY_MODELS]
        for day, rows in groups.items()}


def validate_models(rows, totals):
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_DAILY_MODELS:
        return None
    seen, amounts, result = set(), dict.fromkeys(FIELDS, 0), []
    for row in rows:
        try:
            provider, model = row["provider"], row["model"]
            values = {field: row[field] for field in FIELDS}
        except (KeyError, TypeError):
            return None
        if not model_label(provider, model) or (provider, model) in seen or not any(values.values()) or any(
                type(value) is not int or not 0 <= value <= MAX_COUNT for value in values.values()):
            return None
        seen.add((provider, model))
        for field in FIELDS:
            amounts[field] += values[field]
        result.append({"provider": provider, "model": model, **values})
    if any(amounts[field] > totals[field] for field in FIELDS):
        return None
    return result
