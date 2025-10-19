import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { RateLimiter } from '../backend/utils/rate-limiter';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

const proxyKeyStore = new Map();

// Generate clean user ID with unambiguous characters only
function generateCleanId(length: number = 7): string {
    const chars = '23456789abcdefghjkmnpqrstuvwxyz'; // Excludes: 0, 1, o, l, i
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-endpoint');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Log incoming request for debugging
    console.log('🔥 Incoming request:', {
        method: req.method,
        url: req.url,
        hasBody: !!req.body,
        bodyType: typeof req.body
    });

    // Check for registration - look for 'action' field in body
    if (req.method === 'POST') {
        let bodyData = req.body;
        
        // Ensure body is parsed
        if (typeof bodyData === 'string') {
            try {
                bodyData = JSON.parse(bodyData);
            } catch (e) {
                console.error('❌ Body parse error:', e);
            }
        }

        console.log('📦 Body data:', { 
            hasAction: !!bodyData?.action,
            action: bodyData?.action,
            hasUserId: !!bodyData?.userId,
            hasProvider: !!bodyData?.provider,
            hasApiKey: !!bodyData?.apiKey
        });

        // Route to registration if action is 'register'
        if (bodyData?.action === 'register') {
            console.log('🔀 Routing to registration handler');
            return handleRegistration(bodyData, req, res);
        }
    }

    // Handle all other proxy requests
    console.log('🔀 Routing to universal proxy handler');
    return handleUniversalProxy(req, res);
}

