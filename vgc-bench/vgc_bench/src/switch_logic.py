"""
Rule-based "switch when it makes sense" override for policy players.

The learned policy tends to stay in even when the active Pokemon is in a bad
type matchup. This module layers a conservative switching heuristic on top of
the policy's chosen action: if an active is under a clear type threat (takes a
super-effective hit from an opposing active) and a distinctly better, *legal*
switch-in is on the bench, that slot is switched out instead of attacking.

It is intentionally conservative -- it only overrides on a clear improvement and
only to a switch poke-env already reports as legal (``battle.available_switches``
/ ``battle.trapped``), so it can never produce an illegal action. It operates on
duck-typed battle/Pokemon objects and uses no heavy dependencies, so the
decision logic is unit-tested without poke-env or numpy installed.

Action encoding (per active slot, matching vgc_bench.src.policy.action_map):
0 = pass, 1..6 = switch to that team slot, >=7 = a move. So a switch override
just sets a slot's action to the target team index + 1. The returned list is
accepted by ``DoublesEnv.action_to_order``, which only indexes ``action[0]`` /
``action[1]``.
"""

from typing import Any

# An active is "threatened" if an opposing active hits it for at least this
# type multiplier.
THREAT_MULTIPLIER = 2.0
# Only switch to a bench Pokemon whose matchup score beats staying in by at
# least this margin (keeps the bot from switching on marginal calls).
IMPROVE_MARGIN = 1.0


def _slot(seq: Any, pos: int, default: Any = None) -> Any:
    """Safely index a per-slot sequence."""
    try:
        return seq[pos]
    except (IndexError, KeyError, TypeError):
        return default


def _opponents(battle: Any) -> list:
    """Non-fainted opposing active Pokemon."""
    opp = getattr(battle, "opponent_active_pokemon", None)
    if opp is None:
        return []
    if not isinstance(opp, (list, tuple)):
        opp = [opp]
    return [o for o in opp if o is not None and not getattr(o, "fainted", False)]


def _threat_multiplier(mon: Any, opponents: list) -> float:
    """Worst type multiplier the opponents' STAB types deal to ``mon``."""
    worst = 0.0
    for opp in opponents:
        for t in getattr(opp, "types", []) or []:
            if t is None:
                continue
            try:
                worst = max(worst, float(mon.damage_multiplier(t)))
            except Exception:
                continue
    return worst


def _offense_multiplier(mon: Any, opponents: list) -> float:
    """Best type multiplier ``mon``'s STAB types deal to any opponent."""
    best = 0.0
    for t in getattr(mon, "types", []) or []:
        if t is None:
            continue
        for opp in opponents:
            try:
                best = max(best, float(opp.damage_multiplier(t)))
            except Exception:
                continue
    return best


def matchup_score(mon: Any, opponents: list) -> float:
    """Higher is better: reward threatening opponents and resisting them."""
    return _offense_multiplier(mon, opponents) - _threat_multiplier(mon, opponents)


def should_switch(active: Any, opponents: list) -> bool:
    """True if the active takes a clearly super-effective hit and can act."""
    if active is None or getattr(active, "fainted", False) or not opponents:
        return False
    return _threat_multiplier(active, opponents) >= THREAT_MULTIPLIER


def _flatten_ints(action: Any) -> list[int]:
    """Coerce a per-slot action (numpy array, list, or nested) into ``list[int]``."""
    out: list[int] = []
    for a in action:
        if isinstance(a, (list, tuple)):
            out.extend(int(x) for x in a)
        else:
            out.append(int(a))
    return out


def pick_switch_actions(battle: Any, action: Any) -> list[int]:
    """
    Return a copy of the policy's per-slot ``action`` with bad matchups switched.

    For each active slot the policy did not already switch, if the active is
    threatened, not trapped, and a legal bench Pokemon has a matchup score
    beating staying in by ``IMPROVE_MARGIN``, replace that slot's action with a
    switch to the best such Pokemon. Slots never switch to the same target.
    """
    acts = _flatten_ints(action)
    opponents = _opponents(battle)
    if not opponents:
        return acts

    team = list(getattr(battle, "team", {}).values())
    trapped = getattr(battle, "trapped", [])
    available = getattr(battle, "available_switches", [])
    actives = getattr(battle, "active_pokemon", [])
    chosen_switches = {a for a in acts if 1 <= a <= 6}

    for pos in range(len(acts)):
        if 1 <= acts[pos] <= 6:  # policy already switches this slot
            continue
        if _slot(trapped, pos, False):
            continue
        active = _slot(actives, pos)
        if not should_switch(active, opponents):
            continue
        legal_species = {
            getattr(p, "base_species", None) for p in (_slot(available, pos, []) or [])
        }
        if not legal_species:
            continue
        threshold = matchup_score(active, opponents) + IMPROVE_MARGIN
        best_action, best_score = None, threshold
        for i, mon in enumerate(team):
            switch_action = i + 1
            if switch_action in chosen_switches:
                continue
            if getattr(mon, "base_species", None) not in legal_species:
                continue
            score = matchup_score(mon, opponents)
            if score > best_score:
                best_score, best_action = score, switch_action
        if best_action is not None:
            acts[pos] = best_action
            chosen_switches.add(best_action)
    return acts
