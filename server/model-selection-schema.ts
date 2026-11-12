import { z } from "zod";
import { EFFORT_LEVELS, MAX_CONTEXT_WINDOW_TOKENS, MIN_CONTEXT_WINDOW_TOKENS } from "../shared/model-selection.ts";
import { isModelVariant } from "./contracts.ts";

export const requestedContextWindowSchema = z.number().int().min(MIN_CONTEXT_WINDOW_TOKENS).max(MAX_CONTEXT_WINDOW_TOKENS);

const fields = {
  instanceId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(500),
  effort: z.enum(EFFORT_LEVELS).optional(),
  variant: z.string().refine(isModelVariant, "invalid model variant").optional(),
  contextWindowTokens: requestedContextWindowSchema.optional(),
};
const oneReasoningControl = (selection: { variant?: string; effort?: string }) => selection.variant === undefined || selection.effort === undefined;

export const defaultModelSelectionSchema = z.object(fields).refine(oneReasoningControl,
  "choose either a model variant or an effort level");
export const botDefaultModelSchema = z.object(fields).strict().refine(oneReasoningControl,
  "choose either a model variant or an effort level");
