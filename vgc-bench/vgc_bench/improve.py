"""
Self-improvement loop for the Level 3 opponent.

Level 3 is built in two layers:

  1. FOUNDATION -- two AI bots playing each other (self-play / PSRO). This is the
     strong, general base policy, trained with train.py's self-play family and
     initialized from behavior cloning. It is expensive, so it is built once and
     reused across many adaptation passes.
  2. ADAPTATION -- on top of that foundation, learn to exploit how *you* play:
     behavior-clone a model of your games, freeze it as the exploiter's fixed
     opponent (-1.zip), and continue training the foundation policy to beat it.

So Level 3 = "a self-play champion, then sharpened against you". It orchestrates
the existing tested entry points; nothing here re-implements training:

    (foundation)  train --self_play --behavior_clone
    (model of you) logs2trajs -> pretrain
    (adaptation)  seed exploiter from the foundation + your model -> train --exploiter

The adapted policy is written under method ``ex``, and Level 3 always loads the
newest checkpoint, so afterward you face it with::

    python -m vgc_bench.play --username <name> --reg mb --level 3 --method ex

Requirements: a CUDA GPU, the ML extras (``pip install .[dev]``), and a running
pokemon-showdown server. Run from the repo root. Input games must already be in
``battle_logs/`` (use ``play.py --save-logs`` to capture local games). Use
``--dry-run`` to print the exact commands and paths without executing anything.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from vgc_bench.src.levels import method_save_dir, resolve_latest_checkpoint

# Self-play foundation styles (two bots playing each other) -> train.py flag and
# the resulting checkpoint method tag ("bc" init + LearningStyle.abbrev).
FOUNDATION_STYLES = {
    "self_play": "bc_sp",
    "double_oracle": "bc_do",
    "fictitious_play": "bc_fp",
}
# Method the adaptation (exploiter, seeded from the foundation) writes under.
ADAPT_METHOD = "ex"


def _has_learner_checkpoint(save_dir: Path) -> bool:
    """True if a directory already holds a >=0 numbered checkpoint."""
    if not save_dir.is_dir():
        return False
    for p in save_dir.iterdir():
        if p.suffix == ".zip":
            try:
                if int(p.stem) >= 0:
                    return True
            except ValueError:
                continue
    return False


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
    adapt_steps: int,
    foundation: str,
    foundation_steps: int,
    rebuild_foundation: bool,
    num_workers: int,
    only_winner: bool,
    min_rating: int | None,
    num_epochs: int,
    results_path: str | Path = "results",
    dry_run: bool = False,
) -> None:
    """Run one self-improvement pass: (re)build the foundation, then adapt to you."""
    py = sys.executable
    foundation_method = FOUNDATION_STYLES[foundation]
    foundation_dir = method_save_dir(results_path, foundation_method, reg, num_teams, run_id)
    adapt_dir = method_save_dir(results_path, ADAPT_METHOD, reg, num_teams, run_id)

    def _reg_teams(cmd: list[str]) -> list[str]:
        if reg is not None:
            cmd += ["--reg", reg]
        if num_teams is not None:
            cmd += ["--num_teams", str(num_teams)]
        return cmd

    foundation_cmd = _reg_teams([
        py, "-m", "vgc_bench.train",
        f"--{foundation}", "--behavior_clone",
        "--run_id", str(run_id),
        "--total_steps", str(foundation_steps),
        "--port", str(port), "--device", device,
    ])
    logs2trajs_cmd = [py, "-m", "vgc_bench.logs2trajs", "--num_workers", str(num_workers)]
    if only_winner:
        logs2trajs_cmd.append("--only_winner")
    if min_rating is not None:
        logs2trajs_cmd += ["--min_rating", str(min_rating)]
    pretrain_cmd = [
        py, "-m", "vgc_bench.pretrain",
        "--run_id", str(run_id), "--port", str(port),
        "--device", device, "--num_epochs", str(num_epochs),
    ]
    adapt_cmd = _reg_teams([
        py, "-m", "vgc_bench.train",
        "--exploiter",  # NOT --behavior_clone: we seed from the foundation instead
        "--run_id", str(run_id),
        "--total_steps", str(adapt_steps),
        "--port", str(port), "--device", device,
    ])

    need_foundation = rebuild_foundation or not _has_learner_checkpoint(foundation_dir)

    if dry_run:
        print(f"[dry-run] foundation ({foundation}) dir: {foundation_dir}")
        print(f"[dry-run]   {'BUILD' if need_foundation else 'reuse existing'}: {' '.join(foundation_cmd)}")
        print(f"[dry-run] model of you : {' '.join(logs2trajs_cmd)}")
        print(f"[dry-run]              : {' '.join(pretrain_cmd)}")
        print(f"[dry-run] seed adapt dir {adapt_dir}: <foundation latest> -> 0.zip (if empty), <your model> -> -1.zip")
        print(f"[dry-run] adapt        : {' '.join(adapt_cmd)}")
        print(f"[dry-run] then: python -m vgc_bench.play --reg {reg or '<reg>'} "
              f"--level 3 --method {ADAPT_METHOD} --run_id {run_id}"
              + (f" --num_teams {num_teams}" if num_teams is not None else ""))
        return

    if not _battle_logs_present(Path("battle_logs")):
        raise SystemExit(
            "No usable logs in battle_logs/. Capture games with "
            "`play.py --save-logs` (see the README) before improving."
        )

    if need_foundation:
        print(f">> [1/4] Building the self-play foundation ({foundation}: two bots playing each other) ...")
        subprocess.run(foundation_cmd, check=True)
    else:
        print(f">> [1/4] Reusing existing {foundation} foundation at {foundation_dir}")

    print(">> [2/4] Behavior-cloning a model of how you play ...")
    subprocess.run(logs2trajs_cmd, check=True)
    subprocess.run(pretrain_cmd, check=True)

    print(">> [3/4] Seeding the adaptation from the foundation + your model ...")
    foundation_ckpt = resolve_latest_checkpoint(results_path, foundation_method, reg, num_teams, run_id)
    user_model = resolve_latest_checkpoint(results_path, "bc", reg, None, run_id)
    adapt_dir.mkdir(parents=True, exist_ok=True)
    if not _has_learner_checkpoint(adapt_dir):
        shutil.copyfile(foundation_ckpt, adapt_dir / "0.zip")
        print(f"   foundation {foundation_ckpt} -> {adapt_dir / '0.zip'}")
    shutil.copyfile(user_model, adapt_dir / "-1.zip")
    print(f"   your model {user_model} -> {adapt_dir / '-1.zip'} (fixed opponent)")

    print(">> [4/4] Adapting the foundation to exploit your play ...")
    subprocess.run(adapt_cmd, check=True)

    latest = resolve_latest_checkpoint(results_path, ADAPT_METHOD, reg, num_teams, run_id)
    print(f"Done. New Level 3 checkpoint: {latest}")
    print(f"Play it: python -m vgc_bench.play --reg {reg or '<reg>'} --level 3 "
          f"--method {ADAPT_METHOD} --run_id {run_id}"
          + (f" --num_teams {num_teams}" if num_teams is not None else ""))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Improve Level 3: a self-play foundation, then adapted to your games."
    )
    parser.add_argument("--reg", type=str, default=None, help="VGC regulation, e.g. mb")
    parser.add_argument("--run_id", type=int, default=1, help="run/seed id")
    parser.add_argument("--num_teams", type=int, default=None, help="team count subfolder")
    parser.add_argument("--port", type=int, default=8000, help="showdown server port")
    parser.add_argument("--device", type=str, default="cuda:0", help="torch device")
    parser.add_argument(
        "--foundation",
        choices=sorted(FOUNDATION_STYLES),
        default="self_play",
        help="how the two bots play each other to build the base policy "
        "(self_play = two copies vs each other; double_oracle / fictitious_play "
        "= population self-play, stronger but heavier). Default self_play.",
    )
    parser.add_argument(
        "--foundation_steps", type=int, default=9_830_400,
        help="training timesteps for the foundation (built once, reused).",
    )
    parser.add_argument(
        "--rebuild_foundation", action="store_true",
        help="retrain the foundation even if one already exists.",
    )
    parser.add_argument(
        "--adapt_steps", type=int, default=983_040,
        help="training timesteps for each adaptation pass against your model.",
    )
    parser.add_argument("--num_workers", type=int, default=1, help="log-parse workers")
    parser.add_argument("--only_winner", action="store_true", help="only learn from games you won")
    parser.add_argument("--min_rating", type=int, default=None, help="min Elo to include")
    parser.add_argument("--num_epochs", type=int, default=100, help="BC epochs")
    parser.add_argument(
        "--dry-run", dest="dry_run", action="store_true",
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
        args.adapt_steps,
        args.foundation,
        args.foundation_steps,
        args.rebuild_foundation,
        args.num_workers,
        args.only_winner,
        args.min_rating,
        args.num_epochs,
        dry_run=args.dry_run,
    )
