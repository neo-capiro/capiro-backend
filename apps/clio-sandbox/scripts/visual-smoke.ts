/**
 * Visual-analysis smoke test for the MeriV3 sandbox.
 *
 * Exercises the allowed numerical/statistical/graph stack, produces canonical
 * PNGs, and emits the structured `results.visuals` contract consumed by the
 * MeriV3 interactive chart card. Run locally only where the pinned Python
 * dependencies are installed; the authoritative run is inside the sandbox
 * image or CI's matching Python environment.
 */
import { runSandboxed } from '../src/run.js';

const code = String.raw`
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
import networkx as nx
import statsmodels.api as sm
from scipy.stats import pearsonr

df = pd.read_csv('./data/funding.csv')
df['delta'] = df['current'] - df['request']
r, p_value = pearsonr(df['request'], df['current'])
model = sm.OLS(df['current'], sm.add_constant(df['request'])).fit()

fig, ax = plt.subplots()
ax.plot(df['fy'], df['request'], marker='o', label='Request')
ax.plot(df['fy'], df['current'], marker='o', label='Current')
ax.set_title('Funding trajectory')
ax.set_xlabel('Fiscal year')
ax.set_ylabel('USD millions')
ax.legend()

fig2, ax2 = plt.subplots()
sns.heatmap(
    df[['request', 'current', 'delta']].corr(),
    annot=True,
    cmap=sns.color_palette(['#F0F1F4', '#A85F42'], as_cmap=True),
    ax=ax2,
)
ax2.set_title('Funding correlation')

network = nx.Graph()
network.add_weighted_edges_from([
    ('client', 'office-a', 4),
    ('client', 'office-b', 2),
    ('office-a', 'committee', 3),
])
centrality = nx.degree_centrality(network)

results = {
    'findings': {
        'pearsonR': round(float(r), 6),
        'pearsonP': round(float(p_value), 6),
        'regressionSlope': round(float(model.params.iloc[1]), 6),
        'mostCentralNode': max(centrality, key=centrality.get),
    },
    'table': df.to_dict(orient='records'),
    'visuals': [
        {
            'chartType': 'line',
            'title': 'Funding trajectory',
            'description': 'Request and current funding by fiscal year.',
            'xKey': 'fy',
            'xAxisLabel': 'Fiscal year',
            'yAxisLabel': 'USD millions',
            'series': [
                {'dataKey': 'request', 'label': 'Request', 'valueFormat': 'currency'},
                {'dataKey': 'current', 'label': 'Current', 'valueFormat': 'currency'},
            ],
            'data': df[['fy', 'request', 'current']].to_dict(orient='records'),
        },
        {
            'chartType': 'waterfall',
            'title': 'Current funding movement versus request',
            'xKey': 'fy',
            'series': [{'dataKey': 'delta', 'label': 'Delta', 'valueFormat': 'currency'}],
            'data': df[['fy', 'delta']].to_dict(orient='records'),
        },
    ],
}
print(f"VISUAL_SMOKE:r={r:.4f};slope={model.params.iloc[1]:.4f};central={results['findings']['mostCentralNode']}")
`;

const fundingRows = [
  { fy: 2024, request: 120, current: 116 },
  { fy: 2025, request: 145, current: 151 },
  { fy: 2026, request: 172, current: 160 },
  { fy: 2027, request: 192.2, current: 169.5 },
];

interface SmokeResults {
  findings?: Record<string, unknown>;
  table?: unknown[];
  visuals?: Array<Record<string, unknown>>;
}

async function main(): Promise<void> {
  const result = await runSandboxed({
    code,
    datasets: [{ name: 'funding', rows: fundingRows }],
  });
  const structured = result.results as SmokeResults | null;
  const visuals = structured?.visuals ?? [];
  const pass =
    result.ok &&
    !result.timedOut &&
    result.images.length >= 2 &&
    Array.isArray(structured?.table) &&
    structured!.table!.length === fundingRows.length &&
    visuals.length === 2 &&
    visuals[0]?.chartType === 'line' &&
    visuals[1]?.chartType === 'waterfall' &&
    typeof structured?.findings?.regressionSlope === 'number' &&
    typeof structured?.findings?.mostCentralNode === 'string';

  // eslint-disable-next-line no-console
  console.log(
    `${pass ? 'PASS' : 'FAIL'} visual-analysis smoke — ` +
      `ok=${result.ok} images=${result.images.length} visuals=${visuals.length} ` +
      `duration=${result.durationMs}ms warnings=${result.warnings.length}`,
  );
  if (!pass) {
    // eslint-disable-next-line no-console
    console.error({
      stderr: result.stderr.slice(0, 1000),
      stdout: result.stdout.slice(0, 1000),
      results: result.results,
      warnings: result.warnings,
    });
  }
  process.exit(pass ? 0 : 1);
}

void main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
