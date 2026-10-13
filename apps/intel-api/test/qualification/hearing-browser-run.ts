/**
 * Explicit local qualification only. Uses the production gateway, transcript
 * store, recording store, immutable S3 sink and browser upload transport.
 * The localhost fixture identity replaces Clerk login; it never creates
 * production users or writes the production database. Meri is an injected
 * outage here, so this run cannot qualify model latency or client delivery.
 */
import 'reflect-metadata';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ConfigService } from '@nestjs/config';
import ts from 'typescript';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { HearingSessionService } from '../../src/hearing/hearing-session.service.js';
import { HearingWsTicketService } from '../../src/hearing/hearing-ws-ticket.service.js';
import { HearingCryptoService } from '../../src/hearing/hearing-crypto.service.js';
import { SegmentCommitService } from '../../src/hearing/segment-commit.service.js';
import { HearingGateway } from '../../src/hearing/hearing.gateway.js';
import { RecordingStorageService } from '../../src/hearing/recording/recording-storage.service.js';
import { RecordingPermissionService } from '../../src/hearing/recording/recording-permission.service.js';
import { HearingRecordingService } from '../../src/hearing/recording/recording.service.js';
import { RecordingAssemblyWorker } from '../../src/hearing/recording/recording-assembly.worker.js';
import { HearingAnalysisService } from '../../src/hearing/recording/hearing-analysis.service.js';
import { verifyWsOrigin } from '../../src/hearing/ws-origin.js';

