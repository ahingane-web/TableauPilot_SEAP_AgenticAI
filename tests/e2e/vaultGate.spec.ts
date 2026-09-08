import { test, expect, type Page } from '@playwright/test';

/**
 * UI-only, non-destructive E2E. Verifies the app boots into the vault gate and that
 * the client-side flow (mode toggle, PIN validation) behaves — without touching a
 * real backend or Tableau Cloud.
 */
const usernameInput = (page: Page) => page.locator('input[autocomplete="username"]');
const pinInput = (page: Page) => page.getByPlaceholder('••••••');

test.describe('TableauPilot vault gate', () => {
  test('renders the app shell and the vault gate', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'TableauPilot AI' })).toBeVisible();
    // Default mode is "Unlock".
    await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
    await expect(usernameInput(page)).toBeVisible();
    await expect(pinInput(page)).toBeVisible();
  });

  test('can switch to Register mode', async ({ page }) => {
    await page.goto('/');
    await page.getByText('Register', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create your vault' })).toBeVisible();
  });

  test('submit stays disabled until a username and 6-digit PIN are entered', async ({ page }) => {
    await page.goto('/');
    const submit = page.getByRole('button', { name: 'Unlock' });
    await expect(submit).toBeDisabled();

    await usernameInput(page).fill('tester');
    await expect(submit).toBeDisabled();

    // Non-digits are stripped; fewer than 6 digits keeps it disabled.
    await pinInput(page).fill('12ab');
    await expect(submit).toBeDisabled();

    await pinInput(page).fill('123456');
    await expect(submit).toBeEnabled();
  });

  test('the right pane invites the user to unlock first', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Unlock your vault to begin.')).toBeVisible();
  });
});
