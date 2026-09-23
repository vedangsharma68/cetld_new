import {AIProvider, DEFAULT_MODEL, verifyModel} from '../ai/provider.mjs';

// Opt-in authenticated smoke test. The key must already exist in the process
// environment; this script never accepts it as an argument or prints errors.
try {
  await verifyModel(DEFAULT_MODEL);
  if (!process.env.OPENROUTER_API_KEY) throw new Error('not configured');
  const result = await new AIProvider().generate({messages:[{role:'user',content:'Reply with OK only.'}],maxTokens:32});
  if (!result.content.trim()) throw new Error('empty response');
  console.log('OpenRouter primary model smoke test passed.');
} catch {
  console.error('OpenRouter smoke test failed. Check server configuration and model availability. No credentials or provider response were logged.');
  process.exitCode=1;
}
