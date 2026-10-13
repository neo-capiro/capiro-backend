import { createHash } from 'node:crypto';

// Inert source projection: all bytes and host configuration are caller supplied.
// These declarations are not a description or verification of the live ALB.
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const refuse = message => { throw new Error(`Newsletter declared edge refused: ${message}`); };
const sha256 = value => createHash('sha256').update(value).digest('hex');

export const DECLARED_NEWSLETTER_EDGE_PINS = freeze({
  repository: 'neo-capiro/capirov2',
  commit: '523ef9167f05a33efdbdfbbfc08d5fc2e2679012',
  sources: [
    { path: 'infra/cdk/lib/compute-stack.ts', bytes: 116860, sha256: '9297f3a0c7642433dba9f5ffa5a376490d427806e93c3c8790ef68bd1770debe' },
    { path: 'infra/cdk/lib/web-vnext-stack.ts', bytes: 9731, sha256: '07d385945b6a72ab8c71d26337922024106ea0dcd444144c474941527e40ea83' },
    { path: 'apps/web/nginx/nginx.conf', bytes: 3259, sha256: '57b7f4ac6b072c481bcc3695117f3917f50217447752949d07a8a3c4c9f43828' },
    { path: 'scripts/engagement-api-alb-rules.sh', bytes: 19102, sha256: '133d9067b5de66bb260f96c8a7af41d03c487210679ab71cedc4c30e3bc2e338' },
    { path: 'apps/api/src/engagement/newsletter-outreach.controller.ts', bytes: 5292, sha256: 'c7395dd8d1805d73ff5de5a82fdb83a5f4a85b855349cf607c68cdb3dd4b592d' },
    { path: 'apps/api/src/engagement/newsletter-outreach.service.ts', bytes: 25409, sha256: 'ad6f90090a601f7f89e3d4da5a51e4b0752567a649bb2c6e4b450c383028f522' },
    { path: 'apps/workspace/src/newsletters/newsletter.controller.ts', bytes: 16288, sha256: 'ae8a6453c04d0bab8ea81d717415c3747dbee0edc4d5eff9299df3e97fa576c7' },
    { path: 'apps/workspace/src/newsletters/newsletter.service.ts', bytes: 86320, sha256: '4a2d4c6234dd12bda4b787ed52211d405728c81e6b824afbaaefe382a7977583' },
    { path: 'packages/shared/src/newsletter-render.ts', bytes: 30096, sha256: 'b143df93036c87dbce9dc49a0e01f1f4bd3a7b6cf562b64608940bdea97c3f3c' },
  ],
});

export const runtimeAcceptanceRequirements = freeze({
  evidenceKind: 'requirements-only',
  realLiveVerified: false,
  fullyQualified: false,
  deployedServingVerified: false,
  nativeServingVerified: false,
  uiVerified: false,
  backendHeadVerified: false,
  gates: [
    { id: 'live-edge', operands: ['capture timestamp', 'explicit requested public host', 'DNS/TLS destination', 'actual HTTPS listener identity', 'complete ordered listener conditions and actions', 'target identities and deployed artifact identity'], accepts: 'No earlier rule shadows the intended static, API or Workspace target; managed CDK source alone cannot pass this gate.' },
    { id: 'static-assets', operands: ['all 179 pinned public paths', 'GET and HEAD at the edge', 'exact byte identity', 'MIME', 'nosniff', 'no redirect or login/SPA fallback', 'five historical security-header observations'], accepts: '358 asset measurements pass the static floor; four differing historical headers are separate parity evidence and are not by themselves a production routing defect.' },
    { id: 'capability-api', operands: ['ordinary recipient requests without a preview header or session', 'valid staged capability fixture approved for the target', 'GET archive', 'GET and POST unsubscribe/preferences/survey', 'exact survey block and answer query forwarding', 'invalid capability response', 'private HTML response headers'], accepts: 'Actual intended API handles the declared methods and query without preview routing, private authoring exposure, redirect or HTML shell fallback; a synthetic backend cannot prove capability/storage semantics.' },
    { id: 'upload-assets', operands: ['approved retained immutable asset fixture', '64 lowercase hex capability path', 'GET bytes and MIME', 'nosniff', 'immutable cache and restrictive CSP', 'invalid capability response'], accepts: 'Actual Workspace serves the approved public asset without a session; synthetic storage and auth are not evidence.' },
    { id: 'publication-origins', operands: ['explicit deployed API_PUBLIC_URL and WEB_PUBLIC_URL values supplied by the operator', 'generated ordinary image/link URLs', 'generated capability URLs', 'generated upload URLs', 'background image resolution at the archive document origin'], accepts: 'Resolve API then web then source fallback for capabilities, web then source fallback for uploads and ordinary assets; prove /newsletter serving at any alternate archive origin because the document background remains relative.' },
    { id: 'native-serving', operands: ['deployed web container identity', 'port 8080 request', '/healthz status and body', 'actual static server request path', 'backend target health'], accepts: 'The deployed service satisfies its native serving and health contract; a local gateway or direct Next 404 cannot pass or disprove the live-edge gate.' },
    { id: 'ui', operands: ['actual supported browser', 'authoring and recipient workflow results', 'reviewed layout and accessibility evidence'], accepts: 'Record separate browser evidence before claiming UI acceptance.' },
    { id: 'future-head', operands: ['actual backend HEAD behavior if separately required'], accepts: 'HEAD for dynamic API and uploaded capabilities is future compatibility work; these controllers declare GET/POST only.' },
  ],
});

