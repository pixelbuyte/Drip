import { describe, expect, it } from 'vitest';
import { EXPLORATION_HEAVY_WORLD, YOUNG_PLATFORM_WORLD, runSimulation, type SimulationStrategy } from '../simulate';

function line(tag: string, r: ReturnType<typeof runSimulation>, ms: number) {
  const d = r.diagnostics;
  console.log(
    `${tag} | ${ms}ms dur=${r.world.durationHours.toFixed(0)}h imp=${r.totals.impressions} ` +
    `new=${r.world.newVideosPublished} budget=${(r.budget.rate * 100).toFixed(0)}% dec=${r.budget.decided} starv=${r.budget.starved.length} ` +
    `demand=${(r.budget.demandShare * 100).toFixed(1)}% fresh=${(r.freshShare * 100).toFixed(1)}% ` +
    `freshCand=${d.freshCandidatesPerSession.toFixed(1)} freshPerFull=${d.avgFreshPerFullSlice.toFixed(2)} ` +
    `gini=${r.gini.toFixed(3)} qual=${r.quality.ratio?.toFixed(2)} rpm=${r.rpm.toFixed(0)}`
  );
}

const base = { sessionsPerDay: 500, newVideosPerDay: 2, maxSlices: 2, targetCandidates: 150 };

describe('sweep', () => {
  it('exploration heavy', () => {
    for (const strategy of ['softmax', 'floor-only', 'greedy'] as SimulationStrategy[]) {
      const t0 = Date.now();
      const r = runSimulation({ sessions: 300, seed: 7, strategy, world: { ...EXPLORATION_HEAVY_WORLD, ...base } });
      line(`explore/${strategy}`, r, Date.now() - t0);
    }
    for (const strategy of ['softmax', 'floor-only'] as SimulationStrategy[]) {
      const t0 = Date.now();
      const r = runSimulation({ sessions: 300, seed: 7, strategy, world: { ...YOUNG_PLATFORM_WORLD, ...base } });
      line(`young/${strategy}`, r, Date.now() - t0);
    }
    expect(true).toBe(true);
  }, 600000);

  it('default guardrails', () => {
    const t0 = Date.now();
    const r = runSimulation({ sessions: 1500, seed: 7, world: { maxSlices: 2, targetCandidates: 150 } });
    line('default-1500', r, Date.now() - t0);
    expect(true).toBe(true);
  }, 600000);
});
