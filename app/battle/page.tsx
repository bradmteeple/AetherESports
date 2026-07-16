"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BattleSnapshot, MoveOption, SwitchOption } from "./lib/engine";
import type { ActiveMon, BoardState, StatBlock } from "./lib/protocol";
import { FORMAT_LIST, FORMATS, type FormatKey } from "./lib/formats";
import { needsTarget, targetOptions } from "./lib/choices";

export default function BattlePage() {
  const [selectedFormat, setSelectedFormat] = useState<FormatKey>("gen9randombattle");
  const [runningFormat, setRunningFormat] = useState<FormatKey>("gen9randombattle");
  const [snapshot, setSnapshot] = useState<BattleSnapshot | null>(null);
  const [battleKey, setBattleKey] = useState(0);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const chooseRef = useRef<((choice: string) => void) | null>(null);

  useEffect(() => {
    let controller: import("./lib/engine").BattleController | null = null;
    let cancelled = false;
    setSnapshot(null);

    (async () => {
      const { BattleController } = await import("./lib/engine");
      if (cancelled) return;
      controller = new BattleController(runningFormat, (s) => setSnapshot(s));
      chooseRef.current = (c) => controller!.choose(c);
    })();

    return () => {
      cancelled = true;
      controller?.destroy();
      chooseRef.current = null;
    };
  }, [battleKey, runningFormat]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [snapshot?.log.length]);

  const newBattle = useCallback(() => {
    setRunningFormat(selectedFormat);
    setBattleKey((k) => k + 1);
  }, [selectedFormat]);

  const choose = useCallback((c: string) => chooseRef.current?.(c), []);

  return (
    <>
      <h1 className="page-title">Battle</h1>
      <p className="page-text">
        Powered by the real Pokémon Showdown battle engine. Held items are shown for both teams.
      </p>

      <div className="format-picker">
        {FORMAT_LIST.map((f) => (
          <button
            key={f.key}
            className={"format-btn" + (selectedFormat === f.key ? " format-btn--on" : "")}
            onClick={() => setSelectedFormat(f.key)}
          >
            {f.label}
          </button>
        ))}
        <button className="battle-btn" onClick={newBattle}>
          ↻ New Battle
        </button>
      </div>

      {FORMATS[selectedFormat].note && (
        <p className="format-note">* {FORMATS[selectedFormat].note}</p>
      )}

      {!snapshot ? (
        <div className="battle-loading">Generating teams and starting the battle…</div>
      ) : (
        <div className="battle-grid">
          <FieldSide board={snapshot.board} side="p2" label="Rival AI" doubles={snapshot.gametype === "doubles"} foe />
          <FieldSide board={snapshot.board} side="p1" label="You" doubles={snapshot.gametype === "doubles"} />

          <div className="battle-log" aria-live="polite">
            {snapshot.log.map((line, i) => (
              <div
                key={i}
                className={
                  "battle-log-line" +
                  (line.startsWith("\n") ? " battle-log-line--turn" : "") +
                  (line.startsWith("⚠️") ? " battle-log-line--warn" : "")
                }
              >
                {line.trim()}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>

          <ChoiceArea snapshot={snapshot} choose={choose} onNewBattle={newBattle} />
        </div>
      )}
    </>
  );
}

function FieldSide({
  board,
  side,
  label,
  doubles,
  foe,
}: {
  board: BoardState;
  side: "p1" | "p2";
  label: string;
  doubles: boolean;
  foe?: boolean;
}) {
  const slots = doubles ? [0, 1] : [0];
  return (
    <div className={"field-side" + (doubles ? " field-side--doubles" : "")}>
      {slots.map((i) => (
        <MonCard key={i} mon={board[side][i]} sideLabel={label} foe={foe} />
      ))}
    </div>
  );
}

function StatPop({ stats }: { stats?: StatBlock }) {
  if (!stats) return null;
  const cells: [string, number][] = [
    ["HP", stats.hp],
    ["Atk", stats.atk],
    ["Def", stats.def],
    ["SpA", stats.spa],
    ["SpD", stats.spd],
    ["Spe", stats.spe],
  ];
  return (
    <span className="stat-tooltip" role="tooltip">
      <span className="stat-head">
        Lv {stats.level}
        {stats.tera ? ` · Tera ${stats.tera}` : ""}
      </span>
      <span className="stat-grid">
        {cells.map(([k, v]) => (
          <span className="stat-cell" key={k}>
            <span className="stat-k">{k}</span>
            <span className="stat-v">{v}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

function MonCard({ mon, sideLabel, foe }: { mon: ActiveMon | null; sideLabel: string; foe?: boolean }) {
  return (
    <div
      className={"mon-card" + (foe ? " mon-card--foe" : "") + (mon?.stats ? " has-pop" : "")}
      tabIndex={mon?.stats ? 0 : undefined}
    >
      <div className="mon-card-head">
        <span className="mon-side">{sideLabel}</span>
        <span className="mon-name">{mon ? mon.name : "—"}</span>
        {mon?.status && <span className="mon-status">{mon.status.toUpperCase()}</span>}
      </div>
      {mon?.ability && <div className="mon-ability">{mon.ability}</div>}
      <div className="mon-item">{mon?.item ? `@ ${mon.item}` : " "}</div>
      <StatPop stats={mon?.stats} />
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
  );
}

function ChoiceArea({
  snapshot,
  choose,
  onNewBattle,
}: {
  snapshot: BattleSnapshot;
  choose: (c: string) => void;
  onNewBattle: () => void;
}) {
  if (snapshot.ended) {
    return (
      <div className="choice-panel">
        <p className="choice-hint">
          {snapshot.winner
            ? snapshot.winner === "You"
              ? "🏆 You won the battle!"
              : `Defeat — ${snapshot.winner} won.`
            : "The battle is over."}
        </p>
        <button className="battle-btn" onClick={onNewBattle}>
          Play again
        </button>
      </div>
    );
  }
  if (snapshot.prompt === "wait") {
    return (
      <div className="choice-panel">
        <p className="choice-hint">Waiting for the opponent…</p>
      </div>
    );
  }
  if (snapshot.prompt === "teampreview") {
    return <TeamPreviewPanel key={snapshot.requestId} snapshot={snapshot} choose={choose} />;
  }
  if (snapshot.prompt === "move" || snapshot.prompt === "switch") {
    return <TurnPanel key={snapshot.requestId} snapshot={snapshot} choose={choose} />;
  }
  return <div className="choice-panel" />;
}

function TeamPreviewPanel({ snapshot, choose }: { snapshot: BattleSnapshot; choose: (c: string) => void }) {
  const [order, setOrder] = useState<number[]>([]);
  const pick = snapshot.previewPick;

  const toggle = (slot: number) => {
    setOrder((cur) =>
      cur.includes(slot) ? cur.filter((s) => s !== slot) : cur.length < pick ? [...cur, slot] : cur
    );
  };

  return (
    <div className="choice-panel">
      <p className="choice-hint">
        Team Preview — choose {pick} Pokémon (click in the order you want to lead).
      </p>
      <div className="preview-grid">
        {snapshot.preview.map((p) => {
          const idx = order.indexOf(p.slot);
          return (
            <button
              key={p.slot}
              className={
                "preview-card" +
                (idx >= 0 ? " preview-card--picked" : "") +
                (p.stats ? " has-pop" : "")
              }
              onClick={() => toggle(p.slot)}
            >
              {idx >= 0 && <span className="preview-order">{idx + 1}</span>}
              <span className="preview-name">{p.name}</span>
              {p.ability && <span className="preview-ability">{p.ability}</span>}
              <span className="preview-item">{p.item ? `@ ${p.item}` : "no item"}</span>
              <StatPop stats={p.stats} />
            </button>
          );
        })}
      </div>
      <div className="choice-actions">
        <button
          className="battle-btn"
          disabled={order.length !== pick}
          onClick={() => choose(`team ${order.join("")}`)}
        >
          Confirm lead
        </button>
        <button className="battle-btn battle-btn--ghost" onClick={() => setOrder([])}>
          Clear
        </button>
        <button className="battle-btn battle-btn--ghost" onClick={() => choose("default")}>
          Auto
        </button>
      </div>
    </div>
  );
}

interface Pending {
  slotIndex: number;
  moveSlot: number;
  moveName: string;
  options: { label: string; value: number }[];
}

function TurnPanel({ snapshot, choose }: { snapshot: BattleSnapshot; choose: (c: string) => void }) {
  const isSwitch = snapshot.prompt === "switch";
  const doubles = snapshot.gametype === "doubles";
  const nSlots = isSwitch ? snapshot.forceSwitch.length : snapshot.active.length;

  const initDecisions = useMemo<(string | null)[]>(() => {
    return Array.from({ length: nSlots }, (_, i) => {
      if (isSwitch) return snapshot.forceSwitch[i] ? null : "pass";
      return snapshot.active[i]?.fainted ? "pass" : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [decisions, setDecisions] = useState<(string | null)[]>(initDecisions);
  const [tera, setTera] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const submitted = useRef(false);

  const currentSlot = decisions.findIndex((d) => d === null);
  const usedBench = decisions
    .filter((d): d is string => !!d && d.startsWith("switch"))
    .map((d) => parseInt(d.split(" ")[1], 10));

  // Submit once every slot has a decision.
  useEffect(() => {
    if (currentSlot === -1 && !submitted.current) {
      submitted.current = true;
      choose(decisions.map((d) => d ?? "pass").join(", "));
    }
  }, [currentSlot, decisions, choose]);

  const setSlot = (value: string) => {
    setPending(null);
    setTera(false);
    setDecisions((cur) => cur.map((d, i) => (i === currentSlot ? value : d)));
  };

  const clickMove = (m: MoveOption) => {
    const base = `move ${m.slot}`;
    const suffix = tera ? " terastallize" : "";
    if (!needsTarget(m.target, doubles)) {
      setSlot(base + suffix);
      return;
    }
    const options = targetOptions(m.target, currentSlot, snapshot.board);
    if (options.length <= 1) {
      setSlot(base + (options[0] ? ` ${options[0].value}` : "") + suffix);
      return;
    }
    setPending({ slotIndex: currentSlot, moveSlot: m.slot, moveName: m.name, options });
  };

  const undo = () => {
    submitted.current = false;
    setPending(null);
    setTera(false);
    setDecisions(initDecisions);
  };

  if (currentSlot === -1) {
    return (
      <div className="choice-panel">
        <p className="choice-hint">Locking in your move…</p>
      </div>
    );
  }

  const slotMon = snapshot.board.p1[currentSlot];
  const active = snapshot.active[currentSlot];
  const benchOptions = snapshot.switches.filter(
    (s) => !s.active && !s.fainted && !usedBench.includes(s.slot)
  );
  const canSwitch = !isSwitch ? !active?.trapped : true;

  return (
    <div className="choice-panel">
      <div className="slot-header">
        {nSlots > 1 && (
          <span className="slot-tag">
            Slot {currentSlot === 0 ? "A" : "B"}
          </span>
        )}
        <span className="choice-hint">
          {isSwitch ? "Choose a Pokémon to send out" : "Choose an action"}
          {slotMon ? ` for ${slotMon.name}` : ""}:
        </span>
      </div>

      {pending ? (
        <div className="target-step">
          <p className="choice-hint choice-hint--sub">Target for {pending.moveName}:</p>
          <div className="target-grid">
            {pending.options.map((o) => (
              <button
                key={o.value}
                className="target-btn"
                onClick={() => setSlot(`move ${pending.moveSlot} ${o.value}${tera ? " terastallize" : ""}`)}
              >
                {o.label}
              </button>
            ))}
            <button className="battle-btn battle-btn--ghost" onClick={() => setPending(null)}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <>
          {!isSwitch && active && active.moves.length > 0 && (
            <>
              {active.canTera && (
                <label className="tera-toggle">
                  <input type="checkbox" checked={tera} onChange={(e) => setTera(e.target.checked)} />
                  Terastallize
                </label>
              )}
              <div className="move-grid">
                {active.moves.map((m) => (
                  <button
                    key={m.slot}
                    className="move-btn"
                    disabled={m.disabled || m.pp === 0}
                    onClick={() => clickMove(m)}
                  >
                    <span className="move-name">{m.name}</span>
                    <span className="move-pp">
                      {m.pp}/{m.maxpp} PP
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {canSwitch && benchOptions.length > 0 && (
            <>
              <p className="choice-hint choice-hint--sub">{isSwitch ? "Bench:" : "…or switch:"}</p>
              <SwitchButtons switches={benchOptions} onSwitch={(slot) => setSlot(`switch ${slot}`)} />
            </>
          )}
        </>
      )}

      {decisions.some((d) => d && d !== "pass") && (
        <div className="choice-actions">
          <span className="decisions-preview">
            {decisions.map((d, i) => (d && d !== "pass" ? `${i === 0 ? "A" : "B"}: ${d}` : null)).filter(Boolean).join("   ")}
          </span>
          <button className="battle-btn battle-btn--ghost" onClick={undo}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

function SwitchButtons({
  switches,
  onSwitch,
}: {
  switches: SwitchOption[];
  onSwitch: (slot: number) => void;
}) {
  return (
    <div className="switch-grid">
      {switches.map((s) => (
        <button
          key={s.slot}
          className={"switch-btn" + (s.stats ? " has-pop" : "")}
          onClick={() => onSwitch(s.slot)}
        >
          <span className="switch-name">{s.name}</span>
          {s.ability && <span className="switch-ability">{s.ability}</span>}
          <span className="switch-hp">
            {s.hpPct}%{s.item ? ` · ${s.item}` : ""}
          </span>
          <StatPop stats={s.stats} />
        </button>
      ))}
    </div>
  );
}
