import { registerHook, setHooksLogger } from "@friday/shared";
import { logger } from "../log.js";
import { actingUserHook } from "../prompts/acting-user-hook.js";
import { memoryRecallHook } from "../prompts/memory-recall-hook.js";
import { skillContextHook } from "./skill-context.js";
import { workspaceGuardHook } from "./workspace-guard.js";
import { builderTrailerHook } from "./builder-trailer.js";

setHooksLogger(logger);

registerHook("before_prompt_build", actingUserHook);
registerHook("before_prompt_build", memoryRecallHook);
registerHook("before_prompt_build", skillContextHook);
registerHook("before_tool_call", workspaceGuardHook);
registerHook("agent:bootstrap", builderTrailerHook);
