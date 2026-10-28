import type { AgentId } from '../../lib/muse/types';
import { RESULT_SCHEMA } from './contract';

export interface ModelAdapter {
  generate(instructions: string, input: string, signal: AbortSignal): Promise<unknown>;
}

export const MUSE_MODELS: Record<AgentId, string> = {
  planner: 'muse-wonder-1.0',
  explorer: 'muse-spark-1.3',
  critic: 'muse-wonder-1.0',
  organizer: 'muse-spark-1.3',
};

type Reasoning = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type Configuration = { apiKey: string; baseUrl: string; model: string; reasoning: Reasoning };
const efforts: Reasoning[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function museConfiguration(agent: AgentId, env: Record<string, string | undefined>): Configuration {
  const apiKey = env.MODEL_API_KEY?.trim();
  if (!apiKey) throw new Error('Add MODEL_API_KEY to your local .env file, then restart Muse.');
  const model = env[`MODEL_${agent.toUpperCase()}`]?.trim() || env.MODEL_NAME?.trim() || MUSE_MODELS[agent];
  if (!/^muse-(wonder|spark)-[\d.]+$/.test(model)) throw new Error('Choose a standard Muse Wonder or Muse Spark model.');
  const reasoning = env.MODEL_REASONING_EFFORT || (agent === 'planner' || agent === 'critic' ? 'medium' : 'low');
  if (!efforts.includes(reasoning as Reasoning)) throw new Error('Check MODEL_REASONING_EFFORT in your local configuration.');
  const baseUrl = (env.MODEL_BASE_URL || 'https://api.meta.ai/v1').replace(/\/$/, '');
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS model endpoint without embedded credentials.');
  return { apiKey, baseUrl, model, reasoning: reasoning as Reasoning };
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function parseMuseResponse(result: unknown): unknown {
  if (!record(result)) throw new Error('Muse returned an unreadable response. Please try again.');
  if (result.status === 'incomplete') throw new Error('Muse ran out of response space. Try a smaller request.');
  if (result.status !== 'completed' || !Array.isArray(result.output)) throw new Error('Muse could not finish the response. Please try again.');
  const content = result.output.filter(record).filter(item => item.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content.filter(record) : []);
  if (content.some(item => item.type === 'refusal')) throw new Error('Muse could not help with that request. Try rephrasing it.');
  const output = content.filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('');
  if (!output || output.length > 80_000) throw new Error('Muse did not return a complete board response. Please try again.');
  try { return JSON.parse(output); }
  catch { throw new Error('Muse returned an unreadable board response. Please try again.'); }
}

export function createMuseAdapter(config: Configuration, send: typeof fetch = fetch): ModelAdapter {
  return {
    async generate(instructions, input, signal) {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await send(`${config.baseUrl}/responses`, {
          method: 'POST', signal, redirect: 'error', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model: config.model, instructions, input,
            reasoning: { effort: config.reasoning },
            max_output_tokens: 6144,
            store: false,
            text: { format: { type: 'json_schema', name: 'muse_board_turn', strict: true, schema: RESULT_SCHEMA } },
          }),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error('Muse could not connect. Check your connection and try again.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new Error('Muse could not authenticate. Check your local MODEL_API_KEY and model access.');
        if (response.status === 429) throw new Error('Muse is at its usage limit. Try again shortly.');
        if (response.status === 404) throw new Error('That Muse model is unavailable. Check your local model configuration.');
        if (response.status >= 500) throw new Error('Muse is temporarily unavailable. Try again shortly.');
        throw new Error('Muse could not accept this request. Try a smaller request.');
      }
      let result: unknown;
      try { result = await response.json(); }
      catch { throw new Error('Muse returned an unreadable response. Please try again.'); }
      return parseMuseResponse(result);
    },
  };
}
