"""
Unit tests for vgc_bench.improve (self-improvement orchestrator).

These are dependency-light: improve.py shells out to the training entry points
and never imports torch/poke_env itself, so its path logic can be validated
anywhere. The exploiter save-directory layout must stay in lock-step with the
one train.py builds (method tags "bc" + EXPLOITER.abbrev "ex" == "bc_ex").
"""

from pathlib import Path

from vgc_bench.improve import EXPLOITER_METHOD, exploiter_save_dir


class TestExploiterSaveDir:
    def test_method_string_is_bc_ex(self):
        assert EXPLOITER_METHOD == "bc_ex"

    def test_layout_without_team_count(self):
        d = exploiter_save_dir("results", "mb", None, 1)
        assert d == Path("results/saves_bc_ex/reg_mb/seed1")

    def test_layout_with_team_count(self):
        d = exploiter_save_dir("results", "mb", 4, 2)
        assert d == Path("results/saves_bc_ex/reg_mb/4_teams/seed2")

    def test_multi_reg_uses_reg_all(self):
        d = exploiter_save_dir("results", None, None, 3)
        assert d == Path("results/saves_bc_ex/reg_all/seed3")

    def test_respects_results_root(self):
        d = exploiter_save_dir("results_exp", "ma", None, 5)
        assert d.parts[0] == "results_exp"
        assert d.name == "seed5"
