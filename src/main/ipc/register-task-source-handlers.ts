import type { Store } from '../persistence/loading-store/store'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import { registerJiraHandlers } from './jira/register-handlers'
import { registerJiraIssueSummaryGenerationHandlers } from './jira/issue-summary-generation'
import { registerLarkHandlers } from './lark/register-handlers'
import { registerLinearHandlers } from './linear/register-handlers'

export function registerTaskSourceHandlers(
  store: Pick<Store, 'getSettings'>,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  registerLinearHandlers()
  registerJiraHandlers()
  registerLarkHandlers()
  registerJiraIssueSummaryGenerationHandlers(store, commitMessageAgentEnv)
}
