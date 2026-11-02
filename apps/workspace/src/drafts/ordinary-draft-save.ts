// Compatibility entry for ordinary drafts. The same snapshot/receipt owner
// also serves prospect drafts through their separate source-authorized facade.
export {
  readAtomicDraftState as ordinaryDraftState,
  saveAtomicDraft as saveOrdinaryDraft,
} from './atomic-draft-save.js';
