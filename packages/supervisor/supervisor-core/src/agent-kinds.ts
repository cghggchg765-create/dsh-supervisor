/**
 * The hosted CLI agent kinds this package knows how to launch and drive, as a
 * value list. `src/types.ts` holds only types, so the runtime list lives here
 * and the `AgentKind` union stays its type-level face.
 * @module @deepseek-ai/dsh-supervisor-core/agent-kinds
 */

import type { AgentKind } from './types.ts'

/**
 * Every {@link AgentKind}, in declaration order; used for schema enums, the
 * skill scan, and diagnostics.
 */
export const AGENT_KINDS: readonly AgentKind[] = ['claude-code', 'codex', 'kimi-code', 'qwen-code', 'trae', 'dsh']
