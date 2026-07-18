"""
Unit tests for vgc_bench.src.switch_logic.

Uses duck-typed fake Pokemon/battles (no poke_env) to verify the conservative
"switch out of bad matchups" override: it switches only when the active is
clearly threatened AND a distinctly better, legal bench Pokemon exists, and it
never produces an illegal action.

Convention (matching poke-env): pokemon.damage_multiplier(type) is DEFENSIVE --
how much that pokemon takes from `type`.
"""

from vgc_bench.src.switch_logic import pick_switch_actions, should_switch


class FakeMon:
    def __init__(self, species, types, weak_to=None, fainted=False):
        self.base_species = species
        self.types = types
        self._weak = weak_to or {}
        self.fainted = fainted

    def damage_multiplier(self, t):
        return self._weak.get(t, 1.0)


class FakeBattle:
    def __init__(self, team, actives, opponents, available, trapped):
        self.team = team
        self.active_pokemon = actives
        self.opponent_active_pokemon = opponents
        self.available_switches = available
        self.trapped = trapped


# A grass active weak to the opposing fire mon; a water bench mon resists fire
# and threatens the fire mon.
def _scenario(available_pos0=None, trapped=(False, False)):
    grass = FakeMon("Grass", ["GRASS"], weak_to={"FIRE": 2.0})
    fire_ally = FakeMon("Fireally", ["FIRE"], weak_to={"FIRE": 0.5})
    water = FakeMon("Water", ["WATER"], weak_to={"FIRE": 0.5})
    opp_fire = FakeMon("Oppfire", ["FIRE"], weak_to={"WATER": 2.0, "GRASS": 0.5})
    team = {"a": grass, "b": fire_ally, "c": water}  # water is team index 2 -> switch 3
    return FakeBattle(
        team=team,
        actives=[grass, fire_ally],
        opponents=[opp_fire],
        available=[[water] if available_pos0 is None else available_pos0, [water]],
        trapped=list(trapped),
    ),


class TestShouldSwitch:
    def test_threatened_active_should_switch(self):
        opp = FakeMon("Oppfire", ["FIRE"])
        grass = FakeMon("Grass", ["GRASS"], weak_to={"FIRE": 2.0})
        assert should_switch(grass, [opp]) is True

    def test_safe_active_should_not_switch(self):
        opp = FakeMon("Oppfire", ["FIRE"])
        water = FakeMon("Water", ["WATER"], weak_to={"FIRE": 0.5})
        assert should_switch(water, [opp]) is False

    def test_no_opponents_never_switches(self):
        assert should_switch(FakeMon("x", ["GRASS"]), []) is False


class TestPickSwitchActions:
    def test_switches_bad_matchup_to_better_bench(self):
        (battle,) = _scenario()
        # slot 0 = a move (>=7), slot 1 = a move
        out = pick_switch_actions(battle, [10, 12])
        assert out[0] == 3  # switched to the water mon (team index 2 -> action 3)
        assert out[1] == 12  # healthy fire ally untouched

    def test_does_not_switch_when_trapped(self):
        (battle,) = _scenario(trapped=(True, False))
        out = pick_switch_actions(battle, [10, 12])
        assert out[0] == 10

    def test_does_not_switch_when_no_legal_switch(self):
        (battle,) = _scenario(available_pos0=[])
        out = pick_switch_actions(battle, [10, 12])
        assert out[0] == 10

    def test_leaves_existing_switch_untouched(self):
        (battle,) = _scenario()
        out = pick_switch_actions(battle, [3, 12])  # already switching slot 0
        assert out[0] == 3

    def test_no_double_switch_to_same_target(self):
        # Both actives threatened, only one good switch-in available to both slots.
        grass1 = FakeMon("Grassone", ["GRASS"], weak_to={"FIRE": 2.0})
        grass2 = FakeMon("Grasstwo", ["GRASS"], weak_to={"FIRE": 2.0})
        water = FakeMon("Water", ["WATER"], weak_to={"FIRE": 0.5})
        opp = FakeMon("Oppfire", ["FIRE"], weak_to={"WATER": 2.0, "GRASS": 0.5})
        team = {"a": grass1, "b": grass2, "c": water}  # water -> switch action 3
        battle = FakeBattle(
            team=team,
            actives=[grass1, grass2],
            opponents=[opp],
            available=[[water], [water]],
            trapped=[False, False],
        )
        out = pick_switch_actions(battle, [10, 11])
        # exactly one slot switches to water (action 3); the other can't reuse it
        assert list(out).count(3) == 1

    def test_no_switch_when_bench_not_better(self):
        # Bench mon is also weak to fire -> no clear improvement -> stay in.
        grass = FakeMon("Grass", ["GRASS"], weak_to={"FIRE": 2.0})
        bad_bench = FakeMon("Badbench", ["BUG"], weak_to={"FIRE": 2.0})
        opp = FakeMon("Oppfire", ["FIRE"], weak_to={"GRASS": 0.5, "BUG": 0.5})
        team = {"a": grass, "c": bad_bench}
        battle = FakeBattle(
            team=team,
            actives=[grass, None],
            opponents=[opp],
            available=[[bad_bench], []],
            trapped=[False, False],
        )
        out = pick_switch_actions(battle, [10, 0])
        assert out[0] == 10
