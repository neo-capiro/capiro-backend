/**
 * Fixed parity corpus (SC0.3): N >= 20 representative requests PER SURFACE.
 * Generated deterministically so the corpus is stable across runs.
 */
export interface InEditorFixture {
  id: string;
  dto: {
    messages: Array<{ role: 'user'; text: string }>;
    document: { title: string; sections: Array<{ name: string; content: string }> };
    clientId: string;
  };
}

export interface WorkspaceGenFixture {
  id: string;
  tenantId: string;
  draftId: string;
}

const PROMPTS = [
  'tighten the ask',
  'improve the district nexus',
  'draft the situation section',
  'ground this claim in an official source',
  'summarize the markup status',
  'rewrite for a formal tone',
  'add a risks paragraph',
  'check the PE appropriation type',
];
const SECTIONS = ['Situation', 'Recommendation', 'Background', 'Ask', 'Nexus', 'Risks'];

export const inEditorFixtures: InEditorFixture[] = Array.from({ length: 20 }, (_, i) => {
  const prompt = PROMPTS[i % PROMPTS.length] ?? PROMPTS[0] ?? 'draft';
  const section = SECTIONS[i % SECTIONS.length] ?? SECTIONS[0] ?? 'Situation';
  return {
    id: `in-editor-${i + 1}`,
    dto: {
      messages: [{ role: 'user', text: `${prompt} (case ${i + 1})` }],
      document: {
        title: `Strategy Memo ${i + 1}`,
        sections: [{ name: section, content: '<p>Draft body…</p>' }],
      },
      clientId: `client-${(i % 5) + 1}`,
    },
  };
});

export const workspaceGenFixtures: WorkspaceGenFixture[] = Array.from({ length: 20 }, (_, i) => ({
  id: `workspace-gen-${i + 1}`,
  tenantId: `tenant-${(i % 3) + 1}`,
  draftId: `draft-${i + 1}`,
}));
