// The Reg M-B team "database": every VGC 2026 Reg M-B team the app knows about, as
// pre-packed Showdown teams. This is the single source of truth — the Battle tab draws its
// random matchups from here (see formats.ts `packedTeams`), and the Auto Battle tab lets you
// pick any team to play any other (see auto-engine.ts / auto-mode/page.tsx).
//
// To add a team: import its PokePaste/export text, pack it with @pkmn/sim
// (`Teams.pack(Teams.import(text))`), and append a `{ id, name, packed }` entry. All teams
// here must be legal Reg M-B (Lv 50 doubles, Champions 66-EV rules — see champions-stats.ts).
// EV spreads use the Champions convention (32 in a stat = +32; 64 points across two stats).

export interface NamedTeam {
  id: string; // stable, URL/select-safe key
  name: string; // human label shown in the team pickers
  packed: string; // @pkmn/sim packed team string
}

const TRICK_ROOM =
  "Torkoal||Charcoal|Drought|Eruption,HeatWave,EarthPower,Protect|Quiet|32,,,32,,||,,,,,0||50|]" +
  "Hatterene||LifeOrb|MagicBounce|ExpandingForce,DazzlingGleam,MysticalFire,TrickRoom|Quiet|32,,,32,,||,,,,,0||50|]" +
  "Indeedee-F||PsychicSeed|PsychicSurge|FollowMe,TrickRoom,DazzlingGleam,HelpingHand|Sassy|32,,,,32,||,,,,,0||50|]" +
  "Ursaluna||FlameOrb|Guts|Facade,HeadlongRush,Crunch,Protect|Brave|32,32,,,,||,,,,,0||50|]" +
  "Kingambit||AssaultVest|Defiant|KowtowCleave,SuckerPunch,IronHead,LowKick|Brave|32,32,,,,||,,,,,0||50|]" +
  "Amoonguss||RockyHelmet|Regenerator|Spore,RagePowder,PollenPuff,Protect|Sassy|32,,,,32,||,,,,,0||50|";

const TAILWIND =
  "Tornadus||FocusSash|Prankster|BleakwindStorm,Tailwind,Taunt,Protect|Timid|,,,32,,32||||50|]" +
  "Archaludon||PowerHerb|Stamina|ElectroShot,FlashCannon,DracoMeteor,BodyPress|Modest|32,,,32,,||||50|]" +
  "Ursaluna-Bloodmoon||LifeOrb|MindsEye|BloodMoon,EarthPower,HyperVoice,Protect|Modest|32,,,32,,||,,,,,0||50|]" +
  "Rillaboom||MiracleSeed|GrassySurge|GrassyGlide,FakeOut,HighHorsepower,Protect|Adamant|,32,,,,32||||50|]" +
  "Flutter Mane||BoosterEnergy|Protosynthesis|Moonblast,ShadowBall,IcyWind,Protect|Timid|,,,32,,32||||50|]" +
  "Iron Hands||AssaultVest|QuarkDrive|FakeOut,WildCharge,DrainPunch,IcePunch|Adamant|32,32,,,,||||50|";

// Imported Pokémon Champions teams. NOTE: these are built around Mega Evolution
// (Swampertite / Aerodactylite / Charizardite Y / Floettite) and Floette-Eternal — mechanics
// the Gen 9 engine this app runs on does NOT support. The battles still run, but the Mega
// Stones are inert (no Pokémon Mega Evolves) and Floette-Eternal stays in its base form, so
// these teams play weaker than their real Champions versions. Kept verbatim by request.
const RAIN_MEGA_SWAMPERT =
  "Swampert||Swampertite|Torrent|WaveCrash,Earthquake,IcePunch,Protect|Adamant|2,32,,,,32||||50|]" +
  "Pelipper||FocusSash|Drizzle|WeatherBall,Hurricane,Tailwind,Protect|Modest|2,,,32,,32||||50|]" +
  "Archaludon||Leftovers|Stamina|ElectroShot,DragonPulse,FlashCannon,Protect|Modest|32,,,5,25,4||||50|]" +
  "Sinistcha||KasibBerry|Hospitality|MatchaGotcha,RagePowder,TrickRoom,Protect|Relaxed|32,,7,,27,||||50|]" +
  "Incineroar||SitrusBerry|Intimidate|PartingShot,FakeOut,ThroatChop,FlareBlitz|Careful|31,,7,,20,8||||50|]" +
  "Floette-Eternal||Floettite|FlowerVeil|DazzlingGleam,Moonblast,CalmMind,Protect|Modest|28,,14,15,,9|F|||50|";

const SUN_MEGA_CHARIZARD =
  "Aerodactyl||Aerodactylite|Unnerve|RockSlide,IceFang,Tailwind,WideGuard|Jolly|28,11,9,,1,17|M|||50|]" +
  "Kingambit||FocusSash|Defiant|KowtowCleave,SuckerPunch,IronHead,Protect|Adamant|13,25,1,,1,26|M|||50|]" +
  "Sylveon||FairyFeather|Pixilate|Detect,HyperVoice,HyperBeam,QuickAttack|Modest|18,,10,21,,17|M|||50|]" +
  "Garchomp||LifeOrb|RoughSkin|Earthquake,DragonClaw,StompingTantrum,Protect|Jolly|,32,1,,1,32|M|||50|]" +
  "Charizard||CharizarditeY|Blaze|Protect,HeatWave,SolarBeam,WeatherBall|Modest|24,,16,9,,17|M|||50|]" +
  "Incineroar||SitrusBerry|Intimidate|DarkestLariat,FlareBlitz,FakeOut,PartingShot|Impish|32,,32,,2,|M|||50|";

export const REG_MB_TEAMS: NamedTeam[] = [
  { id: "trick-room", name: "Trick Room — Torkoal / Hatterene", packed: TRICK_ROOM },
  { id: "tailwind", name: "Tailwind — Tornadus / Archaludon", packed: TAILWIND },
  { id: "rain-swampert", name: "Rain — Pelipper / Swampert (Mega)", packed: RAIN_MEGA_SWAMPERT },
  { id: "sun-charizard", name: "Sun — Charizard Y / Aerodactyl (Mega)", packed: SUN_MEGA_CHARIZARD },
];

export function teamById(id: string): NamedTeam | undefined {
  return REG_MB_TEAMS.find((t) => t.id === id);
}

// The packed strings, in registry order — used by formats.ts for the Battle tab's random pool.
export const REG_MB_PACKED: string[] = REG_MB_TEAMS.map((t) => t.packed);
