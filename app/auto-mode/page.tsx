"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AutoBattleController, Tally } from "../battle/lib/auto-engine";

const ZERO: Tally = { blue: 0, red: 0, ties: 0, games: 0 };

export default function AutoMode() {
  const [running, setRunning] = useState(false);
  const [tally, setTally] = useState<Tally>(ZERO);
  // Keep the latest tally available to the effect without making it a dependency
  // (so toggling Start resumes from the running total instead of restarting the effect).
  const tallyRef = useRef<Tally>(ZERO);
  tallyRef.current = tally;

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let controller: AutoBattleController | null = null;

    (async () => {
      const { AutoBattleController } = await import("../battle/lib/auto-engine");
      if (cancelled) return;
      controller = new AutoBattleController({
        initial: tallyRef.current,
        onUpdate: (t) => {
          if (!cancelled) setTally(t);
        },
      });
      controller.start();
    })();

    return () => {
      cancelled = true;
      controller?.destroy();
    };
  }, [running]);

  const toggle = useCallback(() => setRunning((r) => !r), []);
  const reset = useCallback(() => setTally(ZERO), []);

  const decided = tally.blue + tally.red;
  const bluePct = decided ? Math.round((tally.blue / decided) * 100) : 0;
  const redPct = decided ? 100 - bluePct : 0;

  return (
    <>
      <h1 className="page-title">Auto Battle</h1>
      <p className="page-text">
        Simulates VGC 2026 Reg M-B games between two random-play AIs, back-to-back at full
        speed. There&apos;s nothing to watch — press Start and it just runs, tallying results
        until you press Stop.
      </p>

      <div className="auto-controls">
        <button className="battle-btn" onClick={toggle}>
          {running ? "■ Stop" : "▶ Start"}
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

      <div className="auto-scoreboard">
        <div className="auto-stat auto-stat--blue">
          <span className="auto-stat-label">Blue wins</span>
          <span className="auto-stat-value">{tally.blue.toLocaleString()}</span>
          <span className="auto-stat-sub">{bluePct}%</span>
        </div>
        <div className="auto-stat auto-stat--red">
          <span className="auto-stat-label">Red wins</span>
          <span className="auto-stat-value">{tally.red.toLocaleString()}</span>
          <span className="auto-stat-sub">{redPct}%</span>
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

      <p className="auto-note">
        Blue and Red each bring one of the two built-in Reg M-B sample teams. Every game uses
        fresh randomness, so no two play out the same.
      </p>
    </>
  );
}
