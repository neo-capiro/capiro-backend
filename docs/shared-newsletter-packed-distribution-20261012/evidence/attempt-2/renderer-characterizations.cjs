/* Fixed synthetic corpus. Expected outputs are captured from original C source first. */
function characterize(news, render) {
  const results = [];
  const add = (name, value) => results.push({ name, value });
  const config = { ...news.defaultNewsletterConfig(), subject: 'Policy <brief>', company: 'Example firm',
    fromName: 'Policy team', mailingAddress: '10 Example Lane', permissionReminder: 'Opted in.',
    previewText: 'Preview & details' };
  const recipient = { id: 'synthetic', email: 'ada@example.test', firstName: 'Ada <&>', lastName: 'Lovelace',
    company: 'Example Co', phone: '', address: '', birthday: '', client: 'synthetic-client', tags: ['policy'], subscribed: true };
  const block = (kind, overrides = {}) => news.createNewsletterBlock(kind, { id: `test-${kind}`, ...overrides });
  const design = (blocks) => ({ version: 1, styles: news.defaultNewsletterStyles(),
    sections: [{ id: 'section', name: 'Synthetic', style: {}, blocks }] });
  const mergeOptions = { liveMergeTags: true, recipient, archiveUrl: 'https://example.test/archive',
    unsubscribeUrl: 'https://example.test/unsubscribe', preferencesUrl: 'https://example.test/preferences' };
  add('public runtime names/newsletter', Object.keys(news).sort());
  add('public runtime names/renderer', Object.keys(render).sort());
  add('existing default configuration', news.defaultNewsletterConfig());
  add('existing default brand kit', news.defaultNewsletterBrandKit());
  add('node ids remain document-local lazy time/random', news.newsletterId());
  for (const value of ['https://example.test/a?x=1&y=2', 'https://u:p@example.test/', 'javascript:alert(1)',
    '/newsletter/capitol.svg', '#anchor', '*|ARCHIVE|*', 'mailto:ada@example.test', 'tel:+15555550100',
    '//example.test/a', 'data:image/png;base64,YQ==', 'https://', '']) {
    add(`safe link/${value}`, render.newsletterSafeUrl(value));
    add(`safe image/${value}`, render.newsletterSafeUrl(value, true));
  }
  add('escaping special characters', render.newsletterEscape(`<a title="x">O'Reilly & Co</a>`));
  add('merge tags disabled retain legacy tags', render.newsletterMergeText('*|FNAME|* *|CURRENT_YEAR|* *|UNKNOWN|*', config));
  add('merge tags live preserve unknown tags', render.newsletterMergeText('*|FNAME|* *|LNAME|* *|EMAIL|* *|CURRENT_YEAR|* *|UNKNOWN|*', config, mergeOptions));
  add('style clamping and fixed catalog', render.newsletterStyleCss({ fontFamily: 'DM Sans', fontSize: 99999,
    width: -10, lineHeight: 9, paddingTop: -3, radiusTopLeft: 2000, color: '#abc', background: 'url(evil)',
    align: 'right', bold: true, italic: false }));
  add('font catalog known and unknown', [news.newsletterCatalogFont('DM Sans'), news.newsletterCatalogFont('unknown') ?? null]);
  add('bundled legacy SVG remapping', ['capitol', 'policy-desk', 'newsroom', 'social-update', 'other']
    .map(x => render.newsletterBundledImageUrl(`/newsletter/${x}.svg`)));
  add('custom fonts retain filter and CSS escaping', render.newsletterFontCss([
    { id: 'f', name: 'Synthetic', family: 'CapiroFont-11111111-1111-4111-8111-111111111111', format: 'woff2', url: "https://example.test/font('x').woff2" },
    { id: 'bad', name: 'Bad', family: 'unknown', format: 'woff2', url: 'javascript:bad' },
  ]));
  const conditional = block('paragraph', { text: 'Policy audience only', visibility: { mode: 'custom',
    rules: [{ field: 'tags', operator: 'contains', value: 'POLICY' }] } });
  for (const operator of ['is', 'is-not', 'contains', 'does-not-contain', 'is-empty', 'is-not-empty']) {
    const conditionalRule = block('paragraph', { visibility: { mode: 'custom', rules: [{ field: 'company', operator, value: 'Example Co' }] } });
    add(`visibility operator/${operator}`, news.newsletterBlockVisible(conditionalRule, recipient));
  }
  add('visibility without recipient denies', render.renderNewsletterBlock(conditional, design([conditional]), config));
  add('visibility authorized recipient', render.renderNewsletterBlock(conditional, design([conditional]), config, mergeOptions));
  add('editor shows conditional block', render.renderNewsletterBlock(conditional, design([conditional]), config, { editor: true }));
  for (const kind of news.NEWSLETTER_BLOCK_KINDS) {
    const item = block(kind, { text: 'Text *|FNAME|*', imageUrl: '/newsletter/capitol.svg', alt: '<image>',
      url: 'https://example.test/article', items: [{ label: 'Item & details', url: 'https://example.test/product',
        description: 'Description', price: '$12', imageUrl: '/newsletter/newsroom.svg' }],
      columns: kind === 'columns' ? [[block('paragraph', { id: 'nested-left', text: 'Left' })], [block('paragraph', { id: 'nested-right', text: 'Right' })]] : [] });
    add(`block kind/${kind}`, render.renderNewsletterBlock(item, design([item]), config, { ...mergeOptions, publicUrl: 'https://app.example.test/' }));
  }
  const rich = block('paragraph', { html: '<a href="https://example.test/" style="color:red">*|FNAME|*</a>' });
  const callbacks = [];
  add('rich fallback escapes HTML', render.renderNewsletterBlock(rich, design([rich]), config, mergeOptions));
  add('explicit sanitizer remains caller policy', render.renderNewsletterBlock(rich, design([rich]), config,
    { ...mergeOptions, sanitizeHtml: value => { callbacks.push(['sanitize', value]); return value; } }));
  const image = block('image', { imageUrl: '/newsletter/capitol.svg', alt: 'Capitol', url: 'https://example.test/article',
    imageSize: 'scale', imageScale: 42, crop: { x: 10, y: 20, width: 16, height: 9 }, style: { width: 99, align: 'center' } });
  add('image sizing crop asset and rewrite callback', render.renderNewsletterBlock(image, design([image]), config,
    { publicUrl: 'https://app.example.test/', rewriteLink: (url, id) => { callbacks.push(['rewrite', url, id]); return `https://track.example.test/?url=${encodeURIComponent(url)}`; } }));
  const saved = block('survey', { text: 'Start survey', survey: { kind: 'saved-survey', saved: { id: 'synthetic-survey', name: 'Survey' }, blockBackground: '#abc', paddingLinked: false } });
  add('saved survey no callback disabled', render.renderNewsletterBlock(saved, design([saved]), config));
  add('saved survey authorized caller callback', render.renderNewsletterBlock(saved, design([saved]), config,
    { savedSurveyUrl: id => { callbacks.push(['savedSurvey', id]); return 'https://example.test/survey'; } }));
  const oldSurvey = block('survey', { survey: undefined, question: 'Legacy question?', options: ['Yes', 'No'] });
  add('legacy survey callbacks preserved', render.renderNewsletterBlock(oldSurvey, design([oldSurvey]), config,
    { surveyUrl: (id, answer) => { callbacks.push(['survey', id, answer]); return `https://example.test/${answer}`; } }));
  add('callback arguments and order', callbacks);
  for (const target of ['https://example.test/public?a=1', 'https://example.test/engagement/newsletter-public/token',
    'https://example.test/engagement/%6eewsletter-public/token', 'https://u:p@example.test/', '*|ARCHIVE|*', 'javascript:bad']) {
    add(`social target/${target}`, render.newsletterSocialShareTarget(target));
    for (const platform of ['facebook', 'linkedin', 'pinterest', 'twitter', 'instapaper', 'forward'])
      add(`social url/${platform}/${target}`, render.newsletterSocialShareUrl(platform, target));
  }
  const social = block('social');
  social.social.mode = 'share';
  social.social.share = news.defaultNewsletterSocialShare();
  social.social.share.source = 'custom';
  social.social.share.customUrl = 'https://example.test/public';
  social.linkedStyles = false;
  add('share block and mobile styles', render.renderNewsletterDesign(design([social]), config, { publicUrl: 'https://app.example.test' }));
  const full = design([block('heading', { text: 'Hello *|FNAME|*', headingLevel: 1, style: { fontFamily: 'DM Sans' } }),
    rich, image, conditional, saved, block('footer')]);
  full.styles.linkedStyles = false;
  full.styles.mobileText.p = { fontSize: 16, paddingLeft: 3 };
  add('full rich document rendering', render.renderNewsletterDesign(full, config, mergeOptions));
  add('full plain text rendering', render.newsletterPlainText(full, config, { ...mergeOptions, savedSurveyUrl: () => 'https://example.test/survey' }));
  add('government affairs original template', render.renderNewsletterDesign(news.governmentAffairsNewsletter(), config));
  add('column layout original template', render.renderNewsletterDesign(news.createNewsletterLayout(3), config));
  add('code layout original template', render.renderNewsletterDesign(news.createNewsletterLayout(1, true), config));
  return results;
}
module.exports = { characterize };
