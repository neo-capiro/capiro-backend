import axios, { AxiosError } from 'axios';
import {
  FIXTURE_WORKSPACES,
  FIXTURE_CONTEXT_PACKET,
  FIXTURE_CHART_ARTIFACT,
  FIXTURE_SKILLS,
  FIXTURE_SAVED_PROMPTS,
} from './meri-visual-fixture.js';

/**
 * Meri-only API fixture. Used ONLY by the Meri visual harness
 * (vnext-meri-visual.html) via the `?meri=1` alias path — the shared
 * api-fixture.ts keeps its original reject-everything contract for every
 * other visual screen, so their behavior is unchanged.
 *
 * Read-only GETs the Meri surfaces issue through react-query/effects resolve
 * from the fixture below; mutations and unlisted reads still reject, so the
 * harness can never send HTTP.
 */
const READ_FIXTURES: Array<{ match: RegExp; data: unknown }> = [
  { match: /\/api\/clio\/vnext\/workspaces$/, data: { workspaces: FIXTURE_WORKSPACES } },
  { match: /\/api\/clio\/vnext\/saved-prompts$/, data: { prompts: FIXTURE_SAVED_PROMPTS } },
  { match: /\/api\/clio\/v3\/skills$/, data: FIXTURE_SKILLS },
  { match: /\/api\/clio\/v3\/apps$/, data: { apps: [] } },
  { match: /\/api\/clio\/v3\/conversations\/[^/]+\/reasoning-mode$/, data: { reasoningMode: 'standard' } },
  { match: /\/api\/memory\/review\/candidates$/, data: { candidates: [] } },
  { match: /\/api\/memory\/proposals$/, data: { proposals: [] } },
  { match: /\/api\/clio\/context-packets\/conversation\/[^/]+\/latest$/, data: FIXTURE_CONTEXT_PACKET },
  { match: /\/api\/clio\/context-packets\/[^/]+$/, data: FIXTURE_CONTEXT_PACKET },
  { match: /\/api\/clio\/analysis-artifacts\/[^/]+$/, data: FIXTURE_CHART_ARTIFACT },
];

const api = axios.create({
  adapter: async (config) => {
    const url = config.url ?? '';
    const method = (config.method ?? 'get').toLowerCase();
    if (method === 'get') {
      for (const fixture of READ_FIXTURES) {
        if (fixture.match.test(url)) {
          return {
            data: fixture.data,
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
          };
        }
      }
    }
    throw new AxiosError(
      'API unavailable in offline visual fixtures',
      'ERR_VISUAL_FIXTURE',
      config,
    );
  },
});

export const useApi = () => api;
