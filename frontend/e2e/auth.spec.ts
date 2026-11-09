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
  test(`registration, profile, administration, login, expiry and logout ${viewport.width}`, async ({ page, browser }, info) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const member = await browser.newContext({ viewport, baseURL: process.env.E2E_BASE_URL });
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
      await guest.getByRole('button', { name: 'Create invite' }).click();
      await expect(guest.getByText('Invite created.')).toBeVisible();
      await guest.screenshot({ path: info.outputPath(`profile-${viewport.width}.png`) });
      guest.once('dialog', dialog => dialog.accept());
      await guest.getByRole('button', { name: 'Revoke', exact: true }).click();
      await expect(guest.getByText('Invite revoked.')).toBeVisible();
      await expect(guest.getByText('revoked', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'People', exact: true }).click();
      const card = page.locator('div').filter({ has: page.getByRole('heading', { name: email, exact: true }) }).filter({ has: page.getByRole('button', { name: 'Save limit' }) }).last();
      await card.getByLabel('Invite limit').fill('5');
      await card.getByRole('button', { name: 'Save limit' }).click();
      await expect(card.getByText('Invite limit saved.')).toBeVisible();
      await page.screenshot({ path: info.outputPath(`people-${viewport.width}.png`) });
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
}
