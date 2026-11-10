import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { test } from './auth-fixture';

const root = process.env.E2E_REPO_ROOT!;
const directory = process.env.E2E_FIXTURE_DIR!;
const mailPath = (email: string) => resolve(directory, `mail-${encodeURIComponent(email)}.txt`);
const command = (...args: string[]) => execFileSync('uv', ['run', 'python', '-m', 'backend.auth_admin', ...args], {
  cwd: root, env: process.env, encoding: 'utf8',
}).trim();

// Advance only fixture state that would otherwise require waiting for the real
// rate limit or 72-hour idle deadline; the browser still uses real HTTP and SMTP.
function database(sql: string, ...args: string[]) {
  execFileSync('uv', ['run', 'python', '-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2],sys.argv[3:]); c.commit()',
    resolve(process.env.E2E_DATA_DIR!, 'jobs.db'), sql, ...args], { cwd: root });
}

async function verify(page: Page, email: string) {
  await expect(page.getByLabel('Verification code')).toBeVisible();
  let code = '';
  await expect.poll(async () => {
    try { code = await readFile(mailPath(email), 'utf8'); return code; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return '';
    }
  }).toMatch(/^\d{6}$/);
  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('button', { name: 'Profile', exact: true })).toBeVisible();
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`account ${viewport.width}`, () => {
  test.use({ viewport, isMobile: viewport.width === 390, hasTouch: viewport.width === 390 });
  test(`registration, profile, administration, login, expiry and logout ${viewport.width}`, async ({ page, browser }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const member = await browser.newContext({ viewport, isMobile: viewport.width === 390, hasTouch: viewport.width === 390, baseURL: process.env.E2E_BASE_URL });
    const guest = await member.newPage();
    const email = `browser-${viewport.width}-${randomBytes(6).toString('hex')}@example.test`;
    const invite = command('seed-invite').split(/\s+/)[1];
    try {
      await guest.goto('/');
      await expect(guest.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      await guest.getByRole('button', { name: 'Register', exact: true }).click();
      await guest.getByLabel('Email address').fill(email);
      await guest.getByLabel('Invitation code').fill(invite);
      await guest.screenshot({ path: info.outputPath(`register-${viewport.width}.png`) });
      await guest.getByRole('button', { name: 'Send verification code' }).click();
      await verify(guest, email);
      await expect(guest.getByRole('button', { name: 'People', exact: true })).toHaveCount(0);
      await guest.getByRole('button', { name: 'Profile', exact: true }).click();
      await expect(guest.getByText(email).first()).toBeVisible();
      await expect(guest.getByText('0 of 3 invite slots used · 3 remaining')).toBeVisible();
      if (viewport.width === 390) await guest.getByRole('button', { name: 'Create invite' }).tap();
      else await guest.getByRole('button', { name: 'Create invite' }).click();
      await expect(guest.getByText('Invite created.')).toBeVisible();
      const initialProfile = await (await member.request.get('/api/auth/me')).json();
      const firstInvite = initialProfile.invites.find((item: { status: string }) => item.status === 'pending');
      expect(firstInvite).toBeTruthy();
      const recipientEmail = `recipient-${viewport.width}-${randomBytes(6).toString('hex')}@example.test`;
      const recipient = await browser.newContext({ viewport, baseURL: process.env.E2E_BASE_URL });
      try {
        const recipientPage = await recipient.newPage();
        await recipientPage.goto('/');
        await recipientPage.getByRole('button', { name: 'Register', exact: true }).click();
        await recipientPage.getByLabel('Email address').fill(recipientEmail);
        await recipientPage.getByLabel('Invitation code').fill(firstInvite.code);
        await recipientPage.getByRole('button', { name: 'Send verification code' }).click();
        await verify(recipientPage, recipientEmail);
      } finally {
        await recipient.close();
      }
      await guest.reload();
      await guest.getByRole('button', { name: 'Profile', exact: true }).click();
      await expect(guest.getByText('1 of 3 invite slots used · 2 remaining')).toBeVisible();
      for (let count = 2; count <= 3; count++) {
        await guest.getByRole('button', { name: 'Create invite' }).click();
        await expect(guest.getByText(`${count} of 3 invite slots used · ${3 - count} remaining`)).toBeVisible();
      }
      await expect(guest.getByRole('button', { name: 'Create invite' })).toBeDisabled();
      await expect(guest.getByRole('button', { name: /revoke|withdraw/i })).toHaveCount(0);
      const profile = await (await member.request.get('/api/auth/me')).json();
      const pending = profile.invites.find((item: { status: string }) => item.status === 'pending');
      expect(profile.invites.filter((item: { status: string }) => item.status === 'activated')).toHaveLength(1);
      expect((await member.request.delete(`/api/auth/invites/${pending.id}`, { headers: { Origin: process.env.E2E_BASE_URL! } })).status()).toBe(403);
      expect((await member.request.delete(`/api/auth/invites/${firstInvite.id}`, { headers: { Origin: process.env.E2E_BASE_URL! } })).status()).toBe(403);
      expect((await member.request.post('/api/auth/invites', { headers: { Origin: process.env.E2E_BASE_URL! } })).status()).toBe(409);
      expect((await member.request.get(`/api/admin/users/${profile.id}/activity`)).status()).toBe(403);
      expect((await member.request.get('/api/admin/users')).status()).toBe(403);
      expect((await member.request.post(`/api/admin/users/${profile.id}/invite-slot`, { headers: { Origin: process.env.E2E_BASE_URL! } })).status()).toBe(403);
      // Seed only isolated activity metadata; no external search or inference runs.
      const queued = await member.request.post('/api/jobs', {
        headers: { Origin: process.env.E2E_BASE_URL! },
        multipart: { file: { name: 'local-tone.wav', mimeType: 'audio/wav', buffer: await readFile(resolve(directory, 'tone-fixture.wav')) } },
      });
      expect(queued.ok()).toBe(true);
      const queuedId = (await queued.json()).id;
      database('UPDATE jobs SET title=? WHERE id=?', 'Local fixture track', String(queuedId));
      database("INSERT INTO song_searches (id,session_id,created_at,result_json,activity_query) VALUES (?, ?, strftime('%s','now'), '[]', ?)", `fixture-${viewport.width}`, profile.id, 'Local fixture song');
      await guest.screenshot({ path: info.outputPath(`profile-${viewport.width}.png`) });

      const adminProfile = await (await page.request.get('/api/auth/me')).json();
      expect((await page.request.post(`/api/admin/users/${adminProfile.id}/invite-slot`, { headers: { Origin: process.env.E2E_BASE_URL! } })).status()).toBe(409);
      expect(adminProfile.invite_limit).toBeNull();
      const users = await (await page.request.get('/api/admin/users')).json();
      const recipientUser = users.find((user: { email: string }) => user.email === recipientEmail);
      expect(recipientUser.invite_limit).toBe(3);
      const grants = await Promise.all([
        page.request.post(`/api/admin/users/${recipientUser.id}/invite-slot`, { headers: { Origin: process.env.E2E_BASE_URL! } }),
        page.request.post(`/api/admin/users/${recipientUser.id}/invite-slot`, { headers: { Origin: process.env.E2E_BASE_URL! } }),
      ]);
      expect(grants.every(response => response.ok())).toBe(true);
      expect((await Promise.all(grants.map(response => response.json()))).map(user => user.invite_limit).sort()).toEqual([4, 5]);
      const adminInvites: string[] = [];
      try {
        for (let i = 0; i < 4; i++) {
          const response = await page.request.post('/api/auth/invites', { headers: { Origin: process.env.E2E_BASE_URL! } });
          expect(response.ok()).toBe(true);
          adminInvites.push((await response.json()).id);
        }
      } finally {
        for (const id of adminInvites) expect((await page.request.delete(`/api/auth/invites/${id}`, { headers: { Origin: process.env.E2E_BASE_URL! } })).status()).toBe(204);
      }
      expect((await page.request.delete(`/api/auth/invites/${firstInvite.id}`, { headers: { Origin: process.env.E2E_BASE_URL! } })).status()).toBe(404);
      await page.getByRole('button', { name: 'People', exact: true }).click();
      const card = page.locator('div').filter({ has: page.getByRole('heading', { name: email, exact: true }) }).filter({ has: page.getByRole('button', { name: 'Grant +1 invite' }) }).last();
      await expect(card.getByLabel('Invite limit')).toHaveValue('3');
      if (viewport.width === 390) await card.getByRole('button', { name: 'Grant +1 invite' }).tap();
      else await card.getByRole('button', { name: 'Grant +1 invite' }).click();
      await expect(card.getByText('One invite slot granted.')).toBeVisible();
      await expect(card.getByLabel('Invite limit')).toHaveValue('4');
      await guest.reload();
      await guest.getByRole('button', { name: 'Profile', exact: true }).click();
      await expect(guest.getByText('3 of 4 invite slots used · 1 remaining')).toBeVisible();
      await guest.getByRole('button', { name: 'Create invite' }).click();
      await expect(guest.getByText('4 of 4 invite slots used · 0 remaining')).toBeVisible();
      await expect(guest.getByRole('button', { name: 'Create invite' })).toBeDisabled();
      await card.getByRole('button', { name: 'View activity' }).click();
      const activity = card.getByRole('region', { name: 'Activity' });
      await expect(activity.getByText(/Last login:/)).toBeVisible();
      await expect(activity.getByText(/Last activity:/)).toBeVisible();
      await expect(activity.getByText(/Registered:/)).toBeVisible();
      await expect(activity.getByText(new RegExp(`${recipientEmail.replaceAll('.', '\\.')}.*activated`))).toBeVisible();
      await expect(activity.getByRole('heading', { name: 'Jobs' })).toBeVisible();
      await expect(activity.getByRole('heading', { name: 'Searches' })).toBeVisible();
      await expect(activity.getByText(/Local fixture track.*queued/)).toBeVisible();
      await expect(activity.getByText(/Local fixture song.*completed/)).toBeVisible();
      await expect(activity.getByRole('button', { name: 'Withdraw unused invitation' })).toHaveCount(3);
      await page.screenshot({ path: info.outputPath(`people-${viewport.width}.png`) });
      await activity.screenshot({ path: info.outputPath(`member-activity-${viewport.width}.png`) });
      page.once('dialog', dialog => dialog.accept());
      await activity.getByRole('button', { name: 'Withdraw unused invitation' }).first().click();
      await expect(activity.getByRole('button', { name: 'Withdraw unused invitation' })).toHaveCount(2);
      await guest.reload();
      await guest.getByRole('button', { name: 'Profile', exact: true }).click();
      await expect(guest.getByText('3 of 4 invite slots used · 1 remaining')).toBeVisible();
      page.once('dialog', dialog => dialog.accept());
      await card.getByRole('button', { name: 'Revoke sessions' }).click();
      await expect(card.getByText('Sessions revoked.')).toBeVisible();
      await guest.reload();
      await expect(guest.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      database('DELETE FROM auth_sends');
      await rm(mailPath(email), { force: true });
      await guest.getByLabel('Email address').fill(email);
      await guest.getByRole('button', { name: 'Send verification code' }).click();
      await verify(guest, email);
      await guest.getByRole('button', { name: 'Sign out' }).click();
      await expect(guest.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      database('DELETE FROM auth_sends');
      await rm(mailPath(email), { force: true });
      await guest.getByLabel('Email address').fill(email);
      await guest.getByRole('button', { name: 'Send verification code' }).click();
      await verify(guest, email);
      database('UPDATE auth_sessions SET last_activity=0 WHERE user_id=(SELECT id FROM auth_users WHERE email=?)', email);
      await guest.reload();
      await expect(guest.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await member.close();
    }
  });
  });
}
