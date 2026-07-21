"""
Unit tests for vgc_bench.improve (self-improvement orchestrator).

Dependency-light: improve.py shells out to the training entry points and never
imports torch/poke_env itself, so its path/seeding logic can be validated
anywhere. Foundation and adaptation save-dirs must match the layout train.py
builds (method tag "bc" + LearningStyle.abbrev; exploiter -> "ex").
"""

from pathlib import Path

from vgc_bench.improve import ADAPT_METHOD, FOUNDATION_STYLES, _has_learner_checkpoint
from vgc_bench.src.levels import method_save_dir, resolve_latest_checkpoint


class TestMethods:
    def test_adapt_method_is_exploiter(self):
        assert ADAPT_METHOD == "ex"

    def test_foundation_styles_are_selfplay_family(self):
        # Two bots playing each other: pure self-play and the population variants.
        assert FOUNDATION_STYLES["self_play"] == "bc_sp"
        assert FOUNDATION_STYLES["double_oracle"] == "bc_do"
        assert FOUNDATION_STYLES["fictitious_play"] == "bc_fp"


class TestSaveDirs:
    def test_foundation_dir_layout(self):
        d = method_save_dir("results", FOUNDATION_STYLES["self_play"], "mb", 4, 2)
        assert d == Path("results/saves_bc_sp/reg_mb/4_teams/seed2")

    def test_adapt_dir_layout(self):
        d = method_save_dir("results", ADAPT_METHOD, "mb", None, 1)
        assert d == Path("results/saves_ex/reg_mb/seed1")

    def test_multi_reg_uses_reg_all(self):
        d = method_save_dir("results", ADAPT_METHOD, None, None, 3)
        assert d == Path("results/saves_ex/reg_all/seed3")


class TestLearnerCheckpointDetection:
    def _dir(self, root, stems):
        d = root / "saves_ex" / "reg_mb" / "seed1"
        d.mkdir(parents=True)
        for s in stems:
            (d / f"{s}.zip").write_text("")
        return d

    def test_detects_learner_checkpoint(self, tmp_path):
        self._dir(tmp_path, [0, 5])
        assert _has_learner_checkpoint(tmp_path / "saves_ex" / "reg_mb" / "seed1")

    def test_ignores_fixed_opponent_only(self, tmp_path):
        # Only the -1.zip fixed opponent present -> not a learner checkpoint yet.
        self._dir(tmp_path, [-1])
        assert not _has_learner_checkpoint(tmp_path / "saves_ex" / "reg_mb" / "seed1")

    def test_missing_dir_is_false(self, tmp_path):
        assert not _has_learner_checkpoint(tmp_path / "nope")


class TestResolveExcludesFixedOpponent:
    def test_latest_ignores_negative_stem(self, tmp_path):
        d = tmp_path / "saves_ex" / "reg_mb" / "seed1"
        d.mkdir(parents=True)
        for s in (-1, 0, 12, 3):
            (d / f"{s}.zip").write_text("")
        got = resolve_latest_checkpoint(tmp_path, "ex", "mb", None, 1)
        assert got.stem == "12"
