"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoBattleController, ComboWin, GameResult, Tally } from "../battle/lib/auto-engine";
import { buildReplayFrames, type ReplayFrame, type RosterEntry } from "../battle/lib/auto-replay";
import type { ActiveMon, BoardState } from "../battle/lib/protocol";
import { pokeSprite, pokeThumb } from "../battle/lib/sprites";
import { REG_MB_TEAMS, teamById } from "../battle/lib/reg-mb-teams";
import { FORMATS } from "../battle/lib/formats";
import type { LoadedTeam } from "../battle/lib/pokepaste";

interface Replay {
  n: number;
  result: GameResult;
  frames: ReplayFrame[];
}

const ZERO: Tally = {
  blue: 0,
  red: 0,
  ties: 0,
  games: 0,
  searching: false,
  turn: 0,
  sims: 0,
  topCombos: [],
  replayMin: null,
  replayMax: null,
  error: null,
};

const DEFAULT_BLUE = REG_MB_TEAMS[0]?.id ?? "";
const DEFAULT_RED = (REG_MB_TEAMS[1] ?? REG_MB_TEAMS[0])?.id ?? "";

// A short label for an uploaded team, or null when a side uses its preset dropdown.
function uploadLabel(team: LoadedTeam | null): string | null {
  if (!team) return null;
  const shown = team.species.slice(0, 2).join(" / ");
  return `Custom · ${shown}${team.species.length > 2 ? "…" : ""}`;
}

