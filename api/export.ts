import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

interface ExportQuery {
  user_id: string;
  format: 'csv' | 'json';
  start_date?: string;
  end_date?: string;
  provider?: string;
  model?: string;
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
      const query: ExportQuery = {
        user_id: (req.query.user_id as string) || 'anonymous',
        format: (req.query.format as 'csv' | 'json') || 'csv',
        start_date: req.query.start_date as string,
        end_date: req.query.end_date as string,
        provider: req.query.provider as string,
        model: req.query.model as string
      };

      // Default to last 30 days
      const endDate = query.end_date || new Date().toISOString().split('T')[0];
      const startDate = query.start_date || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const data = await fetchExportData(query, startDate, endDate);

      if (query.format === 'csv') {
        const csvContent = generateCSV(data);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="totobox-export-${startDate}-to-${endDate}.csv"`);
        return res.status(200).send(csvContent);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="totobox-export-${startDate}-to-${endDate}.json"`);
        return res.status(200).json({
          success: true,
          export_info: {
            user_id: query.user_id,
            date_range: { start: startDate, end: endDate },
            total_records: data.length,
            generated_at: new Date().toISOString()
          },
          data: data
        });
      }

    } catch (error) {
      console.error('Export API error:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to export data'
      });
    }
  }

  return res.status(405).json({
    success: false,
    error: 'Method not allowed'
  });
}

async function fetchExportData(query: ExportQuery, startDate: string, endDate: string) {
  try {
    let supabaseQuery = supabase
      .from('api_calls')
      .select('*')
      .eq('user_id', query.user_id)
      .gte('created_at', `${startDate}T00:00:00.000Z`)
      .lte('created_at', `${endDate}T23:59:59.999Z`)
      .order('created_at', { ascending: false });

    if (query.provider) {
      supabaseQuery = supabaseQuery.eq('provider', query.provider);
    }

    if (query.model) {
      supabaseQuery = supabaseQuery.eq('model', query.model);
    }

    const { data, error } = await supabaseQuery;

    if (error) {
      throw error;
    }

    return data || [];

  } catch (error) {
    console.error('Error fetching export data:', error);
    return [];
  }
}

function generateCSV(data: any[]): string {
  if (data.length === 0) {
    return 'No data available for the specified criteria';
  }

  const headers = [
    'Date',
    'Time',
    'Provider',
    'Model',
    'Tokens Input',
    'Tokens Output',
    'Total Tokens',
    'Cost (USD)',
    'Latency (ms)',
    'Request ID'
  ];

  const rows = data.map(call => [
    new Date(call.created_at).toLocaleDateString(),
    new Date(call.created_at).toLocaleTimeString(),
    call.provider || 'unknown',
    call.model || 'unknown',
    call.tokens_input || 0,
    call.tokens_output || 0,
    (call.tokens_input || 0) + (call.tokens_output || 0),
    parseFloat(call.cost_usd || 0).toFixed(4),
    call.latency_ms || 0,
    call.id || 'unknown'
  ]);

  // Escape CSV values and handle commas/quotes
  const escapeCSVValue = (value: string | number): string => {
    const stringValue = String(value);
    if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  };

  const csvLines = [
    headers.map(escapeCSVValue).join(','),
    ...rows.map(row => row.map(escapeCSVValue).join(','))
  ];

  return csvLines.join('\n');
}