async function handleRegistration(bodyData: any, req: VercelRequest, res: VercelResponse) {
    try {
        const { userId, provider, apiKey } = bodyData;

        console.log('✅ Registration handler called:', { 
            userId, 
            provider, 
            hasApiKey: !!apiKey 
        });

        if (!userId || !provider || !apiKey) {
            console.log('❌ Missing fields:', { 
                hasUserId: !!userId, 
                hasProvider: !!provider, 
                hasApiKey: !!apiKey 
            });
            return res.status(400).json({ 
                success: false,
                error: 'Missing required fields',
                received: { 
                    userId: !!userId, 
                    provider: !!provider, 
                    apiKey: !!apiKey 
                }
            });
        }

        // Get IP address
        const ipAddress = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
        const ip = Array.isArray(ipAddress) ? ipAddress[0] : ipAddress;

        // Check IP registration limit
        const ipCheck = await RateLimiter.checkIPRegistrationLimit(ip);
        if (!ipCheck.allowed) {
            return res.status(429).json({
                success: false,
                error: ipCheck.reason,
            });
        }

        // Generate clean proxy key
        const proxyKey = `totobox_${generateCleanId(20)}`;
        
        proxyKeyStore.set(proxyKey, {
            userId,
            provider,
            apiKey,
            createdAt: new Date().toISOString()
        });

        console.log('💾 Stored in memory:', proxyKey);

        try {
            const { error: dbError } = await supabase.from('proxy_keys').insert({
                proxy_key: proxyKey,
                user_id: userId,
                provider: provider,
                api_key: apiKey,
                created_at: new Date().toISOString()
            });
            
            if (dbError) {
                console.error('❌ Supabase error:', dbError);
            } else {
                console.log('✅ Stored in Supabase');
            }
        } catch (error) {
            console.error('❌ Supabase storage failed:', error);
        }

        // Record IP registration
        await RateLimiter.recordIPRegistration(ip, userId);

        console.log('✅ Registration successful');
        return res.status(200).json({
            success: true,
            proxyKey: proxyKey,
            proxyUrl: `https://totobox.vercel.app/api/proxy`
        });
    } catch (error) {
        console.error('❌ Registration error:', error);
        return res.status(500).json({ 
            success: false,
            error: 'Failed to register proxy key',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
}

async function handleUniversalProxy(req: VercelRequest, res: VercelResponse) {
    try {
        const startTime = Date.now();

        // Extract proxy key
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log('❌ No authorization header');
            return res.status(401).json({ error: 'Missing authorization' });
        }

        const proxyKey = authHeader.replace('Bearer ', '');

        // Get mapping
        let mapping = proxyKeyStore.get(proxyKey);
        if (!mapping) {
            const { data, error } = await supabase
                .from('proxy_keys')
                .select('*')
                .eq('proxy_key', proxyKey)
                .single();

            if (error || !data || !data.api_key) {
                return res.status(401).json({ error: 'Invalid proxy key' });
            }

            mapping = {
                userId: data.user_id,
                provider: data.provider,
                apiKey: data.api_key,
                createdAt: data.created_at
            };
            proxyKeyStore.set(proxyKey, mapping);
        }

        // **RATE LIMITING CHECKS**
        
        // 1. Check global hourly limit
        const hourlyCheck = await RateLimiter.checkGlobalHourlyLimit();
        if (!hourlyCheck.allowed) {
            return res.status(429).json({ error: hourlyCheck.reason });
        }

        // 2. Check global daily limit
        const dailyCheck = await RateLimiter.checkGlobalDailyLimit();
        if (!dailyCheck.allowed) {
            return res.status(429).json({ error: dailyCheck.reason });
        }

        // 3. Check per-key limits
        const keyCheck = await RateLimiter.checkKeyLimits(mapping.userId);
        if (!keyCheck.allowed) {
            return res.status(429).json({ error: keyCheck.reason });
        }

        // Determine the target URL and endpoint type
        const endpoint = (req.headers['x-api-endpoint'] as string) || req.url?.replace('/api/proxy', '') || '/chat/completions';
        const { targetUrl, headers, isStreaming } = buildTargetConfig(mapping.provider, mapping.apiKey, endpoint);

        console.log('🔗 Proxying to:', targetUrl, 'Streaming:', isStreaming);

        // Handle streaming responses
        if (isStreaming || endpoint.includes('stream=true')) {
            return handleStreamingRequest(req, res, targetUrl, headers, mapping, startTime);
        }

        // Handle regular requests
        const response = await fetch(targetUrl, {
            method: req.method || 'POST',
            headers: headers,
            body: req.body ? JSON.stringify(req.body) : undefined
        });

        const responseData = await response.json();
        const latency = Date.now() - startTime;

        // Log usage based on endpoint type
        await logUsage(mapping, endpoint, req.body, responseData, latency);

        return res.status(response.status).json(responseData);
    } catch (error) {
        console.error('❌ Proxy error:', error);
        return res.status(500).json({
            error: 'Proxy request failed',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
}

function buildTargetConfig(provider: string, apiKey: string, endpoint: string) {
    let baseUrl: string;
    let headers: any = {
        'Content-Type': 'application/json'
    };
    let isStreaming = false;

    switch (provider) {
        case 'openai':
            baseUrl = 'https://api.openai.com/v1';
            headers['Authorization'] = `Bearer ${apiKey}`;
            
            // Map common endpoints
            if (endpoint.includes('embeddings')) {
                endpoint = '/embeddings';
            } else if (endpoint.includes('images')) {
                endpoint = '/images/generations';
            } else if (endpoint.includes('audio')) {
                endpoint = '/audio/transcriptions';
            } else if (endpoint.includes('assistants')) {
                // Keep assistants path as-is
            } else if (endpoint.includes('completions')) {
                endpoint = '/chat/completions';
            }
            
            isStreaming = endpoint.includes('stream') || endpoint.includes('events');
            break;

        case 'anthropic':
            baseUrl = 'https://api.anthropic.com/v1';
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            
            if (endpoint.includes('messages')) {
                endpoint = '/messages';
            }
            
            isStreaming = endpoint.includes('stream');
            break;

        default:
            throw new Error(`Unsupported provider: ${provider}`);
    }

    return {
        targetUrl: `${baseUrl}${endpoint}`,
        headers,
        isStreaming
    };
}

async function handleStreamingRequest(
    req: VercelRequest,
    res: VercelResponse,
    targetUrl: string,
    headers: any,
    mapping: any,
    startTime: number
) {
    try {
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                ...req.body,
                stream: true
            })
        });

        if (!response.ok) {
            const error = await response.text();
            return res.status(response.status).json({ error });
        }

        // Set up SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Stream the response
        const reader = response.body?.getReader();
        if (!reader) {
            return res.status(500).json({ error: 'No response body' });
        }

        const decoder = new TextDecoder();
        let totalTokens = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                // Log final usage
                const latency = Date.now() - startTime;
                await logStreamingUsage(mapping, req.body, totalTokens, latency);
                res.end();
                break;
            }

            const chunk = decoder.decode(value);
            res.write(chunk);

            // Try to extract token count from streaming chunks
            if (chunk.includes('usage')) {
                try {
                    const match = chunk.match(/"total_tokens":(\d+)/);
                    if (match) {
                        totalTokens = parseInt(match[1]);
                    }
                } catch (e) {
                    // Ignore parsing errors
                }
            }
        }
    } catch (error) {
        console.error('❌ Streaming error:', error);
        res.status(500).json({ error: 'Streaming failed' });
    }
}

