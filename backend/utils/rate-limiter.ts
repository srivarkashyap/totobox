import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

interface RateLimitConfig {
    CALLS_PER_KEY: number;
    TOKENS_PER_KEY: number;
    KEYS_PER_IP: number;
    CALLS_PER_HOUR_GLOBAL: number;
    CALLS_PER_DAY_GLOBAL: number;
}

const LIMITS: RateLimitConfig = {
    CALLS_PER_KEY: 20,
    TOKENS_PER_KEY: 100_000,
    KEYS_PER_IP: 3,
    CALLS_PER_HOUR_GLOBAL: 500,
    CALLS_PER_DAY_GLOBAL: 5000,
};

export class RateLimiter {
    /**
     * Check if user has exceeded their key limits
     */
    static async checkKeyLimits(userId: string): Promise<{ allowed: boolean; reason?: string }> {
        try {
            const { data, error } = await supabase
                .from('rate_limits')
                .select('*')
                .eq('user_id', userId)
                .single();

            if (error && error.code !== 'PGRST116') {
                console.error('Rate limit check error:', error);
                return { allowed: true }; // Fail open to not block legitimate users
            }

            if (!data) {
                // First time user, create entry
                await supabase.from('rate_limits').insert({
                    user_id: userId,
                    total_calls: 0,
                    total_tokens: 0,
                });
                return { allowed: true };
            }

            // Check call limit
            if (data.total_calls >= LIMITS.CALLS_PER_KEY) {
                return {
                    allowed: false,
                    reason: `Rate limit exceeded: ${LIMITS.CALLS_PER_KEY} calls per key. Your key has made ${data.total_calls} calls.`,
                };
            }

            // Check token limit
            if (data.total_tokens >= LIMITS.TOKENS_PER_KEY) {
                return {
                    allowed: false,
                    reason: `Token limit exceeded: ${LIMITS.TOKENS_PER_KEY} tokens per key. Your key has used ${data.total_tokens} tokens.`,
                };
            }

            return { allowed: true };
        } catch (error) {
            console.error('Rate limiter error:', error);
            return { allowed: true }; // Fail open
        }
    }

    /**
     * Increment usage for a key
     */
    static async incrementUsage(userId: string, tokens: number): Promise<void> {
        try {
            const { data, error } = await supabase
                .from('rate_limits')
                .select('*')
                .eq('user_id', userId)
                .single();

            if (error || !data) {
                // Create new entry
                await supabase.from('rate_limits').insert({
                    user_id: userId,
                    total_calls: 1,
                    total_tokens: tokens,
                });
            } else {
                // Update existing
                await supabase
                    .from('rate_limits')
                    .update({
                        total_calls: data.total_calls + 1,
                        total_tokens: data.total_tokens + tokens,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('user_id', userId);
            }
        } catch (error) {
            console.error('Failed to increment usage:', error);
        }
    }

    /**
     * Check global hourly rate limit
     */
    static async checkGlobalHourlyLimit(): Promise<{ allowed: boolean; reason?: string }> {
        try {
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

            const { count, error } = await supabase
                .from('api_calls')
                .select('*', { count: 'exact', head: true })
                .gte('timestamp', oneHourAgo);

            if (error) {
                console.error('Global hourly limit check error:', error);
                return { allowed: true };
            }

            if ((count || 0) >= LIMITS.CALLS_PER_HOUR_GLOBAL) {
                return {
                    allowed: false,
                    reason: `Global hourly limit exceeded: ${LIMITS.CALLS_PER_HOUR_GLOBAL} calls/hour. Try again later.`,
                };
            }

            return { allowed: true };
        } catch (error) {
            console.error('Global hourly limit error:', error);
            return { allowed: true };
        }
    }

    /**
     * Check global daily rate limit
     */
    static async checkGlobalDailyLimit(): Promise<{ allowed: boolean; reason?: string }> {
        try {
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

            const { count, error } = await supabase
                .from('api_calls')
                .select('*', { count: 'exact', head: true })
                .gte('timestamp', oneDayAgo);

            if (error) {
                console.error('Global daily limit check error:', error);
                return { allowed: true };
            }

            if ((count || 0) >= LIMITS.CALLS_PER_DAY_GLOBAL) {
                return {
                    allowed: false,
                    reason: `Global daily limit exceeded: ${LIMITS.CALLS_PER_DAY_GLOBAL} calls/day. System at capacity.`,
                };
            }

            return { allowed: true };
        } catch (error) {
            console.error('Global daily limit error:', error);
            return { allowed: true };
        }
    }

    /**
     * Check IP-based registration limit
     */
    static async checkIPRegistrationLimit(ipAddress: string): Promise<{ allowed: boolean; reason?: string }> {
        try {
            const { count, error } = await supabase
                .from('ip_registrations')
                .select('*', { count: 'exact', head: true })
                .eq('ip_address', ipAddress);

            if (error) {
                console.error('IP registration check error:', error);
                return { allowed: true };
            }

            if ((count || 0) >= LIMITS.KEYS_PER_IP) {
                return {
                    allowed: false,
                    reason: `Registration limit exceeded: Maximum ${LIMITS.KEYS_PER_IP} keys per IP address.`,
                };
            }

            return { allowed: true };
        } catch (error) {
            console.error('IP registration error:', error);
            return { allowed: true };
        }
    }

    /**
     * Record IP registration
     */
    static async recordIPRegistration(ipAddress: string, userId: string): Promise<void> {
        try {
            await supabase.from('ip_registrations').insert({
                ip_address: ipAddress,
                user_id: userId,
            });
        } catch (error) {
            console.error('Failed to record IP registration:', error);
        }
    }

    /**
     * Get current limits (for display purposes)
     */
    static getLimits(): RateLimitConfig {
        return LIMITS;
    }

    /**
     * Get usage stats for a key
     */
    static async getUsageStats(userId: string): Promise<{ calls: number; tokens: number } | null> {
        try {
            const { data, error } = await supabase
                .from('rate_limits')
                .select('total_calls, total_tokens')
                .eq('user_id', userId)
                .single();

            if (error || !data) {
                return { calls: 0, tokens: 0 };
            }

            return {
                calls: data.total_calls,
                tokens: data.total_tokens,
            };
        } catch (error) {
            console.error('Failed to get usage stats:', error);
            return null;
        }
    }
}
