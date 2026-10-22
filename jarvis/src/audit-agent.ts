import { loadConfig, loadEnvironment } from './config.js';
import { agentConfigurationChecksPassed, auditAgentConfiguration } from './agents/config-audit.js';

/** Operator-only read-only audit; environment loading remains in config.ts. */
async function main(): Promise<void> {
  try {
    loadEnvironment();
    const config = loadConfig();
    const audit = await auditAgentConfiguration({ apiKey: config.ELEVENLABS_API_KEY, agentId: config.ELEVENLABS_AGENT_ID });
    const checksPassed = agentConfigurationChecksPassed(audit, config.JARVIS_SUPPRESS_FIRST_MESSAGE);
    const manualReview = audit.workflow_present
      || (config.JARVIS_SUPPRESS_FIRST_MESSAGE && !audit.first_message_override_visible);
    process.stdout.write(`${JSON.stringify({ ...audit, configuration_checks_passed: checksPassed,
      manual_review_required: manualReview })}\n`);
    if (!checksPassed || manualReview) process.exitCode = 1;
  } catch {
    // Never include raw configuration exceptions, tokens, agent IDs or upstream messages.
    process.stdout.write(`${JSON.stringify({ status: 'missing_configuration', configuration_checks_passed: false,
      manual_review_required: false, runtime_behavior_verified: false })}\n`);
    process.exitCode = 1;
  }
}

await main();
