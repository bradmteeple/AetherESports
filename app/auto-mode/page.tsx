"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AutoBattleController,
  ComboWin,
  GameResult,
  OpponentProgress,
  Tally,
} from "../battle/lib/auto-engine";
import { buildReplayFrames, type ReplayFrame, type RosterEntry } from "../battle/lib/auto-replay";
import type { ActiveMon, BoardState } from "../battle/lib/protocol";
import { pokeSprite, pokeThumb } from "../battle/lib/sprites";
import { REG_MB_TEAMS, teamById } from "../battle/lib/reg-mb-teams";
import { FORMATS } from "../battle/lib/formats";
import type { LoadedTeam } from "../battle/lib/pokepaste";
import type { RunMode } from "../battle/lib/mcts-worker";
import {
  clearLibrary,
  exportLibrary,
  getGame,
  libraryAvailable,
  listGames,
  teamKey,
  LIBRARY_CAP,
  type GameSummary,
} from "../battle/lib/training-store";
import {
  buildPlaybook,
  libraryTotals,
  MIN_SUPPORT,
  type ComboStat,
  type OpponentPlaybook,
} from "../battle/lib/playbook";

// A battle open in the viewer — either one from this run's rolling window or one loaded back out of
// the stored library, so both sources render through the same component.
interface Replay {
  label: string; // "Battle #12" / "Saved game #340"
  result: GameResult;
  blueName: string;
  redName: string;
  frames: ReplayFrame[];
}

// How many stored games the library panel lists under "recent games".
const RECENT_SHOWN = 12;

// One opponent in the gauntlet roster the user is building (a preset or a custom upload).
interface Opponent {
  id: string; // stable key: a preset id or a generated custom id
  name: string;
  packed: string;
  custom: boolean;
}

const ZERO: Tally = {
  blue: 0,
  red: 0,
  ties: 0,
  games: 0,
  roster: [],
  currentIndex: 0,
  complete: false,
  searching: false,
  turn: 0,
  sims: 0,
  topCombos: [],
  focusId: null,
  replayMin: null,
  replayMax: null,
  error: null,
  mode: "training",
  saved: 0,
  libraryError: null,
};

const DEFAULT_BLUE = REG_MB_TEAMS[0]?.id ?? "";

// A short label for an uploaded team, or null when a side uses its preset dropdown.
function uploadLabel(team: LoadedTeam | null): string | null {
  if (!team) return null;
  const shown = team.species.slice(0, 2).join(" / ");
  return `Custom · ${shown}${team.species.length > 2 ? "…" : ""}`;
}

// The gauntlet starts with every preset except Blue's default team, in registry order.
const DEFAULT_OPPONENTS: Opponent[] = REG_MB_TEAMS.filter((t) => t.id !== DEFAULT_BLUE).map((t) => ({
  id: t.id,
  name: t.name,
  packed: t.packed,
  custom: false,
}));

