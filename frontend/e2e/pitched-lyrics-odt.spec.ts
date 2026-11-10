import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { authenticateOutsider, test } from './auth-fixture';
import type { JobDTO } from '../src/api';

// Synthetic stored analysis exercises production storage/DTO/export and real HTTP.
// The dedicated seeded config runs with queue workers disabled.
const publish = String.raw`
import os,sys
from pathlib import Path
from backend import config,db
from separator.pitch import pitch_to_json
from tests.pitched_lyrics_odt_fixture import document_fixture
assert config.QUEUE_CONCURRENCY == 0
assert config.DATA_DIR.resolve() == Path(os.environ['E2E_DATA_DIR']).resolve()
job=db.get_job(int(sys.argv[1]))
assert job is not None and job.status == 'queued' and job.modal_call_id is None
transcript,analysis=document_fixture(3)
db.mark_done(int(sys.argv[1]),[],transcript,pitch_to_json(analysis))
db.set_title(int(sys.argv[1]),'Synthetic [ODT]')
db.set_original_key(int(sys.argv[1]),'C major')
`;
const inspect = String.raw`
import json,sys,zipfile
from xml.etree import ElementTree as ET
from separator.pitched_lyrics_odt import MIME_TYPE,NS
from tests.pitched_lyrics_odt_fixture import odf_text as text
with zipfile.ZipFile(sys.argv[1]) as archive:
 assert archive.infolist()[0].filename=='mimetype'
 assert archive.infolist()[0].compress_type==zipfile.ZIP_STORED
 assert archive.read('mimetype').decode()==MIME_TYPE
 ET.fromstring(archive.read('META-INF/manifest.xml'))
 body=ET.fromstring(archive.read('content.xml'))
 paragraphs=body.findall('office:body/office:text/text:p',NS)
 print(json.dumps({'text': ''.join(text(p)+ ('\n\n' if p.find('text:line-break',NS) is not None else '\n') for p in paragraphs)}))
`;

for (const width of [1440, 390]) {
  test(`ODT download ${width} keeps selected private stem and shared timestamp columns`, async ({ page, browser }, info) => {
    expect(process.env.QUEUE_CONCURRENCY).toBe('0');
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
    const response = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
      file: { name: 'synthetic-odt.wav', mimeType: 'audio/wav', buffer: source }, extract_pitched_lyrics: 'true',
    } });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).id as number;
    execFileSync('uv', ['run', 'python', '-c', publish, String(id)], {
      cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    await page.reload();
    const job = await (await page.request.get(`/api/jobs/${id}`)).json() as JobDTO;
    const view = page.getByRole('region', { name: 'Lyrics with pitches', exact: true }).first();
    const text = view.getByRole('region', { name: 'Aligned pitch and lyric text' });
    await expect(view).toBeVisible();
    for (const track of job.pitched_lyrics!) {
      await view.getByRole('combobox', { name: 'Pitched lyrics vocal stem' }).selectOption(track.label);
      expect(await text.textContent()).toBe(track.text);
      const pending = page.waitForEvent('download');
      await view.getByRole('link', { name: 'Download lyrics with pitches ODT', exact: true }).click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe(`Synthetic [ODT] - ${track.label} - lyrics-with-pitches.odt`);
      const path = info.outputPath(`${track.label}.odt`);
      await download.saveAs(path);
      const decoded = JSON.parse(execFileSync('uv', ['run', 'python', '-c', inspect, path], { cwd: process.env.E2E_REPO_ROOT!, encoding: 'utf8' }));
      expect(decoded.text).toBe(track.text);
      expect((await page.request.get(`/api/jobs/${id}/pitched-lyrics/${track.label}/download?format=odt`)).headers()['content-type']).toBe('application/vnd.oasis.opendocument.text');
    }
    // Exporting one stem must leave the other stored tracks available unchanged.
    const afterExports = await (await page.request.get(`/api/jobs/${id}`)).json() as JobDTO;
    expect(afterExports.pitched_lyrics).toEqual(job.pitched_lyrics);
    await view.getByRole('combobox', { name: 'Pitched lyrics vocal stem' }).selectOption('lead');
    const columns = await text.evaluate(element => {
      const content = element.textContent!;
      const lyricStart = content.indexOf('[100:00] pair000');
      const pitchStart = content.lastIndexOf('\n', lyricStart - 2) + 1;
      const box = (start: number) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node && start >= node.textContent!.length) {
          start -= node.textContent!.length;
          node = walker.nextNode();
        }
        const range = document.createRange();
        range.setStart(node!, start);
        range.setEnd(node!, start + 1);
        return range.getBoundingClientRect().toJSON();
      };
      const laterWord = content.indexOf('мир', lyricStart);
      const prefix = content.slice(lyricStart, laterWord);
      const laterColumn = [...prefix].reduce((width, char) => width + (char === '\u0301' ? 0 : /[星光]/.test(char) ? 2 : 1), 0);
      return { pitch: box(pitchStart + 9), word: box(lyricStart + 9), stamp: box(lyricStart),
        laterPitch: box(pitchStart + laterColumn), laterWord: box(laterWord),
        lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight), font: getComputedStyle(element).fontFamily };
    });
    expect(columns.pitch.left).toBeCloseTo(columns.word.left, 3);
    expect(columns.laterPitch.left).toBeCloseTo(columns.laterWord.left, 1);
    expect(columns.word.top - columns.pitch.top).toBeCloseTo(columns.lineHeight, 1);
    expect(columns.stamp.left).toBeLessThan(columns.word.left);
    expect(columns.font).toContain('mono');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await view.screenshot({ path: info.outputPath(`odt-${width}-timestamp-columns.png`) });
    const foreign = await browser.newContext();
    await authenticateOutsider(foreign);
    const outsider = await foreign.newPage();
    await outsider.goto(process.env.E2E_BASE_URL!);
    expect((await outsider.request.get(`/api/jobs/${id}/pitched-lyrics/lead/download?format=odt`)).status()).toBe(404);
    await foreign.close();
  });
}

