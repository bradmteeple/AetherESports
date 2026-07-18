"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoBattleController, ComboStat, Tally } from "../battle/lib/auto-engine";
import { REG_MB_TEAMS, teamById } from "../battle/lib/reg-mb-teams";

const ZERO: Tally = {
  blue: 0,
  red: 0,
  ties: 0,
  games: 0,
  powerBlue: 0,
  powerRed: 0,
  topBlue: [],
  topRed: [],
};

const DEFAULT_BLUE = REG_MB_TEAMS[0]?.id ?? "";
const DEFAULT_RED = (REG_MB_TEAMS[1] ?? REG_MB_TEAMS[0])?.id ?? "";

export default function AutoMode() {
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [tally, setTally] = useState<Tally>(ZERO);
  const [blueId, setBlueId] = useState(DEFAULT_BLUE);
  const [redId, setRedId] = useState(DEFAULT_RED);
  const controllerRef = useRef<AutoBattleController | null>(null);

  // One controller per matchup. It stays alive across Stop/Start so power and learning persist
  // (they must only ever ramp up); it's rebuilt only when a team changes or on unmount.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setRunning(false);
    setTally(ZERO);

    (async () => {
      const { AutoBattleController } = await import("../battle/lib/auto-engine");
      if (cancelled) return;
      const p1Team = teamById(blueId)?.packed;
      const p2Team = teamById(redId)?.packed;
      if (!p1Team || !p2Team) return;
      const controller = new AutoBattleController({
        p1Team,
        p2Team,
        onUpdate: (t) => {
          if (!cancelled) setTally(t);
        },
      });
      controllerRef.current = controller;
      setReady(true);
    })();

    return () => {
      cancelled = true;
      controllerRef.current?.destroy();
      controllerRef.current = null;
    };
  }, [blueId, redId]);

  const start = useCallback(() => {
    controllerRef.current?.start();
    setRunning(true);
  }, []);
  const stop = useCallback(() => {
    controllerRef.current?.stop();
    setRunning(false);
  }, []);
  const reset = useCallback(() => {
    controllerRef.current?.reset();
  }, []);

  const blueName = teamById(blueId)?.name ?? "—";
  const redName = teamById(redId)?.name ?? "—";
  const decided = tally.blue + tally.red;
  const bluePct = decided ? Math.round((tally.blue / decided) * 100) : 0;
  const redPct = decided ? 100 - bluePct : 0;
  const bluePow = Math.round(tally.powerBlue * 100);
  const redPow = Math.round(tally.powerRed * 100);

  return (
    <div className="auto-page">
      <h1 className="page-title">Auto Battle</h1>
      <p className="page-text">
        Two AIs battle in VGC 2026 Reg M-B, back-to-back at full speed. Game one is fully random;
        after that they teach each other — the loser of each game ramps up hard and the winner a
        little, so both only ever grow stronger (no ceiling), learning to counter the
        opponent&apos;s threats. There&apos;s nothing to watch; it just runs and tallies, and below
        the score each side&apos;s top 3 winning 4-of-6 selections are labeled.
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
        <button className="battle-btn auto-btn--start" onClick={start} disabled={running || !ready}>
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
          {running ? "running…" : tally.games ? "stopped" : "idle"}
        </span>
      </div>

      <div className="auto-power">
        <PowerBar label={`Blue power · ${blueName}`} accent="blue" pct={bluePow} />
        <PowerBar label={`Red power · ${redName}`} accent="red" pct={redPow} />
      </div>

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
        Each side brings a random 4 of its 6 every game; the columns show that side&apos;s top 3
        selections by win rate (with wins/games), among picks with at least 500 games so the rates
        are meaningful. Changing a team or pressing Reset starts a new arms race (power and learning
        back to zero).
      </p>
    </div>
  );
}

function PowerBar({ label, accent, pct }: { label: string; accent: "blue" | "red"; pct: number }) {
  return (
    <div className={"auto-power-row auto-power-row--" + accent}>
      <span className="auto-power-label">{label}</span>
      <div className="auto-power-track">
        {/* Bar fills to 100% once fully powered; the % label keeps climbing past it. */}
        <div className="auto-power-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="auto-power-pct">{pct}%</span>
    </div>
  );
}

// A selection needs at least this many games before its win rate is trusted enough to rank.
const MIN_GAMES = 500;

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
