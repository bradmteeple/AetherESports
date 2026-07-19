// Production-minification fix for @pkmn/sim's State serialization.
//
// State.serializeBattle encodes object references as `[<constructor.name>:<id>]` (see the sim's
// state.ts `toRef`), and deserialize matches those names against a HARD-CODED list ("Pokemon",
// "Side", "Ability", …). A production bundler (Next's SWC minifier) renames the classes, so
// `constructor.name` becomes "a"/"b"/… — serialize then emits `[a:p1a]`, deserialize can't resolve
// it, and a forked battle ends up with plain objects where Pokémon should be (crashing later with
// "getMoveRequestData is not a function"). This is invisible in dev (unminified) but breaks every
// fork in production — which is exactly what the Monte Carlo searcher relies on.
//
// The class *identities* survive minification even though their `.name` does not, so we patch
// `toRef` to look the canonical name up from the real constructors. The id logic is copied verbatim
// from the sim so behaviour is otherwise identical.

import "./node-shim"; // must precede any @pkmn import
import { State, Battle, Side, Pokemon, Dex } from "@pkmn/sim";

const POSITIONS = "abcdefghijklmnopqrstuvwx";
let installed = false;

export function installSimSerializationFix(): void {
  if (installed) return;
  installed = true;

  const names = new Map<unknown, string>([
    [Battle, "Battle"],
    [Side, "Side"],
    [Pokemon, "Pokemon"],
    [(Dex as any).Ability, "Ability"],
    [(Dex as any).Item, "Item"],
    [(Dex as any).Move, "Move"],
    [(Dex as any).Condition, "Condition"],
    [(Dex as any).Species, "Species"],
  ]);
  // Field isn't a top-level export; grab its constructor from a throwaway battle instance.
  try {
    const probe = new Battle({ formatid: "gen9customgame" as any });
    names.set((probe.field as any).constructor, "Field");
  } catch {
    /* best effort — Field refs are rare */
  }

  (State as any).toRef = function (obj: any) {
    const id = obj instanceof Pokemon ? `${obj.side.id}${POSITIONS[obj.position]}` : `${obj.id}`;
    const name = names.get(obj.constructor) || obj.constructor.name;
    return `[${name}${id ? ":" : ""}${id}]`;
  };
}
