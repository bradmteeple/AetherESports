// Load a custom team from a PokePaste (pokepast.es) URL or from raw Showdown export text.
//
// PokePaste exposes /<id>/json and /<id>/raw. We fetch client-side; if that fails (CORS/network),
// the caller can fall back to the raw team text (which importTeam also accepts). Team parsing/packing
// reuses @pkmn/sim's Teams API already used by the engine.

import "./node-shim"; // must precede any @pkmn import
import { Teams } from "@pkmn/sim";

const POKEPASTE_RE = /pokepast\.es\/([A-Za-z0-9]+)/;

export function pokepasteId(input: string): string | null {
  const m = POKEPASTE_RE.exec(input.trim());
  return m ? m[1] : null;
}

export function looksLikeUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim()) || POKEPASTE_RE.test(input.trim());
}

// Fetch the export text for a PokePaste URL. Throws a friendly Error on failure.
export async function fetchPokepaste(input: string): Promise<string> {
  const id = pokepasteId(input);
  if (!id) throw new Error("That doesn't look like a pokepast.es link.");
  const base = `https://pokepast.es/${id}`;
  // Prefer the JSON endpoint (has the team in `.paste`); fall back to /raw.
  try {
    const res = await fetch(`${base}/json`, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.paste === "string" && data.paste.trim()) return data.paste;
    }
  } catch {
    /* try /raw next */
  }
  try {
    const res = await fetch(`${base}/raw`);
    if (res.ok) {
      const text = await res.text();
      if (text.trim()) return text;
    }
  } catch {
    /* fall through to error */
  }
  throw new Error(
    "Couldn't fetch that PokePaste (the site may block cross-site requests). Paste the team's export text instead."
  );
}

export interface LoadedTeam {
  packed: string;
  species: string[];
}

// Parse Showdown export text into a packed team + species list. Returns null if it isn't a team.
export function importTeam(text: string): LoadedTeam | null {
  try {
    const sets = Teams.import(text);
    if (!sets || !sets.length) return null;
    const packed = Teams.pack(sets);
    if (!packed) return null;
    const species = sets.map((s: any) => s.species || s.name).filter(Boolean);
    return { packed, species };
  } catch {
    return null;
  }
}