async function logUsage(
    mapping: any,
    endpoint: string,
    requestBody: any,
    responseData: any,
    latency: number
) {
    try {
        let inputTokens = 0;
        let outputTokens = 0;
        let cost = 0;
        let model = requestBody?.model || 'unknown';

        // Extract usage based on endpoint type
        if (endpoint.includes('chat/completions') || endpoint.includes('completions')) {
            if (responseData.usage) {
                inputTokens = responseData.usage.prompt_tokens || 0;
                outputTokens = responseData.usage.completion_tokens || 0;
            }
        } else if (endpoint.includes('embeddings')) {
            if (responseData.usage) {
                inputTokens = responseData.usage.prompt_tokens || 0;
            }
            model = requestBody?.model || 'text-embedding-ada-002';
        } else if (endpoint.includes('images')) {
            // Image generation doesn't have tokens, calculate by image count
            const imageCount = responseData.data?.length || 1;
            const size = requestBody?.size || '1024x1024';
            cost = calculateImageCost(size, imageCount);
            model = 'dall-e-3';
        }

        if (inputTokens > 0 || outputTokens > 0) {
            cost = calculateCost(model, inputTokens, outputTokens);
        }

        console.log('📊 Logging usage:', {
            userId: mapping.userId,
            model,
            inputTokens,
            outputTokens,
            cost
        });

        await supabase.from('api_calls').insert({
            user_id: mapping.userId,
            provider: mapping.provider,
            model: model,
            endpoint: endpoint,
            tokens_input: inputTokens,
            tokens_output: outputTokens,
            total_tokens: inputTokens + outputTokens,
            cost_usd: cost,
            latency_ms: latency,
            created_at: new Date().toISOString()
        });

        // Increment rate limiter usage
        await RateLimiter.incrementUsage(mapping.userId, inputTokens + outputTokens);
        
        console.log('✅ Usage logged successfully');
    } catch (error) {
        console.error('❌ Failed to log usage:', error);
    }
}

async function logStreamingUsage(
    mapping: any,
    requestBody: any,
    totalTokens: number,
    latency: number
) {
    try {
        const model = requestBody?.model || 'unknown';
        const cost = calculateCost(model, totalTokens, 0);

        await supabase.from('api_calls').insert({
            user_id: mapping.userId,
            provider: mapping.provider,
            model: model,
            endpoint: 'streaming',
            tokens_input: 0,
            tokens_output: totalTokens,
            total_tokens: totalTokens,
            cost_usd: cost,
            latency_ms: latency,
            created_at: new Date().toISOString()
        });

        // Increment rate limiter usage
        await RateLimiter.incrementUsage(mapping.userId, totalTokens);
    } catch (error) {
        console.error('❌ Failed to log streaming usage:', error);
    }
}

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing: Record<string, { input: number; output: number }> = {
        'gpt-4': { input: 0.03, output: 0.06 },
        'gpt-4-turbo': { input: 0.01, output: 0.03 },
        'gpt-4-turbo-preview': { input: 0.01, output: 0.03 },
        'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
        'gpt-3.5-turbo-0125': { input: 0.0005, output: 0.0015 },
        'text-embedding-ada-002': { input: 0.0001, output: 0 },
        'text-embedding-3-small': { input: 0.00002, output: 0 },
        'text-embedding-3-large': { input: 0.00013, output: 0 },
        'claude-3-opus': { input: 0.015, output: 0.075 },
        'claude-3-sonnet': { input: 0.003, output: 0.015 },
        'claude-3-haiku': { input: 0.00025, output: 0.00125 }
    };

    const rates = pricing[model] || { input: 0.001, output: 0.002 };
    return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output;
}

function calculateImageCost(size: string, count: number): number {
    const pricing: Record<string, number> = {
        '1024x1024': 0.04,
        '1792x1024': 0.08,
        '1024x1792': 0.08
    };
    return (pricing[size] || 0.04) * count;
}
