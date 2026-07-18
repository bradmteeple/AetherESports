"""
Unit tests for vgc_bench.src.log_capture.

These use duck-typed fake battles (no poke_env needed) to verify that live
games are reconstructed and written in the exact shape logs2trajs / improve.py
consume: battle_logs/logs_<format>.json == {"<format>-<num>": [uploadtime, log]}.
"""

import json
from pathlib import Path

from vgc_bench.src.log_capture import format_and_key, reconstruct_log, save_battle_logs


class FakeBattle:
    def __init__(self, tag, replay_data, finished=True, builder=None):
        self.battle_tag = tag
        self._replay_data = replay_data
        self.finished = finished
        if builder is not None:
            self._build_replay_log = builder


class TestReconstructLog:
    def test_prefers_build_replay_log(self):
        b = FakeBattle("battle-x-1", [["", "turn", "1"]], builder=lambda: ">x-1\n|win|me")
        assert reconstruct_log(b) == ">x-1\n|win|me"

    def test_falls_back_to_joining_replay_data(self):
        b = FakeBattle("battle-gen9-9", [["", "player", "p1", "me"], ["", "win", "me"]])
        log = reconstruct_log(b)
        assert log == ">battle-gen9-9\n|player|p1|me\n|win|me"

    def test_none_when_no_data(self):
        assert reconstruct_log(FakeBattle("battle-x-1", [])) is None


class TestFormatAndKey:
    def test_strips_battle_prefix_and_recovers_format(self):
        fmt, key = format_and_key("battle-gen9championsvgc2026regmb-42")
        assert fmt == "gen9championsvgc2026regmb"
        assert key == "gen9championsvgc2026regmb-42"
        # logs2trajs recovers the format via key.split("-")[0]
        assert key.split("-")[0] == fmt


class TestSaveBattleLogs:
    def test_writes_expected_shape_and_skips_unfinished(self, tmp_path=None):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            battles = {
                "battle-gen9championsvgc2026regmb-1": FakeBattle(
                    "battle-gen9championsvgc2026regmb-1",
                    [["", "player", "p1", "ash"], ["", "win", "ash"]],
                ),
                "battle-gen9championsvgc2026regmb-2": FakeBattle(
                    "battle-gen9championsvgc2026regmb-2", [["", "turn", "1"]], finished=False
                ),
            }
            written = save_battle_logs(battles, out_dir=out, now=1234)
            assert written == 1
            data = json.loads((out / "logs_gen9championsvgc2026regmb.json").read_text())
            assert list(data) == ["gen9championsvgc2026regmb-1"]
            uploadtime, log = data["gen9championsvgc2026regmb-1"]
            assert uploadtime == 1234
            assert "|win|ash" in log

    def test_merges_across_sessions_idempotently(self):
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            out = Path(td)
            b1 = {"battle-f-1": _win_battle("f-1", "a")}
            b2 = {"battle-f-2": _win_battle("f-2", "b")}
            assert save_battle_logs(b1, out_dir=out, now=1) == 1
            assert save_battle_logs(b2, out_dir=out, now=2) == 1
            # re-saving b1 does not create a duplicate key
            assert save_battle_logs(b1, out_dir=out, now=3) == 1
            data = json.loads((out / "logs_f.json").read_text())
            assert set(data) == {"f-1", "f-2"}


def _win_battle(stripped_id, winner):
    tag = f"battle-{stripped_id}"
    return FakeBattle(tag, [["", "win", winner]])
