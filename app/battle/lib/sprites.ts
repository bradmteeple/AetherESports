// Pokémon Showdown 2D sprite URLs (placeholder battle assets).
//
// Uses @pkmn/img to build correct Gen-5 sprite URLs — it handles the forme-naming edge cases
// (Landorus-Therian, Urshifu-Rapid-Strike, …) that a naive toID() gets wrong. Images are served
// from Showdown's CDN (play.pokemonshowdown.com); they load in visitors' browsers and degrade
// gracefully (see the onError handlers in page.tsx) if the CDN is unreachable.

import { Sprites } from "@pkmn/img";

export interface Sprite {
  url: string;
  w: number;
  h: number;
}

// Front sprite (gen5/…) for the opponent, back sprite (gen5-back/…) for the player.
export function pokeSprite(name: string, foe: boolean): Sprite | null {
  try {
    const s = Sprites.getPokemon(name, { gen: 5, side: foe ? "p2" : "p1" });
    return { url: s.url, w: s.w, h: s.h };
  } catch {
    return null;
  }
}

// Small front-sprite thumbnail for team preview / switch bench.
export function pokeThumb(name: string): string | null {
  try {
    return Sprites.getPokemon(name, { gen: 5, side: "p2" }).url;
  } catch {
    return null;
  }
}
