import puppeteer from "npm:puppeteer-core";

const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://localhost:8080/ws/" + (Deno.args[0] ?? 'default'),
});

const page = await browser.newPage();

// Navigate the page to a URL.
await page.goto("https://www.baidu.com/", {
  waitUntil: "networkidle2",
});

// Set screen size.
await page.setViewport({ width: 1080, height: 1024 });

await page.pdf({
  path: "screenshot.pdf",
});

await browser.close();
