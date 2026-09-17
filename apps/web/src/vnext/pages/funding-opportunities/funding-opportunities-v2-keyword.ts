export interface FundingOpportunityV2KeywordController {
  update(value: string, commit: (value: string) => void): void;
  commit(value: string, commit: (value: string) => void): void;
  cancel(): void;
  dispose(): void;
}

export function createFundingOpportunityV2KeywordController(delayMs = 300): FundingOpportunityV2KeywordController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    update(value, commit) {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        commit(value);
      }, delayMs);
    },
    commit(value, commit) {
      cancel();
      commit(value);
    },
    cancel,
    dispose: cancel,
  };
}
