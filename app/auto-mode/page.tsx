"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoBattleController, ComboStat, GameResult, Tally } from "../battle/lib/auto-engine";
import { buildReplayFrames, type ReplayFrame, type RosterEntry } from "../battle/lib/auto-replay";
import type { ActiveMon, BoardState } from "../battle/lib/protocol";
import { encodePlan } from "../battle/lib/game-plan";
import { pokeSprite, pokeThumb } from "../battle/lib/sprites";
import { REG_MB_TEAMS, teamById } from "../battle/lib/reg-mb-teams";

interface Replay {
  n: number;
  result: GameResult;
  frames: ReplayFrame[];
}

// Blue needs a reasonable sample before its game plan is worth generating.
const MIN_PLAN_GAMES = 20;

const ZERO: Tally = {
  blue: 0,
  red: 0,
  ties: 0,
  games: 0,
  searching: false,
  turn: 0,
  sims: 0,
  topBlue: [],
  topRed: [],
  replayMin: null,
  replayMax: null,
};

const DEFAULT_BLUE = REG_MB_TEAMS[0]?.id ?? "";
const DEFAULT_RED = (REG_MB_TEAMS[1] ?? REG_MB_TEAMS[0])?.id ?? "";

export default function AutoMode() {
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false); // engine chunk loading on the first Start
  const [tally, setTally] = useState<Tally>(ZERO);
  const [blueId, setBlueId] = useState(DEFAULT_BLUE);
  const [redId, setRedId] = useState(DEFAULT_RED);
  const [planUrl, setPlanUrl] = useState<string | null>(null);
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

  // The controller stays alive across Stop/Start so power/learning persist (they must only ever
  // ramp up). Changing a team (or unmounting) tears it down; a fresh one is built on next Start.
  useEffect(() => {
    setRun(false);
    setTally(ZERO);
    setPlanUrl(null);
    setReplay(null);
    setReplayError(null);
    setReplayNum("");
    setLoading(false);
    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [blueId, redId, setRun]);

  // Start creates the engine lazily on click (the @pkmn chunk is large — never gate the button
  // behind it). The button flips to running immediately; the loop begins once the chunk loads.
  const start = useCallback(async () => {
    setPlanUrl(null);
    setReplay(null);
    setReplayError(null);
    setRun(true);
    try {
      if (!controllerRef.current) {
        setLoading(true);
        const { AutoBattleController } = await import("../battle/lib/auto-engine");
        if (!aliveRef.current) return;
        if (!controllerRef.current) {
          const p1Team = teamById(blueId)?.packed;
          const p2Team = teamById(redId)?.packed;
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
  }, [blueId, redId, setRun]);

  const stop = useCallback(() => {
    const c = controllerRef.current;
    c?.stop();
    setRun(false);
    // Generate Blue's game plan from the run so far and expose the flowchart link.
    if (c) {
      const plan = c.bluePlan(teamById(blueId)?.name ?? "Blue", teamById(redId)?.name ?? "Red");
      setPlanUrl(plan.games >= MIN_PLAN_GAMES ? `/auto-mode/plan?d=${encodePlan(plan)}` : null);
      // Default the "view a battle" box to the most recent game so a click just works.
      const t = c.getTally();
      if (t.replayMax != null) setReplayNum(String(t.replayMax));
    }
  }, [blueId, redId, setRun]);

  const reset = useCallback(() => {
    setPlanUrl(null);
    setReplay(null);
    setReplayError(null);
    setReplayNum("");
    controllerRef.current?.reset();
  }, []);

  // Look up the typed battle number and render its play-by-play.
  const viewBattle = useCallback(() => {
    const c = controllerRef.current;
    const n = parseInt(replayNum, 10);
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
    setReplay({ n: g.n, result: g.result, frames: buildReplayFrames(g.lines) });
  }, [replayNum]);

  const blueName = teamById(blueId)?.name ?? "—";
  const redName = teamById(redId)?.name ?? "—";
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
        accumulate over time. It keeps a running tally, and below the score each side&apos;s top
        winning 4-of-6 selections are labeled.
      </p>

      <div className="auto-teampick">
        <label className="auto-team-field auto-team-field--blue">
          <span className="auto-team-label">Blue team</span>
          <select
            className="auto-team-select"
            value={blueId}
            disabled={running}
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
            disabled={running}
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

      {!running && tally.replayMax != null && (
        <p className="auto-replay-hint auto-plan-hint--center">
          Battles {(tally.replayMin ?? 0).toLocaleString()}–{tally.replayMax.toLocaleString()} are
          available to watch back.
        </p>
      )}
      {replayError && <p className="auto-replay-error">{replayError}</p>}
      {replay && <ReplayViewer replay={replay} blueName={blueName} redName={redName} />}

      {!running && planUrl && (
        <div className="auto-plan-cta">
          <Link className="battle-btn auto-plan-link" href={planUrl} target="_blank" rel="noopener noreferrer">
            🧭 View Blue&apos;s game plan →
          </Link>
          <span className="auto-plan-hint">Opens a shareable flowchart of how Blue played this matchup.</span>
        </div>
      )}
      {!running && !planUrl && tally.games > 0 && tally.games < MIN_PLAN_GAMES && (
        <p className="auto-plan-hint auto-plan-hint--center">
          Run at least {MIN_PLAN_GAMES} games, then Stop to generate Blue&apos;s game plan.
        </p>
      )}

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

      <div className="auto-leads">
        <WinColumn title={`Blue — top winning picks · ${blueName}`} accent="blue" combos={tally.topBlue} />
        <WinColumn title={`Red — top winning picks · ${redName}`} accent="red" combos={tally.topRed} />
      </div>

      <p className="auto-note">
        The search chooses which 4 of 6 to bring, so each side converges on its strongest selections;
        the columns show that side&apos;s top selections by win rate (with wins/games), among picks
        with at least {MIN_GAMES} games so the rates mean something. Changing a team or pressing Reset
        clears the tally and starts over.
      </p>
    </div>
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

// A selection needs at least this many games before its win rate is trusted enough to rank.
const MIN_GAMES = 10;

function WinColumn({
  title,
  accent,
  combos,
}: {
  title: string;
  accent: "blue" | "red";
  combos: ComboStat[];
}) {
  // combos arrive sorted by win rate; keep only well-sampled ones, then label the top 3.
  const top = combos.filter((c) => c.games >= MIN_GAMES).slice(0, 3);
  const best = combos.reduce((m, c) => Math.max(m, c.games), 0); // progress toward the threshold
  return (
    <div className={"auto-lead-col auto-lead-col--" + accent}>
      <div className="auto-lead-title">{title}</div>
      {top.length === 0 ? (
        <p className="auto-lead-empty">
          Gathering data — each pick needs {MIN_GAMES.toLocaleString()}+ games
          {best ? ` (best so far: ${best.toLocaleString()})` : ""}.
        </p>
      ) : (
        <ol className="auto-lead-list">
          {top.map((c) => (
            <li key={c.combo} className="auto-lead-row">
              <span className="auto-lead-combo">{c.combo}</span>
              <span className="auto-lead-count">
                {c.games ? `${Math.round((c.wins / c.games) * 100)}%` : "—"}
                {c.games ? ` · ${c.wins.toLocaleString()}/${c.games.toLocaleString()}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
