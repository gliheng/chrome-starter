# chrome-starter

A generic puppeteer service.

1. Install puppeteer-core from npm
2. Connect to this service to manipulate chrome

```js
import puppeteer from "npm:puppeteer-core";

const session = nanoid();
const browser = await puppeteer.connect({
  browserWSEndpoint: "ws://localhost:8080/ws/" + session,
});
```
