"""
Interactive play module for VGC-Bench.

Allows a trained policy to play games on Pokemon Showdown, either by
accepting challenges or playing on the ranked ladder.
"""

import argparse
import asyncio
from pathlib import Path

from poke_env import AccountConfiguration, ShowdownServerConfiguration
from torch import device

from vgc_bench.src.levels import LEVEL_CONFIGS, level_from_int, make_opponent
from vgc_bench.src.log_capture import save_battle_logs
from vgc_bench.src.policy import MaskedActorCriticPolicy
from vgc_bench.src.policy_player import PolicyPlayer
from vgc_bench.src.teams import RandomTeamBuilder, get_available_regs
from vgc_bench.src.utils import format_map


async def play(
    username: str,
    password: str | None,
    reg: str | None,
    run_id: int,
    results_suffix: str | None,
    method: str,
    num_teams: int | None,
    n_games: int,
    play_on_ladder: bool,
    level: int,
    save_logs: bool,
):
    """
    Run a difficulty-tiered opponent in interactive play mode.

    Builds a Level 1/2/3 opponent (see ``vgc_bench.src.levels``) and either
    enters the Pokemon Showdown ladder or waits to accept challenges from other
    players.

    Args:
        reg: VGC regulation identifier (e.g. 'ma', 'mb'), or None for all.
        run_id: Training run identifier for loading the model.
        results_suffix: Optional suffix appended to results<run_id> for paths.
        method: Method string used in checkpoint directory names.
        num_teams: Number of teams the model was trained with.
        n_games: Number of games to play.
        play_on_ladder: If True, play on ladder; if False, accept challenges.
        level: Difficulty level (1=day-2 regional, 2=regional champion,
            3=world champion).
        save_logs: If True, save every completed game to battle_logs/ so it can
            feed the self-improvement loop (python -m vgc_bench.improve).
    """
    assert not (play_on_ladder and reg is None), "ladder mode requires a specific --reg"
    print("Setting up...")
    results_path = Path(f"results{f'_{results_suffix}' if results_suffix else ''}")
    team_paths = None
    if results_suffix:
        team_paths = [results_path / "team1.txt", results_path / "team2.txt"]
    battle_format = format_map[reg if reg is not None else get_available_regs()[0]]
    cfg = LEVEL_CONFIGS[level_from_int(level)]
    team = RandomTeamBuilder(
        run_id, num_teams, reg, team_paths, prefer_featured=cfg.prefer_featured
    )
    agent = make_opponent(
        level,
        reg=reg,
        battle_format=battle_format,
        server_configuration=ShowdownServerConfiguration,
        run_id=run_id,
        num_teams=num_teams,
        method=method,
        results_path=str(results_path),
        team=team,
        account_configuration=AccountConfiguration(username, password),
        avatar="turo-ai",
        log_level=40,
        max_concurrent_battles=3,
        accept_open_team_sheet=True,
        start_timer_on_battle_start=play_on_ladder,
    )
    if reg is None and isinstance(agent, PolicyPlayer):
        agent._accept_all_formats = True
    if isinstance(agent, PolicyPlayer):
        assert isinstance(agent.policy, MaskedActorCriticPolicy)
        agent.policy.debug = True
    print(f"Ready: {cfg.description} ({level_from_int(level).label})")
    try:
        if play_on_ladder:
            print("Entering ladder")
            await agent.ladder(n_games=n_games)
            print(f"{agent.n_won_battles}-{agent.n_lost_battles}-{agent.n_tied_battles}")
        else:
            print("Awaiting challenges")
            await agent.accept_challenges(opponent=None, n_challenges=n_games)
    finally:
        if save_logs:
            battles = getattr(agent, "battles", None)
            if battles is None:
                battles = getattr(agent, "_battles", {})
            written = save_battle_logs(battles)
            print(f"Saved {written} game log(s) to battle_logs/ for self-improvement")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--username", type=str, required=True, help="Pokemon Showdown username"
    )
    parser.add_argument(
        "--password", type=str, default=None, help="Pokemon Showdown password"
    )
    parser.add_argument(
        "--reg",
        type=str,
        default=None,
        help="VGC regulation to play in (e.g. MA). Omit to accept any regulation",
    )
    parser.add_argument(
        "--run_id", type=int, default=1, help="AI's ID from its training run"
    )
    parser.add_argument(
        "--results_suffix",
        type=str,
        default=None,
        help="suffix appended to results<run_id> for output paths",
    )
    parser.add_argument(
        "--method",
        type=str,
        default="bc",
        help="method string for checkpoint directory, e.g. bc_do_xm. Defaults to "
        "'bc' (uses/downloads the behavior-cloning model). Ignored at Level 1.",
    )
    parser.add_argument(
        "--num_teams",
        type=int,
        default=None,
        help="Number of teams AI was trained with",
    )
    parser.add_argument(
        "-n", type=int, default=1, help="Number of games to play. Default is 1."
    )
    parser.add_argument(
        "-l", action="store_true", help="Play ladder. Default accepts challenges."
    )
    parser.add_argument(
        "--level",
        type=int,
        choices=[1, 2, 3],
        default=3,
        help="Difficulty: 1=day-2 regional player, 2=regional champion, "
        "3=world champion (default).",
    )
    parser.add_argument(
        "--save-logs",
        dest="save_logs",
        action="store_true",
        help="Save completed games to battle_logs/ to feed the self-improvement "
        "loop (python -m vgc_bench.improve).",
    )
    args = parser.parse_args()
    reg = args.reg.lower() if args.reg is not None else None
    asyncio.run(
        play(
            args.username,
            args.password,
            reg,
            args.run_id,
            args.results_suffix,
            args.method,
            args.num_teams,
            args.n,
            args.l,
            args.level,
            args.save_logs,
        )
    )
