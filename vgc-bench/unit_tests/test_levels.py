"""
Unit tests for vgc_bench.src.levels.

These intentionally avoid importing torch / poke_env: the difficulty-level
enum, per-level configuration, and checkpoint-path resolution are all
dependency-light so they can be validated in any environment. The heavy
``make_opponent`` path (which builds real poke_env players) is exercised
separately on a machine with the ML dependencies installed.
"""

import pytest

from vgc_bench.src.levels import (
    LEVEL_CONFIGS,
    Level,
    level_from_int,
    resolve_latest_checkpoint,
)


class TestLevel:
    def test_three_levels_with_expected_values(self):
        assert [lvl.value for lvl in Level] == [1, 2, 3]

    def test_labels_mention_skill_archetypes(self):
        assert "regional" in Level.ONE.label
        assert "regional champion" in Level.TWO.label
        assert "world champion" in Level.THREE.label

    def test_level_from_int_roundtrip(self):
        for i in (1, 2, 3):
            assert level_from_int(i) is Level(i)

    @pytest.mark.parametrize("bad", [0, 4, -1, 99])
    def test_level_from_int_rejects_out_of_range(self, bad):
        with pytest.raises(ValueError):
            level_from_int(bad)


class TestLevelConfigs:
    def test_all_levels_configured(self):
        assert set(LEVEL_CONFIGS) == set(Level)

    def test_level1_is_modelless_heuristic(self):
        cfg = LEVEL_CONFIGS[Level.ONE]
        assert cfg.kind == "heuristic"

    def test_level2_is_sampled_policy_with_blunders(self):
        cfg = LEVEL_CONFIGS[Level.TWO]
        assert cfg.kind == "policy"
        assert cfg.deterministic is False
        assert cfg.blunder > 0.0

    def test_level3_is_greedy_full_strength_on_featured_teams(self):
        cfg = LEVEL_CONFIGS[Level.THREE]
        assert cfg.kind == "policy"
        assert cfg.deterministic is True
        assert cfg.blunder == 0.0
        assert cfg.prefer_featured is True

    def test_policy_levels_use_switch_heuristic(self):
        # The learned policy tends to stay in; the rule-based switch override is
        # enabled for the policy-backed tiers so they switch bad matchups out.
        assert LEVEL_CONFIGS[Level.TWO].switch_heuristic is True
        assert LEVEL_CONFIGS[Level.THREE].switch_heuristic is True

    def test_policy_levels_get_stronger_with_level(self):
        # Level 1 is a rule-based heuristic (its weakness is being rule-based,
        # not the blunder field). Among the policy-backed levels, a higher level
        # must not blunder more, and the top tier must play greedily.
        policy_levels = [lvl for lvl in Level if LEVEL_CONFIGS[lvl].kind == "policy"]
        blunders = [LEVEL_CONFIGS[lvl].blunder for lvl in policy_levels]
        assert blunders == sorted(blunders, reverse=True)
        assert LEVEL_CONFIGS[Level.THREE].deterministic is True
        # Level 1 is the only model-less tier.
        assert LEVEL_CONFIGS[Level.ONE].kind == "heuristic"
        assert all(LEVEL_CONFIGS[lvl].kind == "policy" for lvl in (Level.TWO, Level.THREE))


class TestResolveLatestCheckpoint:
    def _make(self, root, rel, stems):
        d = root / rel
        d.mkdir(parents=True)
        for s in stems:
            (d / f"{s}.zip").write_text("")
        return d

    def test_bc_layout_picks_highest_numbered_checkpoint(self, tmp_path):
        self._make(tmp_path / "saves_bc", "seed1", [1, 5, 20, 3])
        got = resolve_latest_checkpoint(tmp_path, "bc", "mb", None, 1)
        assert got.stem == "20"

    def test_rl_layout_nests_by_reg_and_team_count(self, tmp_path):
        self._make(tmp_path / "saves_do" / "reg_mb" / "2_teams", "seed7", [10, 100, 2])
        got = resolve_latest_checkpoint(tmp_path, "do", "mb", 2, 7)
        assert got.stem == "100"
        assert "reg_mb" in got.parts and "2_teams" in got.parts and "seed7" in got.parts

    def test_missing_directory_raises(self, tmp_path):
        with pytest.raises((FileNotFoundError, IndexError)):
            resolve_latest_checkpoint(tmp_path, "bc", "mb", None, 1)
