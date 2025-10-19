import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method === 'GET') {
    return res.status(200).json({ 
      message: 'totoboX API is working!', 
      timestamp: new Date().toISOString() 
    });
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
}