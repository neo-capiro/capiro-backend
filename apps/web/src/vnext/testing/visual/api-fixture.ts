import axios, { AxiosError } from 'axios';

// Seeded React Query data supplies the fixtures. Unseeded reads and every
// mutation fail locally, so capturing or clicking a fixture cannot send HTTP.
const api = axios.create({
  adapter: async (config) => {
    throw new AxiosError(
      'API unavailable in offline visual fixtures',
      'ERR_VISUAL_FIXTURE',
      config,
    );
  },
});

export const useApi = () => api;
