import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const completeSourceJob = String.raw`
import os,sys
from backend import config,db
assert config.QUEUE_CONCURRENCY == 0
assert str(config.DATA_DIR.resolve()) == os.environ['E2E_DATA_DIR']
job=db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'queued'
db.mark_done(job.id,[],None)
`;

// This case uses the real upload, owner session, ResultsView and listening HTTP
// response. Only independent decoded-reference WAVs are supplied by test routes.
// No model worker runs: use the dedicated config through run.mjs --visual.
test('Firefox partial-stream seeking keeps decoded audio on the native clock', async ({ browser, page, context }, info) => {
  test.setTimeout(120_000);
  expect(process.env.QUEUE_CONCURRENCY).toBe('0');
  const sourcePath = info.outputPath('aperiodic-vbr.mp3');
  // Original synthesis: chirps plus amplitude-varying noise make
  // short PCM windows distinguishable without checking in a private recording.
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
    'aevalsrc=0.14*sin(2*PI*(170*t+11*t*t))+0.08*sin(2*PI*(340*t+3.7*t*t))+0.035*(2*random(0)-1)*(0.5+0.5*sin(0.7*t)):s=48000:d=303',
    '-ac', '2', '-c:a', 'libmp3lame', '-q:a', '0', '-map_metadata', '-1', sourcePath,
  ], { timeout: 30_000 });
  const references = new Map<string, Buffer>();
  for (const [name, start, seconds] of [['natural', 0, 5], ['seek', 25, 15]] as const) {
    const path = info.outputPath(`reference-${name}.wav`);
    // Output-side -ss decodes from the beginning, rather than trusting the MP3
    // seek index under test. Only these small crops enter the browser.
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', sourcePath,
      '-ss', String(start), '-t', String(seconds), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_f32le', path,
    ], { timeout: 15_000 });
    references.set(`/__listening-reference/${name}.wav`, await readFile(path));
  }
  await page.goto('/');
  const submitted = await page.request.post('/api/jobs', { multipart: {
    file: { name: 'aperiodic-vbr.mp3', mimeType: 'audio/mpeg', buffer: await readFile(sourcePath) },
    detect_pitch: 'true',
  } });
  expect(submitted.ok()).toBe(true);
  const id = (await submitted.json()).id as number;
  execFileSync('uv', ['run', 'python', '-c', completeSourceJob, String(id)], {
    cwd: process.env.E2E_REPO_ROOT,
    env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
  });
  const owner = await context.storageState();
  const reports = [];
  for (const trial of [
    { name: 'natural', target: 0, referenceStart: 0 },
    { name: 'seek', target: 33.4, referenceStart: 25 },
  ]) {
    const isolated = await browser.newContext({ storageState: owner, baseURL: process.env.E2E_BASE_URL });
    try {
      await isolated.route('**/__listening-reference/*.wav', route => {
        const body = references.get(new URL(route.request().url()).pathname);
        if (!body) throw new Error('Unknown reference crop');
        return route.fulfill({ contentType: 'audio/wav', body });
      });
      const view = await isolated.newPage();
      await view.goto('/');
      const player = view.getByRole('link', { name: 'Download original', exact: true }).locator('..').locator('audio');
      await expect(player).toBeVisible();
      const report = await player.evaluate(async (element, trial) => {
        const audio = element as HTMLAudioElement & {
          captureStream?: () => MediaStream;
          mozCaptureStream?: () => MediaStream;
        };
        const bounded = async <T>(promise: Promise<T>, stage: string, timeoutMs = 8000): Promise<T> => {
          let timer = 0;
          try {
            return await Promise.race([promise, new Promise<never>((_, reject) => {
              timer = window.setTimeout(() => reject(new Error(`${stage} timed out`)), timeoutMs);
            })]);
          } finally { clearTimeout(timer); }
        };
        const offline = new OfflineAudioContext(1, 1, 48000);
        const referenceResponse = await fetch(`/__listening-reference/${trial.name}.wav`);
        const referenceAudio = await offline.decodeAudioData(await referenceResponse.arrayBuffer());
        const reference = referenceAudio.getChannelData(0);
        audio.muted = true;
        const capture = audio.captureStream ?? audio.mozCaptureStream;
        if (!capture) throw new Error('Native media capture is unavailable');
        const stream = capture.call(audio);
        let bufferedBeforeSeek = 0;
        const ready = new Promise<void>((resolve, reject) => {
          audio.addEventListener('error', () => reject(new Error(`Media error ${audio.error?.code}`)), { once: true });
          audio.addEventListener('loadedmetadata', () => {
            bufferedBeforeSeek = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0;
            if (!trial.target) { resolve(); return; }
            if (bufferedBeforeSeek >= trial.target) { reject(new Error(`Seek target ${trial.target} already buffered through ${bufferedBeforeSeek}`)); return; }
            audio.addEventListener('seeked', () => resolve(), { once: true });
            audio.currentTime = trial.target;
          }, { once: true });
        });
        audio.preload = 'metadata';
        audio.load();
        // A raw MP3 may read sequentially to the target at the controlled
        // 64KiB/s rate rather than issuing a second Range request.
        await bounded(ready, 'metadata and initial partial seek', 20000);
        await bounded(audio.play(), 'native muted play');
        if (!stream.getAudioTracks().length) {
          await bounded(new Promise<void>(resolve => stream.addEventListener('addtrack', () => resolve(), { once: true })), 'captured audio track');
        }
        // Measure steady native playback, not capture-track startup. Apply the
        // same settling interval to natural playback and the partial seek.
        await bounded(new Promise<void>(resolve => {
          const sample = () => {
            if (audio.currentTime >= trial.target + 0.5) resolve();
            else requestAnimationFrame(sample);
          };
          sample();
        }), 'native playback settling');
        const recorder = new MediaRecorder(stream, { mimeType: 'audio/ogg;codecs=opus', audioBitsPerSecond: 256000 });
        const chunks: BlobPart[] = [];
        let nativeStart = NaN;
        const started = new Promise<void>(resolve => { recorder.onstart = () => { nativeStart = audio.currentTime; resolve(); }; });
        const stopped = new Promise<void>((resolve, reject) => {
          recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
          recorder.onstop = () => resolve();
          recorder.onerror = () => reject(new Error('Native recording failed'));
        });
        recorder.start();
        await bounded(started, 'recorder start');
        await new Promise(resolve => setTimeout(resolve, 1400));
        const nativeEnd = audio.currentTime;
        recorder.stop();
        audio.pause();
        await bounded(stopped, 'recorder stop');
        for (const track of stream.getTracks()) track.stop();
        const recorded = await offline.decodeAudioData(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer());
        const samples = recorded.getChannelData(0);
        const rate = recorded.sampleRate;
        if (rate !== referenceAudio.sampleRate) throw new Error('Reference and recording sample rates differ');
        let energy = 0;
        for (let i = 0; i < samples.length; i += 24) energy += samples[i] * samples[i];
        const score = (start: number) => {
          if (start < 0 || start + samples.length > reference.length) return -1;
          let cross = 0, referenceEnergy = 0;
          for (let i = 0; i < samples.length; i += 24) {
            const value = reference[start + i];
            cross += samples[i] * value;
            referenceEnergy += value * value;
          }
          return energy * referenceEnergy > 0 ? cross / Math.sqrt(energy * referenceEnergy) : -1;
        };
        const center = Math.round((nativeStart - trial.referenceStart) * rate);
        const coarse = [];
        // Resolve waveform phase before grouping nearby peaks; a coarse grid
        // can otherwise select a neighboring cycle and discard the true match.
        for (let start = Math.max(0, center - 2 * rate); start <= center + 2 * rate; start += 4) {
          coarse.push({ start, correlation: score(start) });
        }
        coarse.sort((a, b) => b.correlation - a.correlation);
        const candidates: typeof coarse = [];
        for (const candidate of coarse) {
          if (candidates.every(other => Math.abs(candidate.start - other.start) >= 0.05 * rate)) candidates.push(candidate);
          if (candidates.length === 32) break;
        }
        const refined = candidates.map(candidate => {
          let best = candidate;
          for (let start = candidate.start - 4; start <= candidate.start + 4; start++) {
            const correlation = score(start);
            if (correlation > best.correlation) best = { start, correlation };
          }
          return best;
        }).sort((a, b) => b.correlation - a.correlation);
        const peaks: typeof coarse = [];
        for (const candidate of refined) {
          if (peaks.every(other => Math.abs(candidate.start - other.start) >= 0.15 * rate)) peaks.push(candidate);
          if (peaks.length === 3) break;
        }
        const decodedEnd = trial.referenceStart + (peaks[0].start + samples.length) / rate;
        return { trial: trial.name, target: trial.target, bufferedBeforeSeek, nativeStart, nativeEnd,
          capturedDuration: samples.length / rate, correlation: peaks[0].correlation,
          separatedPeakMargin: peaks[0].correlation - peaks[1].correlation,
          decodedEnd, contentMinusClock: decodedEnd - nativeEnd, offlineState: offline.state,
          sampleRate: rate, recordedSamples: Array.from(samples) };
      }, trial);
      const { recordedSamples, ...measurement } = report;
      reports.push(measurement);
      await info.attach(`native-listening-${trial.name}-pcm`, {
        body: Buffer.from(new Float32Array(recordedSamples).buffer), contentType: 'application/octet-stream',
      });
      await info.attach(`native-listening-${trial.name}`, { body: JSON.stringify(measurement, null, 2), contentType: 'application/json' });
    } finally { await isolated.close(); }
  }
  const calibratedError = reports[1].contentMinusClock - reports[0].contentMinusClock;
  await info.attach('native-listening-clock', { body: JSON.stringify({ reports, calibratedError }, null, 2), contentType: 'application/json' });
  for (const report of reports) {
    expect(report.nativeEnd - report.nativeStart).toBeGreaterThan(1);
    expect(report.capturedDuration).toBeGreaterThan(1);
    expect(report.correlation).toBeGreaterThan(0.9);
    expect(report.separatedPeakMargin).toBeGreaterThan(0.1);
  }
  expect(reports[1].bufferedBeforeSeek).toBeLessThan(reports[1].target);
  expect(Math.abs(calibratedError)).toBeLessThan(0.1);
});