const contracts = new WeakSet();
function capture(source, pattern, label) {
  const match = pattern.exec(source);
  if (!match) refuse(`pinned token pattern: ${label}`);
  return match;
}
function needs(source, literal, label) {
  if (!source.includes(literal)) refuse(`pinned token pattern: ${label}`);
}
function dnsHost(value, label, wildcard = false) {
  if (typeof value !== 'string' || value.length > 253 || !value.length) refuse(`${label} must be an explicit literal DNS host`);
  const host = wildcard && value.startsWith('*.') ? value.slice(2) : value;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) ||
      host.split('.').some(part => !part.length || part.length > 63 || part.startsWith('-') || part.endsWith('-')))
    refuse(`${label} must be an explicit literal DNS host`);
  if (wildcard && !value.startsWith('*.')) refuse(`${label} requires an explicit *. DNS pattern`);
  return value.toLowerCase();
}
function configHost(value, label, wildcard = false) {
  // Preserve the source's raw app/root inequality by accepting canonical config only.
  if (typeof value === 'string' && /[A-Z]/.test(value))
    refuse(`${label} configuration host must use canonical lowercase`);
  return dnsHost(value, label, wildcard);
}
function sourceHeaders(source) {
  const result = {};
  for (const match of source.matchAll(/'([^']+)'\s*:\s*(?:'([^']*)'|"([^"]*)")/g))
    result[match[1].toLowerCase()] = match[2] ?? match[3];
  return result;
}
function lineOf(source, index) { return source.slice(0, index).split('\n').length; }

