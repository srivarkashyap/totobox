import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

interface AnalyticsCache {
  data: any;
  timestamp: number;
  user_id: string;
}

// Simple in-memory cache for analytics data
const analyticsCache = new Map<string, AnalyticsCache>();
const CACHE_DURATION = 10000; // 10 seconds cache for real-time feel

function getCachedAnalytics(userId: string): any | null {
  const cached = analyticsCache.get(userId);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  return null;
}

function setCachedAnalytics(userId: string, data: any): void {
  analyticsCache.set(userId, {
    data,
    timestamp: Date.now(),
    user_id: userId
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    try {
      const { user_id = 'anonymous' } = req.query;
      const userId = Array.isArray(user_id) ? user_id[0] : user_id;

      // Check cache first
      const cachedData = getCachedAnalytics(userId);
      if (cachedData) {
        return res.status(200).json({
          success: true,
          data: cachedData,
          cached: true
        });
      }

      // Fallback data in case of database issues
      const fallbackData = {
        today: {
          cost: 0,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          calls: 0
        },
        recent_activity: [],
        last_updated: new Date().toISOString()
      };

      try {
        // Get last 7 days of usage (covers recent activity well)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        console.log('🔍 Query details:');
        console.log('  User ID:', userId);
        console.log('  Seven days ago:', sevenDaysAgo);

        // Fetch ALL data for aggregation
        const { data: recentUsage, error: usageError, count } = await supabase
          .from('api_calls')
          .select('*', { count: 'exact' })
          .eq('user_id', userId)
          .gte('created_at', sevenDaysAgo);

        console.log('🔍 Query results:');
        console.log('  Count:', count);
        console.log('  Data length:', recentUsage?.length);
        console.log('  Error:', usageError);

        if (usageError) {
          console.warn('Usage query failed:', usageError);
          setCachedAnalytics(userId, fallbackData);
          return res.status(200).json({
            success: true,
            data: fallbackData,
            fallback: true
          });
        }

        // Calculate totals
        const totalCost = recentUsage?.reduce((sum: number, call: any) => 
          sum + (parseFloat(call.cost_usd || call.cost || 0)), 0) || 0;
        
        const totalInputTokens = recentUsage?.reduce((sum: number, call: any) => 
          sum + (parseInt(call.tokens_input || call.input_tokens || 0)), 0) || 0;
        
        const totalOutputTokens = recentUsage?.reduce((sum: number, call: any) => 
          sum + (parseInt(call.tokens_output || call.output_tokens || 0)), 0) || 0;
        
        const totalTokens = totalInputTokens + totalOutputTokens;
        const totalCalls = recentUsage?.length || 0;

        // Get recent activity (last 100 calls with full details)
        const { data: recentCalls } = await supabase
          .from('api_calls')
          .select('id, created_at, provider, model, endpoint, tokens_input, tokens_output, total_tokens, cost_usd, latency_ms')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(100);

        console.log('📋 Fetched recent calls:', recentCalls?.length || 0);

        // Map to clean format with all details
        const recent_activity = (recentCalls || []).map((call: any) => {
          const inputTokens = call.tokens_input || 0;
          const outputTokens = call.tokens_output || 0;
          const totalTokens = call.total_tokens || (inputTokens + outputTokens);
          const ratio = inputTokens > 0 ? (outputTokens / inputTokens).toFixed(2) : '0.00';

          return {
            id: call.id,
            timestamp: call.created_at,
            provider: call.provider,
            model: call.model,
            endpoint: call.endpoint || '/chat/completions',
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            tokens: totalTokens,
            ratio: ratio,
            cost: call.cost_usd,
            latency_ms: call.latency_ms
          };
        });

        console.log('✅ Mapped activity records:', recent_activity.length);

        const analyticsData = {
          today: {
            cost: totalCost,
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            total_tokens: totalTokens,
            calls: totalCalls
          },
          recent_activity: recent_activity,
          last_updated: new Date().toISOString()
        };

        // Cache the result
        setCachedAnalytics(userId, analyticsData);

        return res.status(200).json({
          success: true,
          data: analyticsData
        });

      } catch (dbError) {
        console.error('Database error in analytics:', dbError);
        
        // Return fallback data if database fails
        setCachedAnalytics(userId, fallbackData);
        return res.status(200).json({
          success: true,
          data: fallbackData,
          fallback: true,
          error_logged: true
        });
      }

    } catch (error) {
      console.error('Analytics handler error:', error);
      return res.status(500).json({ 
        success: false,
        error: 'Failed to fetch analytics' 
      });
    }
  }

  return res.status(405).json({ 
    success: false,
    error: 'Method not allowed' 
  });
}

