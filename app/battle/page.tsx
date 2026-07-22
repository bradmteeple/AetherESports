"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BattleSnapshot, ControllerOpts, CustomTeam, MoveOption, RosterMon, SelectedTeams, SwitchOption } from "./lib/engine";
import type { ActiveMon, BoardState, StatBlock } from "./lib/protocol";
import { FORMAT_LIST, FORMATS, type FormatKey } from "./lib/formats";
import { needsTarget, targetOptions } from "./lib/choices";
import { pokeSprite, pokeThumb } from "./lib/sprites";
import { emptyMatchup, matchupValue, setMatchup, type Cell, type Matchup } from "./lib/matchup";

// species of each set in a selected team (forme name), for the matchup grid axes
function speciesOf(sets: any[]): string[] {
  return (sets ?? []).map((s) => String(s?.species || s?.name || "")).filter(Boolean);
}

interface MatchupStep {
  preTeams: SelectedTeams;
  aiSpecies: string[];
  playerSpecies: string[];
}

export default function BattlePage() {
  const [selectedFormat, setSelectedFormat] = useState<FormatKey>("gen9randombattle");
  const [runningFormat, setRunningFormat] = useState<FormatKey>("gen9randombattle");
  const [selectedLevel, setSelectedLevel] = useState(2);
  const [runningLevel, setRunningLevel] = useState(2);
  const [snapshot, setSnapshot] = useState<BattleSnapshot | null>(null);
  const [battleKey, setBattleKey] = useState(0);
  const [started, setStarted] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [customTeam, setCustomTeam] = useState<{ packed: string; species: string[] } | null>(null);
  const [playerTeam, setPlayerTeam] = useState<{ packed: string; species: string[] } | null>(null);
  const [runningCustom, setRunningCustom] = useState<CustomTeam | undefined>(undefined);
  const [runningOpts, setRunningOpts] = useState<ControllerOpts | undefined>(undefined);
  // Level-3 pre-battle matchup chart step (null unless the player is filling it in).
  const [matchupStep, setMatchupStep] = useState<MatchupStep | null>(null);
  const [matchup, setMatchupState] = useState<Matchup>(emptyMatchup());
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const chooseRef = useRef<((choice: string) => void) | null>(null);

  // Both custom teams are always assumed to be for the currently selected format,
  // so their singles/doubles nature follows that format rather than a manual toggle.
  const selectedDoubles = FORMATS[selectedFormat].gametype === "doubles";

  // Switching formats clears any loaded custom team — a team pasted for one
  // format shouldn't silently carry over into a different one.
  const selectFormat = useCallback(
    (key: FormatKey) => {
      if (key === selectedFormat) return;
      setSelectedFormat(key);
      setCustomTeam(null);
      setPlayerTeam(null);
    },
    [selectedFormat]
  );

  useEffect(() => {
    if (!started) return; // wait for the user to press Start Battle
    let controller: import("./lib/engine").BattleController | null = null;
    let cancelled = false;
    setSnapshot(null);

    (async () => {
      const { BattleController } = await import("./lib/engine");
      if (cancelled) return;
      controller = new BattleController(runningFormat, runningLevel, (s) => setSnapshot(s), runningCustom, runningOpts);
      chooseRef.current = (c) => controller!.choose(c);
    })();

    return () => {
      cancelled = true;
      controller?.destroy();
      chooseRef.current = null;
    };
  }, [battleKey, runningFormat, runningLevel, started, runningCustom, runningOpts]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [snapshot?.log.length]);

  const startBattle = useCallback(async () => {
    const custom: CustomTeam | undefined =
      customTeam || playerTeam
        ? { aiTeam: customTeam?.packed, playerTeam: playerTeam?.packed, doubles: selectedDoubles }
        : undefined;
    setRunningFormat(selectedFormat);
    setRunningLevel(selectedLevel);
    setRunningCustom(custom);

    // Level 3: pick the teams now and let the player set a matchup chart before the battle begins.
    if (selectedLevel === 3) {
      const { selectTeams } = await import("./lib/engine");
      const preTeams = selectTeams(FORMATS[selectedFormat], custom);
      setStarted(false); // tear down any battle in progress while the chart is filled in
      setSnapshot(null);
      setMatchupState(emptyMatchup());
      setMatchupStep({
        preTeams,
        aiSpecies: speciesOf(preTeams.p2Sets),
        playerSpecies: speciesOf(preTeams.p1Sets),
      });
      return;
    }

    setRunningOpts(undefined);
    setStarted(true);
    setBattleKey((k) => k + 1);
  }, [selectedFormat, selectedLevel, customTeam, playerTeam, selectedDoubles]);

  const beginBattle = useCallback(() => {
    if (!matchupStep) return;
    setRunningOpts({ preTeams: matchupStep.preTeams, matchup });
    setMatchupStep(null);
    setStarted(true);
    setBattleKey((k) => k + 1);
  }, [matchupStep, matchup]);

  const choose = useCallback((c: string) => chooseRef.current?.(c), []);

  return (
    <div className="battle-page">
      <div className="custom-team-stack">
        <CustomTeamPanel
          title="Your Team"
          owner="You"
          team={playerTeam}
          formatLabel={FORMATS[selectedFormat].label}
          doubles={selectedDoubles}
          onLoad={setPlayerTeam}
          onClear={() => setPlayerTeam(null)}
        />
        <CustomTeamPanel
          title="Rival AI Team"
          owner="The Rival AI"
          team={customTeam}
          formatLabel={FORMATS[selectedFormat].label}
          doubles={selectedDoubles}
          onLoad={setCustomTeam}
          onClear={() => setCustomTeam(null)}
        />
      </div>
      <h1 className="page-title">Battle</h1>
      <p className="page-text">
        Powered by the real Pokémon Showdown battle engine. Held items are shown for both teams.
      </p>

      <div className="format-picker">
        {FORMAT_LIST.map((f) => (
          <button
            key={f.key}
            className={"format-btn" + (selectedFormat === f.key ? " format-btn--on" : "")}
            onClick={() => selectFormat(f.key)}
          >
            {f.label}
          </button>
        ))}
        <button className="battle-btn" onClick={startBattle}>
          {started ? "↻ New Battle" : "▶ Start Battle"}
        </button>
      </div>

      <div className="level-picker">
        <span className="level-label">AI level:</span>
        {[
          { n: 1, label: "1 · Rookie" },
          { n: 2, label: "2 · Skilled" },
          {
            n: 3,
            label: "3 · Adaptive",
            tip: "Designed to improve with every game you play against it — it learns your tendencies and sharpens each game.",
          },
        ].map((lvl) => (
          <button
            key={lvl.n}
            className={
              "level-btn" +
              (selectedLevel === lvl.n ? " level-btn--on" : "") +
              (lvl.tip ? " has-pop" : "")
            }
            onClick={() => setSelectedLevel(lvl.n)}
          >
            {lvl.label}
            {lvl.tip && (
              <span className="stat-tooltip level-tip" role="tooltip">
                <span className="tip-text">{lvl.tip}</span>
              </span>
            )}
          </button>
        ))}
      </div>

      {FORMATS[selectedFormat].note && (
        <p className="format-note">* {FORMATS[selectedFormat].note}</p>
      )}

      {matchupStep ? (
        <MatchupSetup
          step={matchupStep}
          matchup={matchup}
          onSet={(ai, you, v) => setMatchupState((m) => setMatchup(m, ai, you, v))}
          onAllNeutral={() => setMatchupState(emptyMatchup())}
          onBegin={beginBattle}
          onCancel={() => setMatchupStep(null)}
        />
      ) : !started ? (
        <div className="battle-loading">Choose a format and AI level above, then press ▶ Start Battle.</div>
      ) : !snapshot ? (
        <div className="battle-loading">Generating teams and starting the battle…</div>
      ) : (
        <div className="battle-layout">
          <AiWhyPanel open={whyOpen} onToggle={() => setWhyOpen((o) => !o)} reasons={snapshot.aiReasons} />

          <div className="battle-main">
            <div className="battle-grid">
              <RosterTray label="Rival AI" mons={snapshot.rosters.p2} />
              <FieldSide board={snapshot.board} side="p2" label="Rival AI" doubles={snapshot.gametype === "doubles"} foe />
              <FieldSide board={snapshot.board} side="p1" label="You" doubles={snapshot.gametype === "doubles"} />
              <RosterTray label="You" mons={snapshot.rosters.p1} />

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

              <ChoiceArea snapshot={snapshot} choose={choose} onNewBattle={startBattle} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Pre-battle matchup chart for the Adaptive (Level 3) AI. Rows = the AI's Pokémon, columns = your
// Pokémon; each cell rates the matchup FROM THE AI'S PERSPECTIVE, cycling neutral → AI favored (+) →
// AI weak (−). The AI plays to it (see AdaptiveAI in ai.ts). Default all-neutral makes Level 3 behave
// exactly as before.
function MatchupSetup({
  step,
  matchup,
  onSet,
  onAllNeutral,
  onBegin,
  onCancel,
}: {
  step: MatchupStep;
  matchup: Matchup;
  onSet: (aiSpecies: string, playerSpecies: string, v: Cell) => void;
  onAllNeutral: () => void;
  onBegin: () => void;
  onCancel: () => void;
}) {
  // neutral → AI favored (+1) → AI weak (−1) → neutral
  const cycle = (v: Cell): Cell => (v === 0 ? 1 : v === 1 ? -1 : 0);
  const cellClass = (v: Cell) =>
    "matchup-cell" + (v > 0 ? " matchup-cell--pos" : v < 0 ? " matchup-cell--neg" : "");
  const cellText = (v: Cell) => (v > 0 ? "+" : v < 0 ? "−" : "0");
  const cellTitle = (ai: string, you: string, v: Cell) =>
    `${ai} vs ${you}: ${v > 0 ? "AI favored" : v < 0 ? "AI at a disadvantage" : "neutral"}`;

  return (
    <div className="matchup-setup">
      <div className="matchup-head">
        <h2 className="matchup-title">Set the Adaptive AI&apos;s matchups</h2>
        <p className="matchup-sub">
          Rate each of the AI&apos;s Pokémon (rows) against each of yours (columns) — from the AI&apos;s
          point of view. Click a cell to cycle: <span className="matchup-key matchup-key--neutral">0</span>{" "}
          neutral → <span className="matchup-key matchup-key--pos">+</span> AI favored →{" "}
          <span className="matchup-key matchup-key--neg">−</span> AI at a disadvantage. The AI switches
          in to, targets, and holds its ground on favorable matchups, and retreats from bad ones.
        </p>
      </div>

      <div className="matchup-scroll">
        <table className="matchup-table">
          <thead>
            <tr>
              <th className="matchup-corner" scope="col">
                AI ↓ / You →
              </th>
              {step.playerSpecies.map((you, j) => (
                <th key={j} className="matchup-col-head" scope="col" title={you}>
                  <Thumb name={you} />
                  <span className="matchup-axis-name">{you}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {step.aiSpecies.map((ai, i) => (
              <tr key={i}>
                <th className="matchup-row-head" scope="row" title={ai}>
                  <Thumb name={ai} />
                  <span className="matchup-axis-name">{ai}</span>
                </th>
                {step.playerSpecies.map((you, j) => {
                  const v = matchupValue(matchup, ai, you);
                  return (
                    <td key={j} className="matchup-cell-wrap">
                      <button
                        type="button"
                        className={cellClass(v)}
                        title={cellTitle(ai, you, v)}
                        onClick={() => onSet(ai, you, cycle(v))}
                      >
                        {cellText(v)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="matchup-actions">
        <button className="battle-btn" onClick={onBegin}>
          ▶ Begin Battle
        </button>
        <button className="battle-btn battle-btn--ghost" onClick={onAllNeutral}>
          All neutral
        </button>
        <button className="battle-btn battle-btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CustomTeamPanel({
  title,
  owner,
  team,
  formatLabel,
  doubles,
  onLoad,
  onClear,
}: {
  title: string;
  owner: string; // who plays this team, e.g. "You" or "The Rival AI"
  team: { packed: string; species: string[] } | null;
  formatLabel: string;
  doubles: boolean;
  onLoad: (t: { packed: string; species: string[] }) => void;
  onClear: () => void;
}) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const input = text.trim();
    if (!input) return;
    setBusy(true);
    setStatus(null);
    try {
      const { looksLikeUrl, fetchPokepaste, importTeam } = await import("./lib/pokepaste");
      const raw = looksLikeUrl(input) ? await fetchPokepaste(input) : input;
      const loaded = importTeam(raw);
      if (!loaded) {
        setStatus("Couldn't read a team from that — check the paste or export text.");
      } else {
        onLoad(loaded);
        setText("");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Failed to load that team.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="custom-team-panel">
      <div className="ct-title">{title}</div>
      {team ? (
        <>
          <p className="ct-note">
            {owner} will use this custom team ({team.species.length}) for {formatLabel} (
            {doubles ? "Doubles" : "Singles"}).
          </p>
          <ul className="ct-list">
            {team.species.map((s, i) => (
              <li key={i}>
                <Thumb name={s} />
                <span>{s}</span>
              </li>
            ))}
          </ul>
          <button className="battle-btn battle-btn--ghost" onClick={onClear}>
            Clear team
          </button>
        </>
      ) : (
        <>
          <textarea
            className="ct-input"
            rows={3}
            placeholder="Paste a PokePaste URL — or the team's export text"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="ct-note">
            {owner} will use this team for {formatLabel} ({doubles ? "Doubles" : "Singles"}). Changing
            the format clears it.
          </p>
          <button className="battle-btn" disabled={busy || !text.trim()} onClick={load}>
            {busy ? "Loading…" : "Load Team"}
          </button>
          {status && <p className="ct-error">{status}</p>}
        </>
      )}
    </aside>
  );
}

function AiWhyPanel({
  open,
  onToggle,
  reasons,
}: {
  open: boolean;
  onToggle: () => void;
  reasons: string[];
}) {
  return (
    <aside className={"ai-panel" + (open ? " ai-panel--open" : "")}>
      <button
        className="why-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-label="Why did the Rival AI make that move?"
        title="Why did the Rival AI make that move?"
      >
        ?
      </button>
      {open && (
        <div className="why-box" role="region" aria-label="Rival AI reasoning">
          <div className="why-title">Rival AI — why?</div>
          {reasons.length ? (
            <ul className="why-list">
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="why-empty">The Rival AI hasn&apos;t moved yet.</p>
          )}
        </div>
      )}
    </aside>
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

function RosterTray({ label, mons }: { label: string; mons: RosterMon[] }) {
  if (!mons.length) return null;
  const alive = mons.filter((m) => !m.fainted).length;
  return (
    <div className="roster-tray">
      <span className="roster-label">
        {label} <span className="roster-count">{alive}/{mons.length}</span>
      </span>
      <div className="roster-mons">
        {mons.map((m, i) => (
          <span
            key={i}
            className={"roster-mon" + (m.fainted ? " roster-mon--fainted" : "")}
            title={m.fainted ? `${m.name} (fainted)` : m.name}
          >
            <Thumb name={m.name} />
            <span className="roster-mon-name">{m.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Thumb({ name }: { name: string }) {
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
      <div
        className={"mon-body" + (mon?.stats ? " has-pop" : "")}
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
              <Thumb name={p.name} />
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
  const [mega, setMega] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const submitted = useRef(false);

  // Battle gimmick appended to a move choice. Mega and Tera are mutually exclusive — the engine
  // never offers both on one Pokémon (a Mega-Stone holder can't Terastallize).
  const gimmick = mega ? " mega" : tera ? " terastallize" : "";

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
    setMega(false);
    setDecisions((cur) => cur.map((d, i) => (i === currentSlot ? value : d)));
  };

  const clickMove = (m: MoveOption) => {
    const base = `move ${m.slot}`;
    if (!needsTarget(m.target, doubles)) {
      setSlot(base + gimmick);
      return;
    }
    const options = targetOptions(m.target, currentSlot, snapshot.board);
    if (options.length <= 1) {
      setSlot(base + (options[0] ? ` ${options[0].value}` : "") + gimmick);
      return;
    }
    setPending({ slotIndex: currentSlot, moveSlot: m.slot, moveName: m.name, options });
  };

  const undo = () => {
    submitted.current = false;
    setPending(null);
    setTera(false);
    setMega(false);
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
                onClick={() => setSlot(`move ${pending.moveSlot} ${o.value}${gimmick}`)}
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
              {active.canMega && (
                <label className="tera-toggle mega-toggle">
                  <input type="checkbox" checked={mega} onChange={(e) => setMega(e.target.checked)} />
                  Mega Evolve
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
          <Thumb name={s.name} />
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
