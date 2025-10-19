import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

interface HistoryQuery {
  user_id: string;
  start_date?: string;
  end_date?: string;
  provider?: string;
  model?: string;
  limit?: number;
}

interface AggregatedData {
  date: string;
  total_cost: number;
  total_tokens: number;
  total_calls: number;
  avg_latency: number;
  providers: Record<string, number>;
  models: Record<string, number>;
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
      const query: HistoryQuery = {
        user_id: (req.query.user_id as string) || 'anonymous',
        start_date: req.query.start_date as string,
        end_date: req.query.end_date as string,
        provider: req.query.provider as string,
        model: req.query.model as string,
        limit: parseInt(req.query.limit as string) || 100
      };

      // Default to last 30 days if no date range specified
      const endDate = query.end_date || new Date().toISOString().split('T')[0];
      const startDate = query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const response = await getHistoricalData(query, startDate, endDate);
      
      return res.status(200).json({
        success: true,
        data: response
      });

    } catch (error) {
      console.error('History API error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch historical data'
      });
    }
  }

  return res.status(405).json({
    success: false,
    error: 'Method not allowed'
  });
}

async function getHistoricalData(query: HistoryQuery, startDate: string, endDate: string) {
  try {
    // Build Supabase query
    let supabaseQuery = supabase
      .from('api_calls')
      .select('*')
      .eq('user_id', query.user_id)
      .gte('created_at', `${startDate}T00:00:00.000Z`)
      .lte('created_at', `${endDate}T23:59:59.999Z`)
      .order('created_at', { ascending: false })
      .limit(query.limit!);

    // Add optional filters
    if (query.provider) {
      supabaseQuery = supabaseQuery.eq('provider', query.provider);
    }

    if (query.model) {
      supabaseQuery = supabaseQuery.eq('model', query.model);
    }

    const { data: rawData, error } = await supabaseQuery;

    if (error) {
      throw error;
    }

    const calls = rawData || [];

    // Generate aggregated data by day
    const dailyAggregation = aggregateDataByDay(calls);
    
    // Generate chart data
    const chartData = generateChartData(calls);
    
    // Calculate summary statistics
    const summary = calculateSummaryStats(calls);

    return {
      summary,
      daily_aggregation: dailyAggregation,
      chart_data: chartData,
      raw_calls: calls.slice(0, 50), // Latest 50 calls for detailed view
      total_records: calls.length,
      date_range: {
        start: startDate,
        end: endDate
      }
    };

  } catch (error) {
    console.error('Error fetching historical data:', error);
    
    // Return fallback data structure
    return {
      summary: {
        total_cost: 0,
        total_tokens: 0,
        total_calls: 0,
        avg_cost_per_call: 0,
        avg_tokens_per_call: 0,
        avg_latency: 0
      },
      daily_aggregation: [],
      chart_data: {
        cost_trend: [],
        token_usage: [],
        provider_breakdown: [],
        model_usage: []
      },
      raw_calls: [],
      total_records: 0,
      date_range: { start: startDate, end: endDate },
      fallback: true
    };
  }
}

function aggregateDataByDay(calls: any[]): AggregatedData[] {
  const dailyData = new Map<string, AggregatedData>();

  calls.forEach(call => {
    const date = call.created_at.split('T')[0];
    
    if (!dailyData.has(date)) {
      dailyData.set(date, {
        date,
        total_cost: 0,
        total_tokens: 0,
        total_calls: 0,
        avg_latency: 0,
        providers: {},
        models: {}
      });
    }

    const dayData = dailyData.get(date)!;
    dayData.total_cost += parseFloat(call.cost_usd) || 0;
    dayData.total_tokens += (parseInt(call.tokens_input) || 0) + (parseInt(call.tokens_output) || 0);
    dayData.total_calls += 1;
    dayData.avg_latency = (dayData.avg_latency * (dayData.total_calls - 1) + (call.latency_ms || 0)) / dayData.total_calls;

    // Track providers
    if (call.provider) {
      dayData.providers[call.provider] = (dayData.providers[call.provider] || 0) + 1;
    }

    // Track models
    if (call.model) {
      dayData.models[call.model] = (dayData.models[call.model] || 0) + 1;
    }
  });

  return Array.from(dailyData.values()).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function generateChartData(calls: any[]) {
  const dailyData = aggregateDataByDay(calls);

  // Cost trend data (last 7 days)
  const costTrend = dailyData.slice(-7).map(day => ({
    date: day.date,
    cost: day.total_cost
  }));

  // Token usage trend (last 7 days)
  const tokenUsage = dailyData.slice(-7).map(day => ({
    date: day.date,
    tokens: day.total_tokens
  }));

  // Provider breakdown
  const providerCounts = calls.reduce((acc, call) => {
    if (call.provider) {
      acc[call.provider] = (acc[call.provider] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  const providerBreakdown = Object.entries(providerCounts).map(([provider, count]) => ({
    provider,
    count: count as number,
    percentage: ((count as number) / calls.length) * 100
  }));

  // Model usage
  const modelCounts = calls.reduce((acc, call) => {
    if (call.model) {
      acc[call.model] = (acc[call.model] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>);

  const modelUsage = Object.entries(modelCounts).map(([model, count]) => ({
    model,
    count: count as number,
    percentage: ((count as number) / calls.length) * 100
  }));

  return {
    cost_trend: costTrend,
    token_usage: tokenUsage,
    provider_breakdown: providerBreakdown,
    model_usage: modelUsage
  };
}

function calculateSummaryStats(calls: any[]) {
  if (calls.length === 0) {
    return {
      total_cost: 0,
      total_tokens: 0,
      total_calls: 0,
      avg_cost_per_call: 0,
      avg_tokens_per_call: 0,
      avg_latency: 0
    };
  }

  const totalCost = calls.reduce((sum, call) => sum + (parseFloat(call.cost_usd) || 0), 0);
  const totalTokens = calls.reduce((sum, call) => sum + (parseInt(call.tokens_input) || 0) + (parseInt(call.tokens_output) || 0), 0);
  const totalLatency = calls.reduce((sum, call) => sum + (call.latency_ms || 0), 0);

  return {
    total_cost: totalCost,
    total_tokens: totalTokens,
    total_calls: calls.length,
    avg_cost_per_call: totalCost / calls.length,
    avg_tokens_per_call: totalTokens / calls.length,
    avg_latency: totalLatency / calls.length
  };
}
