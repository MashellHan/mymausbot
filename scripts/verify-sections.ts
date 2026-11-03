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
    entry: "/scripts/testing/sections-preview.tsx", route: "/__sections.html", title: "Isolated departments",
  });
  console.log(JSON.stringify({ previewUrl: preview.previewUrl + "?view=search&mode=simple&query=work&skin=midnight",
    fixture: "synthetic bots, rooms and departments only" }));
  await parkUntilSignal();
} finally {
  await preview?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
