"""
Capture live battles as Showdown logs for the self-improvement loop.

When you play the bot on your local Showdown server, poke-env accumulates every
battle-room protocol message on the battle object (``battle._replay_data``,
populated unconditionally in ``AbstractBattle.parse_message``). This module
reconstructs the raw Showdown log from that and appends it to
``battle_logs/logs_<format>.json`` in the exact shape ``logs2trajs`` /
``improve.py`` consume: ``{"<format>-<num>": [uploadtime, raw_log]}``.

That closes the loop: play locally -> logs land in ``battle_logs/`` -> run
``python -m vgc_bench.improve`` to fold those games into a stronger Level 3.

The functions here operate on duck-typed battle objects (anything exposing
``battle_tag``, ``finished`` and ``_replay_data`` / ``_build_replay_log``), so
they carry no heavy dependencies and are unit-tested without poke-env installed.
"""

import json
import time
from pathlib import Path
from typing import Any, Mapping


def reconstruct_log(battle: Any) -> str | None:
    """
    Return the raw Showdown protocol log for a battle, or None if unavailable.

    Prefers poke-env's own ``_build_replay_log()``; falls back to joining the
    accumulated ``_replay_data`` the same way poke-env does.
    """
    builder = getattr(battle, "_build_replay_log", None)
    if callable(builder):
        try:
            log = builder()
            if log:
                return log
        except Exception:
            pass
    data = getattr(battle, "_replay_data", None)
    if not data:
        return None
    tag = getattr(battle, "battle_tag", "battle-unknown")
    body = "\n".join("|".join(str(tok) for tok in msg) for msg in data)
    return f">{tag}\n{body}"


def format_and_key(battle_tag: str) -> tuple[str, str]:
    """
    Split a poke-env ``battle_tag`` into (format_id, log_key).

    ``"battle-gen9championsvgc2026regmb-42"`` -> ``("gen9championsvgc2026regmb",
    "gen9championsvgc2026regmb-42")``. The key drops the ``battle-`` prefix so
    that ``logs2trajs`` recovers the format via ``key.split("-")[0]``.
    """
    stripped = battle_tag[len("battle-"):] if battle_tag.startswith("battle-") else battle_tag
    fmt = stripped.rsplit("-", 1)[0] if "-" in stripped else stripped
    return fmt, stripped


def save_battle_logs(
    battles: Mapping[str, Any],
    out_dir: str | Path = "battle_logs",
    now: int | None = None,
) -> int:
    """
    Append finished battles to ``battle_logs/logs_<format>.json``.

    Existing files are merged (keyed by battle id, so replaying the same games
    is idempotent), letting logs accumulate across play sessions.

    Args:
        battles: mapping of battle_tag -> battle (e.g. ``player.battles``).
        out_dir: directory to write ``logs_<format>.json`` files into.
        now: optional unix timestamp to stamp entries with.

    Returns:
        Number of finished battles written.
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    ts = int(time.time()) if now is None else int(now)
    by_format: dict[str, dict[str, list[Any]]] = {}
    for tag, battle in battles.items():
        if not getattr(battle, "finished", False):
            continue
        log = reconstruct_log(battle)
        if not log:
            continue
        fmt, key = format_and_key(tag)
        by_format.setdefault(fmt, {})[key] = [ts, log]

    written = 0
    for fmt, entries in by_format.items():
        path = out / f"logs_{fmt}.json"
        existing: dict[str, Any] = {}
        if path.exists():
            try:
                existing = json.loads(path.read_text())
            except json.JSONDecodeError:
                existing = {}
        existing.update(entries)
        path.write_text(json.dumps(existing))
        written += len(entries)
    return written
