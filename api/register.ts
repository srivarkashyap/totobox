import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { RateLimiter } from '../backend/utils/rate-limiter';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

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
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        const { userId, provider, apiKey } = req.body;

        console.log('📝 Registration request:', { userId, provider, hasApiKey: !!apiKey });

        if (!userId || !provider || !apiKey) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: userId, provider, apiKey',
            });
        }

        // Get IP address
        const ipAddress = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
        const ip = Array.isArray(ipAddress) ? ipAddress[0] : ipAddress;

        console.log('🌐 IP address:', ip);

        // Check IP registration limit (commented out for now, enable later)
        // try {
        //     const ipCheck = await RateLimiter.checkIPRegistrationLimit(ip);
        //     console.log('✅ IP check result:', ipCheck);
            
        //     if (!ipCheck.allowed) {
        //         return res.status(429).json({
        //             success: false,
        //             error: ipCheck.reason,
        //         });
        //     }
        // } catch (ipError) {
        //     console.error('❌ IP check error:', ipError);
        //     // Continue anyway - don't block on rate limit errors
        // }

        // Generate proxy key with clean format
        const proxyKey = `totobox_${generateCleanId(20)}`;

        console.log('🔑 Generated proxy key:', proxyKey);
        console.log('💾 Attempting to insert into Supabase...');

        // Store in Supabase
        const { data, error: insertError } = await supabase.from('proxy_keys').insert({
            user_id: userId,
            proxy_key: proxyKey,
            provider: provider,
            api_key: apiKey,
            created_at: new Date().toISOString()
        }).select();

        console.log('📊 Supabase response:', { data, error: insertError });

        if (insertError) {
            console.error('❌ Failed to store proxy key:', insertError);
            return res.status(500).json({
                success: false,
                error: 'Failed to register proxy key',
                details: insertError.message,
                code: insertError.code,
                hint: insertError.hint
            });
        }

        // Record IP registration (commented out for now)
        // try {
        //     await RateLimiter.recordIPRegistration(ip, userId);
        // } catch (ipRecordError) {
        //     console.error('❌ Failed to record IP:', ipRecordError);
        //     // Continue anyway
        // }

        const baseUrl = process.env.VERCEL_URL 
            ? `https://${process.env.VERCEL_URL}`
            : 'https://totobox.vercel.app';

        console.log('✅ Registration successful!');

        return res.status(200).json({
            success: true,
            data: {
                proxyKey: proxyKey,
                proxyUrl: `${baseUrl}/api/proxy`,
                provider: provider,
            },
        });
    } catch (error) {
        console.error('❌ Registration error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
        });
    }
}

