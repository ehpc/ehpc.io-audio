import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { test } from './auth-fixture';
import type { PitchAnalysisDTO } from '../src/api';
import { songArtwork, songVersions } from './song-fixtures';
import { seedCachedSongs } from './cache-fixture';

const mobile = { width: 390, height: 844 };
const desktop = { width: 1440, height: 1000 };
const pitchName = 'Pitch shift (semitones)';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-01T12:00:00Z'));
});

test.afterEach(async ({ page, browser }, info) => {
  await writeFile(info.outputPath('runtime.json'), JSON.stringify({
    runtime: process.env.E2E_VISUAL_RUNTIME,
    browser: browser.version(),
    os: await readFile('/etc/os-release', 'utf8'),
    viewport: page.viewportSize(),
  }, null, 2));
});

// Real owner-scoped completed job; no processing or model inference.
const seedDeleteDialog = String.raw`
import sys
from backend import db
with db._session() as c:
    cursor = c.execute("INSERT INTO jobs (session_id,status,source_type,source_value,title,options_json,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?)",
                       (sys.argv[1], "done", "upload", "fixture.wav", "Visual fixture track", "{}", 1767268800, 1767268801))
    print(cursor.lastrowid)
`;
for (const viewport of [mobile, desktop]) {
  test(`delete confirmation ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const identity = await (await page.request.get('/api/auth/me')).json() as { id: string };
    const id = execFileSync('uv', ['run', 'python', '-c', seedDeleteDialog, identity.id], {
      cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! }, encoding: 'utf8',
    }).trim();
    try {
      await page.goto('/');
      await page.getByRole('button', { name: 'Delete Visual fixture track', exact: true }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('Shared reusable processing cache is not deleted.');
      await compare(dialog, info, `delete-confirmation-${viewport.width}.png`);
    } finally {
      execFileSync('uv', ['run', 'python', '-c',
        'import sys; from backend import db\nwith db._session() as c: c.execute("DELETE FROM jobs WHERE id=? AND session_id=?", (int(sys.argv[1]), sys.argv[2]))', id, identity.id], {
        cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
      });
    }
  });
}
// Fixed, synthetic metadata in the isolated database exercises the actual admin
// activity UI without sending searches, mail, or inference requests.
const seedAccountActivity = String.raw`
import sys
from backend import db
with db._session() as c:
    admin, member = sys.argv[1:]
    t = 1767268800
    c.execute("UPDATE auth_users SET last_login_at=?,last_activity_at=? WHERE id=?", (t, t+60, member))
    c.execute("UPDATE auth_invites SET activated_at=? WHERE recipient_id=?", (t-3600, member))
    c.execute("INSERT OR REPLACE INTO auth_invites (id,verifier,owner_id,recipient_id,created_at,activated_at,revoked) VALUES (?,?,?,?,?,?,0)", ("visual-pending", "visual-pending-verifier", member, None, t, None))
    c.execute("INSERT OR REPLACE INTO auth_invites (id,verifier,owner_id,recipient_id,created_at,activated_at,revoked) VALUES (?,?,?,?,?,?,0)", ("visual-activated", "visual-activated-verifier", member, admin, t-300, t-200))
    for job_id,title,status in [(-2,"Completed fixture track","done"),(-1,"Queued fixture track","queued")]:
        c.execute("INSERT OR REPLACE INTO jobs (id,session_id,status,source_type,source_value,title,options_json,created_at,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)", (job_id,member,status,"upload","fixture.wav",title,"{}",t,t+1 if status=="done" else None,t+2 if status=="done" else None))
    c.execute("INSERT OR REPLACE INTO song_searches (id,session_id,created_at,result_json,activity_query) VALUES (?,?,?,?,?)", ("visual-search",member,t,"[]","Fixture song query"))
    c.execute("INSERT OR REPLACE INTO song_searches (id,session_id,created_at,result_json,activity_query) VALUES (?,?,?,?,?)", ("visual-search-unknown",member,t-30,"[]",None))
`;


for (const viewport of [desktop, mobile]) {
  test(`admin cached songs ${viewport.width}`, async ({ page }, info) => {
    seedCachedSongs();
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole('button', { name: 'People', exact: true }).click();
    await page.getByRole('button', { name: 'Manage cached songs' }).click();
    const cache = page.getByRole('region', { name: 'Cached songs' });
    await expect(cache.getByText('Silver harbor')).toBeVisible();
    await cache.getByRole('checkbox', { name: /Silver harbor/ }).check();
    await cache.getByRole('checkbox', { name: /Quiet morning/ }).check();
    await cache.screenshot({ path: info.outputPath('cache-panel.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
    await expect.soft(cache).toHaveScreenshot(`admin-cache-${viewport.width}.png`);
    await cache.getByRole('button', { name: 'Clear selected (2)' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('2 selected songs');
    await dialog.screenshot({ path: info.outputPath('cache-dialog.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
    await expect.soft(dialog).toHaveScreenshot(`admin-cache-confirm-${viewport.width}.png`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const viewport of [desktop, mobile]) {
  test(`account screens ${viewport.width}`, async ({ page, context }, info) => {
    await page.setViewportSize(viewport);
    await context.clearCookies();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await compare(page, info, `signin-${viewport.width}.png`);
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Join the workspace' })).toBeVisible();
    await compare(page, info, `register-${viewport.width}.png`);
    await context.addCookies([{ name: 'auth_session', value: process.env.E2E_AUTH_SESSION!, url: process.env.E2E_BASE_URL!, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
    await expect(page.getByText(/Unlimited invitations/)).toBeVisible();
    await compare(page, info, `profile-${viewport.width}.png`);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'People', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
    await compare(page, info, `people-${viewport.width}.png`);
    const admin = await (await page.request.get('/api/auth/me')).json();
    const adminCard = page.locator('div').filter({ has: page.getByRole('heading', { name: admin.email, exact: true }) }).filter({ has: page.getByRole('button', { name: 'View activity' }) }).last();
    await expect(adminCard.getByText('Invite limit: Unlimited')).toBeVisible();
    await expect(adminCard.getByRole('button', { name: 'Grant +1 invite' })).toHaveCount(0);
    const people = await (await page.request.get('/api/admin/users')).json() as { id: string; email: string }[];
    const member = people.find(person => person.email === 'e2e-outsider@example.test')!;
    execFileSync('uv', ['run', 'python', '-c', seedAccountActivity, admin.id, member.id], {
      cwd: process.env.E2E_REPO_ROOT!, env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    const memberCard = page.locator('div').filter({ has: page.getByRole('heading', { name: member.email, exact: true }) }).filter({ has: page.getByRole('button', { name: 'View activity' }) }).last();
    await memberCard.getByRole('button', { name: 'View activity' }).click();
    const activity = memberCard.getByRole('region', { name: 'Activity' });
    await expect(activity.getByText(/Registered:/)).toBeVisible();
    await expect(activity.getByText(/Last login:/)).toBeVisible();
    await expect(activity.getByText(/Completed fixture track.*done/)).toBeVisible();
    await expect(activity.getByText(/Queued fixture track.*queued/)).toBeVisible();
    await expect(activity.getByText(/Fixture song query.*completed/)).toBeVisible();
    await expect(activity.getByText(/Query unavailable/)).toBeVisible();
    await expect(activity.getByText(/e2e-admin@example.test.*activated/)).toBeVisible();
    await expect(activity.getByRole('button', { name: 'Withdraw unused invitation' })).toBeVisible();
    await compare(activity, info, `people-activity-${viewport.width}.png`);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

async function analyze(page: Page, info: TestInfo, unknown = false) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
  const response = page.waitForResponse(res => res.url().endsWith('/api/key-analysis') && res.request().method() === 'POST');
  await page.getByLabel('Audio file', { exact: true }).setInputFiles(resolve(process.env.E2E_FIXTURE_DIR!, unknown ? 'silent-fixture.wav' : 'tone-fixture.wav'));
  const result = await response;
  expect(result.ok()).toBe(true);
  const analysis = await result.json();
  expect(analysis.original_key).toBe(unknown ? null : 'C major');
  await writeFile(info.outputPath('analysis.json'), JSON.stringify(analysis, null, 2));
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

async function adjust(page: Page) {
  if (page.viewportSize()!.width <= 700) await page.getByRole('tab', { name: 'Adjust', exact: true }).click();
}

async function compare(subject: Page | Locator, info: TestInfo, name: string, mask: Locator[] = []) {
  // Keep an actual PNG even on success, alongside the strict baseline comparison.
  await subject.screenshot({ path: info.outputPath('actual.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
  await expect(subject).toHaveScreenshot(name, { mask });
}

async function expectReadableTooltip(page: Page, info: TestInfo, interaction: string) {
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Drums, bass and other instruments are all available as downloads.');
  const geometry = await tooltip.evaluate(element => {
    const box = element.getBoundingClientRect();
    const footer = document.querySelector('.workspace-action');
    const footerBox = footer?.getBoundingClientRect();
    const footerTop = footer && footerBox && ['fixed', 'sticky'].includes(getComputedStyle(footer).position)
      && footerBox.top < innerHeight ? footerBox.top : null;
    const uncovered = [0.1, 0.5, 0.9].flatMap(x => [0.1, 0.5, 0.9].map(y => {
      const painted = document.elementFromPoint(box.left + box.width * x, box.top + box.height * y);
      return !!painted && (painted === element || element.contains(painted));
    }));
    return { box: box.toJSON(), width: innerWidth, height: innerHeight, footerTop, uncovered,
      fits: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight };
  });
  await info.attach(`drums-help-${interaction}`, { body: JSON.stringify(geometry), contentType: 'application/json' });
  expect(geometry.box.left).toBeGreaterThanOrEqual(0);
  expect(geometry.box.top).toBeGreaterThanOrEqual(0);
  expect(geometry.box.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.box.bottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.fits).toBe(true);
  expect(geometry.uncovered.every(Boolean)).toBe(true);
}

for (const tab of ['Outputs', 'Adjust', 'Review']) {
  test(`mobile 390 ${tab} workspace`, async ({ page }, info) => {
    await page.setViewportSize(mobile);
    await analyze(page, info);
    if (tab !== 'Outputs') {
      await page.getByRole('checkbox', { name: 'Extract vocals', exact: true }).check();
      await page.locator('details.vocal-variants summary').click();
      await page.getByRole('button', { name: '+ Female vocals', exact: true }).click();
      await page.getByRole('button', { name: '+ Instruments', exact: true }).click();
      await page.getByRole('button', { name: 'Add mix', exact: true }).click();
      await adjust(page);
      await page.getByRole('spinbutton', { name: pitchName }).fill('2');
      await page.getByRole('spinbutton', { name: 'Tempo (% of original)' }).fill('120');
      await expect(page.locator('.pitch-key-badge')).toHaveText('Resulting key: D major');
      await page.getByRole('tab', { name: tab, exact: true }).click();
    }
    await page.getByRole('heading', { name: "ehpc's Vocal Tools", exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await compare(page, info, `mobile-390-${tab.toLowerCase()}.png`);
  });
}

for (const viewport of [desktop, { width: 2560, height: 1440 }]) {
  test(`desktop ${viewport.width} workspace`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await analyze(page, info);
    await page.getByRole('checkbox', { name: 'Extract vocals', exact: true }).check();
    await page.getByRole('spinbutton', { name: pitchName }).fill('2');
    await expect(page.locator('.pitch-key-badge')).toHaveText('Resulting key: D major');
    await page.getByRole('heading', { name: "ehpc's Vocal Tools", exact: true }).click();
    await compare(page, info, `desktop-${viewport.width}-workspace.png`);
  });
}

for (const viewport of [desktop, mobile]) {
  test.describe(`karaoke output dependencies ${viewport.width}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 390, isMobile: viewport.width === 390 });
    test('preserves manual output choices and exposes locked dependencies by hover, focus and touch', async ({ page }, info) => {
      let submittedJobs = 0;
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') submittedJobs++;
      });
      await analyze(page, info);
      const karaoke = page.getByRole('checkbox', { name: 'Karaoke with pitches', exact: true });
      const vocals = page.getByRole('checkbox', { name: 'Extract vocals', exact: true });
      const lyrics = page.getByRole('checkbox', { name: 'Extract lyrics', exact: true });
      const instruments = page.getByRole('checkbox', { name: 'Extract instruments', exact: true });
      const drums = page.getByRole('checkbox', { name: 'Split drums, bass & other instruments', exact: true });
      const manualBacking = viewport.width === 390 ? instruments : drums;
      const includedBacking = viewport.width === 390 ? drums : instruments;
      const manual = viewport.width === 390 ? lyrics : vocals;
      const included = viewport.width === 390 ? vocals : lyrics;
      await manual.check();
      await manualBacking.check();
      await karaoke.check();
      for (const control of [vocals, lyrics, instruments, drums]) {
        await expect(control).toBeChecked();
        await expect(control).toBeDisabled();
      }
      const help = page.getByRole('button', { name: 'Why Extract instruments is included', exact: true });
      if (viewport.width === 390) await help.tap();
      else {
        await instruments.hover();
        await expect(page.getByRole('tooltip')).toBeVisible();
        await page.mouse.move(0, 0);
        await help.focus();
      }
      await expect(page.getByRole('tooltip')).toBeVisible();
      await help.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      const drumsHelp = page.getByRole('button', { name: 'Why Split drums, bass & other instruments is included', exact: true });
      if (viewport.width === 390) await drumsHelp.tap(); else await drumsHelp.hover();
      await expectReadableTooltip(page, info, 'pointer');
      await drumsHelp.press('Escape');
      await page.mouse.move(0, 0);
      await help.focus();
      await help.press('Escape');
      for (let step = 0; step < 60 && !(await drumsHelp.evaluate(element => element === document.activeElement)); step++) {
        await page.keyboard.press('Tab');
      }
      await expect(drumsHelp).toBeFocused();
      await expectReadableTooltip(page, info, 'keyboard');
      await drumsHelp.press('Escape');
      await karaoke.uncheck();
      await expect(vocals).toBeEnabled();
      await expect(lyrics).toBeEnabled();
      await expect(manual).toBeChecked();
      await expect(included).not.toBeChecked();
      await expect(instruments).toBeEnabled();
      await expect(drums).toBeEnabled();
      await expect(manualBacking).toBeChecked();
      await expect(includedBacking).not.toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Lyrics with pitches', exact: true })).not.toBeChecked();
      await karaoke.check();
      await page.evaluate(() => window.scrollTo(0, 0));
      if (viewport.width === 390) await help.tap(); else await help.focus();
      await expect(page.getByRole('tooltip')).toBeVisible();
      const layout = await karaoke.evaluate(input => {
        const label = input.closest('label')!.getBoundingClientRect();
        const outputs = input.closest('fieldset')!;
        const rowTops = [...outputs.querySelectorAll('input')].map(control => control.getBoundingClientRect().top);
        return { height: label.height, first: input.getBoundingClientRect().top === Math.min(...rowTops),
          width: innerWidth, document: document.documentElement.scrollWidth };
      });
      expect(layout.first).toBe(true);
      expect(layout.height).toBeGreaterThanOrEqual(44);
      expect(layout.width).toBe(viewport.width);
      expect(layout.document).toBeLessThanOrEqual(viewport.width);
      expect(submittedJobs, 'option/help interactions must not submit an analysis job').toBe(0);
      await compare(page, info, `karaoke-options-${viewport.width}.png`);
    });
  });
}