export default function AutoMode() {
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false); // engine chunk loading on the first Start
  const [tally, setTally] = useState<Tally>(ZERO);
  const [blueId, setBlueId] = useState(DEFAULT_BLUE);
  const [blueUpload, setBlueUpload] = useState<LoadedTeam | null>(null); // uploaded team overrides preset
  const [opponents, setOpponents] = useState<Opponent[]>(DEFAULT_OPPONENTS); // the ordered roster
  const [mode, setMode] = useState<RunMode>("training"); // train across the field, or run the gauntlet
  const [rotateEvery, setRotateEvery] = useState(1); // training: games per opponent before rotating
  const [persist, setPersist] = useState(true); // save finished games to the library
  const [focusId, setFocusId] = useState<string | null>(null); // opponent the combos panel reflects
  const [replayNum, setReplayNum] = useState<string>(""); // the battle number typed in
  const [replay, setReplay] = useState<Replay | null>(null); // the battle currently shown
  const [replayError, setReplayError] = useState<string | null>(null);
  const controllerRef = useRef<AutoBattleController | null>(null);
  const runningRef = useRef(false); // mirrors `running` for async guards
  const aliveRef = useRef(true);
  const customCounter = useRef(0); // gives each custom-uploaded opponent a stable, unique id

  // Stored-game library: what's on disk for the current filter, plus the derived playbook.
  const [libGames, setLibGames] = useState<GameSummary[]>([]);
  const [libScope, setLibScope] = useState<"team" | "all">("team"); // this Blue team, or everything
  const [libBusy, setLibBusy] = useState(false);
  const [libError, setLibError] = useState<string | null>(null);
  const syncedAt = useRef(0); // tally.saved at the last mid-run library refresh

  const setRun = useCallback((v: boolean) => {
    runningRef.current = v;
    setRunning(v);
  }, []);

  // A stable string key over the roster (ids, in order) so the teardown effect only fires on a real
  // roster change — not on every render's new array identity.
  const rosterKey = opponents.map((o) => o.id).join(",");

  // Blue's packed team (an upload overrides the preset), its display name, and its stable library
  // identity. Declared before the callbacks below so they can list them as dependencies.
  const bluePacked = blueUpload?.packed ?? teamById(blueId)?.packed ?? "";
  const blueKey = bluePacked ? teamKey(bluePacked) : "";
  const blueName = uploadLabel(blueUpload) ?? teamById(blueId)?.name ?? "—";

  // Track mount so an in-flight engine import can bail if we've unmounted.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // If the worker reports it can't run a matchup, stop the UI's running state too.
  useEffect(() => {
    if (tally.error) setRun(false);
  }, [tally.error, setRun]);

  // The controller stays alive across Stop/Start so a run resumes where it left off. Changing Blue's
  // team, the run mode/rotation, or the roster (or unmounting) tears it down; a fresh one is built on
  // Start. The stored library is untouched by any of this — it's the point of saving games.
  useEffect(() => {
    setRun(false);
    setTally(ZERO);
    setReplay(null);
    setReplayError(null);
    setReplayNum("");
    setFocusId(null);
    setLoading(false);
    return () => {
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [blueId, blueUpload, rosterKey, mode, rotateEvery, persist, setRun]);

  // Read the stored library for the current filter. Called on mount, whenever the filter changes,
  // when a run stops, and periodically mid-run so the playbook fills in as games are banked.
  const refreshLibrary = useCallback(async () => {
    if (!libraryAvailable()) return;
    setLibBusy(true);
    try {
      const rows = await listGames(libScope === "team" && blueKey ? { blueKey } : {});
      if (!aliveRef.current) return;
      setLibGames(rows);
      setLibError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      setLibError(e instanceof Error ? e.message : "Couldn't read the stored games.");
    } finally {
      if (aliveRef.current) setLibBusy(false);
    }
  }, [blueKey, libScope]);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary, running]); // `running` flipping false re-reads what the run just banked

  // Mid-run top-up: re-read after every 10 games saved, so a long training session's playbook keeps
  // pace without hammering storage on every single game.
  useEffect(() => {
    if (!running) {
      syncedAt.current = tally.saved;
      return;
    }
    if (tally.saved - syncedAt.current >= 10) {
      syncedAt.current = tally.saved;
      void refreshLibrary();
    }
  }, [tally.saved, running, refreshLibrary]);

  const addCustomOpponent = useCallback((team: LoadedTeam) => {
    customCounter.current += 1;
    const id = `custom-${customCounter.current}`;
    setOpponents((prev) => [
      ...prev,
      { id, name: uploadLabel(team) ?? "Custom team", packed: team.packed, custom: true },
    ]);
  }, []);

  // Start creates the engine lazily on click (the @pkmn chunk is large — never gate the button
  // behind it). The button flips to running immediately; the loop begins once the chunk loads.
  const start = useCallback(async () => {
    setReplay(null);
    setReplayError(null);
    // A finished gauntlet re-runs from the top when Start is pressed again.
    if (controllerRef.current && tally.complete) controllerRef.current.reset();
    setRun(true);
    try {
      if (!controllerRef.current) {
        setLoading(true);
        const { AutoBattleController } = await import("../battle/lib/auto-engine");
        if (!aliveRef.current) return;
        if (!controllerRef.current) {
          const roster = opponents.map(({ id, name, packed }) => ({ id, name, packed }));
          if (!bluePacked || roster.length === 0) {
            setRun(false);
            return;
          }
          controllerRef.current = new AutoBattleController({
            p1Team: bluePacked,
            roster,
            mode,
            rotateEvery,
            blueName,
            persist,
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
  }, [bluePacked, blueName, opponents, mode, rotateEvery, persist, tally.complete, setRun]);

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
    setFocusId(null);
    controllerRef.current?.reset();
  }, []);

  // Point the combos panel at a specific opponent.
  const focusOpponent = useCallback((id: string) => {
    setFocusId(id);
    controllerRef.current?.setFocus(id);
  }, []);

  // Load battle `n` from this run's rolling window and render its play-by-play. Shared by the manual
  // box and the winning-combination replay chips.
  const openReplay = useCallback(
    (n: number) => {
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
            ? `Battle #${n} isn't available in this run — only battles ${t.replayMin.toLocaleString()}–${t.replayMax.toLocaleString()} are kept in memory. Saved games are below.`
            : `No battles have been played yet.`
        );
        return;
      }
      setReplayError(null);
      setReplayNum(String(n));
      setReplay({
        label: `Battle #${g.n.toLocaleString()}`,
        result: g.result,
        blueName,
        redName: c.opponentName(g.opponentId) ?? "Red",
        frames: buildReplayFrames(g.lines),
      });
    },
    [blueName]
  );

  // Load a game back out of the stored library — these survive a refresh, a team change, and the
  // in-memory window's eviction, so they're what the playbook links to.
  const openStored = useCallback(async (id: number) => {
    try {
      const g = await getGame(id);
      if (!aliveRef.current) return;
      if (!g) {
        setReplay(null);
        setReplayError(`Saved game #${id} is no longer stored.`);
        return;
      }
      setReplayError(null);
      setReplay({
        label: `Saved game #${g.id.toLocaleString()} · ${new Date(g.ts).toLocaleString()}`,
        result: g.result,
        blueName: g.blueName,
        redName: g.opponentName,
        frames: buildReplayFrames(g.lines),
      });
    } catch (e) {
      if (!aliveRef.current) return;
      setReplay(null);
      setReplayError(e instanceof Error ? e.message : "Couldn't open that saved game.");
    }
  }, []);

  const viewBattle = useCallback(() => openReplay(parseInt(replayNum, 10)), [replayNum, openReplay]);

  // Download the filtered library as JSON, so a training session's evidence can leave the browser.
  const exportGames = useCallback(async () => {
    setLibBusy(true);
    try {
      const json = await exportLibrary(libScope === "team" && blueKey ? { blueKey } : {});
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `aether-training-${libScope === "team" ? blueKey : "all"}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setLibError(e instanceof Error ? e.message : "Couldn't export the stored games.");
    } finally {
      if (aliveRef.current) setLibBusy(false);
    }
  }, [blueKey, libScope]);

  // Deleting stored games is irreversible, so it always asks first.
  const wipeLibrary = useCallback(async () => {
    const scoped = libScope === "team" && blueKey;
    const what = scoped ? `the ${libGames.length} game(s) saved for ${blueName}` : "every saved game";
    if (!window.confirm(`Delete ${what}? This can't be undone.`)) return;
    setLibBusy(true);
    try {
      await clearLibrary(scoped ? blueKey : undefined);
      await refreshLibrary();
    } catch (e) {
      setLibError(e instanceof Error ? e.message : "Couldn't clear the stored games.");
    } finally {
      if (aliveRef.current) setLibBusy(false);
    }
  }, [blueKey, blueName, libGames.length, libScope, refreshLibrary]);

  // The reference for optimal play, recomputed from whatever the library filter currently holds.
  const playbook = useMemo(() => buildPlaybook(libGames), [libGames]);
  const totals = useMemo(() => libraryTotals(libGames), [libGames]);

  const currentName = tally.roster[tally.currentIndex]?.name ?? "—";
  const focusName = tally.roster.find((o) => o.id === tally.focusId)?.name ?? "";
  const decided = tally.blue + tally.red;
  const bluePct = decided ? Math.round((tally.blue / decided) * 100) : 0;
  const redPct = decided ? 100 - bluePct : 0;

  return (
    <div className="auto-page">
      <h1 className="page-title">Auto Battle</h1>
      <p className="page-text">
        Blue faces a roster of opponents. Every decision is a Monte Carlo search that looks ahead over
        a forked copy of the real battle simulator — mixed strategies, averaged luck, and Mega timing
        worked out on its own; nothing is scripted.{" "}
        {mode === "training" ? (
          <>
            In <strong>Training</strong>, Blue rotates through the whole roster — {rotateEvery} game
            {rotateEvery === 1 ? "" : "s"} against each team, round-robin, for as long as you leave it
            running — so evidence builds against every opponent instead of piling up on the first team
            that blocks a gauntlet. Every game is saved below and mined into a playbook: which four to
            bring, which two to lead, and the games that back it up.
          </>
        ) : (
          <>
            In <strong>Gauntlet</strong>, Blue keeps playing one opponent until it <em>dominantly</em>{" "}
            wins — 95%-confident (Wilson score) that its true win rate over decided games is above 60%,
            over at least 15 decided games — then advances to the next team. A stuck matchup (like a
            mirror) plays on until you press Stop.
          </>
        )}{" "}
        It runs deliberately slowly for accuracy. Click any winning combination below to watch that
        battle.
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
      </div>

      <div className="auto-modebar">
        <div className="auto-mode-group" role="group" aria-label="Run mode">
          <button
            className={"auto-mode-btn" + (mode === "training" ? " auto-mode-btn--on" : "")}
            onClick={() => setMode("training")}
            disabled={running}
          >
            🎯 Training
            <span className="auto-mode-sub">rotate through every team</span>
          </button>
          <button
            className={"auto-mode-btn" + (mode === "gauntlet" ? " auto-mode-btn--on" : "")}
            onClick={() => setMode("gauntlet")}
            disabled={running}
          >
            🏆 Gauntlet
            <span className="auto-mode-sub">beat each in order</span>
          </button>
        </div>

        {mode === "training" && (
          <label className="auto-mode-field">
            <span className="auto-team-label">Games per team before rotating</span>
            <select
              className="auto-team-select"
              value={rotateEvery}
              disabled={running}
              onChange={(e) => setRotateEvery(Number(e.target.value))}
            >
              {[1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="auto-mode-check" title="Finished games are stored in this browser">
          <input
            type="checkbox"
            checked={persist}
            disabled={running || !libraryAvailable()}
            onChange={(e) => setPersist(e.target.checked)}
          />
          <span>Save games to the library</span>
        </label>
      </div>

      <RosterBuilder
        opponents={opponents}
        setOpponents={setOpponents}
        disabled={running}
        mode={mode}
        onAddCustom={addCustomOpponent}
      />

      <div className="auto-controls">
        <button
          className="battle-btn auto-btn--start"
          onClick={start}
          disabled={running || !blueId || opponents.length === 0}
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
            : tally.complete
              ? "complete"
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
      {tally.libraryError && (
        <p className="auto-replay-error auto-plan-hint--center">
          Games aren&apos;t being saved: {tally.libraryError}
        </p>
      )}
      {replayError && <p className="auto-replay-error">{replayError}</p>}
      {replay && <ReplayViewer replay={replay} />}

      {running && (
        <div className="auto-thinking">
          <span className="auto-thinking-dot" />
          <span className="auto-thinking-text">
            {blueName} vs {currentName} — searching {tally.sims.toLocaleString()} sims per decision
            {tally.turn ? ` · game turn ${tally.turn}` : ""}. Games finish slowly;{" "}
            {mode === "training"
              ? `Blue rotates to the next team every ${rotateEvery} game${rotateEvery === 1 ? "" : "s"}.`
              : "Blue advances only once it dominantly wins."}
            {persist ? ` ${tally.saved.toLocaleString()} saved this run.` : ""}
          </span>
        </div>
      )}

      <RosterProgress
        roster={tally.roster}
        complete={tally.complete}
        focusId={tally.focusId}
        mode={mode}
        onFocus={focusOpponent}
      />

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

      <TopCombos combos={tally.topCombos} blueName={blueName} focusName={focusName} onOpen={openReplay} />

      <p className="auto-note">
        A &quot;combination&quot; is a specific bring-4 split into a lead pair and a back pair; the two
        shown are the ones Blue won the most games with against the selected opponent in{" "}
        <em>this run</em> — click an opponent above to inspect its combinations. Editing the roster or
        pressing Reset clears the tally (never the saved library). Only the most recent 500 battles of
        a run stay in memory; saved games below outlive it.
      </p>

      <TrainingLibrary
        games={libGames}
        playbook={playbook}
        totals={totals}
        scope={libScope}
        onScope={setLibScope}
        blueName={blueName}
        busy={libBusy}
        error={libError}
        onRefresh={refreshLibrary}
        onExport={exportGames}
        onClear={wipeLibrary}
        onOpen={openStored}
      />
    </div>
  );
}

// The opponent roster the run works through, in order. Presets are toggled on/off; custom teams are
// uploaded (and validated as Reg M-B legal by TeamUpload) and added as extra opponents. Order is the
// gauntlet sequence — or the training rotation — adjustable with the up/down controls.
function RosterBuilder({
  opponents,
  setOpponents,
  disabled,
  mode,
  onAddCustom,
}: {
  opponents: Opponent[];
  setOpponents: React.Dispatch<React.SetStateAction<Opponent[]>>;
  disabled: boolean;
  mode: RunMode;
  onAddCustom: (team: LoadedTeam) => void;
}) {
  const inRoster = (id: string) => opponents.some((o) => o.id === id);
  const togglePreset = (t: { id: string; name: string; packed: string }) => {
    setOpponents((prev) =>
      prev.some((o) => o.id === t.id)
        ? prev.filter((o) => o.id !== t.id)
        : [...prev, { id: t.id, name: t.name, packed: t.packed, custom: false }]
    );
  };
  const move = (i: number, dir: -1 | 1) => {
    setOpponents((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const remove = (id: string) => setOpponents((prev) => prev.filter((o) => o.id !== id));

  return (
    <div className="auto-roster-build">
      <div className="auto-roster-title">
        {mode === "training"
          ? "Opponent roster · Blue trains against each in rotation"
          : "Opponent roster · Blue must dominantly beat each in order"}
      </div>

      {opponents.length === 0 ? (
        <p className="auto-note auto-plan-hint--center">
          Add at least one opponent — check a preset below or upload a custom team.
        </p>
      ) : (
        <ol className="auto-roster-list">
          {opponents.map((o, i) => (
            <li key={o.id} className="auto-roster-row">
              <span className="auto-roster-order">{i + 1}</span>
              <span className="auto-roster-name">
                {o.name}
                {o.custom && <span className="auto-roster-tag">custom</span>}
              </span>
              <span className="auto-roster-actions">
                <button
                  className="battle-btn battle-btn--ghost auto-roster-mini"
                  disabled={disabled || i === 0}
                  onClick={() => move(i, -1)}
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  className="battle-btn battle-btn--ghost auto-roster-mini"
                  disabled={disabled || i === opponents.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  className="battle-btn battle-btn--ghost auto-roster-mini"
                  disabled={disabled}
                  onClick={() => remove(o.id)}
                  aria-label="Remove"
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="auto-roster-presets">
        {REG_MB_TEAMS.map((t) => (
          <label key={t.id} className="auto-roster-check">
            <input
              type="checkbox"
              checked={inRoster(t.id)}
              disabled={disabled}
              onChange={() => togglePreset(t)}
            />
            <span>{t.name}</span>
          </label>
        ))}
      </div>

      <div className="auto-uploads">
        <TeamUpload
          accent="red"
          label="opponent"
          team={null}
          disabled={disabled}
          onLoad={onAddCustom}
          onClear={() => {}}
          titleText="Add a custom opponent"
          ctaText="Add opponent"
          noteText="Must be Reg M-B legal (66-EV budget, no Restricted Legendaries). Adds one opponent to the roster."
        />
      </div>
    </div>
  );
}

// The standings: each opponent's record, its Wilson win-rate floor against the 60% bar, and its
// status. Click a row to point the winning-combinations panel at that opponent. In training, "beaten"
// is a read-out (Blue clears the bar right now) rather than a step the run has passed.
function RosterProgress({
  roster,
  complete,
  focusId,
  mode,
  onFocus,
}: {
  roster: OpponentProgress[];
  complete: boolean;
  focusId: string | null;
  mode: RunMode;
  onFocus: (id: string) => void;
}) {
  if (!roster.length) return null;
  const beaten = roster.filter((o) => o.beaten).length;
  return (
    <div className="auto-progress">
      <div className="auto-progress-title">
        {mode === "training"
          ? `Training rotation · dominant vs ${beaten} of ${roster.length}`
          : `Gauntlet · beaten ${beaten} of ${roster.length}`}
      </div>
      {complete && (
        <div className="auto-complete">
          🏆 Gauntlet complete — Blue dominantly beat all {roster.length} opponents.
        </div>
      )}
      {roster.map((o) => {
        const pct = Math.round(o.lowerBound * 100);
        const cls =
          "auto-opp" +
          (o.status === "current" ? " auto-opp--current" : "") +
          (o.status === "beaten" ? " auto-opp--beaten" : "") +
          (o.id === focusId ? " auto-opp--focus" : "");
        return (
          <button key={o.id} className={cls} onClick={() => onFocus(o.id)}>
            <span className="auto-opp-name">{o.name}</span>
            <span className="auto-opp-record">
              {o.blue}–{o.red}
              {o.ties ? ` · ${o.ties} tie${o.ties === 1 ? "" : "s"}` : ""}
            </span>
            <span className="auto-opp-wilson" title="Wilson 95% lower bound of Blue's decided win rate (needs > 60%)">
              {o.blue + o.red ? `${pct}% floor` : "—"}
            </span>
            <span className={"auto-opp-badge auto-opp-badge--" + o.status}>
              {o.status === "beaten"
                ? mode === "training"
                  ? "dominant ✓"
                  : "beaten ✓"
                : o.status === "current"
                  ? "current"
                  : mode === "training"
                    ? "in rotation"
                    : "pending"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Blue's top 2 winning combinations (a specific lead pair + back pair), each with clickable chips to
// watch the games it won. Ranked by number of wins.
function TopCombos({
  combos,
  blueName,
  focusName,
  onOpen,
}: {
  combos: ComboWin[];
  blueName: string;
  focusName: string;
  onOpen: (n: number) => void;
}) {
  if (!combos.length) {
    return (
      <p className="auto-note auto-plan-hint--center">
        {focusName
          ? `Top winning combinations vs ${focusName} appear here once Blue wins a few games.`
          : "Top winning combinations appear here once Blue wins a few games."}
      </p>
    );
  }
  return (
    <div className="auto-combos">
      <div className="auto-combos-title">
        Top winning combinations · {blueName}
        {focusName ? ` vs ${focusName}` : ""}
      </div>
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
  titleText,
  ctaText,
  noteText,
}: {
  accent: "blue" | "red";
  label: string;
  team: LoadedTeam | null;
  disabled: boolean;
  onLoad: (t: LoadedTeam) => void;
  onClear: () => void;
  titleText?: string; // overrides the "{label} — upload a team" heading (e.g. roster "add" mode)
  ctaText?: string; // overrides the "Load team" button label
  noteText?: string; // overrides the legality note
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
      <div className="ct-title">{titleText ?? `${label} — upload a team`}</div>
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
          {busy ? "Loading…" : (ctaText ?? "Load team")}
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
      <p className="ct-note">
        {noteText ?? `Must be Reg M-B legal (66-EV budget, no Restricted Legendaries). Overrides the ${label} dropdown.`}
      </p>
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

// A visual, turn-by-turn replay of one battle — this run's or one loaded back out of the library —
// with the Battle-tab board look and only turn navigation (Prev / slider / Next). Blue is p1 (near
// side), Red is p2 (foe). Team names travel with the replay so a saved game shows the teams it was
// actually played with, not whatever is selected now.
function ReplayViewer({ replay }: { replay: Replay }) {
  const { blueName, redName } = replay;
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
        <span className="auto-viewer-title">{replay.label}</span>
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


// ── Stored games ────────────────────────────────────────────────────────────────────────────────
// The persistent side of the page: every game a run saved, and what those games say about how to
// play the matchup. Unlike the live tally above, this survives a refresh, a team swap, and the
// in-memory replay window's eviction — it's the reference the training runs are for.

const pct = (x: number) => `${Math.round(x * 100)}%`;

function TrainingLibrary({
  games,
  playbook,
  totals,
  scope,
  onScope,
  blueName,
  busy,
  error,
  onRefresh,
  onExport,
  onClear,
  onOpen,
}: {
  games: GameSummary[];
  playbook: OpponentPlaybook[];
  totals: ReturnType<typeof libraryTotals>;
  scope: "team" | "all";
  onScope: (s: "team" | "all") => void;
  blueName: string;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onExport: () => void;
  onClear: () => void;
  onOpen: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null); // opponent id showing all its lines

  if (!libraryAvailable()) {
    return (
      <p className="auto-note auto-plan-hint--center">
        This browser can&apos;t store games (private mode or storage disabled), so runs can&apos;t be
        kept as reference material.
      </p>
    );
  }

  return (
    <div className="auto-library">
      <div className="auto-library-head">
        <div className="auto-library-title">Saved games · reference for optimal play</div>
        <div className="auto-library-actions">
          <div className="auto-mode-group auto-mode-group--mini" role="group" aria-label="Library scope">
            <button
              className={"auto-mode-btn" + (scope === "team" ? " auto-mode-btn--on" : "")}
              onClick={() => onScope("team")}
            >
              This team
            </button>
            <button
              className={"auto-mode-btn" + (scope === "all" ? " auto-mode-btn--on" : "")}
              onClick={() => onScope("all")}
            >
              All teams
            </button>
          </div>
          <button className="battle-btn battle-btn--ghost" onClick={onRefresh} disabled={busy}>
            {busy ? "…" : "↻ Refresh"}
          </button>
          <button
            className="battle-btn battle-btn--ghost"
            onClick={onExport}
            disabled={busy || games.length === 0}
          >
            ⤓ Export JSON
          </button>
          <button
            className="battle-btn battle-btn--ghost auto-library-danger"
            onClick={onClear}
            disabled={busy || games.length === 0}
          >
            Clear
          </button>
        </div>
      </div>

      <p className="auto-note auto-library-scope">
        {scope === "team" ? `Games Blue played with ${blueName}.` : "Games across every Blue team."} The
        library keeps the most recent {LIBRARY_CAP.toLocaleString()} games in this browser.
      </p>

      {error && <p className="auto-replay-error">{error}</p>}

      {games.length === 0 ? (
        <p className="auto-note auto-plan-hint--center">
          Nothing saved yet. Run Training with <em>Save games to the library</em> on, and every
          finished game lands here — with a playbook of what actually wins.
        </p>
      ) : (
        <>
          <div className="auto-scoreboard auto-scoreboard--library">
            <div className="auto-stat">
              <span className="auto-stat-label">Saved games</span>
              <span className="auto-stat-value">{totals.games.toLocaleString()}</span>
              <span className="auto-stat-sub">
                vs {totals.opponents} team{totals.opponents === 1 ? "" : "s"}
              </span>
            </div>
            <div className="auto-stat auto-stat--blue">
              <span className="auto-stat-label">Record</span>
              <span className="auto-stat-value">
                {totals.blue}–{totals.red}
              </span>
              <span className="auto-stat-sub">{totals.ties} tie{totals.ties === 1 ? "" : "s"}</span>
            </div>
            <div className="auto-stat">
              <span className="auto-stat-label">Win rate</span>
              <span className="auto-stat-value">{pct(totals.winRate)}</span>
              <span className="auto-stat-sub">of {totals.decided} decided</span>
            </div>
            <div className="auto-stat">
              <span className="auto-stat-label">Confidence floor</span>
              <span className="auto-stat-value">{pct(totals.lower)}</span>
              <span className="auto-stat-sub">Wilson 95%</span>
            </div>
          </div>

          {playbook.map((p) => (
            <PlaybookCard
              key={p.opponentId}
              entry={p}
              expanded={expanded === p.opponentId}
              onToggle={() => setExpanded(expanded === p.opponentId ? null : p.opponentId)}
              onOpen={onOpen}
            />
          ))}

          <RecentGames games={games} onOpen={onOpen} />

          <p className="auto-note">
            Lines are ranked by their Wilson 95% <em>lower bound</em>, not raw win rate, so a 2–0 fluke
            never outranks a 34–11 line: the ranking already accounts for how much evidence there is. A
            line needs {MIN_SUPPORT} games before it can be headlined as the recommendation. Click any
            game number to watch it back.
          </p>
        </>
      )}
    </div>
  );
}

// One opponent's page of the playbook: the line the games support, the line to avoid, and — on
// demand — every line tried, plus what that opponent tends to lead with.
function PlaybookCard({
  entry,
  expanded,
  onToggle,
  onOpen,
}: {
  entry: OpponentPlaybook;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (id: number) => void;
}) {
  const shown = expanded ? entry.leads : entry.leads.slice(0, 3);
  return (
    <div className="auto-play">
      <div className="auto-play-head">
        <span className="auto-play-name">vs {entry.opponentName}</span>
        <span className="auto-play-record">
          {entry.blue}–{entry.red}
          {entry.ties ? ` · ${entry.ties} tie${entry.ties === 1 ? "" : "s"}` : ""} over{" "}
          {entry.games.toLocaleString()} game{entry.games === 1 ? "" : "s"}
        </span>
        <span className="auto-play-floor" title="Wilson 95% lower bound of Blue's decided win rate">
          {pct(entry.winRate)} · {pct(entry.lower)} floor
        </span>
      </div>

      {entry.best ? (
        <div className="auto-play-best">
          <span className="auto-play-tag auto-play-tag--best">Bring this</span>
          <LineSummary stat={entry.best} onOpen={onOpen} />
        </div>
      ) : (
        <p className="auto-note auto-play-thin">
          No line has {MIN_SUPPORT} games yet — keep training this matchup for a recommendation.
        </p>
      )}

      {entry.worst && entry.best && entry.worst.key !== entry.best.key && (
        <div className="auto-play-best auto-play-best--avoid">
          <span className="auto-play-tag auto-play-tag--avoid">Avoid</span>
          <LineSummary stat={entry.worst} onOpen={onOpen} />
        </div>
      )}

      {entry.leads.length > 0 && (
        <table className="auto-play-table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Back</th>
              <th>Record</th>
              <th>Win</th>
              <th>Floor</th>
              <th>Watch</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.key}>
                <td>{l.lead}</td>
                <td>{l.back}</td>
                <td>
                  {l.wins}–{l.losses}
                  {l.ties ? `–${l.ties}` : ""}
                </td>
                <td>{l.decided ? pct(l.winRate) : "—"}</td>
                <td>{pct(l.lower)}</td>
                <td>
                  <ReplayChips ids={l.winIds} max={3} onOpen={onOpen} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="auto-play-foot">
        {entry.leads.length > 3 && (
          <button className="battle-btn battle-btn--ghost auto-roster-mini" onClick={onToggle}>
            {expanded ? "Show fewer lines" : `Show all ${entry.leads.length} lines`}
          </button>
        )}
        {entry.redLeads.length > 0 && (
          <span className="auto-play-foes">
            They lead:{" "}
            {entry.redLeads.slice(0, 3).map((r, i) => (
              <span key={r.lead} className="auto-play-foe">
                {i > 0 && ", "}
                {r.lead} ({r.games}×, Blue {pct(r.games ? r.blueWins / r.games : 0)})
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

// The headline for one line of play: what to bring, what to lead, how it has gone, and the games.
function LineSummary({ stat, onOpen }: { stat: ComboStat; onOpen: (id: number) => void }) {
  return (
    <div className="auto-play-line">
      <span className="auto-combo-config">
        <span className="auto-combo-part">
          <span className="auto-combo-part-label">Lead</span>
          <ComboMons names={stat.lead} />
        </span>
        <span className="auto-combo-part">
          <span className="auto-combo-part-label">Back</span>
          <ComboMons names={stat.back} />
        </span>
      </span>
      <span className="auto-play-line-stats">
        {stat.wins}–{stat.losses}
        {stat.ties ? `–${stat.ties}` : ""} · {stat.decided ? pct(stat.winRate) : "—"} win ·{" "}
        {pct(stat.lower)} floor
      </span>
      <span className="auto-combo-replays">
        {stat.winIds.length > 0 && (
          <>
            <span className="auto-combo-replays-label">Wins:</span>
            <ReplayChips ids={stat.winIds} max={6} onOpen={onOpen} />
          </>
        )}
        {stat.lossIds.length > 0 && (
          <>
            <span className="auto-combo-replays-label">Losses:</span>
            <ReplayChips ids={stat.lossIds} max={3} onOpen={onOpen} />
          </>
        )}
      </span>
    </div>
  );
}

function ReplayChips({ ids, max, onOpen }: { ids: number[]; max: number; onOpen: (id: number) => void }) {
  if (!ids.length) return <span className="auto-combo-more">—</span>;
  return (
    <>
      {ids.slice(0, max).map((id) => (
        <button key={id} className="auto-combo-chip" onClick={() => onOpen(id)}>
          #{id.toLocaleString()}
        </button>
      ))}
      {ids.length > max && <span className="auto-combo-more">+{ids.length - max}</span>}
    </>
  );
}

// The newest saved games, so a run that just finished can be watched back straight away.
function RecentGames({ games, onOpen }: { games: GameSummary[]; onOpen: (id: number) => void }) {
  const rows = games.slice(0, RECENT_SHOWN);
  if (!rows.length) return null;
  return (
    <div className="auto-recent">
      <div className="auto-combos-title">Most recent saved games</div>
      <table className="auto-play-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Played</th>
            <th>Opponent</th>
            <th>Blue led</th>
            <th>Turns</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => (
            <tr key={g.id}>
              <td>
                <button className="auto-combo-chip" onClick={() => onOpen(g.id)}>
                  #{g.id.toLocaleString()}
                </button>
              </td>
              <td>{new Date(g.ts).toLocaleString()}</td>
              <td>{g.opponentName}</td>
              <td>{g.blueLead ?? "—"}</td>
              <td>{g.turns || "—"}</td>
              <td className={"auto-recent-result auto-recent-result--" + g.result}>
                {g.result === "blue" ? "Blue win" : g.result === "red" ? "Loss" : "Tie"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
