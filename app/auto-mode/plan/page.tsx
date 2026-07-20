"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { decodePlan, planToBullets, type PlanData } from "../../battle/lib/game-plan";

export default function PlanPage() {
  // undefined = still reading the URL; null = no/invalid data.
  const [plan, setPlan] = useState<PlanData | null | undefined>(undefined);

  useEffect(() => {
    const d = new URLSearchParams(window.location.search).get("d");
    setPlan(d ? decodePlan(d) : null);
  }, []);

  if (plan === undefined) {
    return <div className="battle-loading">Loading game plan…</div>;
  }

  if (plan === null) {
    return (
      <div className="plan-page">
        <h1 className="page-title">Game plan</h1>
        <p className="page-text">
          No plan data in this link. Open the Auto Battle tab, run a matchup, and press Stop to
          generate a shareable plan.
        </p>
        <Link className="battle-btn" href="/auto-mode">
          ← Back to Auto Battle
        </Link>
      </div>
    );
  }

  const bullets = planToBullets(plan);

  return (
    <div className="plan-page">
      <h1 className="page-title">Blue&apos;s game plan</h1>
      <p className="page-text">
        How <strong className="plan-blue">{plan.blueTeam}</strong> (Blue) played against{" "}
        <strong className="plan-red">{plan.redTeam}</strong> (Red) — a {plan.archetype} plan derived
        from {plan.games.toLocaleString()} self-play games.
      </p>

      <div className="plan-badges">
        <span className="plan-badge plan-badge--blue">Blue win rate {plan.winPct}%</span>
        <span className="plan-badge">
          {plan.blueWins.toLocaleString()}–{plan.redWins.toLocaleString()} decided
        </span>
        <span className="plan-badge">{plan.archetype}</span>
      </div>

      <ul className="plan-bullets">
        {bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>

      <div className="plan-actions">
        <Link className="battle-btn battle-btn--ghost" href="/auto-mode">
          ← Back to Auto Battle
        </Link>
      </div>
    </div>
  );
}
