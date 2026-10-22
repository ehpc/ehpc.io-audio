import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

for (const viewport of [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 1440, height: 1000 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
]) {
  const mobile = viewport.width <= 700;
  test.describe(`audio adjustment buttons at ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: mobile, hasTouch: mobile });
    test('steps, manual values, bounds and reactive previews', async ({ page }, info) => {
      await page.goto('/');
      await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
      await page.getByLabel('Audio file', { exact: true }).setInputFiles(resolve(process.env.E2E_FIXTURE_DIR!, 'tone-fixture.wav'));
      if (mobile) await page.getByRole('tab', { name: 'Adjust', exact: true }).tap();
      await expect(page.getByText('Original key: C major', { exact: true })).toBeVisible({ timeout: 60_000 });
      const pitch = page.getByRole('spinbutton', { name: 'Pitch shift (semitones)' });
      const tempo = page.getByRole('spinbutton', { name: 'Tempo (% of original)' });
      const badge = page.locator('.pitch-key-badge');
      await expect(badge).toHaveText('Resulting key: C major');
      await expect(pitch).toHaveAccessibleDescription('Resulting key: C major');
      await pitch.fill('2');
      await expect(badge).toHaveText('Resulting key: D major');
      await pitch.fill('0');
      const activate = async (name: string) => {
        const button = page.getByRole('button', { name, exact: true });
        await expect(button).toBeVisible();
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        if (mobile) await button.tap();
        else await button.click();
      };
      await activate('Increase pitch');
      await expect(pitch).toHaveValue('1');
      await expect(page.getByText('Target key: Db major', { exact: true })).toBeVisible();
      await activate('Decrease pitch');
      await expect(pitch).toHaveValue('0');
      await activate('Decrease pitch');
      await expect(pitch).toHaveValue('-1');
      await activate('Increase tempo');
      await expect(tempo).toHaveValue('101');
      await activate('Decrease tempo');
      await expect(tempo).toHaveValue('100');

      await pitch.fill('-2.25');
      await activate('Increase pitch');
      await expect(pitch).toHaveValue('-1.25');
      await expect(page.getByText('Target key: B major (-25 cents)', { exact: true })).toBeVisible();
      await expect(badge).toHaveText('Resulting key: B major (-25 cents)');
      await pitch.fill('-2.123456789');
      await expect(badge).toHaveText('Resulting key: Bb major (-12.3456789 cents)');
      const keyGeometry = await page.locator('.pitch-key-field').evaluate(field => {
        const input = field.querySelector('input')!;
        const badge = field.querySelector('.pitch-key-badge')!;
        const box = field.getBoundingClientRect();
        const inputBox = input.getBoundingClientRect();
        const badgeBox = badge.getBoundingClientRect();
        return {
          field: { left: box.left, right: box.right, width: box.width },
          input: { left: inputBox.left, right: inputBox.right, width: inputBox.width },
          badge: { left: badgeBox.left, right: badgeBox.right, width: badgeBox.width },
          badgeOverflow: badge.scrollWidth > badge.clientWidth,
        };
      });
      expect(keyGeometry.input.width).toBeGreaterThanOrEqual(64);
      expect(keyGeometry.input.right).toBeLessThanOrEqual(keyGeometry.badge.left);
      expect(keyGeometry.badge.right).toBeLessThanOrEqual(keyGeometry.field.right);
      expect(keyGeometry.badgeOverflow).toBe(false);
      await page.screenshot({ path: info.outputPath(`pitch-key-fractional-${viewport.width}.png`), fullPage: true });
      await info.attach('pitch-key-geometry', { body: JSON.stringify(keyGeometry, null, 2), contentType: 'application/json' });
      await pitch.fill('-1.25');
      await tempo.fill('120.5');
      await activate('Decrease tempo');
      await expect(tempo).toHaveValue('119.5');
      if (mobile) await page.getByRole('tab', { name: 'Review', exact: true }).tap();
      await expect(page.getByText('Full song (pitch -1.25 st, tempo 119.5%)', { exact: true })).toBeVisible();
      await expect(page.getByText('Original (unchanged)', { exact: true })).toBeVisible();
      if (mobile) await page.getByRole('tab', { name: 'Adjust', exact: true }).tap();
      await expect(pitch).toHaveValue('-1.25');
      await expect(tempo).toHaveValue('119.5');

      await tempo.fill('2');
      await activate('Decrease tempo');
      await expect(tempo).toHaveValue('1');
      await expect(page.getByRole('button', { name: 'Decrease tempo', exact: true })).toBeDisabled();
      await tempo.fill('0.25');
      await expect(page.getByRole('button', { name: 'Decrease tempo', exact: true })).toBeDisabled();
      await activate('Increase tempo');
      await expect(tempo).toHaveValue('1.25');
      await activate('Decrease tempo');
      await expect(tempo).toHaveValue('0.25');
      await pitch.fill('');
      await expect(page.getByRole('button', { name: 'Increase pitch', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Decrease pitch', exact: true })).toBeDisabled();
      await expect(badge).toHaveCount(0);
      await pitch.fill('2');
      if (!mobile) {
        const increase = page.getByRole('button', { name: 'Increase pitch', exact: true });
        await increase.focus();
        await increase.press('Enter');
        await expect(pitch).toHaveValue('3');
        await increase.press('Space');
        await expect(pitch).toHaveValue('4');
      }
      await tempo.fill('120.5');
      await tempo.blur();
      await pitch.fill('2');
      await expect(badge).toHaveText('Resulting key: D major');
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        targets: [...document.querySelectorAll('.number-stepper button')].map(element => {
          const box = element.getBoundingClientRect();
          return { name: element.getAttribute('aria-label'), width: box.width, height: box.height };
        }),
      }));
      expect(geometry.document).toBeLessThanOrEqual(geometry.viewport);
      await page.screenshot({ path: info.outputPath(`adjustments-${viewport.width}.png`), fullPage: true });
      await info.attach('adjustment-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
      await page.getByRole('button', { name: 'From URL', exact: true }).click();
      await expect(badge).toHaveCount(0);
      await page.getByRole('button', { name: 'Upload audio', exact: true }).click();
      await page.getByLabel('Audio file', { exact: true }).setInputFiles(resolve(process.env.E2E_FIXTURE_DIR!, 'silent-fixture.wav'));
      await expect(page.getByText('Original key: Undetermined', { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(badge).toHaveCount(0);
    });
  });
}