export default function AutoMode() {
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false); // engine chunk loading on the first Start
  const [tally, setTally] = useState<Tally>(ZERO);
  const [blueId, setBlueId] = useState(DEFAULT_BLUE);
  const [redId, setRedId] = useState(DEFAULT_RED);
  const [blueUpload, setBlueUpload] = useState<LoadedTeam | null>(null); // uploaded team overrides preset
  const [redUpload, setRedUpload] = useState<LoadedTeam | null>(null);
  const [replayNum, setReplayNum] = useState<string>(""); // the battle number typed in
  const [replay, setReplay] = useState<Replay | null>(null); // the battle currently shown
  const [replayError, setReplayError] = useState<string | null>(null);
  const controllerRef = useRef<AutoBattleController | null>(null);
  const runningRef = useRef(false); // mirrors `running` for async guards
  const aliveRef = useRef(true);

  const setRun = useCallback((v: boolean) => {
    runningRef.current = v;
    setRunning(v);
  }, []);

  // Track mount so an in-flight engine import can bail if we've unmounted.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // If the worker reports it can't run the matchup, stop the UI's running state too.
  useEffect(() => {
    if (tally.error) setRun(false);
  }, [tally.error, setRun]);

  // The controller stays alive across Stop/Start so power/learning persist (they must only ever
  // ramp up). Changing a team (or unmounting) tears it down; a fresh one is built on next Start.
  useEffect(() => {
    setRun(false);
    setTally(ZERO);
    setReplay(null);
    setReplayError(null);
    setReplayNum("");
    setLoading(false);
    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [blueId, redId, blueUpload, redUpload, setRun]);

  // Start creates the engine lazily on click (the @pkmn chunk is large — never gate the button
  // behind it). The button flips to running immediately; the loop begins once the chunk loads.
  const start = useCallback(async () => {
    setReplay(null);
    setReplayError(null);
    setRun(true);
    try {
      if (!controllerRef.current) {
        setLoading(true);
        const { AutoBattleController } = await import("../battle/lib/auto-engine");
        if (!aliveRef.current) return;
        if (!controllerRef.current) {
          // An uploaded team overrides that side's preset dropdown.
          const p1Team = blueUpload?.packed ?? teamById(blueId)?.packed;
          const p2Team = redUpload?.packed ?? teamById(redId)?.packed;
          if (!p1Team || !p2Team) {
            setRun(false);
            return;
          }
          controllerRef.current = new AutoBattleController({
            p1Team,
            p2Team,
            onUpdate: (t) => setTally(t),
          });
        }
      }
      if (runningRef.current) controllerRef.current.start(); // user may have hit Stop while loading
    } catch {
      setRun(false);
    } finally {
      setLoading(false);
    }
  }, [blueId, redId, blueUpload, redUpload, setRun]);

  const stop = useCallback(() => {
    const c = controllerRef.current;
    c?.stop();
    setRun(false);
    // Default the "view a battle" box to the most recent game so a click just works.
    if (c) {
      const t = c.getTally();
      if (t.replayMax != null) setReplayNum(String(t.replayMax));
    }
  }, [setRun]);

  const reset = useCallback(() => {
    setReplay(null);
    setReplayError(null);
    setReplayNum("");
    controllerRef.current?.reset();
  }, []);

  // Load battle `n` and render its play-by-play in the viewer. Shared by the manual box and the
  // winning-combination replay chips.
  const openReplay = useCallback((n: number) => {
    const c = controllerRef.current;
    if (!c || !Number.isFinite(n)) {
      setReplay(null);
      setReplayError("Enter a battle number.");
      return;
    }
    const g = c.getReplay(n);
    if (!g) {
      setReplay(null);
      const t = c.getTally();
      setReplayError(
        t.replayMin != null && t.replayMax != null
          ? `Battle #${n} isn't available — only battles ${t.replayMin.toLocaleString()}–${t.replayMax.toLocaleString()} are kept.`
          : `No battles have been played yet.`
      );
      return;
    }
    setReplayError(null);
    setReplayNum(String(n));
    setReplay({ n: g.n, result: g.result, frames: buildReplayFrames(g.lines) });
  }, []);

  const viewBattle = useCallback(() => openReplay(parseInt(replayNum, 10)), [replayNum, openReplay]);

  const blueName = uploadLabel(blueUpload) ?? teamById(blueId)?.name ?? "—";
  const redName = uploadLabel(redUpload) ?? teamById(redId)?.name ?? "—";
  const decided = tally.blue + tally.red;
  const bluePct = decided ? Math.round((tally.blue / decided) * 100) : 0;
  const redPct = decided ? 100 - bluePct : 0;

  return (
    <div className="auto-page">
      <h1 className="page-title">Auto Battle</h1>
      <p className="page-text">
        Two AIs play VGC 2026 Reg M-B. Every decision is a Monte Carlo search that looks ahead over
        a forked copy of the real battle simulator: it treats each simultaneous turn as a small game
        and plays a mixed strategy, averages over the luck, and works out when to Mega Evolve on its
        own — nothing about it is scripted. It runs deliberately slowly for accuracy, so games
        accumulate over time. Below the score are the two lead+back combinations Blue won the most
        with — click any win to watch that battle.
      </p>

      <div className="auto-teampick">
        <label className="auto-team-field auto-team-field--blue">
          <span className="auto-team-label">Blue team</span>
          <select
            className="auto-team-select"
            value={blueId}
            disabled={running || !!blueUpload}
            onChange={(e) => setBlueId(e.target.value)}
          >
            {REG_MB_TEAMS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <span className="auto-vs">vs</span>
        <label className="auto-team-field auto-team-field--red">
          <span className="auto-team-label">Red team</span>
          <select
            className="auto-team-select"
            value={redId}
            disabled={running || !!redUpload}
            onChange={(e) => setRedId(e.target.value)}
          >
            {REG_MB_TEAMS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="auto-uploads">
        <TeamUpload
          accent="blue"
          label="Blue"
          team={blueUpload}
          disabled={running}
          onLoad={setBlueUpload}
          onClear={() => setBlueUpload(null)}
        />
        <TeamUpload
          accent="red"
          label="Red"
          team={redUpload}
          disabled={running}
          onLoad={setRedUpload}
          onClear={() => setRedUpload(null)}
        />
      </div>

      <div className="auto-controls">
        <button
          className="battle-btn auto-btn--start"
          onClick={start}
          disabled={running || !blueId || !redId}
        >
          ▶ Start
        </button>
        <button className="battle-btn auto-btn--stop" onClick={stop} disabled={!running}>
          ■ Stop
        </button>
        <button
          className="battle-btn battle-btn--ghost"
          onClick={reset}
          disabled={running || tally.games === 0}
        >
          Reset
        </button>
        <span className={"auto-status" + (running ? " auto-status--on" : "")}>
          {running
            ? loading
              ? "starting…"
              : tally.turn
                ? `searching · turn ${tally.turn}`
                : "thinking…"
            : tally.games
              ? "stopped"
              : "idle"}
        </span>

        {!running && tally.replayMax != null && (
          <form
            className="auto-replay-pick"
            onSubmit={(e) => {
              e.preventDefault();
              viewBattle();
            }}
          >
            <label className="auto-replay-label" htmlFor="replay-num">
              Watch battle #
            </label>
            <input
              id="replay-num"
              className="auto-replay-input"
              type="number"
              inputMode="numeric"
              min={tally.replayMin ?? 1}
              max={tally.replayMax}
              value={replayNum}
              onChange={(e) => setReplayNum(e.target.value)}
              placeholder="#"
            />
            <button type="submit" className="battle-btn auto-replay-btn" disabled={!replayNum}>
              ▶ Watch
            </button>
          </form>
        )}
      </div>

      {tally.error && (
        <p className="auto-replay-error auto-plan-hint--center">Couldn&apos;t run this matchup: {tally.error}</p>
      )}

      {!running && tally.replayMax != null && (
        <p className="auto-replay-hint auto-plan-hint--center">
          Battles {(tally.replayMin ?? 0).toLocaleString()}–{tally.replayMax.toLocaleString()} are
          available to watch back.
        </p>
      )}
      {replayError && <p className="auto-replay-error">{replayError}</p>}
      {replay && <ReplayViewer replay={replay} blueName={blueName} redName={redName} />}

      {running && (
        <div className="auto-thinking">
          <span className="auto-thinking-dot" />
          <span className="auto-thinking-text">
            {blueName} vs {redName} — searching {tally.sims.toLocaleString()} sims per decision
            {tally.turn ? ` · game turn ${tally.turn}` : ""}. Games finish slowly; the tally grows as
            they complete.
          </span>
        </div>
      )}

      <div className="auto-scoreboard">
        <div className="auto-stat auto-stat--blue">
          <span className="auto-stat-label">Blue wins</span>
          <span className="auto-stat-value">{tally.blue.toLocaleString()}</span>
          <span className="auto-stat-sub">{bluePct}% of decided</span>
        </div>
        <div className="auto-stat auto-stat--red">
          <span className="auto-stat-label">Red wins</span>
          <span className="auto-stat-value">{tally.red.toLocaleString()}</span>
          <span className="auto-stat-sub">{redPct}% of decided</span>
        </div>
        <div className="auto-stat">
          <span className="auto-stat-label">Ties</span>
          <span className="auto-stat-value">{tally.ties.toLocaleString()}</span>
          <span className="auto-stat-sub">&nbsp;</span>
        </div>
        <div className="auto-stat">
          <span className="auto-stat-label">Games</span>
          <span className="auto-stat-value">{tally.games.toLocaleString()}</span>
          <span className="auto-stat-sub">&nbsp;</span>
        </div>
      </div>

      <TopCombos combos={tally.topCombos} blueName={blueName} onOpen={openReplay} />

      <p className="auto-note">
        A &quot;combination&quot; is a specific bring-4 split into a lead pair and a back pair; the two
        shown are the ones Blue won the most games with. Changing a team or pressing Reset clears the
        tally. Only the most recent 500 battles are stored, so some older wins may not be watchable.
      </p>
    </div>
  );
}

// Blue's top 2 winning combinations (a specific lead pair + back pair), each with clickable chips to
// watch the games it won. Ranked by number of wins.
function TopCombos({
  combos,
  blueName,
  onOpen,
}: {
  combos: ComboWin[];
  blueName: string;
  onOpen: (n: number) => void;
}) {
  if (!combos.length) {
    return (
      <p className="auto-note auto-plan-hint--center">
        Top winning combinations appear here once Blue wins a few games.
      </p>
    );
  }
  return (
    <div className="auto-combos">
      <div className="auto-combos-title">Top winning combinations · {blueName}</div>
      {combos.map((c, i) => {
        const missing = c.wins - c.replays.length;
        return (
          <div key={c.lead + "|" + c.back} className="auto-combo">
            <div className="auto-combo-head">
              <span className="auto-combo-rank">#{i + 1}</span>
              <span className="auto-combo-config">
                <span className="auto-combo-part">
                  <span className="auto-combo-part-label">Lead</span>
                  <ComboMons names={c.lead} />
                </span>
                <span className="auto-combo-part">
                  <span className="auto-combo-part-label">Back</span>
                  <ComboMons names={c.back} />
                </span>
              </span>
              <span className="auto-combo-record">
                won {c.wins.toLocaleString()} of {c.games.toLocaleString()}
              </span>
            </div>
            <div className="auto-combo-replays">
              {c.replays.length > 0 ? (
                <>
                  <span className="auto-combo-replays-label">Watch a win:</span>
                  {c.replays.slice(0, 12).map((n) => (
                    <button key={n} className="auto-combo-chip" onClick={() => onOpen(n)}>
                      #{n.toLocaleString()}
                    </button>
                  ))}
                  {missing > 0 && (
                    <span className="auto-combo-more">
                      +{missing.toLocaleString()} older win{missing === 1 ? "" : "s"} no longer stored
                    </span>
                  )}
                </>
              ) : (
                <span className="auto-combo-more">Its winning replays are no longer stored.</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ComboMons({ names }: { names: string }) {
  return (
    <span className="auto-combo-mons">
      {names.split(" + ").map((nm, i) => (
        <span key={i} className="auto-combo-mon">
          <UploadThumb name={nm} />
          {nm}
        </span>
      ))}
    </span>
  );
}

function UploadThumb({ name }: { name: string }) {
  const url = pokeThumb(name);
  if (!url) return null;
  return (
    <img
      className="mon-thumb"
      src={url}
      alt=""
      onError={(e) => {
        e.currentTarget.style.display = "none";
      }}
    />
  );
}

// Paste/upload a custom team for one side. A team is only accepted once it validates as Reg M-B
// legal; problems are shown and the team is not used until fixed. Reuses the Battle tab's import
// pipeline (pokepaste.ts) and the shared .custom-team / .ct-* styles.
function TeamUpload({
  accent,
  label,
  team,
  disabled,
  onLoad,
  onClear,
}: {
  accent: "blue" | "red";
  label: string;
  team: LoadedTeam | null;
  disabled: boolean;
  onLoad: (t: LoadedTeam) => void;
  onClear: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      setBusy(true);
      setError(null);
      setProblems([]);
      try {
        const { looksLikeUrl, fetchPokepaste, importTeamValidated } = await import(
          "../battle/lib/pokepaste"
        );
        const raw = looksLikeUrl(trimmed) ? await fetchPokepaste(trimmed) : trimmed;
        const res = importTeamValidated(raw, FORMATS.vgcregmb.engineFormat);
        if (!res) {
          setError("Couldn't read a team from that — check the paste or export text.");
          return;
        }
        if (res.problems.length) {
          setProblems(res.problems);
          return; // not accepted until legal
        }
        onLoad({ packed: res.packed, species: res.species });
        setText("");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load that team.");
      } finally {
        setBusy(false);
      }
    },
    [onLoad]
  );

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const t = String(reader.result || "");
      setText(t);
      void load(t);
    };
    reader.readAsText(file);
  };

  if (team) {
    return (
      <aside className={"custom-team-panel auto-upload auto-upload--" + accent}>
        <div className="ct-title">{label} — uploaded team</div>
        <ul className="ct-list">
          {team.species.map((s, i) => (
            <li key={i}>
              <UploadThumb name={s} />
              <span>{s}</span>
            </li>
          ))}
        </ul>
        <button className="battle-btn battle-btn--ghost" disabled={disabled} onClick={onClear}>
          Clear (use preset)
        </button>
      </aside>
    );
  }

  return (
    <aside className={"custom-team-panel auto-upload auto-upload--" + accent}>
      <div className="ct-title">{label} — upload a team</div>
      <textarea
        className="ct-input"
        rows={3}
        placeholder="Paste a PokePaste URL — or the team's export text"
        value={text}
        disabled={disabled || busy}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="auto-upload-actions">
        <button className="battle-btn" disabled={disabled || busy || !text.trim()} onClick={() => load(text)}>
          {busy ? "Loading…" : "Load team"}
        </button>
        <button
          type="button"
          className="battle-btn battle-btn--ghost"
          disabled={disabled || busy}
          onClick={() => fileRef.current?.click()}
        >
          Upload .txt
        </button>
        <input ref={fileRef} type="file" accept=".txt,.text,text/plain" hidden onChange={onFile} />
      </div>
      <p className="ct-note">Must be Reg M-B legal (66-EV budget, no Restricted Legendaries). Overrides the {label} dropdown.</p>
      {error && <p className="ct-error">{error}</p>}
      {problems.length > 0 && (
        <div className="ct-error auto-upload-problems">
          <div>Not Reg M-B legal — fix and reload:</div>
          <ul>
            {problems.slice(0, 6).map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

// A visual, turn-by-turn replay of one stored battle — the Battle-tab board look, with the only
// controls being turn navigation (Prev / slider / Next). Blue is p1 (near side), Red is p2 (foe).
function ReplayViewer({
  replay,
  blueName,
  redName,
}: {
  replay: Replay;
  blueName: string;
  redName: string;
}) {
  const [idx, setIdx] = useState(0);

  // Snap back to the lead whenever a different battle is loaded.
  useEffect(() => {
    setIdx(0);
  }, [replay]);

  const frames = replay.frames;
  const last = frames.length - 1;
  const clamped = Math.min(idx, last);
  const frame = frames[clamped];
  const winner =
    replay.result === "blue"
      ? `🏆 ${blueName} (Blue) won`
      : replay.result === "red"
        ? `🏆 ${redName} (Red) won`
        : "The battle ended in a tie";

  if (!frame) return null;
  const turnLabel = frame.turn === 0 ? "Lead" : `Turn ${frame.turn}`;

  return (
    <div className="auto-viewer">
      <div className="auto-viewer-head">
        <span className="auto-viewer-title">Battle #{replay.n.toLocaleString()}</span>
        <span className="auto-viewer-result">{winner}</span>
      </div>

      <div className="auto-viewer-board">
        <ReplayRoster label={`Red · ${redName}`} accent="red" mons={frame.red} />
        <ReplayField board={frame.board} side="p2" label="Red" foe />
        <ReplayField board={frame.board} side="p1" label="Blue" />
        <ReplayRoster label={`Blue · ${blueName}`} accent="blue" mons={frame.blue} />
      </div>

      <div className="auto-viewer-nav">
        <button
          className="battle-btn battle-btn--ghost"
          onClick={() => setIdx((i) => Math.max(0, Math.min(i, last) - 1))}
          disabled={clamped === 0}
        >
          ◀ Prev
        </button>
        <input
          className="auto-viewer-slider"
          type="range"
          min={0}
          max={last}
          value={clamped}
          onChange={(e) => setIdx(Number(e.target.value))}
          aria-label="Turn"
        />
        <span className="auto-viewer-turn">
          {turnLabel} <span className="auto-viewer-turn-of">/ {frames[last].turn}</span>
        </span>
        <button
          className="battle-btn battle-btn--ghost"
          onClick={() => setIdx((i) => Math.min(last, Math.min(i, last) + 1))}
          disabled={clamped === last}
        >
          Next ▶
        </button>
      </div>

      <div className="battle-log auto-viewer-log" aria-live="polite">
        <div className="battle-log-line battle-log-line--turn">— {turnLabel} —</div>
        {frame.events
          .filter((e) => e.kind !== "turn")
          .map((e, i) => (
            <div
              key={i}
              className={"battle-log-line" + (e.kind === "result" ? " battle-log-line--turn" : "")}
            >
              {e.text}
            </div>
          ))}
        {frame.events.length === 0 && <div className="battle-log-line">The battle begins.</div>}
      </div>
    </div>
  );
}

function ReplayField({
  board,
  side,
  label,
  foe,
}: {
  board: BoardState;
  side: "p1" | "p2";
  label: string;
  foe?: boolean;
}) {
  // Each card is pinned to its battle slot (a = 0, b = 1), so a Pokémon never changes screen
  // position until it switches out or faints. The foe's row is mirrored (slot b, then a) to match
  // the standard Showdown doubles layout, where the opponent's slot-a sits on the right.
  const order = foe ? [1, 0] : [0, 1];
  return (
    <div className="field-side field-side--doubles">
      {order.map((i) => (
        <ReplayMonCard key={i} mon={board[side][i]} sideLabel={label} foe={foe} />
      ))}
    </div>
  );
}

function ReplayMonCard({
  mon,
  sideLabel,
  foe,
}: {
  mon: ActiveMon | null;
  sideLabel: string;
  foe?: boolean;
}) {
  const sprite = mon && !mon.fainted ? pokeSprite(mon.name, !!foe) : null;
  return (
    <div className={"mon-card" + (foe ? " mon-card--foe" : "")}>
      {sprite && (
        <img
          className="mon-sprite"
          src={sprite.url}
          alt={mon?.name ?? ""}
          width={sprite.w}
          height={sprite.h}
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}
      <div className="mon-body">
        <div className="mon-card-head">
          <span className="mon-side">{sideLabel}</span>
          <span className="mon-name">{mon ? mon.name : "—"}</span>
          {mon?.status && <span className="mon-status">{mon.status.toUpperCase()}</span>}
        </div>
        <div className="mon-item">{mon?.item ? `@ ${mon.item}` : " "}</div>
        <div className="hp-bar">
          <div
            className={
              "hp-fill" +
              (mon && mon.hpPct <= 20 ? " hp-fill--low" : mon && mon.hpPct <= 50 ? " hp-fill--mid" : "")
            }
            style={{ width: `${mon ? mon.hpPct : 0}%` }}
          />
        </div>
        <div className="hp-label">{mon ? (mon.fainted ? "Fainted" : `${mon.hpPct}%`) : ""}</div>
      </div>
    </div>
  );
}

function ReplayRoster({
  label,
  accent,
  mons,
}: {
  label: string;
  accent: "blue" | "red";
  mons: RosterEntry[];
}) {
  if (!mons.length) return null;
  const alive = mons.filter((m) => !m.fainted).length;
  return (
    <div className={"roster-tray roster-tray--" + accent}>
      <span className="roster-label">
        {label}{" "}
        <span className="roster-count">
          {alive}/{mons.length}
        </span>
      </span>
      <div className="roster-mons">
        {mons.map((m, i) => {
          const url = pokeThumb(m.name);
          return (
            <span
              key={i}
              className={"roster-mon" + (m.fainted ? " roster-mon--fainted" : "")}
              title={m.fainted ? `${m.name} (fainted)` : m.name}
            >
              {url && (
                <img
                  className="mon-thumb"
                  src={url}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              )}
              <span className="roster-mon-name">{m.name}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

