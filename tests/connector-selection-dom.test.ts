import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

const domTest = test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER);
const fixture = readFileSync(new URL("./fixtures/chatgpt-connector-markdown-2026-11-15.html", import.meta.url), "utf8");
const appName = "Fame Codex Native Home";

for (const staleHighlight of [false, true]) for (const width of [1258, 1]) {
  domTest(`markdown connector activates its exact button with composer focus, staleHighlight=${staleHighlight}, width=${width}`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width, height: width === 1 ? 1 : 676 } });
      await page.setContent(fixture);
      if (staleHighlight) await page.locator('[data-list-navigation-item]').evaluate(row => row.setAttribute("aria-current", "true"));
      const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config: { appName } });
      const checkpoints: string[] = [];
      const composer = await worker.selectConnector(page, async (checkpoint: string) => { checkpoints.push(checkpoint); });
      expect(await composer.locator('[app-mention-display-name]').getAttribute("app-mention-display-name")).toBe(appName);
      expect(await worker.connectorIsSelected(composer)).toBeTrue();
      expect(await worker.attachedPromptText(page)).toBe("");
      expect(checkpoints).toContain("connector-selected");
      expect(await page.locator("body").getAttribute("data-activations")).toBe("1");
      expect(await page.locator("body").getAttribute("data-submitted")).toBeNull();
    } finally {
      await browser.close();
    }
  }, 20_000);
}

domTest("markdown connector rejects duplicate exact rows without activating either", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(fixture);
    await page.locator('[data-list-navigation-item]').evaluate(row => row.after(row.cloneNode(true)));
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config: { appName } });
    let failure: unknown;
    try { await worker.selectConnector(page); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(await page.locator("body").getAttribute("data-activations")).toBe("0");
    expect(await page.locator('[app-mention-display-name]').count()).toBe(0);
    expect(await worker.attachedPromptText(page)).toBe("");
    expect(await page.locator("body").getAttribute("data-submitted")).toBeNull();
  } finally {
    await browser.close();
  }
}, 20_000);

domTest("cancellation after markdown connector activation clears the selected pill", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(fixture);
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), { config: { appName } });
    const controller = new AbortController();
    let failure: unknown;
    try {
      await worker.selectConnector(page, async (checkpoint: string) => {
        if (checkpoint === "connector-choice-activated") controller.abort();
      }, false, { triggerAttempts: 0 }, controller.signal);
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(await page.locator("body").getAttribute("data-activations")).toBe("1");
    expect(await page.locator('[app-mention-display-name]').count()).toBe(0);
    expect(await worker.attachedPromptText(page)).toBe("");
    expect(await page.locator("body").getAttribute("data-submitted")).toBeNull();
  } finally {
    await browser.close();
  }
}, 20_000);
