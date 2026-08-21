import { expect, test } from "@playwright/test";

function channel(value: string): number[] {
  return value.match(/\d+/gu)?.slice(0, 3).map(Number) ?? [];
}

function luminance([red = 0, green = 0, blue = 0]: readonly number[]): number {
  const convert = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * convert(red) + 0.7152 * convert(green) + 0.0722 * convert(blue);
}

test("keyboard search flow uses the real local API contract", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.bringToFront();

  const search = page.getByRole("searchbox", { name: "Search the knowledge base" });
  await expect(search).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: "Search is ready" })).toBeVisible();
  await expect(page.getByText("card-gateway-artifacts")).toBeVisible();

  await search.fill('timeout_ms("gateway")');
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Search" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(search).toBeFocused();

  const searchResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/search") && response.request().method() === "POST",
  );
  await page.keyboard.press("Enter");
  expect((await searchResponse).status()).toBe(200);
  await expect(page.getByRole("heading", { name: "2 results" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.locator("mark")).toHaveCount(3);

  await search.press("ArrowDown");
  const openActions = page.getByRole("button", { name: "Open full file" });
  await expect(openActions.nth(0)).toBeFocused();
  await expect(openActions.nth(0)).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("ArrowDown");
  await expect(openActions.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(openActions.nth(0)).toBeFocused();

  const expand = page.locator(".additional-excerpts > button");
  await expect(expand).toHaveAccessibleName("Show 1 more matched section");
  await expand.click();
  await expect(expand).toHaveAttribute("aria-expanded", "true");
  await expect(expand).toHaveAccessibleName("Hide 1 more matched section");
  await expect(page.getByText(/second timeout_ms policy/)).toBeVisible();

  await openActions.nth(0).focus();
  await page.keyboard.press("Enter");
  const viewerHost = page.getByRole("complementary", { name: "Selected file" });
  await expect(viewerHost).toBeVisible();
  await expect(viewerHost.getByRole("heading", { name: "gateway.md" })).toBeVisible();
  await expect(page).toHaveURL(/file=[a-f0-9]{64}/u);

  const motionDuration = await page
    .locator(".status-dot")
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(motionDuration)).toBeLessThanOrEqual(0.001);

  const buttonColors = await page.getByRole("button", { name: "Search" }).evaluate((element) => {
    const style = getComputedStyle(element);
    return { foreground: style.color, background: style.backgroundColor };
  });
  const light = luminance(channel(buttonColors.foreground));
  const dark = luminance(channel(buttonColors.background));
  const contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
  expect(contrast).toBeGreaterThanOrEqual(4.5);
});
