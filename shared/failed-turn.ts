export * from "../packages/phone-protocol/src/failed-turn.ts";

export const CONNECTION_INPUT_REFUSAL = "The model provider refused to continue because an input item does not belong to this connection. Start a new conversation with this bot to use the current connection.";
export const CODEX_TOOL_CONVERSION_REFUSAL = "This connection could not convert the tools sent by Codex. Choose another model type for this model in Bot settings.";

export function isConnectionInputRefusal(value: unknown): boolean {
  return typeof value === "string" && /\binput item does not belong to this connection\b/i.test(value);
}

export function isCodexToolConversionRefusal(value: unknown): boolean {
  return typeof value === "string" && (value === CODEX_TOOL_CONVERSION_REFUSAL ||
    /\b(?:tool type namespace|responses item additional_tools) is not supported on this conversion\b/i.test(value));
}
