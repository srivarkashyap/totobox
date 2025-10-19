import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_ANON_KEY!;
  
  // Test 1: Check env vars
  const envTest = {
    hasUrl: !!supabaseUrl,
    hasKey: !!supabaseKey,
    urlValue: supabaseUrl,
    keyPrefix: supabaseKey?.substring(0, 20) + '...'
  };
  
  // Test 2: Try to connect and query
  const supabase = createClient(supabaseUrl, supabaseKey);
  
  const { data, error, count } = await supabase
    .from('api_calls')
    .select('*', { count: 'exact' });
  
  return res.status(200).json({
    success: true,
    envTest,
    queryTest: {
      totalRows: count,
      hasData: !!data,
      dataLength: data?.length || 0,
      hasError: !!error,
      error: error?.message || null,
      firstRow: data?.[0] || null
    }
  });
}
