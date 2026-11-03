import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const server = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end("{}");
});
await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
let preview: MountedPreview | undefined;
try {
  preview = await mountPreview({ info: { url: `http://127.0.0.1:${address.port}` } }, {
    entry: "/scripts/testing/quote-ui-preview.tsx", route: "/__quote-ui.html", title: "Isolated quoted replies",
  });
  console.log(JSON.stringify({ previewUrl: preview.previewUrl + "?scenario=ready&mode=simple&skin=midnight",
    fixture: "synthetic messages only" }));
  await parkUntilSignal();
} finally {
  await preview?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
