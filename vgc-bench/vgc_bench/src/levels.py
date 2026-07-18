"""
Difficulty-level opponent factory for VGC-Bench.

Defines three difficulty tiers and builds a configured poke-env player for each,
so callers (e.g. ``play.py``) can spin up an opponent of a chosen strength with a
single call. Strength is realized entirely from existing, proven mechanisms:

  * Level 1 (day-2 regional championship player): ``SimpleHeuristicsPlayer``, a
    rule-based bot that understands type matchups and switching but is
    exploitable. It needs no trained model, so it works for any regulation
    (including Reg M-B) immediately.
  * Level 2 (regional champion): the trained neural policy sampled
    stochastically with a small blunder rate, on randomly chosen teams.
  * Level 3 (world champion): the trained neural policy played greedily on
    featured/meta teams, always loading the latest available checkpoint -- the
    hook the self-improvement loop writes to so the bot keeps getting stronger.

The heavy imports (torch, stable_baselines3, the policy classes) are deferred
into :func:`make_opponent` so the :class:`Level` enum and per-level configuration
can be imported and tested without those dependencies installed.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, unique
from pathlib import Path
from typing import Any


@unique
class Level(Enum):
    """The three selectable difficulty tiers."""

    ONE = 1
    TWO = 2
    THREE = 3

    @property
    def label(self) -> str:
        """Human-readable name including the skill archetype."""
        return {
            Level.ONE: "Level 1 - day-2 regional championship player",
            Level.TWO: "Level 2 - regional champion",
            Level.THREE: "Level 3 - world champion",
        }[self]


@dataclass(frozen=True)
class LevelConfig:
    """
    Declarative strength configuration for a difficulty level.

    Attributes:
        kind: Player family to build -- "heuristic" (rule-based, no model) or
            "policy" (neural network agent).
        deterministic: For policy players, whether to pick the argmax action
            (strongest) instead of sampling from the distribution.
        blunder: For policy players, probability of playing a random legal move
            on a given turn (weakens the agent). 0.0 disables it.
        prefer_featured: Whether to draw teams from the curated ``featured/``
            pool when it exists.
        switch_heuristic: For policy players, whether to layer the rule-based
            switch override so the agent switches out of bad matchups.
        description: Short human-readable summary of how this level plays.
    """

    kind: str
    deterministic: bool
    blunder: float
    prefer_featured: bool
    switch_heuristic: bool
    description: str


LEVEL_CONFIGS: dict[Level, LevelConfig] = {
    Level.ONE: LevelConfig(
        kind="heuristic",
        deterministic=False,
        blunder=0.0,
        prefer_featured=False,
        switch_heuristic=False,
        description="Rule-based SimpleHeuristics opponent: solid fundamentals, exploitable.",
    ),
    Level.TWO: LevelConfig(
        kind="policy",
        deterministic=False,
        blunder=0.05,
        prefer_featured=False,
        switch_heuristic=True,
        description="Trained policy, sampled stochastically with occasional slips.",
    ),
    Level.THREE: LevelConfig(
        kind="policy",
        deterministic=True,
        blunder=0.0,
        prefer_featured=True,
        switch_heuristic=True,
        description="Trained policy at full strength on meta teams; self-improving.",
    ),
}


def level_from_int(value: int) -> Level:
    """Convert an integer (1, 2, or 3) into a :class:`Level`, or raise."""
    try:
        return Level(value)
    except ValueError:
        raise ValueError(
            f"invalid difficulty level {value!r}; expected 1, 2, or 3"
        ) from None


def resolve_latest_checkpoint(
    results_path: str | Path,
    method: str,
    reg: str | None,
    num_teams: int | None,
    run_id: int,
) -> Path:
    """
    Return the newest numbered checkpoint for a training run.

    Mirrors the checkpoint-directory layout used by ``play.py`` / ``eval.py``:
    ``bc`` models live directly under ``results/saves_bc/seed<run_id>`` while
    RL methods are additionally nested by regulation and team count. The latest
    checkpoint is the one with the highest integer filename stem.

    Raises:
        FileNotFoundError: if the saves directory does not exist.
        IndexError: if the directory exists but contains no checkpoints.
    """
    method_dir = Path(results_path) / f"saves_{method}"
    if method != "bc":
        method_dir = method_dir / (f"reg_{reg}" if reg is not None else "reg_all")
        if num_teams is not None:
            method_dir = method_dir / f"{num_teams}_teams"
    saves_path = method_dir / f"seed{run_id}"
    checkpoints = sorted(saves_path.iterdir(), key=lambda p: int(p.stem))
    return checkpoints[-1]


def _resolve_or_download_checkpoint(
    results_path: str | Path,
    method: str,
    reg: str | None,
    num_teams: int | None,
    run_id: int,
) -> Path:
    """
    Find the latest local checkpoint, or fall back to the HuggingFace BC model.

    When no local checkpoint exists yet and ``method == "bc"``, download the
    published behavior-cloning policy so Levels 2 and 3 work out of the box
    before any local training has happened.
    """
    try:
        return resolve_latest_checkpoint(results_path, method, reg, num_teams, run_id)
    except (FileNotFoundError, IndexError):
        if method == "bc":
            from huggingface_hub import hf_hub_download

            from vgc_bench.src.callback import HF_BC_MODEL_FILE, HF_BC_MODEL_REPO

            return Path(
                hf_hub_download(repo_id=HF_BC_MODEL_REPO, filename=HF_BC_MODEL_FILE)
            )
        raise


def make_opponent(
    level: "Level | int",
    *,
    reg: str | None,
    battle_format: str,
    server_configuration: Any,
    run_id: int = 1,
    num_teams: int | None = None,
    method: str = "bc",
    device: str = "cuda:0",
    results_path: str | Path = "results",
    team: Any = None,
    **player_kwargs: Any,
) -> Any:
    """
    Build a poke-env player configured for the requested difficulty level.

    Args:
        level: The :class:`Level` (or its integer 1/2/3) to build.
        reg: VGC regulation identifier (e.g. 'mb'), or None for multi-reg.
        battle_format: Showdown battle format id (from ``utils.format_map``).
        server_configuration: poke-env ``ServerConfiguration`` to connect with.
        run_id: Training run/seed used to locate checkpoints.
        num_teams: Team-count subfolder for RL checkpoints (None for bc).
        method: Checkpoint method string (e.g. 'bc', 'bc_do_xm').
        device: Torch device string for policy inference.
        results_path: Root results directory holding ``saves_*`` folders.
        team: Optional pre-built team builder; if None one is created honoring
            the level's ``prefer_featured`` setting.
        **player_kwargs: Extra keyword arguments forwarded to the player
            constructor (account_configuration, avatar, log_level, etc.).

    Returns:
        A ready-to-use poke-env ``Player`` (``SimpleHeuristicsPlayer`` for
        Level 1, ``PolicyPlayer`` for Levels 2 and 3).
    """
    from torch import device as torch_device
    from poke_env.player import SimpleHeuristicsPlayer

    from vgc_bench.src.policy_player import PolicyPlayer
    from vgc_bench.src.teams import RandomTeamBuilder

    if isinstance(level, int):
        level = level_from_int(level)
    cfg = LEVEL_CONFIGS[level]

    if team is None:
        team = RandomTeamBuilder(
            run_id, num_teams, reg, prefer_featured=cfg.prefer_featured
        )

    common: dict[str, Any] = dict(
        battle_format=battle_format,
        server_configuration=server_configuration,
        team=team,
        **player_kwargs,
    )

    if cfg.kind == "heuristic":
        return SimpleHeuristicsPlayer(**common)

    player = PolicyPlayer(
        deterministic=cfg.deterministic,
        blunder=cfg.blunder,
        switch_heuristic=cfg.switch_heuristic,
        **common,
    )
    checkpoint = _resolve_or_download_checkpoint(
        results_path, method, reg, num_teams, run_id
    )
    player.set_policy(checkpoint, torch_device(device))
    return player
