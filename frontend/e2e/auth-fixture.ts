import { test as base, type BrowserContext } from '@playwright/test';

// The runner creates this session by redeeming a real invitation and email OTP.
// Each test receives a fresh browser context, without repeating rate-limited mail.
export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    const session = process.env.E2E_AUTH_SESSION;
    if (!session || !baseURL) throw new Error('Use the E2E runner to create an authenticated session.');
    await context.addCookies([{ name: 'auth_session', value: session, url: baseURL, httpOnly: true, sameSite: 'Lax' }]);
    await use(context);
  },
});

export async function authenticateOutsider(context: BrowserContext) {
  const session = process.env.E2E_AUTH_OUTSIDER_SESSION;
  const url = process.env.E2E_BASE_URL;
  if (!session || !url) throw new Error('Missing outsider session from E2E runner.');
  await context.addCookies([{ name: 'auth_session', value: session, url, httpOnly: true, sameSite: 'Lax' }]);
}