async function main() {
  const db = new URL(process.env.DATABASE_URL ?? '');
  if (
    process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
    !['localhost', '127.0.0.1'].includes(db.hostname)
  )
    throw new Error('Local disposable database required');
  if (
    !process.env.DEEPGRAM_API_KEY ||
    !process.env.PHASE4_QUALIFICATION_OUTPUT ||
    !process.env.PLAYWRIGHT_MODULE
  )
    throw new Error('Explicit qualification environment required');
  const minutes = Number(process.env.PHASE4_QUALIFICATION_MINUTES ?? '3');
  if (!Number.isFinite(minutes) || minutes < 2 || minutes > 260)
    throw new Error('Duration must be 2..260 actual minutes');
  const out = resolve(process.env.PHASE4_QUALIFICATION_OUTPUT);
  mkdirSync(out, { recursive: true });
  const events = join(out, 'events.jsonl');
  const log = (event: string, data: unknown = {}) =>
    appendFileSync(events, JSON.stringify({ at: new Date().toISOString(), event, data }) + '\n');
  const p = new PrismaService({ transactionOptions: { maxWait: 10_000, timeout: 10_000 } });
  const config = new ConfigService(),
    sessions = new HearingSessionService(p),
    tickets = new HearingWsTicketService(p);
  const storage = new RecordingStorageService(config),
    crypto = new HearingCryptoService(config),
    commit = new SegmentCommitService(p, crypto);
  if (process.env.PHASE4_INJECT_STORAGE_REPLY_LOSS === 'true') {
    const put = storage.put.bind(storage);
    let writes = 0;
    storage.put = async (...args: Parameters<RecordingStorageService['put']>) => {
      await put(...args);
      if (++writes === 40) {
        log('injected_storage_reply_loss');
        throw Object.assign(new Error('Controlled lost S3 success reply'), { name: 'AbortError' });
      }
    };
  }
  const tenantId = randomUUID(),
    userId = 'owned-qualification-' + randomUUID();
  const internalUserId = randomUUID();
  await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenantId}::uuid,${'owned-browser-' + tenantId},'Owned browser test')`;
  await p.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${internalUserId}::uuid,${userId},${userId + '@example.invalid'})`;
  await p.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenantId}::uuid,${internalUserId}::uuid,'standard_user','active')`;
  await p.featureFlag.create({
    data: { tenantId, feature: 'legiwatch_hearing_recording_v1', enabled: true },
  });
  const flags = { isEnabled: async (_feature: string, tenant: string) => tenant === tenantId };
  const permissions = new RecordingPermissionService(p, flags as any, storage);
  const recording = new HearingRecordingService(p, sessions, permissions, storage);
  const orchestrator = {
    extract: async () => {
      throw new Error('Controlled Meri outage');
    },
  };
  const analysis = new HearingAnalysisService(p, crypto, commit, orchestrator as any);
  const gateway = new HearingGateway(
    {} as any,
    flags as any,
    sessions,
    tickets,
    commit,
    { matchAndPersist: async () => 0 } as any,
    orchestrator as any,
    { linkSession: async () => ({ combined: 0 }) } as any,
    { promoteMatches: async () => ({ alerts: 0 }) } as any,
    config,
    recording,
    analysis,
  );
  const port = 5197,
    origin = 'http://127.0.0.1:' + port;
  const startupFailure = process.env.PHASE4_QUALIFICATION_START_FAILURE === 'true';
  if (startupFailure) {
    if (minutes >= 240) throw Error('Startup failure injection is a separate short qualification');
    Object.assign(gateway, { deepgramApiKey: 'owned-qualification-intentionally-invalid-key' });
  }
  const permission = await p.hearingMediaPermission.create({
    data: {
      tenantId,
      sourceUrl: origin + '/source',
      mode: 'browser',
      operations: ['capture', 'transcription', 'retention', 'analysis'],
      evidence:
        'Owned synthesized speech and tone created for this isolated qualification; no hearing publisher material.',
      reviewedBy: userId,
      retentionDays: 1,
      expiresAt: new Date(Date.now() + 86400_000),
    },
  });
  const session = await p.liveHearingSession.create({
    data: {
      tenantId,
      createdBy: userId,
      title: 'Owned browser qualification',
      sourceType: 'meeting',
      audioSource: 'browser_mic',
      sourceUrl: origin + '/source',
      recordingPolicy: 'transcript_only',
      consentStatus: 'confirmed',
      issueIds: [],
      billIds: [],
      programElementIds: [],
      agencyIds: [],
    },
  });
  await recording.enable(tenantId, session.id, userId);
  const transport = ts.transpileModule(
    readFileSync(resolve('test', 'qualification', 'hearing-recording-transport.ts'), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
  ).outputText;
  const sourceHtml =
    '<title>LegiWatch owned source</title><button id="play">Play owned synthetic source</button><audio id="speech" src="/speech.wav"></audio><script>play.onclick=async()=>{window.context=new AudioContext();await context.resume();const tone=context.createOscillator();window.gain=context.createGain();gain.gain.value=.001;tone.connect(gain).connect(context.destination);tone.start();window.recess=false;window.started=Date.now();await speech.play();setInterval(()=>{if(!window.recess){speech.currentTime=0;speech.play()}},60000);window.ready=true};window.setRecess=enabled=>{window.recess=enabled;if(enabled)speech.pause();gain.gain.value=enabled?0:.001}</script>';
  const captureHtml = `<title>LegiWatch browser recording qualification</title>
    <button id="start">Select owned source and start capture</button><button id="stop">Stop and save final audio</button>
    <p id="status">Idle</p><audio id="reopened" controls></audio>
    <script type="module">
    import {HearingRecordingTransport} from '/transport.js';
    window.metrics={saved:0,maxBacklog:0,lag:[],events:[],tracks:null};window.phase='idle';
    const event=(type,data={})=>{metrics.events.push({type,at:Date.now(),...data});document.getElementById('status').textContent=type;fetch('/event',{method:'POST',body:JSON.stringify({type,...data})})};
    let socket,recorder,stream,transport,epoch,startClock,chain=Promise.resolve(),stopping=false;
    async function start(){
      stopping=false;window.phase='selecting';
      stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
      metrics.tracks={audio:stream.getAudioTracks().map(t=>t.getSettings()),video:stream.getVideoTracks().map(t=>t.getSettings())};
      if(!stream.getAudioTracks().length)throw Error('Selected source has no audio');
      stream.getVideoTracks().forEach(t=>t.stop());
      const ticket=await (await fetch('/ticket',{method:'POST'})).json();
      socket=new WebSocket('ws://'+location.host+'/intel-api/live?sessionId=${session.id}&ticket='+encodeURIComponent(ticket.ticket));
      window.socket=socket;
      socket.onmessage=e=>{
        const m=JSON.parse(e.data);
        if(m.type==='recording_epoch')epoch=m;
        if(m.type==='audio_saved'){transport?.acknowledge(m);metrics.saved=m.durableBytes;metrics.lag.push(performance.now()-startClock-(m.durableEndMs-epoch.startMs));}
        if(m.type==='error')event(m.code||'error');
        if(m.type==='final')event('final',{id:m.segmentId,startMs:m.segment.startMs,endMs:m.segment.endMs});
        if(m.type==='status'&&m.status==='connected')socket.send(JSON.stringify({type:'capture_start',mimeType:'audio/webm;codecs=opus',recordingProtocol:1,displaySurface:'browser'}));
        if(m.type==='status'&&m.status==='capture_ready'){
          if(!epoch)throw Error('Missing durable epoch');
          transport=new HearingRecordingTransport(socket,epoch.epochId,()=>{});
          recorder=new MediaRecorder(new MediaStream(stream.getAudioTracks()),{mimeType:'audio/webm;codecs=opus',audioBitsPerSecond:64000});
          startClock=performance.now();chain=Promise.resolve();
          recorder.ondataavailable=e=>{if(!e.data.size)return;const pending=transport.enqueue(e.data,performance.now()-startClock);metrics.maxBacklog=Math.max(metrics.maxBacklog,transport.backlogBytes);chain=pending.catch(err=>{if(window.phase!=='closed')event('save_failed',{message:err.message});socket.close();throw err});chain.catch(()=>{});};
          recorder.start(500);window.phase='capturing';event('capture_started',{epochId:epoch.epochId,tracks:metrics.tracks});
        }
        if(m.type==='status'&&['ended','failed'].includes(m.status)){window.phase='stopped';event(m.status);}
      };
      socket.onclose=()=>{if(recorder?.state==='recording')recorder.stop();stream?.getTracks().forEach(t=>t.stop());transport?.stop();window.phase='closed';event('socket_closed');};
      stream.getAudioTracks()[0].onended=()=>{event('selected_source_ended');socket.close();};
    }
    async function stop(){
      if(stopping)return;stopping=true;
      if(recorder?.state==='recording')await new Promise(r=>{recorder.onstop=r;recorder.stop()});
      await chain;await transport?.drain();
      socket.send(JSON.stringify({type:'capture_stop',finalSequence:transport.finalSequence}));
      stream?.getTracks().forEach(t=>t.stop());
    }
    document.getElementById('start').onclick=()=>start().catch(e=>{event('start_failed',{message:e.message});window.phase='failed'});
    document.getElementById('stop').onclick=()=>stop().catch(e=>event('stop_failed',{message:e.message}));
    window.stopCapture=stop;
    </script>`;
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.host !== '127.0.0.1:' + port) {
        res.writeHead(403).end();
        return;
      }
      if (req.url === '/speech.wav') {
        res.setHeader('Content-Type', 'audio/wav');
        res.end(readFileSync(process.env.PHASE4_OWNED_SPEECH!));
        return;
      }
      if (req.url === '/transport.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(transport);
        return;
      }
      if (req.url === '/ticket' && req.method === 'POST') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(await tickets.mint(tenantId, userId, session.id)));
        return;
      }
      if (req.url === '/event' && req.method === 'POST') {
        let body = '';
        for await (const part of req) {
          body += part;
          if (body.length > 10000) throw Error('Event too large');
        }
        log('browser', JSON.parse(body));
        res.end('{}');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(req.url === '/source' ? sourceHtml : captureHtml);
    } catch {
      res.writeHead(500).end('Qualification request failed');
    }
  });
  const ws = new WebSocketServer({
    server,
    path: '/intel-api/live',
    maxPayload: 1_000_000,
    verifyClient: verifyWsOrigin,
  });
  ws.on('connection', (client, request) => {
    void gateway.handleConnection(client, request);
    client.on('close', () => void gateway.handleDisconnect(client));
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const require = createRequire(resolve('package.json')),
    { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    ignoreDefaultArgs: ['--mute-audio'],
    args: [
      '--auto-select-tab-capture-source-by-title=LegiWatch owned source',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-usermedia-screen-capturing',
    ],
  });
  const context = await browser.newContext(),
    source = await context.newPage(),
    page = await context.newPage();
  const started = Date.now();
  const sourceFiles = [
    'src/hearing/hearing.gateway.ts',
    'src/hearing/deepgram-stream.manager.ts',
    'src/hearing/segment-commit.service.ts',
    'src/hearing/recording/recording.service.ts',
    'src/hearing/recording/recording-storage.service.ts',
    'src/hearing/recording/recording-assembly.worker.ts',
    'test/qualification/hearing-recording-transport.ts',
  ];
  const sourceHashes = Object.fromEntries(
    sourceFiles.map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(resolve(path)))
        .digest('hex'),
    ]),
  );
  const metadata = {
    startedAt: new Date(started).toISOString(),
    requestedMinutes: minutes,
    startupFailure,
    browser: browser.version(),
    os: process.platform,
    sourceHashes,
    tenantId,
    sessionId: session.id,
    permissionId: permission.id,
    source: 'owned synthesized speech and tone',
    sink: 'existing private versioned S3 assets bucket',
    database: 'local disposable PostgreSQL',
    auth: 'localhost fixture identity with actual single-use DB tickets',
    analysis: 'controlled Meri outage',
    backgroundTimerThrottling:
      'browser defaults; capture tab selection automated for the owned fixture; headless mute disabled',
  };
  writeFileSync(join(out, 'run.json'), JSON.stringify(metadata, null, 2));
  log('started', metadata);
  try {
    await source.goto(origin + '/source');
    await source.click('#play');
    await source.waitForFunction(() => (window as any).ready);
    await page.goto(origin);
    await page.click('#start');
    await page.waitForFunction(() => (window as any).phase === 'capturing', {}, { timeout: 30000 });
    if (startupFailure) {
      Object.assign(gateway, { deepgramApiKey: process.env.DEEPGRAM_API_KEY });
      log('startup_failure_recording_started');
    }
    await source.evaluate(() => {
      const audio = document.getElementById('speech') as HTMLAudioElement;
      audio.currentTime = 0;
      void audio.play();
    });
    const deadline = started + minutes * 60_000;
    const long = minutes >= 240;
    const recessStart = started + (long ? 45 * 60_000 : 30_000),
      recessEnd = recessStart + (long ? 16 * 60_000 : 15_000);
    const reconnectAt = started + (long ? 90 * 60_000 : 70_000);
    let recess = false,
      recessDone = false,
      reconnected = false,
      unplannedReshares = 0;
    while (Date.now() < deadline) {
      const now = Date.now();
      if (now >= recessStart && !recessDone && !recess) {
        await source.evaluate(() => (window as any).setRecess(true));
        recess = true;
        log('recess_started');
      }
      if (now >= recessEnd && recess) {
        await source.evaluate(() => (window as any).setRecess(false));
        recess = false;
        recessDone = true;
        log('recess_ended');
      }
      if (now >= reconnectAt && !reconnected) {
        await page.evaluate(() => (window as any).socket.close());
        log('controlled_network_disconnect');
        await new Promise((r) => setTimeout(r, 7000));
        await page.reload();
        await page.click('#start');
        await page.waitForFunction(
          () => (window as any).phase === 'capturing',
          {},
          { timeout: 30000 },
        );
        reconnected = true;
        log('explicit_reshare_completed');
      }
      const sample = await page.evaluate(() => ({
        phase: (window as any).phase,
        saved: (window as any).metrics.saved,
        maxBacklog: (window as any).metrics.maxBacklog,
        heap: (performance as any).memory?.usedJSHeapSize,
        lag: (window as any).metrics.lag.splice(0),
      }));
      log('sample', { elapsedMs: Date.now() - started, ...sample });
      if (sample.phase !== 'capturing') {
        log('unplanned_capture_interruption', { phase: sample.phase, savedBytes: sample.saved });
        if (!long || ++unplannedReshares > 3)
          throw Error('Capture interruption exceeded qualification recovery budget');
        // Real product recovery requires a fresh analyst gesture. This fixture
        // explicitly clicks the share action again; it does not silently resume
        // a browser grant or count the intervening time as recorded media.
        await new Promise((r) => setTimeout(r, 10000));
        await page.reload();
        await page.click('#start');
        await page.waitForFunction(
          () => (window as any).phase === 'capturing',
          {},
          { timeout: 30000 },
        );
        log('explicit_reshare_after_unplanned_interruption', { number: unplannedReshares });
      }
      await new Promise((r) => setTimeout(r, 10000));
    }
    await page.click('#stop');
    await page.waitForFunction(
      () => ['stopped', 'closed'].includes((window as any).phase),
      {},
      { timeout: 45000 },
    );
    await page.close();
    log('capture_browser_page_closed');
    const worker = new RecordingAssemblyWorker(p, storage);
    const current = await recording.manifest(tenantId, session.id, userId);
    while (await worker.runOne(current.recording!.id)) log('assembled_epoch');
    const manifest = await recording.manifest(tenantId, session.id, userId);
    const reopenContext = await browser.newContext(),
      reopened = await reopenContext.newPage();
    await reopened.goto(origin);
    for (const epoch of manifest.recording?.epochs ?? []) {
      if (!epoch.playable) continue;
      const access = await recording.playback(tenantId, session.id, userId, epoch.id);
      await reopened.evaluate((url) => {
        const a = document.getElementById('reopened') as HTMLAudioElement;
        a.src = url;
        a.load();
      }, access.url);
      await reopened.waitForFunction(
        () => (document.getElementById('reopened') as HTMLAudioElement).readyState >= 1,
      );
      for (const fraction of [0.05, 0.5, 0.95]) {
        await reopened.evaluate((f) => {
          const a = document.getElementById('reopened') as HTMLAudioElement;
          a.currentTime = a.duration * f;
        }, fraction);
        await reopened.waitForFunction(
          () => !(document.getElementById('reopened') as HTMLAudioElement).seeking,
        );
      }
      log('reopened_seek_verified', { epochId: epoch.id, durationMs: epoch.decodedDurationMs });
    }
    const transcripts = await p.transcriptSegment.aggregate({
      where: { tenantId, sessionId: session.id },
      _count: true,
      _max: { endMs: true },
    });
    if (transcripts._count < 1)
      throw Error('Known speech was not persisted; audio-track presence alone is insufficient');
    const capturedMediaMs = (manifest.recording?.epochs ?? []).reduce(
      (sum, epoch) => sum + (epoch.decodedDurationMs ?? 0),
      0,
    );
    if (long && capturedMediaMs < 240 * 60_000)
      throw Error('Decoded captured media did not reach four hours; elapsed gaps do not count');
    const result = {
      ...metadata,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      capturedMediaMs,
      unplannedReshares,
      manifest,
      transcripts,
      qualification: long
        ? 'actual elapsed browser pipeline run; see auth/model/default-throttling limits'
        : 'short real browser/provider/storage fixture; not four-hour qualification',
    };
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
    log('completed', { elapsedMs: result.elapsedMs });
    console.log(
      JSON.stringify({
        event: 'qualification_completed',
        sessionId: session.id,
        elapsedMs: result.elapsedMs,
        output: out,
      }),
    );
  } catch (error) {
    log('failed', { message: (error as Error).message });
    throw error;
  } finally {
    await browser.close();
    ws.close();
    server.close();
    await p.$disconnect();
  }
}
void main().catch((error) => {
  console.error('Browser qualification failed: ' + (error as Error).message);
  process.exitCode = 1;
});
