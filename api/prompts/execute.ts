// backend/api/prompts/execute.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnon = process.env.SUPABASE_ANON_KEY!;
const supabaseService = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, (supabaseService || supabaseAnon));

type ExecStatus = 'success' | 'error';

interface PromptExecution {
  id: string;
  prompt_id: string | null;
  user_id: string;
  api_key_id: string;
  provider: string;
  model: string;
  prompt_content: string;
  response_content: string;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
  latency_ms: number;
  status: ExecStatus;
  error_message?: string;
  created_at: string;
}

interface ExecutePromptRequest {
  prompt_id?: string;
  prompt_content: string;
  api_key_id: string;
  model: string;
  provider: 'openai' | 'anthropic';
  max_tokens?: number;
  temperature?: number;
  // Optional: allow passing a direct API key if enabled via env
  api_key?: string;
}

type UsageLike = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};

const DIRECT_API_KEYS_ENABLED = process.env.DIRECT_API_KEYS_ENABLED === 'true';

function normalizeUsage(provider: string, raw: any): UsageLike {
  if (!raw) return {};
  // OpenAI: { prompt_tokens, completion_tokens, total_tokens }
  // Anthropic messages: { input_tokens, output_tokens }
  if (provider === 'anthropic') {
    const u = raw?.usage || raw; // some SDKs put it top-level or inside usage
    return {
      prompt_tokens: u?.input_tokens ?? 0,
      completion_tokens: u?.output_tokens ?? 0,
      total_tokens: (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0)
    };
  }
  const u = raw?.usage || raw;
  return {
    prompt_tokens: u?.prompt_tokens ?? 0,
    completion_tokens: u?.completion_tokens ?? 0,
    total_tokens: u?.total_tokens ?? ((u?.prompt_tokens ?? 0) + (u?.completion_tokens ?? 0))
  };
}