// Deterministic catalog boundary fixtures: these snapshots assert discovery UI,
// not model/provider accuracy. Existing native key/audio fixtures stay real.
for (const viewport of [mobile, desktop]) {
  test(`song discovery selected ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/song-search', route => route.fulfill({
      status: 202, json: { status: 'pending', search_id: 'visual-song' },
    }));
    await page.route('**/api/song-search/visual-song', route => route.fulfill({ json: {
      status: 'done', songs: songVersions,
    } }));
    await page.route('**/api/key-analysis', route => route.fulfill({ json: { original_key: 'C major' } }));
    await page.route(songVersions[0].thumbnail_url!, route => route.fulfill({ contentType: 'image/svg+xml', body: songArtwork }));
    await page.route(songVersions[2].thumbnail_url!, route => route.abort());
    await page.goto('/');
    await page.getByRole('button', { name: 'Find song', exact: true }).click();
    await page.getByLabel('Describe a song').fill('Hikaru Utada First Love');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('radio')).toHaveCount(3);
    await expect(page.getByRole('radio').first()).toBeChecked();
    await page.getByRole('radio', { name: /Dance Remix/ }).check();
    const artwork = page.locator('.song-match img');
    await expect(artwork).toHaveCount(1);
    await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(page.getByRole('status')).toHaveCount(0);
    await page.getByRole('heading', { name: "ehpc's Vocal Tools", exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    await compare(page, info, `song-discovery-selected-${viewport.width}.png`);
  });

  test(`song discovery pending ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.route('**/api/song-search', route => route.fulfill({
      status: 202, json: { status: 'pending', search_id: 'visual-pending' },
    }));
    await page.route('**/api/song-search/visual-pending', route => route.fulfill({ json: { status: 'pending' } }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Find song', exact: true }).click();
    await page.getByLabel('Describe a song').fill('A soulful piano ballad by Hikaru Utada');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('status')).toBeVisible();
    await page.getByRole('heading', { name: "ehpc's Vocal Tools", exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    await compare(page.locator('.source-panel'), info, `song-discovery-pending-${viewport.width}.png`);
  });
}

for (const viewport of [mobile, desktop]) {
  test(`mix builder queue edit remove ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await analyze(page, info);
    const add = async (parts: string[]) => {
      for (const part of parts) await page.getByRole('button', { name: `+ ${part}`, exact: true }).click();
      await page.getByRole('button', { name: 'Add mix', exact: true }).click();
    };
    // The four approved example pairs plus a 3-part mix.
    await add(['Drums', 'Bass']);
    await add(['Drums', 'Vocals']);
    await add(['Bass', 'Vocals']);
    await add(['Drums', 'Other instruments']);
    await page.locator('details.vocal-variants summary').click();
    await add(['Drums', 'Bass', 'Vocals']);
    // A custom-named variant mix: mobile must show the component breakdown inline.
    await add(['Female vocals', 'Instruments']);
    await page.getByRole('button', { name: 'Edit Female vocals + Instruments' }).click();
    const name = page.getByLabel('Mix name for Female vocals + Instruments');
    await page.waitForTimeout(200);
    await name.press('ControlOrMeta+a');
    await name.pressSequentially('Chorus lift', { delay: 120 });
    await expect(page.getByRole('button', { name: 'Save mix' })).toBeVisible();
    await expect(name).toHaveValue('Chorus lift');
    await page.getByRole('button', { name: 'Save mix' }).click();
    await expect(page.getByRole('button', { name: 'Edit Chorus lift' })).toBeVisible();
    // Remove an earlier row while nothing is being edited.
    await page.getByRole('button', { name: 'Remove Drums + Bass', exact: true }).click();
    await expect(page.getByText('Your mixes (5)', { exact: true })).toBeVisible();
    await page.getByRole('heading', { name: "ehpc's Vocal Tools", exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    // Mobile tabs hide inactive panes, so capture the builder on its own tab.
    await compare(page.locator('.mix-group'), info, `mix-builder-${viewport.width}.png`);
    if (viewport.width <= 700) {
      await adjust(page);
      await page.getByRole('tab', { name: 'Review', exact: true }).click();
    }
    await compare(page.locator('.review-page'), info, `mix-review-${viewport.width}.png`);
  });
}

const states = [
  { name: 'known-zero', pitch: '0', key: 'C major' },
  { name: 'shifted-plus-two', pitch: '2', key: 'D major' },
  { name: 'unknown', pitch: '0', key: null },
  { name: 'long-fractional-cents', pitch: '2.123456789', key: 'D major (+12.3456789 cents)' },
];
for (const viewport of [mobile, desktop]) {
  for (const state of states) {
    test(`focused pitch ${viewport.width} ${state.name}`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await analyze(page, info, state.key === null);
      await adjust(page);
      const input = page.getByRole('spinbutton', { name: pitchName });
      await input.fill(state.pitch);
      await input.focus();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(state.pitch);
      if (state.key) {
        await expect(input).toHaveAccessibleDescription(`Resulting key: ${state.key}`);
      } else {
        await expect(page.locator('.pitch-key-badge')).toHaveCount(0);
        await expect(page.getByText('Original key: Undetermined', { exact: true })).toBeVisible();
      }
      // Include the neighboring tempo control to catch wrapping/overlap and
      // leave room for the pitch focus outline without eight whole-page images.
      await compare(page.locator('.workspace-numbers'), info, `pitch-${viewport.width}-${state.name}.png`);
    });
  }
}

// Genuine full-song CREPE/Whisper output, filtered to output9.5–15.2s.
// Audio remains the uncut public-domain recording; these cases exercise the
// real upload/API/storage/native transform/rendering path without another GPU.
const publishTimeline = String.raw`
import json,sys
from backend import config,db
from backend.queue import _persist_results
from separator.lyrics import transcript_from_json
from separator.pitch import pitch_from_json,pitch_to_json
from separator.stems import StemResult
value=json.load(sys.stdin)
job=db.get_job(int(sys.argv[1]))
assert job is not None
source=(config.UPLOADS_DIR / str(job.id) / job.source_value).read_bytes()
assert config.QUEUE_CONCURRENCY == 0
# Geometry fixtures reuse the original recording for each player, not inference.
manifest=_persist_results(job,{label:StemResult(source,0) for label in value.get('playback_labels',['song'])})
db.mark_done(job.id,manifest,transcript_from_json(json.dumps(value['transcript'])),
    pitch_to_json(pitch_from_json(json.dumps(value['pitch']))))
`;

for (const viewport of [mobile, desktop]) {
  test(`detected vocal melody ${viewport.width} with linked sung words`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg'));
    const fixture = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8');
    const response = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
      file: { name: 'auld-lang-syne-full.ogg', mimeType: 'audio/ogg', buffer: source },
      detect_pitch: 'true', extract_lyrics: 'true', pitch_semitones: '1.25', tempo_percent: '125',
    } });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).id as number;
    execFileSync('uv', ['run', 'python', '-c', publishTimeline, String(id)], {
      cwd: process.env.E2E_REPO_ROOT!, input: fixture,
      env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    await page.reload();
    const view = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
    await expect(view).toBeVisible();
    const player = view.locator('audio[controls]');
    // Exercise the real HTTP source; native control paint is browser-owned.
    await player.evaluate(element => {
      element.preload = 'auto';
      element.load();
    });
    await expect.poll(() => player.evaluate(element => Number.isFinite(element.duration)
      && element.seekable.length > 0)).toBe(true);
    const payload = await (await page.request.get(`/api/jobs/${id}/pitch`)).json() as PitchAnalysisDTO;
    const acquaintanceIndex = payload.words.findIndex(word => word.text === 'acquaintance');
    const noteIndex = payload.tracks[0].notes.findIndex(note => note.word_indices.includes(acquaintanceIndex));
    const note = view.locator('.pitch-note').nth(noteIndex);
    await note.scrollIntoViewIfNeeded();
    await note.click();
    await expect(view.locator('.pitch-selection')).toContainText('acquaintance');
    await expect.poll(() => player.evaluate(element => !element.seeking && element.readyState >= 4)).toBe(true);
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await compare(view, info, `vocal-melody-${viewport.width}-word-notes.png`, [player]);
    // Captured CREPE/Whisper data retains its word-to-note provenance; this is
    // the actual reader and keyboard using the same output-clock position.
    const reader = view.getByLabel('Current karaoke line');
    await expect(reader.getByRole('group', { name: 'Current lyrics' })).toBeVisible();
    await expect(reader.getByRole('group', { name: 'Next lyrics' })).toBeVisible();
    await expect(reader.locator('.timeline-karaoke-pitches').first()).toBeVisible();
    await expect(view.getByLabel('Piano keyboard')).toBeVisible();
    await compare(view.locator('.pitch-footer'), info, `karaoke-piano-${viewport.width}.png`, [player]);
    const piano = view.getByLabel('Piano keyboard');
    const key = piano.getByRole('button', { name: 'Piano C3', exact: true });
    await key.scrollIntoViewIfNeeded();
    const bounds = (await key.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 10);
    await page.mouse.down();
    await expect(key).toHaveAttribute('aria-pressed', 'true');
    await expect(key).toHaveClass(/piano-key-active/);
    await compare(piano.locator('.piano-scroll'), info, `piano-pressed-${viewport.width}.png`);
    await page.mouse.up();
    const toggle = view.getByRole('button', { name: 'Pitches', exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(reader.locator('.timeline-karaoke-pitches')).toHaveCount(0);
    await expect(reader.getByRole('group', { name: 'Current lyrics' })).toBeVisible();
    await expect(reader.getByRole('group', { name: 'Next lyrics' })).toBeVisible();
  });
}

// Synthetic alignment stresses a crowded word without changing the captured
// CREPE/Whisper provenance fixture above. Audio remains paused at a fixed seek.
for (const viewport of [mobile, desktop]) {
  test(`crowded karaoke pitches ${viewport.width}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg'));
    const fixture = JSON.parse(await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8'));
    const words = [
      { text: 'silver', start_s: 5, end_s: 7.5, probability: null, origin: 'reference-aligned' },
      { text: 'Next', start_s: 11.875, end_s: 13.125, probability: null, origin: 'reference-aligned' },
      { text: 'chorus', start_s: 13.75, end_s: 15.625, probability: null, origin: 'reference-aligned' },
    ];
    const line = (text: string, start_s: number, end_s: number) => ({
      text, start_s, end_s, status: 'aligned', support: 0.8, reason: 'Synthetic visual fixture',
      unconfirmed_words: [], recognized_variant: null,
    });
    fixture.transcript.words = words;
    fixture.transcript.segments = [];
    fixture.transcript.sections = [];
    fixture.transcript.canonical_word_positions = words.map((_, word_index) => ({
      word_index, reference_line_index: word_index === 0 ? 0 : 1,
      reference_token_index: word_index === 0 ? 1 : word_index - 1,
    }));
    fixture.transcript.reference = { ...fixture.transcript.reference, status: 'partial',
      lines: [line('Before silver, after', 3.75, 11.25), line('Next chorus', 11.875, 15.625)] };
    fixture.pitch.words = words.map(word => ({ ...word, start_s: word.start_s / 1.25, end_s: word.end_s / 1.25 }));
    const pitches = ['C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4', 'G#4', 'A4', 'A#4', 'B4', 'C5',
      'C#5', 'D5', 'D#5', 'E5', 'F5', 'F#5', 'G5', 'G#5', 'A5', 'A#5', 'B5', 'C6'];
    const note = (name: string, midi: number, start_s: number, word: number) => ({
      note: name, midi, frequency_hz: 440 * 2 ** ((midi - 69) / 12), confidence: 0.8, cents: 0,
      start_s, end_s: start_s + 0.07, word_indices: [word],
    });
    fixture.pitch.tracks = [{ label: 'lead', notes: [
      ...pitches.map((name, i) => note(name, 61 + i, 4 + i * 0.08, 0)),
      ...['F#4', 'G#4', 'A#4'].map((name, i) => note(name, 66 + i * 2, 9.5 + i * 0.2, 1)),
      ...['C#5', 'D#5', 'F#5'].map((name, i) => note(name, [73, 75, 78][i], 11 + i * 0.2, 2)),
    ] }];
    const response = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
      file: { name: 'auld-lang-syne-full.ogg', mimeType: 'audio/ogg', buffer: source },
      detect_pitch: 'true', extract_lyrics: 'true', pitch_semitones: '1.25', tempo_percent: '125',
    } });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).id as number;
    execFileSync('uv', ['run', 'python', '-c', publishTimeline, String(id)], {
      cwd: process.env.E2E_REPO_ROOT!, input: JSON.stringify(fixture),
      env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    await page.reload();
    const view = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
    const player = view.locator('audio[controls]');
    await player.evaluate(audio => { audio.preload = 'auto'; audio.load(); });
    await expect.poll(() => player.evaluate(audio => Number.isFinite(audio.duration) && audio.seekable.length > 0)).toBe(true);
    await player.evaluate(audio => { audio.pause(); audio.currentTime = 5.625; });
    await expect.poll(() => player.evaluate(audio => !audio.seeking && audio.paused && Math.abs(audio.currentTime - 5.625) < 0.05)).toBe(true);
    const reader = view.getByLabel('Current karaoke line');
    await expect(reader.getByRole('group', { name: /^Pitches for silver:/ })).toHaveText(pitches.join(' '));
    const next = reader.getByRole('group', { name: 'Next lyrics' });
    await expect(next.getByText('Next', { exact: true })).toBeVisible();
    await expect(next.getByText('chorus', { exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await reader.screenshot({ path: info.outputPath('actual.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
    await expect.soft(reader).toHaveScreenshot(`karaoke-crowded-${viewport.width}.png`);
    await view.getByRole('button', { name: 'Open karaoke fullscreen' }).click();
    const fullscreen = page.getByRole('dialog', { name: 'Karaoke fullscreen' });
    await expect(fullscreen.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(fullscreen.getByRole('group', { name: 'Current lyrics' })).toBeVisible();
    await expect(fullscreen.getByRole('group', { name: 'Next lyrics' })).toBeVisible();
    await expect(fullscreen.getByRole('button', { name: 'Larger lyrics' })).toBeDisabled();
    await fullscreen.screenshot({ path: info.outputPath('fullscreen.png'), animations: 'disabled', caret: 'hide', scale: 'css' });
    await expect(fullscreen).toHaveScreenshot(`karaoke-fullscreen-${viewport.width}.png`);
  });
}

// Synthetic canonical text exercises reference support/provenance presentation;
// no hosted copyrighted lyrics or fabricated audio-recognition claim is stored.
const publishReference = String.raw`
import json,sys
from backend import db
from separator.lyrics import transcript_from_json
value=json.load(sys.stdin)
job=db.get_job(int(sys.argv[1]))
assert job is not None
db.mark_done(job.id,[],transcript_from_json(json.dumps(value)),None)
`;

for (const viewport of [mobile, desktop]) {
  test(`reference-aligned provenance ${viewport.width} with untimed conflicting line`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
    const response = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
      file: { name: 'synthetic-reference.wav', mimeType: 'audio/wav', buffer: source },
      extract_lyrics: 'true',
    } });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).id as number;
    const original = [{ start_s: 1, end_s: 3, text: 'Amber lanterns shine' }];
    const fixture = {
      segments: [{ start_s: 1, end_s: 3, text: 'Amber lanterns softly shine' }],
      language: 'English', timestamp_reference: 'original', sections: [], structure_model: null,
      asr_model: 'Qwen/Qwen3-ASR-1.7B', word_alignment: 'torchaudio/MMS_FA',
      words: [{ start_s: 1, end_s: 1.5, text: 'Amber', probability: null, alignment_score: 0.71 }],
      recognition_chunks: [{ input_start_s: 0, input_end_s: 4, ownership_start_s: 0, ownership_end_s: 4,
        text: 'Amber lanterns shine. Silver branches sleep.', language: 'English' }],
      reference: {
        status: 'partial', reason: 'One reference-aligned line; conflicting recognition retained.',
        provider: 'Synthetic test fixture', source_url: null, record_id: null,
        artist: 'Synthetic Artist', title: 'Synthetic Song', album: null, duration_s: 4,
        agreement: 0.75, fetched_at: '2026-01-01T12:00:00+00:00', cached: true,
        original_segments: original, original_words: [], corrections: [],
        lines: [
          { text: 'Amber lanterns softly shine', status: 'aligned', support: 0.75, start_s: 1, end_s: 3,
            unconfirmed_words: ['softly'], recognized_variant: null,
            reason: 'Reference-aligned phrase, not proof of every word.' },
          { text: 'Silver branches sway', status: 'unconfirmed', support: 0.67, start_s: null, end_s: null,
            unconfirmed_words: ['sway'], recognized_variant: 'silver branches sleep',
            reason: 'Conflicting lyric retained; no timestamp invented.' },
        ],
      },
    };
    execFileSync('uv', ['run', 'python', '-c', publishReference, String(id)], {
      cwd: process.env.E2E_REPO_ROOT!, input: JSON.stringify(fixture),
      env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    await page.reload();
    const view = page.getByLabel('Lyrics transcript', { exact: true }).first();
    await expect(view).toBeVisible();
    await view.getByText('Online alignment and raw recognition details', { exact: true }).click();
    await view.getByText('Canonical reference order and audio support', { exact: true }).click();
    await expect(view.getByText('??:?? · 67% local word agreement', { exact: false })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await compare(view, info, `reference-provenance-${viewport.width}.png`);
  });
}

const publishPitched = String.raw`
import json,sys
from backend import db
from separator.lyrics import transcript_from_json
from separator.pitch import pitch_from_json,pitch_to_json
value=json.load(sys.stdin)
db.mark_done(int(sys.argv[1]),[],transcript_from_json(json.dumps(value['transcript'])),
    pitch_to_json(pitch_from_json(json.dumps(value['pitch']))))
`;

for (const viewport of [mobile, desktop]) {
  test(`pitched lyrics ${viewport.width} canonical word cells and unknown timings`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const source = await readFile(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
    const response = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
      file: { name: 'synthetic-pitch-typography.wav', mimeType: 'audio/wav', buffer: source },
      extract_pitched_lyrics: 'true', pitch_semitones: '1.25', tempo_percent: '125',
    } });
    expect(response.ok()).toBe(true);
    const id = (await response.json()).id as number;
    // Deliberately synthetic data tests typography, not model accuracy.
    const words = [
      { start_s: 1, end_s: 2, text: 'Cœur', probability: null, alignment_score: 0.8, origin: 'reference-aligned' },
      { start_s: 2, end_s: 3, text: 'поёт', probability: null, alignment_score: 0.8, origin: 'reference-aligned' },
      { start_s: 3, end_s: 4, text: '星光', probability: null, alignment_score: 0.8, origin: 'reference-aligned' },
    ];
    const fixture = {
      transcript: {
        segments: [{ start_s: 1, end_s: 4, text: 'Cœur поёт 星光' }], language: 'Synthetic',
        timestamp_reference: 'original', sections: [{ start_s: 0, end_s: 4, label: 'verse' }],
        structure_model: 'Synthetic typography fixture', words,
        canonical_word_positions: words.map((_, index) => ({ word_index: index, reference_line_index: 0, reference_token_index: index })),
        reference: {
          status: 'partial', reason: 'Synthetic typography fixture, not inference', provider: 'Synthetic',
          lines: [
            { text: 'Cœur поёт 星光', status: 'aligned', start_s: 1, end_s: 4 },
            { text: 'Unconfirmed closing words', status: 'unconfirmed' },
          ],
        },
      },
      pitch: {
        source_duration_s: 5, duration_s: 4, pitch_shift_semitones: 1.25, tempo_percent: 125,
        timestamp_reference: 'output', pitch_reference: 'output', word_alignment: 'torchaudio/MMS_FA',
        words: words.map(word => ({ ...word, start_s: word.start_s / 1.25, end_s: word.end_s / 1.25 })),
        tracks: [{ label: 'vocals', notes: [
          { start_s: 0.8, end_s: 1, midi: 61.25, frequency_hz: 281.26, confidence: 0.9, word_indices: [0] },
          { start_s: 1.05, end_s: 1.3, midi: 61.25, frequency_hz: 281.26, confidence: 0.9, word_indices: [0] },
          { start_s: 1.3, end_s: 1.6, midi: 63.25, frequency_hz: 315.7, confidence: 0.9, word_indices: [0] },
          { start_s: 1.6, end_s: 2.4, midi: 65.25, frequency_hz: 354.35, confidence: 0.9, word_indices: [1] },
        ] }],
      },
    };
    execFileSync('uv', ['run', 'python', '-c', publishPitched, String(id)], {
      cwd: process.env.E2E_REPO_ROOT!, input: JSON.stringify(fixture),
      env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
    });
    await page.reload();
    const view = page.getByRole('region', { name: 'Lyrics with pitches', exact: true }).first();
    await expect(view).toBeVisible();
    const text = view.getByRole('region', { name: 'Aligned pitch and lyric text' });
    await expect(text).toContainText('C#4 C#4 D#4');
    await expect(text).toContainText('? ? ? [??:??] Unconfirmed closing words');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    await compare(view, info, `pitched-lyrics-${viewport.width}-word-cells.png`);
  });
}

for (const viewport of [mobile, desktop]) {
  test.describe(`full-range pitch controls ${viewport.width}`, () => {
    test.use({ viewport, isMobile: viewport.width <= 700, hasTouch: viewport.width <= 700 });
    test('keeps transformed source choices within the device and notes tappable beside sticky lanes', async ({ page }, info) => {
      await page.goto('/');
      const source = await readFile(resolve(process.env.E2E_REPO_ROOT!, 'tests/fixtures/auld-lang-syne-full.ogg'));
      const fixture = JSON.parse(await readFile(resolve(process.env.E2E_REPO_ROOT!, 'frontend/e2e/fixtures/pitch-visual-window.json'), 'utf8'));
      // Purpose-built geometry: the failing full-song range, 64ms note and long
      // timeline, with every transformed reference choice. This is not inference.
      const geometryNotes = [
        { start_s: 1, end_s: 1.1, midi: 36, word_indices: [] },
        { start_s: 13.476, end_s: 13.54, midi: 57, word_indices: [0] },
        { start_s: 100, end_s: 100.1, midi: 73, word_indices: [] },
      ].map(note => ({ ...note, frequency_hz: 440 * 2 ** ((note.midi - 69) / 12), confidence: 0.9 }));
      fixture.pitch.tracks = ['vocals', 'lead', 'backing'].map(label => ({ label, notes: label === 'vocals' ? geometryNotes : [] }));
      fixture.pitch.words = [fixture.pitch.words.find((word: { text: string }) => word.text === 'acquaintance')];
      fixture.playback_labels = ['song', 'vocals', 'lead', 'backing'];
      const response = await page.request.post('/api/jobs', { headers: { Origin: process.env.E2E_BASE_URL! }, multipart: {
        file: { name: 'auld-lang-syne-full.ogg', mimeType: 'audio/ogg', buffer: source },
        detect_pitch: 'true', extract_vocals: 'true', extract_lyrics: 'true', lead_backing: 'true',
        pitch_semitones: '1.25', tempo_percent: '125',
      } });
      expect(response.ok()).toBe(true);
      const id = (await response.json()).id as number;
      execFileSync('uv', ['run', 'python', '-c', publishTimeline, String(id)], {
        cwd: process.env.E2E_REPO_ROOT!, input: JSON.stringify(fixture),
        env: { ...process.env, DATA_DIR: process.env.E2E_DATA_DIR! },
      });
      await page.reload();
      const view = page.getByRole('region', { name: 'Karaoke with pitches', exact: true });
      await expect(view).toBeVisible();
      const assertDeviceWidth = async () => {
        expect(await page.evaluate(() => innerWidth)).toBe(viewport.width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
        const bounds = await view.getByLabel('Pitch background audio', { exact: true }).boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      };
      await assertDeviceWidth();
      const scroll = view.locator('.pitch-viewport');
      await scroll.evaluate(element => { element.scrollLeft = 1000; });
      await view.getByRole('slider', { name: 'Melody zoom', exact: true }).press('End');
      await assertDeviceWidth();
      expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      const note = view.locator('.pitch-note[data-note="A3"]');
      await note.scrollIntoViewIfNeeded();
      await note.click();
      await expect(view.locator('.pitch-selection')).toContainText('A3');
      // Expose the whole scrollport before placing notes at its two edges.
      await scroll.scrollIntoViewIfNeeded();
      for (const boundary of ['ruler', 'words']) {
        await note.evaluate((element, edge) => {
          const scroller = element.closest('.pitch-viewport')!;
          const bounds = element.getBoundingClientRect();
          const lane = scroller.querySelector(`.pitch-${edge}`)!.getBoundingClientRect();
          scroller.scrollTop += edge === 'ruler' ? bounds.top - lane.bottom - 4 : bounds.bottom - lane.top + 4;
        }, boundary);
        const geometry = await note.evaluate(element => {
          const box = element.getBoundingClientRect();
          const scroller = element.closest('.pitch-viewport')!;
          return {
            top: box.top, bottom: box.bottom,
            rulerBottom: scroller.querySelector('.pitch-ruler')!.getBoundingClientRect().bottom,
            wordsTop: scroller.querySelector('.pitch-words')!.getBoundingClientRect().top,
            hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('.pitch-note') === element,
          };
        });
        expect(geometry.top).toBeGreaterThanOrEqual(geometry.rulerBottom);
        expect(geometry.bottom).toBeLessThanOrEqual(geometry.wordsTop);
        expect(geometry.top).toBeGreaterThanOrEqual(0);
        expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
        expect(geometry.hit).toBe(true);
        if (viewport.width <= 700) await note.tap();
        else await note.click();
        await expect(view.locator('.pitch-selection')).toContainText('A3');
        await assertDeviceWidth();
        await writeFile(info.outputPath(`${boundary}-geometry.json`), JSON.stringify(geometry));
      }
      await view.locator('.pitch-word').click();
      await expect(view.locator('.pitch-selection')).toContainText('acquaintance');
      await view.getByRole('slider', { name: 'Pitch timeline position' }).press('Home');
      await expect(view.getByRole('slider', { name: 'Pitch timeline position' })).toHaveAttribute('aria-valuenow', '0');
      await page.screenshot({ path: info.outputPath('responsive-controls.png') });
    });
  });
}