function verifiedSourceTexts(sources) {
  if (!(sources instanceof Map) || sources.size !== DECLARED_NEWSLETTER_EDGE_PINS.sources.length)
    refuse('exact explicitly supplied source Map required');
  const sourceTexts = new Map();
  for (const pin of DECLARED_NEWSLETTER_EDGE_PINS.sources) {
    const bytes = sources.get(pin.path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256)
      refuse(`source pin mismatch: ${pin.path}`);
    sourceTexts.set(pin.path, bytes.toString('utf8'));
  }
  return sourceTexts;
}
function projectManagedRouting(compute, hosts, computePath) {
  const rules = [], outOfScopeRules = [];
  const action = (name, target, paths, hostPatterns, outside = false) => {
    const match = capture(compute, new RegExp(`httpsListener\\.addAction\\('${name}', \\{([\\s\\S]*?)\\n    \\}\\);`), name);
    const priority = Number(capture(match[1], /priority: (\d+),/, `${name} priority`)[1]);
    const targetGroup = capture(match[1], /action: elb\.ListenerAction\.forward\(\[this\.(\w+)\]\)/, `${name} target`)[1];
    const declaredPaths = paths ? [...capture(match[1], /pathPatterns\(\[([\s\S]*?)\]\)/, `${name} paths`)[1].matchAll(/'([^']+)'/g)].map(row => row[1]) : [];
    if (paths && declaredPaths.join('|') !== paths.join('|')) refuse(`${name} declared paths`);
    const rule = { name, priority, target, sourceTarget: targetGroup, paths: declaredPaths,
      hosts: hostPatterns ?? [], anyHost: !hostPatterns, source: { path: computePath, line: lineOf(compute, match.index) } };
    (outside ? outOfScopeRules : rules).push(rule);
  };
  action('ApiPaths', 'api', ['/api/*', '/webhooks/*', '/health']);
  action('WorkspaceApi', 'workspace', ['/workspace-api/*']);
  action('StrategyApi', 'unmatched', ['/strategy-api/*'], undefined, true);
  action('MeriApi', 'unmatched', ['/meri-api/*'], undefined, true);
  needs(compute, 'if (cfg.rootDomain !== cfg.appHost)', 'conditional marketing rule');
  if (hosts.rootDomain !== hosts.appHost)
    action('Marketing', 'marketing', undefined, [hosts.rootDomain, `www.${hosts.rootDomain}`]);
  action('WebDefault', 'web', undefined, [hosts.appHost, hosts.wildcardHost]);
  needs(compute, 'hostHeaders([cfg.appHost, cfg.wildcardHost])', 'web host expressions');
  needs(compute, 'cfg.rootDomain,\n            `www.${cfg.rootDomain}`', 'marketing host expressions');
  needs(compute, 'DO NOT assume this CDK ALB / its target groups / its listener', 'live drift caveat');
  needs(compute, '2026-06-27', 'drift date');
  const expected = { ApiPaths: [3, 'apiTargetGroup'], WorkspaceApi: [10, 'workspaceTargetGroup'],
    Marketing: [5, 'marketingTargetGroup'], WebDefault: [20, 'webTargetGroup'],
    StrategyApi: [12, 'apiStrategyTargetGroup'], MeriApi: [15, 'meriv2OrchestratorTargetGroup'] };
  for (const rule of [...rules, ...outOfScopeRules]) {
    if (rule.priority !== expected[rule.name][0] || rule.sourceTarget !== expected[rule.name][1])
      refuse(`${rule.name} declared priority/target`);
  }
  rules.sort((a, b) => a.priority - b.priority);
  outOfScopeRules.sort((a, b) => a.priority - b.priority);
  needs(compute, "defaultAction: elb.ListenerAction.fixedResponse(404", 'unmatched listener response');
  return { rules, outOfScopeRules };
}
function projectWebServing(compute, vnext, nginx) {
  needs(vnext, "hostHeaderConfig: { values: [props.hostname] }", 'vnext isolated host rule');
  needs(vnext, 'it does not create it.', 'full engagement flag routing caveat');
  if (vnext.includes("field: 'path-pattern'")) refuse('unexpected vnext path rule');
  const nginxPort = Number(capture(nginx, /listen (\d+) default_server;/, 'nginx port')[1]);
  const health = capture(nginx, /location = (\/healthz) \{[\s\S]*?return (\d+) "(ok\\n)";/, 'nginx health');
  needs(vnext, 'http://127.0.0.1:8080/healthz || exit 1', 'vnext container health');
  needs(compute, 'http://127.0.0.1:8080/healthz || exit 1', 'compute web container health');
  const staticHeaders = {};
  for (const match of nginx.matchAll(/add_header ([\w-]+) "([^"]+)" always;/g))
    if (!['cache-control', 'content-type'].includes(match[1].toLowerCase())) staticHeaders[match[1].toLowerCase()] = match[2];
  if (Object.keys(staticHeaders).length !== 5) refuse('five nginx server security headers');
  return {
    webVnext: { listenerModel: 'separate-imported-listener-host-rule', hostnameExpression: 'props.hostname',
      priorityExpression: 'props.listenerPriority', target: 'web-vnext', pathRuleDeclared: false,
      fullEngagementFlagCreatesPathRule: false, actualEngagementAlbRuleRequired: true },
    web: { port: nginxPort, health: { path: health[1], status: Number(health[2]), body: 'ok\n' },
      staticSecurityHeaders: staticHeaders, staticHeaderScope: 'nginx server headers inherited by /newsletter requests in location /',
      spaFallback: '/index.html', staticNewsletterCachePolicyDeclared: false },
  };
}
function projectManualPreview(manual) {
  const previewPath = capture(manual, /PREVIEW_PATH_PATTERN="([^"]+)"/, 'manual preview path')[1];
  const previewPriority = Number(capture(manual, /PREVIEW_RULE_PRIORITY="\$\{PREVIEW_RULE_PRIORITY:-(\d+)\}"/, 'manual default priority')[1]);
  const headerName = capture(manual, /PREVIEW_HEADER_NAME="\$\{PREVIEW_HEADER_NAME:-([^}]+)\}"/, 'manual default header')[1];
  const headerValue = capture(manual, /PREVIEW_HEADER_VALUE="\$\{PREVIEW_HEADER_VALUE:-([^}]+)\}"/, 'manual default header value')[1];
  needs(manual, 'values.length === 1 &&', 'exact manual path predicate');
  needs(manual, 'headers.length === 1 &&', 'exact manual header predicate');
  needs(manual, 'headers[0].values[0] === env.PREVIEW_HEADER_VALUE', 'exact manual header value predicate');
  needs(manual, '!hasRewrite(rule) &&', 'manual no rewrite');
  needs(manual, '!hasWeighting(rule)', 'manual no weighting');
  return { listenerModel: 'separate-manual-default-dark-preview', deployedRuleVerified: false,
    sourceDefaultsMayBeOverridden: true, priority: previewPriority, paths: [previewPath],
    headers: { [headerName.toLowerCase()]: headerValue }, conditionJoin: 'AND',
    target: 'engagement-api-preview', headerIsAuthorization: false, ordinaryRecipientHeaderPresent: false };
}
function projectCapabilityApis(publicSource, outreach, assetSource, workspace) {
  const publicController = publicSource.slice(publicSource.indexOf("@Controller('engagement/newsletter-public')"));
  if (!publicController.startsWith("@Controller('engagement/newsletter-public')")) refuse('public controller');
  const methods = [...publicController.matchAll(/@(Get|Post)\('(:token\/[^']+)'\)/g)]
    .map(row => ({ method: row[1].toUpperCase(), path: `/api/engagement/newsletter-public/${row[2]}`,
      query: row[2].endsWith('/survey') ? ['block', 'answer'] : [] }));
  if (methods.length !== 7 || /@Head\(/.test(publicController)) refuse('public declared GET/POST surface');
  needs(publicController, 'this.service.survey(token, query.block, query.answer, true)', 'survey POST query forwarding');
  const capabilityHeaders = sourceHeaders(publicController);
  const assetController = assetSource.slice(assetSource.indexOf("@Controller('newsletters/assets/file')"));
  needs(assetController, "@Get(':token')", 'asset GET');
  const uploadHeaders = sourceHeaders(assetController);
  uploadHeaders['content-type'] = 'asset.mimeType';
  needs(workspace, '!/^[a-f0-9]{64}$/.test(token)', 'upload capability token');
  needs(outreach, '!/^[a-f\\d]{64}$/.test(token)', 'public capability token');
  return {
    capabilities: { methods, tokenPattern: '^[a-f0-9]{64}$', headers: capabilityHeaders,
      currentHeadDeclared: false, validTokenRequiresStagedPublishedDelivery: true,
      getDoesNotConfirmMutation: true, postConfirmsMutation: true },
    uploads: { methods: [{ method: 'GET', path: '/workspace-api/newsletters/assets/file/:token' }],
      tokenPattern: '^[a-f0-9]{64}$', headers: uploadHeaders, currentHeadDeclared: false },
  };
}
function projectPublication(outreach, workspace, renderer, rendererPath) {
  needs(outreach, "process.env.API_PUBLIC_URL || process.env.WEB_PUBLIC_URL || 'https://app.capiro.ai'", 'public origin precedence');
  needs(outreach, "publicUrl: process.env.WEB_PUBLIC_URL || 'https://app.capiro.ai'", 'renderer origin precedence');
  needs(workspace, "(this.env.get<string>('WEB_PUBLIC_URL') || 'https://app.capiro.ai').replace(/\\/$/, '')", 'upload origin precedence');
  needs(renderer, "if (url.startsWith('/newsletter/') && options.publicUrl)", 'ordinary link origin');
  needs(renderer, "if (safe.startsWith('/newsletter/') && options.publicUrl)", 'ordinary image origin');
  needs(renderer, 'newsletterCssUrl(styles.backgroundImage)', 'raw document background');
  return { fallback: 'https://app.capiro.ai', capabilityPrecedence: ['API_PUBLIC_URL', 'WEB_PUBLIC_URL', 'fallback'],
    assetPrecedence: ['WEB_PUBLIC_URL', 'fallback'], ordinaryImageAndLinkUsesPublicUrl: true,
    backgroundImageUsesPublicUrl: false, backgroundImageResolution: 'archive-document-origin',
    source: { path: rendererPath, line: lineOf(renderer, renderer.indexOf('newsletterCssUrl(styles.backgroundImage)')) } };
}

export function projectDeclaredNewsletterEdge({ sources, appHost, rootDomain, wildcardHost } = {}) {
  const sourceTexts = verifiedSourceTexts(sources);
  const hosts = { appHost: configHost(appHost, 'appHost'), rootDomain: configHost(rootDomain, 'rootDomain'),
    wildcardHost: configHost(wildcardHost, 'wildcardHost', true) };
  const [computePath, vnextPath, nginxPath, manualPath, publicPath, outreachPath, assetPath, workspacePath, rendererPath] =
    DECLARED_NEWSLETTER_EDGE_PINS.sources.map(pin => pin.path);
  const [compute, vnext, nginx, manual, publicSource, outreach, assetSource, workspace, renderer] =
    [computePath, vnextPath, nginxPath, manualPath, publicPath, outreachPath, assetPath, workspacePath, rendererPath]
      .map(path => sourceTexts.get(path));
  const contract = freeze({
    schemaVersion: 1, evidenceKind: 'pinned-source-declaration', realLiveVerified: false,
    fullyQualified: false, deployedServingVerified: false, nativeServingVerified: false, uiVerified: false,
    provenance: { ...DECLARED_NEWSLETTER_EDGE_PINS, sourceBytesVerified: true,
      liveDriftWarningDeclared: true, liveDriftCommentDate: '2026-06-27' },
    listenerModel: 'managed-compute-cdk-only', hosts, ...projectManagedRouting(compute, hosts, computePath), unmatchedStatus: 404,
    manualPreview: projectManualPreview(manual),
    ...projectWebServing(compute, vnext, nginx),
    ...projectCapabilityApis(publicSource, outreach, assetSource, workspace),
    publication: projectPublication(outreach, workspace, renderer, rendererPath),
    runtimeAcceptanceRequirements,
  });
  contracts.add(contract);
  return contract;
}

function literalRequest(contract, request) {
  if (!contracts.has(contract)) refuse('projected contract instance required');
  if (!request || typeof request !== 'object' || Array.isArray(request)) refuse('literal request required');
  const host = dnsHost(request.host, 'request host');
  const path = request.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
      /[^\x21-\x7e]|[\\#]/.test(path) || /%(?![a-f\d]{2})/i.test(path)) refuse('literal request path required');
  const pathname = path.split('?', 1)[0];
  if (/\/\//.test(pathname) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname) ||
      /%(?:2e|2f|5c|00|0a|0d)/i.test(pathname)) refuse('ambiguous request path normalization');
  const headers = request.headers ?? {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(headers))) refuse('literal header object required');
  const lower = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~a-z0-9-]+$/i.test(name) || typeof value !== 'string' || /[^\x20-\x7e]/.test(value) ||
        Object.hasOwn(lower, name.toLowerCase())) refuse('literal unambiguous headers required');
    lower[name.toLowerCase()] = value;
  }
  return { host, pathname, headers: lower };
}
function patternMatches(pattern, value) {
  if (!pattern.includes('*')) return pattern === value;
  const parts = pattern.split('*');
  return value.startsWith(parts[0]) && value.endsWith(parts[1]) && value.length >= parts[0].length + parts[1].length;
}
export function selectDeclaredNewsletterTarget(contract, request) {
  const { host, pathname } = literalRequest(contract, request);
  for (const rule of [...contract.rules, ...contract.outOfScopeRules].sort((a, b) => a.priority - b.priority)) {
    if (rule.paths.length && !rule.paths.some(pattern => patternMatches(pattern, pathname))) continue;
    if (rule.hosts.length && !rule.hosts.some(pattern => patternMatches(pattern, host))) continue;
    return rule.target;
  }
  return 'unmatched';
}
export function matchesDeclaredNewsletterManualPreview(contract, request) {
  const { pathname, headers } = literalRequest(contract, request);
  return contract.manualPreview.paths.some(pattern => patternMatches(pattern, pathname)) &&
    Object.entries(contract.manualPreview.headers).every(([name, value]) => headers[name] === value);
}

// Reproduce source string precedence and single trailing-slash removal exactly.
// Configured values are explicit inputs, not read from an environment or URL parser.
export function resolveNewsletterPublicationOrigins({ apiPublicUrl, webPublicUrl } = {}) {
  for (const value of [apiPublicUrl, webPublicUrl])
    if (value !== undefined && typeof value !== 'string') refuse('publication values must be explicitly supplied strings or absent');
  const fallback = 'https://app.capiro.ai';
  const capabilityOrigin = (apiPublicUrl || webPublicUrl || fallback).replace(/\/$/, '');
  const assetOrigin = (webPublicUrl || fallback).replace(/\/$/, '');
  return freeze({ capabilityOrigin, assetOrigin, rendererPublicUrl: webPublicUrl || fallback,
    capabilityBaseUrl: `${capabilityOrigin}/api/engagement/newsletter-public`,
    uploadBaseUrl: `${assetOrigin}/workspace-api/newsletters/assets/file`,
    relativeBackgroundImageBase: 'archive-document-origin', usesSourceFallback: !apiPublicUrl && !webPublicUrl,
    realLiveVerified: false });
}