function calculateCost(model: string, usage: UsageLike): number {
  // Prices are placeholders; adjust to your cost table as needed.
  const pricing: Record<string, { input: number; output: number }> = {
    // OpenAI examples (per 1K tokens)
    'gpt-4': { input: 0.03, output: 0.06 },
    'gpt-4-turbo': { input: 0.01, output: 0.03 },
    'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
    // Anthropic examples
    'claude-3-opus': { input: 0.015, output: 0.075 },
    'claude-3-sonnet': { input: 0.003, output: 0.015 },
    'claude-3-haiku': { input: 0.00025, output: 0.00125 }
  };

  const rates = pricing[model] || { input: 0.01, output: 0.03 };
  const inTok = (usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outTok = (usage.completion_tokens ?? usage.output_tokens ?? 0);
  const inputCost = (inTok / 1000) * rates.input;
  const outputCost = (outTok / 1000) * rates.output;
  return +(inputCost + outputCost).toFixed(6);
}

async function makeProxyRequest(
  provider: 'openai' | 'anthropic',
  model: string,
  prompt: string,
  apiKey: string,
  options: { max_tokens?: number; temperature?: number } = {}
) {
  if (provider === 'openai') {
    const targetUrl = 'https://api.openai.com/v1/chat/completions';
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.max_tokens ?? 1000,
      temperature: options.temperature ?? 0.7
    };
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error(`OpenAI ${resp.status} ${await resp.text()}`);
    return await resp.json();
  }

  if (provider === 'anthropic') {
    // Anthropic Messages API
    const targetUrl = 'https://api.anthropic.com/v1/messages';
    const body = {
      model,
      max_tokens: options.max_tokens ?? 1000,
      temperature: options.temperature ?? 0.7,
      messages: [{ role: 'user', content: prompt }]
    };
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status} ${await resp.text()}`);
    return await resp.json();
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const user_id = (req.headers['x-user-id'] as string) || 'anonymous';
    const executeData: ExecutePromptRequest = req.body;

    if (!executeData?.prompt_content || !executeData?.api_key_id || !executeData?.model || !executeData?.provider) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: prompt_content, api_key_id, model, provider'
      });
    }

    // Resolve the real API key
    const directKey = (DIRECT_API_KEYS_ENABLED && executeData.api_key) ? executeData.api_key : null;
    const apiKey = directKey || await getOriginalApiKey(executeData.api_key_id, user_id);
    if (!apiKey) {
      return res.status(401).json({ success: false, error: 'Invalid or expired API key' });
    }

    const started = Date.now();
    try {
      const llmResponse = await makeProxyRequest(
        executeData.provider,
        executeData.model,
        executeData.prompt_content,
        apiKey,
        { max_tokens: executeData.max_tokens, temperature: executeData.temperature }
      );

      const latency = Date.now() - started;
      const usageNorm = normalizeUsage(executeData.provider, llmResponse);
      const cost = calculateCost(executeData.model, usageNorm);

      let responseContent = '';
      if (executeData.provider === 'openai') {
        responseContent = llmResponse?.choices?.[0]?.message?.content || '';
      } else if (executeData.provider === 'anthropic') {
        const c0 = llmResponse?.content?.[0];
        responseContent = (c0?.text) || '';
      }

      // Save execution
      const execRow: PromptExecution = {
        id: `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        prompt_id: executeData.prompt_id || null,
        user_id,
        api_key_id: executeData.api_key_id,
        provider: executeData.provider,
        model: executeData.model,
        prompt_content: executeData.prompt_content,
        response_content: responseContent,
        tokens_input: usageNorm.prompt_tokens ?? 0,
        tokens_output: usageNorm.completion_tokens ?? 0,
        cost_usd: cost,
        latency_ms: latency,
        status: 'success',
        created_at: new Date().toISOString()
      };

      const { data: savedExecution, error: saveErr } = await supabase
        .from('prompt_executions')
        .insert([execRow])
        .select()
        .single();

      if (saveErr) console.warn('Failed to save execution record:', saveErr);

      // Update prompt stats if linked to a saved prompt
      if (executeData.prompt_id) {
        await updatePromptStats(executeData.prompt_id, user_id, cost, (usageNorm.total_tokens ?? 0), latency);
      }

      return res.status(200).json({
        success: true,
        data: {
          response: responseContent,
          execution_id: savedExecution?.id ?? execRow.id,
          usage: {
            prompt_tokens: usageNorm.prompt_tokens ?? 0,
            completion_tokens: usageNorm.completion_tokens ?? 0,
            total_tokens: usageNorm.total_tokens ?? ((usageNorm.prompt_tokens ?? 0) + (usageNorm.completion_tokens ?? 0))
          },
          cost_usd: cost,
          latency_ms: latency,
          provider: executeData.provider,
          model: executeData.model
        }
      });
    } catch (llmError: any) {
      const latency = Date.now() - started;

      await supabase.from('prompt_executions').insert([{
        id: `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        prompt_id: executeData.prompt_id || null,
        user_id,
        api_key_id: executeData.api_key_id,
        provider: executeData.provider,
        model: executeData.model,
        prompt_content: executeData.prompt_content,
        response_content: '',
        tokens_input: 0,
        tokens_output: 0,
        cost_usd: 0,
        latency_ms: latency,
        status: 'error',
        error_message: (llmError?.message || String(llmError)).slice(0, 1000),
        created_at: new Date().toISOString()
      }]);

      return res.status(500).json({
        success: false,
        error: 'Prompt execution failed',
        details: llmError?.message || String(llmError)
      });
    }
  } catch (error) {
    console.error('Execute prompt error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

async function getOriginalApiKey(proxyKeyId: string, userId: string): Promise<string | null> {
  try {
    // Expect a table: api_keys(id, user_id, provider, api_key)
    const { data, error } = await supabase
      .from('api_keys')
      .select('api_key')
      .eq('id', proxyKeyId)
      .eq('user_id', userId)
      .single();

    if (error) {
      console.warn('API key lookup error:', error.message);
      return null;
    }
    return data?.api_key ?? null;
  } catch (err) {
    console.error('Error getting original API key:', err);
    return null;
  }
}

async function updatePromptStats(promptId: string, userId: string, cost: number, tokens: number, latency: number) {
  try {
    const { data: currentPrompt } = await supabase
      .from('prompts')
      .select('usage_count, avg_cost, avg_tokens, avg_latency')
      .eq('id', promptId)
      .eq('user_id', userId)
      .single();

    if (!currentPrompt) return;

    const newUsageCount = (currentPrompt.usage_count ?? 0) + 1;
    const newAvgCost = (((currentPrompt.avg_cost ?? 0) * (currentPrompt.usage_count ?? 0)) + cost) / newUsageCount;
    const newAvgTokens = (((currentPrompt.avg_tokens ?? 0) * (currentPrompt.usage_count ?? 0)) + tokens) / newUsageCount;
    const newAvgLatency = (((currentPrompt.avg_latency ?? 0) * (currentPrompt.usage_count ?? 0)) + latency) / newUsageCount;

    await supabase
      .from('prompts')
      .update({
        usage_count: newUsageCount,
        avg_cost: +newAvgCost.toFixed(6),
        avg_tokens: Math.round(newAvgTokens),
        avg_latency: Math.round(newAvgLatency),
        updated_at: new Date().toISOString()
      })
      .eq('id', promptId)
      .eq('user_id', userId);
  } catch (error) {
    console.error('Error updating prompt stats:', error);
  }
}

