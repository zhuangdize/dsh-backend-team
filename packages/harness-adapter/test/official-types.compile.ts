import type {
  ToolDefinition,
  ToolExecution,
  ToolGuard,
  ToolRunContext,
  ToolRuntime,
} from '@deepseek-ai/dsh-tools'
import type {
  HarnessMonotonicGuard,
  HarnessToolDefinition,
  HarnessToolExecution,
  HarnessToolRunContext,
  HarnessToolService,
} from '../src/index.js'

// Compile-time-only seam: this file imports official rc.6 declarations but
// emits no runtime import and is excluded from the package build.
const officialDefinition: ToolDefinition = {} as HarnessToolDefinition
const officialGuard: ToolGuard = {} as HarnessMonotonicGuard
const officialRegister: ToolRuntime['register'] = {} as HarnessToolService['register']
const localTools = {} as HarnessToolService
// The registry-owned token is intentionally opaque locally; this wrapper is
// the only compile-time brand bridge and the production adapter never creates
// or inspects the token.
const officialGuardRegister: ToolRuntime['guard'] = (guard) => localTools.guard(guard as unknown as HarnessMonotonicGuard)
const localExecution: HarnessToolExecution = {} as ToolExecution
const localRunContext: HarnessToolRunContext = {} as ToolRunContext
// The production adapter only consumes execution identity and cancellation;
// it intentionally does not expose host-owned turn-control methods locally.
// @ts-expect-error local execution context must not expose host turn control
const forbiddenDeferContext = localRunContext.deferContext
// @ts-expect-error local execution context must not expose host turn control
const forbiddenConcludeTurn = localRunContext.concludeTurn

void officialDefinition
void officialGuard
void officialRegister
void officialGuardRegister
void localExecution
void localRunContext
void forbiddenDeferContext
void forbiddenConcludeTurn
