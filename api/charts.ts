import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    try {
      const { user_id = 'anonymous', days = '7' } = req.query;
      const userId = Array.isArray(user_id) ? user_id[0] : user_id;
      const daysNum = parseInt(Array.isArray(days) ? days[0] : days);

      // Get data for the specified number of days
      const startDate = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000).toISOString();

      const { data: apiCalls, error } = await supabase
        .from('api_calls')
        .select('*')
        .eq('user_id', userId)
        .gte('created_at', startDate)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Charts query error:', error);
        return res.status(200).json({
          success: true,
          data: {
            input_tokens: [],
            output_tokens: [],
            call_frequency: [],
            cost_distribution: []
          },
          fallback: true
        });
      }

      // Process data for charts
      const chartData = processChartData(apiCalls || [], daysNum);

      return res.status(200).json({
        success: true,
        data: chartData
      });

    } catch (error) {
      console.error('Charts handler error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch chart data'
      });
    }
  }

  return res.status(405).json({
    success: false,
    error: 'Method not allowed'
  });
}

function processChartData(calls: any[], days: number) {
  // Group by day
  const dayBuckets: Record<string, any> = {};
  
  calls.forEach(call => {
    const date = new Date(call.created_at).toISOString().split('T')[0];
    
    if (!dayBuckets[date]) {
      dayBuckets[date] = {
        input_tokens: 0,
        output_tokens: 0,
        calls: 0,
        cost: 0
      };
    }

    dayBuckets[date].input_tokens += parseInt(call.tokens_input || call.input_tokens || 0);
    dayBuckets[date].output_tokens += parseInt(call.tokens_output || call.output_tokens || 0);
    dayBuckets[date].calls += 1;
    dayBuckets[date].cost += parseFloat(call.cost_usd || call.cost || 0);
  });

  // Convert to arrays for charts
  const dates = Object.keys(dayBuckets).sort();
  
  return {
    input_tokens: dates.map(date => ({
      date,
      value: dayBuckets[date].input_tokens
    })),
    output_tokens: dates.map(date => ({
      date,
      value: dayBuckets[date].output_tokens
    })),
    call_frequency: dates.map(date => ({
      date,
      value: dayBuckets[date].calls
    })),
    cost_distribution: [{
      key: 'Current Key',
      input_cost: calls.reduce((sum, call) => 
        sum + (parseFloat(call.cost_usd || call.cost || 0) * 
        (parseInt(call.tokens_input || call.input_tokens || 0) / 
        (parseInt(call.tokens_input || call.input_tokens || 0) + 
         parseInt(call.tokens_output || call.output_tokens || 0) || 1))), 0),
      output_cost: calls.reduce((sum, call) => 
        sum + (parseFloat(call.cost_usd || call.cost || 0) * 
        (parseInt(call.tokens_output || call.output_tokens || 0) / 
        (parseInt(call.tokens_input || call.input_tokens || 0) + 
         parseInt(call.tokens_output || call.output_tokens || 0) || 1))), 0),
      total_cost: calls.reduce((sum, call) => 
        sum + parseFloat(call.cost_usd || call.cost || 0), 0)
    }]
  };
}