test('historical karaoke exposes saved pitched lyrics without reprocessing', async ({ page, browser }, info) => {
  expect(process.env.QUEUE_CONCURRENCY).toBe('0');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const source = await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
  const response = await page.request.post('/api/jobs', {
    headers: { Origin: process.env.E2E_BASE_URL! },
    multipart: {
      file: { name: 'historical-karaoke.wav', mimeType: 'audio/wav', buffer: source },
      detect_pitch: 'true', extract_lyrics: 'true',
    },
  });
  expect(response.ok()).toBe(true);
  const id = (await response.json()).id as number;
  execFileSync('uv', ['run', 'python', '-c', publish, String(id)], {
    cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
  });
  await page.reload();
  const job = await (await page.request.get(`/api/jobs/${id}`)).json() as JobDTO;
  expect(job.options.extract_pitched_lyrics).toBe(false);
  const view = page.getByRole('region', { name: 'Lyrics with pitches', exact: true }).first();
  await expect(view).toBeVisible();
  const track = job.pitched_lyrics![0];
  const txtPending = page.waitForEvent('download');
  await view.getByRole('link', { name: 'Download lyrics with pitches TXT', exact: true }).click();
  const txt = await txtPending;
  expect(await readFile((await txt.path())!, 'utf8')).toBe(track.text);
  const odtPending = page.waitForEvent('download');
  await view.getByRole('link', { name: 'Download lyrics with pitches ODT', exact: true }).click();
  const odt = await odtPending;
  const path = info.outputPath('historical.odt');
  await odt.saveAs(path);
  const decoded = JSON.parse(execFileSync('uv', ['run', 'python', '-c', inspect, path], {
    cwd: process.env.E2E_REPO_ROOT!, encoding: 'utf8',
  }));
  expect(decoded.text).toBe(track.text);
  const foreign = await browser.newContext();
  await authenticateOutsider(foreign);
  const outsider = await foreign.newPage();
  await outsider.goto(process.env.E2E_BASE_URL!);
  expect((await outsider.request.get(`/api/jobs/${id}/pitched-lyrics/${track.label}/download`)).status()).toBe(404);
  expect((await outsider.request.get(`/api/jobs/${id}/pitched-lyrics/${track.label}/download?format=odt`)).status()).toBe(404);
  await foreign.close();
});
