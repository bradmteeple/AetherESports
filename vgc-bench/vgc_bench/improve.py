"""
Self-improvement loop for the Level 3 opponent (learns from YOUR games).

Turns your own games against the bot into a stronger, personalized Level 3
policy by (1) behavior-cloning a model of how you play and (2) training a new
policy to exploit that model. It orchestrates the existing, tested module entry
points -- nothing here re-implements training:

    logs2trajs  ->  pretrain (a model of you)  ->  train --exploiter (beats you)

Level 3 (see ``vgc_bench/src/levels.py`` and ``play.py``) always loads the
newest checkpoint in its saves directory. The exploiter writes to method
``bc_ex``, so after running this you face the improved bot with::

    python -m vgc_bench.play --username <name> --reg mb --level 3 --method bc_ex

Run it again after more games and it keeps compounding -- each pass refreshes the
model of you and continues training the exploiter against it.

Requirements: a CUDA GPU, the ML extras (``pip install .[dev]``), and a running
pokemon-showdown server (the pretrain/train steps need it, exactly like
``train.py``). Run from the repo root.

Input data: your games against the bot must already be in
``battle_logs/logs_<format>.json`` in the same shape ``scrape_logs.py`` produces
(``{battle_id: [uploadtime, raw_log]}`` with open team sheets) -- see the README
for how to collect them. This orchestrator does not scrape or capture games
itself; it consumes whatever is in ``battle_logs/``.

Use ``--dry-run`` to print the exact commands and resolved paths without
executing anything (no GPU or ML dependencies needed).
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from vgc_bench.src.levels import resolve_latest_checkpoint

# Method string the exploiter run writes under, matching train.py's tag logic
# (behavior_clone -> "bc", LearningStyle.EXPLOITER.abbrev -> "ex", mirror matches
# allowed, teampreview on): "bc" + "ex" == "bc_ex".
EXPLOITER_METHOD = "bc_ex"


def exploiter_save_dir(
    results_path: str | Path,
    reg: str | None,
    num_teams: int | None,
    run_id: int,
) -> Path:
    """
    Directory where ``train --exploiter --behavior_clone`` writes checkpoints.

    Mirrors the layout built in ``train.py`` for the exploiter method so the
    fixed opponent (``-1.zip``) is placed exactly where training expects it and
    Level 3 (``--method bc_ex``) later finds the learner's checkpoints.
    """
    d = Path(results_path) / f"saves_{EXPLOITER_METHOD}"
    d = d / (f"reg_{reg}" if reg is not None else "reg_all")
    if num_teams is not None:
        d = d / f"{num_teams}_teams"
    return d / f"seed{run_id}"


def _battle_logs_present(battle_logs_dir: Path) -> bool:
    """True if battle_logs/ holds at least one non-empty JSON log file."""
    if not battle_logs_dir.is_dir():
        return False
    for f in battle_logs_dir.iterdir():
        if f.suffix == ".json" and f.stat().st_size > 2:
            try:
                if json.loads(f.read_text()):
                    return True
            except (json.JSONDecodeError, OSError):
                continue
    return False


def improve(
    reg: str | None,
    run_id: int,
    num_teams: int | None,
    port: int,
    device: str,
    total_steps: int,
    num_workers: int,
    only_winner: bool,
    min_rating: int | None,
    num_epochs: int,
    results_path: str | Path = "results",
    dry_run: bool = False,
) -> None:
    """
    Run one self-improvement pass, learning from games in ``battle_logs/``.

    Steps (each an existing entry point): convert your logs to trajectories,
    behavior-clone a model of your play, install it as the exploiter's fixed
    opponent (``-1.zip``), then exploiter-train a stronger Level 3 policy.
    """
    py = sys.executable
    logs2trajs = [py, "-m", "vgc_bench.logs2trajs", "--num_workers", str(num_workers)]
    if only_winner:
        logs2trajs.append("--only_winner")
    if min_rating is not None:
        logs2trajs += ["--min_rating", str(min_rating)]

    pretrain = [
        py, "-m", "vgc_bench.pretrain",
        "--run_id", str(run_id),
        "--port", str(port),
        "--device", device,
        "--num_epochs", str(num_epochs),
    ]

    train = [
        py, "-m", "vgc_bench.train",
        "--exploiter", "--behavior_clone",
        "--run_id", str(run_id),
        "--total_steps", str(total_steps),
        "--port", str(port),
        "--device", device,
    ]
    if reg is not None:
        train += ["--reg", reg]
    if num_teams is not None:
        train += ["--num_teams", str(num_teams)]

    save_dir = exploiter_save_dir(results_path, reg, num_teams, run_id)
    fixed_opponent = save_dir / "-1.zip"

    if dry_run:
        print("[dry-run] battle_logs present:", _battle_logs_present(Path("battle_logs")))
        print("[dry-run] 1) convert logs :", " ".join(logs2trajs))
        print("[dry-run] 2) model of you :", " ".join(pretrain))
        print(f"[dry-run] 3) install fixed opponent -> {fixed_opponent}")
        print("[dry-run] 4) exploiter    :", " ".join(train))
        print(
            f"[dry-run] then: python -m vgc_bench.play --reg {reg or '<reg>'} "
            f"--level 3 --method {EXPLOITER_METHOD} --run_id {run_id}"
            + (f" --num_teams {num_teams}" if num_teams is not None else "")
        )
        return

    if not _battle_logs_present(Path("battle_logs")):
        raise SystemExit(
            "No usable logs in battle_logs/. Add your games against the bot as "
            "battle_logs/logs_<format>.json (see the README) before improving."
        )

    print(">> [1/4] Converting your games to trajectories ...")
    subprocess.run(logs2trajs, check=True)

    print(">> [2/4] Behavior-cloning a model of how you play ...")
    subprocess.run(pretrain, check=True)

    print(">> [3/4] Installing that model as the exploiter's fixed opponent ...")
    user_model = resolve_latest_checkpoint(results_path, "bc", reg, None, run_id)
    save_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(user_model, fixed_opponent)
    print(f"   {user_model} -> {fixed_opponent}")

    print(">> [4/4] Training a Level 3 policy to exploit your play ...")
    subprocess.run(train, check=True)

    latest = resolve_latest_checkpoint(results_path, EXPLOITER_METHOD, reg, num_teams, run_id)
    print(f"Done. New Level 3 checkpoint: {latest}")
    print(
        f"Play it: python -m vgc_bench.play --reg {reg or '<reg>'} --level 3 "
        f"--method {EXPLOITER_METHOD} --run_id {run_id}"
        + (f" --num_teams {num_teams}" if num_teams is not None else "")
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Improve the Level 3 opponent from your games against it."
    )
    parser.add_argument("--reg", type=str, default=None, help="VGC regulation, e.g. mb")
    parser.add_argument("--run_id", type=int, default=1, help="run/seed id")
    parser.add_argument("--num_teams", type=int, default=None, help="team count subfolder")
    parser.add_argument("--port", type=int, default=8000, help="showdown server port")
    parser.add_argument("--device", type=str, default="cuda:0", help="torch device")
    parser.add_argument(
        "--total_steps", type=int, default=983_040, help="exploiter training timesteps"
    )
    parser.add_argument("--num_workers", type=int, default=1, help="log-parse workers")
    parser.add_argument(
        "--only_winner", action="store_true", help="only learn from games you won"
    )
    parser.add_argument("--min_rating", type=int, default=None, help="min Elo to include")
    parser.add_argument("--num_epochs", type=int, default=100, help="BC epochs")
    parser.add_argument(
        "--dry-run",
        dest="dry_run",
        action="store_true",
        help="print commands and resolved paths without running anything",
    )
    args = parser.parse_args()
    reg = args.reg.lower() if args.reg is not None else None
    improve(
        reg,
        args.run_id,
        args.num_teams,
        args.port,
        args.device,
        args.total_steps,
        args.num_workers,
        args.only_winner,
        args.min_rating,
        args.num_epochs,
        dry_run=args.dry_run,
    )
