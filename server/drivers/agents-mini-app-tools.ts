import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const MINI_APP_TOOL_ROUTES: Readonly<Record<string, string>> = {
  mini_app_info: "mini-apps/info", mini_app_connect: "mini-apps/connect", mini_app_publish: "mini-apps/publish",
  mini_app_rollback: "mini-apps/rollback", mini_app_archive: "mini-apps/archive", mini_app_report: "mini-apps/report",
};
export const MINI_APP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(MINI_APP_TOOL_ROUTES));

export async function callMiniAppTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const result = await context.client.apiResponse(`/api/internal/${MINI_APP_TOOL_ROUTES[name]}`, { method: "POST", body: JSON.stringify(args) });
  return result.ok ? { text: JSON.stringify(result.body) } : { text: String(result.body.error ?? "The Mini App operation failed."), isError: true };
}

const appId = { type: "string", format: "uuid" };
const mutation = { app_id: appId, requestKey: { type: "string", maxLength: 128 }, expectedRevision: { type: "integer", minimum: 1 } };
export const MINI_APP_TOOL_DEFINITIONS = [
  { name: "mini_app_info", description: "Discover your granted local Mini Apps, or read an app's editable HTML, data bindings and versions with app_id. Check for an existing app before making a recurring dashboard/report. Set guide=true for the complete authoring and refresh contract. Local workspace only; read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: { app_id: appId, guide: { type: "boolean" } } } },
  { name: "mini_app_connect", description: "Connect this bot's existing local Data for reusable Mini Apps. Returns a stable datasetId and physical table schemas; bound Data survives bot deletion. Call once before first publishing. No arguments; cannot connect another bot's Data.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "mini_app_publish", description: "Create or update a persistent local Mini App in Computer > Mini Apps. Read mini_app_info with guide=true first. Pass app_id to update, publication with requestKey, expectedRevision, slug, title, description, self-contained html and declarative bindings. Data-only updates use Data tools and refresh automatically. Does not publish to the internet.",
    inputSchema: { type: "object", additionalProperties: false, required: ["publication"], properties: { app_id: appId, publication: { type: "object", additionalProperties: true } } } },
  { name: "mini_app_rollback", description: "Restore a granted Mini App's earlier templateVersion with its current expectedRevision and a new requestKey. Advances app revision; does not rewind business Data.",
    inputSchema: { type: "object", additionalProperties: false, required: ["app_id", "requestKey", "expectedRevision", "templateVersion"], properties: { ...mutation, templateVersion: { type: "integer", minimum: 1 } } } },
  { name: "mini_app_archive", description: "Archive a granted local Mini App when requested. Hides it from the active library; keeps its immutable templates and bound Data. Requires the current revision and a new requestKey.",
    inputSchema: { type: "object", additionalProperties: false, required: ["app_id", "requestKey", "expectedRevision"], properties: mutation } },
  { name: "mini_app_report", description: "Prepare this bot's retained report Data and an install draft, or publish one immutable X AI/GitHub edition. Prepare takes action and kind only. Publish also takes edition with editionKey for interactive/backfill work; an Automation uses its original scheduled China day. Same key and content replay, different content conflicts. Source URLs are recorded data, never fetched by this tool.",
    inputSchema: { type: "object", additionalProperties: false, required: ["action", "kind"], properties: {
      action: { type: "string", enum: ["prepare", "publish"] }, kind: { type: "string", enum: ["x_ai_digest", "github_activity"] },
      edition: { type: "object", additionalProperties: true },
    } } },
];
