import { startStubCanvas } from "./server.js";

const port = Number(process.env["STUB_PORT"] ?? 3999);
const stub = await startStubCanvas(port, {
  token: process.env["STUB_TOKEN"] ?? "stub-token",
  feedToken: process.env["STUB_FEED_TOKEN"] ?? "feedsecret",
});
console.log(`stub canvas listening on ${stub.origin}`);
console.log(`  token:    ${stub.token}`);
console.log(`  feed url: ${stub.feedUrl}`);
