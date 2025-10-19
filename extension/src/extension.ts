import * as vscode from 'vscode';
import { httpClient } from './http-client';
import { CryptoUtils } from './crypto-utils';
import { ConfigManager } from './config-manager';
import { ErrorHandler } from './error-handler';

interface APIKeyConfig {
    id: string;
    name: string;
    provider: string;
    providerVersion?: string;
    encryptedKey?: string;
    maskedKey?: string;
    proxyKey: string;
    isActive: boolean;
    createdAt: string;
    lastUsed?: string;
}

interface UsageData {
    cost: number;
    tokens: number;
    calls: number;
    lastUpdate: string;
}

interface ChartData {
    keyId: string;
    keyName: string;
    color: string;
    data: {
        labels: string[];
        tokens: number[];
        inputTokens: number[];
        outputTokens: number[];
        costs: number[];
        calls: number[];
    };
}

type TabType = 'home' | 'logs' | 'keys' | 'settings';

const PROVIDERS: Record<string, { label: string; versions: string[] }> = {
    openai: {
        label: 'OpenAI',
        versions: ['gpt-3.5-turbo', 'gpt-4', 'gpt-4o', 'gpt-4-turbo'],
    },
    anthropic: {
        label: 'Anthropic',
        versions: ['claude-3-haiku', 'claude-3-sonnet', 'claude-3-opus', 'claude-3.5-sonnet'],
    },
    gemini: {
        label: 'Gemini',
        versions: ['gemini-1.0', 'gemini-1.5', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    },
    meta: {
        label: 'Meta',
        versions: ['llama-2-7b', 'llama-2-13b', 'llama-2-70b', 'llama-3', 'llama-3.1'],
    },
    perplexity: {
        label: 'Perplexity',
        versions: ['sonar-small', 'sonar-medium', 'sonar-large'],
    },
    copilot: {
        label: 'GitHub Copilot',
        versions: ['gpt-4', 'gpt-4o', 'gpt-4o-mini'],
    },
};

const CHART_COLORS = ['#4a9eff', '#00d26a', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316'];
const CONFIG_SECTION = 'totobox';

class TotoBoxExtension {
    private statusBarItem!: vscode.StatusBarItem;
    private currentData: {
        cost: number;
        tokens: number;
        calls: number;
        lastUpdate: string;
        input_tokens?: number;
        output_tokens?: number;
    } = {
        cost: 0,
        tokens: 0,
        calls: 0,
        lastUpdate: new Date().toISOString(),
        input_tokens: 0,
        output_tokens: 0
    };
    private updateTimer: NodeJS.Timeout | null = null;
    private webviewPanel: vscode.WebviewPanel | null = null;
    private isDisposed = false;
    private activeTab: TabType = 'home';
    private connectionStatus: 'connected' | 'degraded' | 'disconnected' = 'connected';
    private lastSuccessfulUpdate = Date.now();
    private selectedKeys: Map<string, Set<string>> = new Map([
        ['input', new Set()],
        ['output', new Set()],
        ['calls', new Set()],
        ['cost', new Set()] 
    ]);
    private chartTimeWindow: '1h' | '24h' | '7d' | '30d' = '7d';
    private totalApiCalls: number = 0;
    private cryptoUtils: CryptoUtils;
    private configManager: ConfigManager;
    private errorHandler: ErrorHandler;
    private hasRealKeys = false;

    constructor(private context: vscode.ExtensionContext) {
        this.cryptoUtils = CryptoUtils.getInstance();
        this.configManager = ConfigManager.getInstance(context);
        this.errorHandler = ErrorHandler.getInstance();
    }

    public async initialize(): Promise<void> {
        try {
            await this.cryptoUtils.initializeMasterKey(this.context);
            this.initializeStatusBar();
            this.startDataUpdateLoop();
            this.registerCommands();
            await this.checkForRealKeys();
        } catch (error) {
            console.error('Failed to initialize totoboX:', error);
            vscode.window.showErrorMessage(`Failed to initialize totoboX: ${error}`);
        }
    }

    private async checkForRealKeys(): Promise<void> {
        const keys = await this.getAPIKeys();
        this.hasRealKeys = keys.length > 0;
    }

    private initializeStatusBar(): void {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'totobox.showDashboard';
        this.updateStatusBarDisplay();
        this.statusBarItem.show();
        this.context.subscriptions.push(this.statusBarItem);
    }

    private updateStatusBarDisplay(): void {
        if (this.isDisposed) return;
        
        const statusIcon = this.connectionStatus === 'connected' ? '$(graph)' :
                        this.connectionStatus === 'degraded' ? '$(warning)' : 
                        '$(x)';
        
        const cost = this.currentData.cost?.toFixed(4) || '0.0000';
        const tokens = this.currentData.tokens?.toLocaleString() || '0';
        
        this.statusBarItem.text = `${statusIcon} $${cost} | ${tokens} tokens`;
        this.statusBarItem.tooltip = `totoboX: Click to view dashboard\n💰 Cost: $${cost}\n📊 Tokens: ${tokens}\n📞 Calls: ${this.currentData.calls}`;
    }

    private startDataUpdateLoop(): void {
        this.fetchAnalytics().catch(() => {});
        const refreshInterval = this.configManager.get('refreshInterval');
        this.updateTimer = setInterval(() => {
            if (!this.isDisposed) {
                this.fetchAnalytics().catch(() => {});
            }
        }, refreshInterval * 1000);
    }

    private async fetchAnalytics(): Promise<void> {
        try {
            const activeKey = await this.getActiveAPIKey();
            
            console.log('🔍 [fetchAnalytics] Starting analytics fetch...');

            if (!activeKey) {
                console.log('⚠️ [fetchAnalytics] No active key found');
                this.currentData = { 
                    cost: 0, 
                    tokens: 0, 
                    calls: 0, 
                    lastUpdate: new Date().toISOString() 
                };
                this.connectionStatus = 'connected';
                this.updateStatusBarDisplay();
                this.refreshWebview();
                return;
            }

            const backendUrl = this.configManager.getBackendUrl();
            const url = `${backendUrl}/api/analytics?user_id=${encodeURIComponent(activeKey.id)}`;

            console.log('🌐 [fetchAnalytics] Fetching from:', url);

            const res = await httpClient.get(url, {
                timeout: this.configManager.get('timeout'),
                cache: true,
                cacheTTL: 60000
            });

            // Handle double nesting: res.data contains the API response which has { success, data }
            const apiResponse = res?.data as any;
            
            console.log('📥 [fetchAnalytics] API Response:', apiResponse);

            if (res?.success && apiResponse?.success && apiResponse?.data?.today) {
                const t = apiResponse.data.today;
                
                console.log('✅ [fetchAnalytics] Processing analytics data:', t);

                this.currentData = {
                    cost: typeof t.cost === 'number' ? t.cost : 0,
                    tokens: typeof t.total_tokens === 'number' ? t.total_tokens : (typeof t.tokens === 'number' ? t.tokens : 0),
                    calls: typeof t.calls === 'number' ? t.calls : 0,
                    lastUpdate: new Date().toISOString(),
                    input_tokens: typeof t.input_tokens === 'number' ? t.input_tokens : 0,
                    output_tokens: typeof t.output_tokens === 'number' ? t.output_tokens : 0,
                };
                
                this.totalApiCalls = typeof t.calls === 'number' ? t.calls : 0;
                this.chartTimeWindow = this.determineOptimalTimeWindow(this.totalApiCalls);

                this.connectionStatus = res.cached || res.fallback ? 'degraded' : 'connected';

                if (!res.cached && !res.fallback) {
                    this.lastSuccessfulUpdate = Date.now();
                }

                console.log('💾 [fetchAnalytics] Updated currentData:', this.currentData);

                await this.updateKeyLastUsed(activeKey.id);
            } else {
                console.log('⚠️ [fetchAnalytics] Invalid response structure');
                this.connectionStatus = 'degraded';
                if (Date.now() - this.lastSuccessfulUpdate > 10 * 60_000) {
                    this.connectionStatus = 'disconnected';
                }
            }
        } catch (error) {
            console.error('❌ [fetchAnalytics] Error:', error);
            await this.errorHandler.handleError(
                error as Error,
                {
                    operation: 'fetchAnalytics',
                    retry: () => this.fetchAnalytics()
                }
            );
            this.connectionStatus = 'disconnected';
        } finally {
            this.updateStatusBarDisplay();
            this.refreshWebview();
        }
    }

    private determineOptimalTimeWindow(callCount: number): '1h' | '24h' | '7d' | '30d' {
        if (callCount === 0) {
            return '24h'; // Default for new users
        } else if (callCount < 10) {
            return '1h'; // Hourly for first few calls
        } else if (callCount < 50) {
            return '24h'; // Last 24 hours
        } else if (callCount < 200) {
            return '7d'; // Last 7 days
        } else {
            return '30d'; // Last 30 days for power users
        }
    }

    private async fetchRecentLogs(): Promise<any[]> {
        try {
            const backendUrl = this.configManager.getBackendUrl();
            const keys = await this.getAPIKeys();
            
            if (keys.length === 0) {
                console.log('⚠️ No API keys configured');
                return [];
            }

            const activeKey = keys.find(k => k.isActive) || keys[0];
            const url = `${backendUrl}/api/analytics?user_id=${encodeURIComponent(activeKey.id)}`;
            
            console.log('🔍 Fetching logs from:', url);
            
            const response = await httpClient.get(url, {
                timeout: this.configManager.get('timeout'),
                cache: false
            });

            console.log('📦 Raw response:', response);
            
            // Handle double-nested structure from httpClient
            // response.data.data.recent_activity (double nested!)
            let actualData: any = response;
            
            // Unwrap first level
            if (actualData?.data) {
                actualData = actualData.data;
            }
            
            // Unwrap second level if it exists
            if (actualData?.data) {
                actualData = actualData.data;
            }

            console.log('📦 Actual data after unwrapping:', actualData);
            console.log('📦 Recent activity:', actualData?.recent_activity);

            if (actualData?.recent_activity && Array.isArray(actualData.recent_activity)) {
                const logs = actualData.recent_activity;
                console.log('✅ Logs found:', logs.length);
                console.log('📋 First log:', logs[0]);
                return logs;
            }

            console.log('⚠️ No recent_activity found');
            return [];
        } catch (error) {
            console.error('❌ Failed to fetch logs:', error);
            return [];
        }
    }

    private async generateChartData(): Promise<ChartData[]> {
        const keys = await this.getAPIKeys();
        
        // Generate appropriate labels based on time window
        const labels = this.generateChartLabels(this.chartTimeWindow);

        if (!this.hasRealKeys) {
            return this.getDemoChartData(labels);
        }

        // Determine days parameter based on time window
        const daysParam = this.chartTimeWindow === '1h' ? 1 : 
                        this.chartTimeWindow === '24h' ? 1 : 
                        this.chartTimeWindow === '7d' ? 7 : 30;

        const chartDataPromises = keys.map(async (key, index) => {
            try {
                const backendUrl = this.configManager.getBackendUrl();
            
                // Fetch all three chart types with dynamic days parameter
                const [tokenResponse, costResponse, callsResponse] = await Promise.all([
                    httpClient.get(`${backendUrl}/api/charts?user_id=${encodeURIComponent(key.id)}&chart_type=token_usage&days=${daysParam}`, {
                        timeout: this.configManager.get('timeout'),
                        cache: true,
                        cacheTTL: 300000
                    }),
                    httpClient.get(`${backendUrl}/api/charts?user_id=${encodeURIComponent(key.id)}&chart_type=cost_trend&days=${daysParam}`, {
                        timeout: this.configManager.get('timeout'),
                        cache: true,
                        cacheTTL: 300000
                    }),
                    httpClient.get(`${backendUrl}/api/charts?user_id=${encodeURIComponent(key.id)}&chart_type=hourly_pattern&days=${daysParam}`, {
                        timeout: this.configManager.get('timeout'),
                        cache: true,
                        cacheTTL: 300000
                    })
                ]);
                
                console.log('Token response:', tokenResponse?.data);
                console.log('Cost response:', costResponse?.data);
                console.log('Calls response:', callsResponse?.data);
                
                if (tokenResponse?.success || costResponse?.success || callsResponse?.success) {
                    const tokenData = this.extractDailyTokens(tokenResponse?.data || [], labels);
                    return {
                        keyId: key.id,
                        keyName: key.name,
                        color: CHART_COLORS[index % CHART_COLORS.length],
                        data: {
                            labels,
                            tokens: tokenData.total,
                            inputTokens: tokenData.input,
                            outputTokens: tokenData.output,
                            costs: this.extractDailyCosts(costResponse?.data || [], labels),
                            calls: this.extractDailyCalls(callsResponse?.data || [], labels)
                        }
                    };
                }
            } catch (error) {
                console.warn(`Failed to fetch chart data for key ${key.id}:`, error);
            }

            // Fallback to zero data with correct array length
            const arrayLength = labels.length;
            return {
                keyId: key.id,
                keyName: key.name,
                color: CHART_COLORS[index % CHART_COLORS.length],
                data: {
                    labels,
                    tokens: new Array(arrayLength).fill(0),
                    inputTokens: new Array(arrayLength).fill(0),
                    outputTokens: new Array(arrayLength).fill(0),
                    costs: new Array(arrayLength).fill(0),
                    calls: new Array(arrayLength).fill(0)
                }
            };
        });

        return await Promise.all(chartDataPromises);
    }

    private generateChartLabels(timeWindow: '1h' | '24h' | '7d' | '30d'): string[] {
        if (timeWindow === '1h') {
            // Last hour: show 12 x 5-minute intervals
            const labels = [];
            for (let i = 11; i >= 0; i--) {
                labels.push(`-${i * 5}m`);
            }
            return labels;
        } else if (timeWindow === '24h') {
            // Last 24 hours: show every 2 hours
            const labels = [];
            const now = new Date();
            for (let i = 23; i >= 0; i -= 2) {
                const hour = (now.getHours() - i + 24) % 24;
                labels.push(`${hour}:00`);
            }
            return labels.reverse();
        } else if (timeWindow === '7d') {
            // Last 7 days: show days of week
            return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        } else {
            // Last 30 days: show weeks
            return ['Week 1', 'Week 2', 'Week 3', 'Week 4'];
        }
    }


    private extractDailyTokens(chartData: any, labels: string[]): { total: number[], input: number[], output: number[] } {
        const arrayLength = labels.length;
        const totalTokens = new Array(arrayLength).fill(0);
        const inputTokens = new Array(arrayLength).fill(0);
        const outputTokens = new Array(arrayLength).fill(0);
    
    // rest of the method stays the same...

        if (Array.isArray(chartData)) {
            const dayMap: Record<string, number> = {
                'Mon': 0, 'Tue': 1, 'Wed': 2, 'Thu': 3, 'Fri': 4, 'Sat': 5, 'Sun': 6
            };
        
            chartData.forEach((item: any) => {
                const date = new Date(item.date);
                const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
                const dayIndex = dayMap[dayName];
            
                if (dayIndex !== undefined) {
                    const input = item.input || 0;
                    const output = item.output || 0;
                    const total = item.total || (input + output) || 0;
                    
                    inputTokens[dayIndex] = input;
                    outputTokens[dayIndex] = output;
                    totalTokens[dayIndex] = total;
                }
            });
        }

        return {
            total: totalTokens,
            input: inputTokens,
            output: outputTokens
        };
    }


    private extractDailyCosts(chartData: any, labels: string[]): number[] {
        const arrayLength = labels.length;
        const costsByDay = new Array(arrayLength).fill(0);
    
    // rest of the method stays the same...
    
        if (Array.isArray(chartData)) {
            const dayMap: Record<string, number> = {
                'Mon': 0, 'Tue': 1, 'Wed': 2, 'Thu': 3, 'Fri': 4, 'Sat': 5, 'Sun': 6
            };
        
            chartData.forEach((item: any) => {
                const date = new Date(item.date);
                const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
                const dayIndex = dayMap[dayName];
                
                if (dayIndex !== undefined) {
                    costsByDay[dayIndex] = parseFloat(item.cost) || 0;
                }
            });
        }
    
        return costsByDay;
    }

    private extractDailyCalls(chartData: any, labels: string[]): number[] {
        const arrayLength = labels.length;
        const callsByDay = new Array(arrayLength).fill(0);
    
    // rest of the method stays the same...

        if (Array.isArray(chartData)) {
            // Group by date and sum all hours for each day
            const dailyTotals = new Map<string, number>();
            
            chartData.forEach((item: any) => {
                const date = item.date || new Date().toISOString().split('T')[0];
                const current = dailyTotals.get(date) || 0;
                dailyTotals.set(date, current + (item.count || 0));
            });
            
            // Map to day names
            const dayMap: Record<string, number> = {
                'Mon': 0, 'Tue': 1, 'Wed': 2, 'Thu': 3, 'Fri': 4, 'Sat': 5, 'Sun': 6
            };
            
            dailyTotals.forEach((count, dateStr) => {
                const date = new Date(dateStr);
                const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
                const dayIndex = dayMap[dayName];
                
                if (dayIndex !== undefined) {
                    callsByDay[dayIndex] = count;
                }
            });
        }

        return callsByDay;
    }

    private getDemoChartData(labels: string[]): ChartData[] {
        return [
            {
                keyId: 'key1',
                keyName: 'Production API',
                color: CHART_COLORS[0],
                data: {
                    labels,
                    tokens: [45000, 52000, 48000, 61000, 55000, 67000, 58000],
                    inputTokens: [18000, 20800, 19200, 24400, 22000, 26800, 23200],
                    outputTokens: [27000, 31200, 28800, 36600, 33000, 40200, 34800],
                    costs: [12.5, 14.8, 13.2, 18.6, 16.1, 21.3, 17.9],
                    calls: [89, 104, 96, 122, 110, 134, 116]
                }
            },
            {
                keyId: 'key2',
                keyName: 'Development API',
                color: CHART_COLORS[1],
                data: {
                    labels,
                    tokens: [32000, 38000, 35000, 42000, 39000, 45000, 41000],
                    inputTokens: [12800, 15200, 14000, 16800, 15600, 18000, 16400],
                    outputTokens: [19200, 22800, 21000, 25200, 23400, 27000, 24600],
                    costs: [8.4, 9.8, 9.1, 11.2, 10.3, 12.1, 10.9],
                    calls: [64, 76, 70, 84, 78, 90, 82]
                }
            },
            {
                keyId: 'key3',
                keyName: 'Testing API',
                color: CHART_COLORS[2],
                data: {
                    labels,
                    tokens: [18000, 22000, 19000, 25000, 21000, 28000, 24000],
                    inputTokens: [7200, 8800, 7600, 10000, 8400, 11200, 9600],
                    outputTokens: [10800, 13200, 11400, 15000, 12600, 16800, 14400],
                    costs: [4.2, 5.1, 4.6, 6.8, 5.5, 7.2, 6.3],
                    calls: [38, 45, 42, 51, 47, 58, 52]
                }
            }
        ];
    }


    private async getAPIKeys(): Promise<APIKeyConfig[]> {
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        return cfg.get('apiKeys', []) || [];
    }

    private async setAPIKeys(keys: APIKeyConfig[]): Promise<void> {
        await vscode.workspace.getConfiguration(CONFIG_SECTION)
            .update('apiKeys', keys, vscode.ConfigurationTarget.Global);
    }

    private async getActiveAPIKey(): Promise<APIKeyConfig | null> {
        const keys = await this.getAPIKeys();
        return keys.find(k => k.isActive) || null;
    }

    private async updateKeyLastUsed(keyId: string): Promise<void> {
        const keys = await this.getAPIKeys();
        const k = keys.find(x => x.id === keyId);
        if (k) {
            k.lastUsed = new Date().toISOString();
            await this.setAPIKeys(keys);
        }
    }

    private registerCommands(): void {
        const showDashboardCmd = vscode.commands.registerCommand(
            'totobox.showDashboard',
            () => {
                console.log('Show Dashboard command triggered');
                return this.showDashboard();
            }
        );

        const refreshDataCmd = vscode.commands.registerCommand(
            'totobox.refreshData',
            () => {
                console.log('Refresh Data command triggered');
                return this.fetchAnalytics();  // FIXED HERE
            }
        );

        this.context.subscriptions.push(showDashboardCmd);
        this.context.subscriptions.push(refreshDataCmd);
        console.log('Commands registered successfully');
    }

    public async showDashboard(): Promise<void> {
        if (this.webviewPanel) {
            this.webviewPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.webviewPanel = vscode.window.createWebviewPanel(
            'totoboxDashboard',
            'totoboX Dashboard',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        this.webviewPanel.onDidDispose(() => {
            this.webviewPanel = null;
        });

        this.webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
            try {
                switch (msg?.command) {
                    case 'switchTab':
                        this.activeTab = msg.tab;
                        await this.refreshWebview();
                        break;
                    case 'generateProxy':
                        await this.handleGenerateProxy(msg.data);
                        break;
                    case 'switchKey':
                        await this.handleSwitchKey(msg.keyId);
                        break;
                    case 'removeKey':
                        await this.handleRemoveKey(msg.keyId);
                        break;
                    case 'renameKey':
                        await this.handleRenameKey(msg.keyId, msg.newName);
                        break;
                    case 'copyProxy':
                        await this.handleCopyProxy(msg.proxyKey);
                        break;
                    case 'exportCSV':
                        await this.handleExportCSV();
                        break;
                    case 'refreshData':
                        await this.fetchAnalytics();
                        break;
                    case 'saveSettings':
                        await this.handleSaveSettings(msg.data);
                        break;
                    case 'toggleKeySelection':
                        await this.handleToggleKeySelection(msg.keyId, msg.chartType);
                        break;
                    
                    case 'changeTimeWindow':
                        await this.handleChangeTimeWindow(msg.timeWindow);
                        break;

                }
            } catch (err) {
                await this.errorHandler.handleError(err as Error, {
                    operation: 'webviewMessage',
                    details: msg
                });
            }
        });

        await this.refreshWebview();
    }

    private async handleToggleKeySelection(keyId: string, chartType: 'token' | 'cost' | 'calls'): Promise<void> {
        const selectedSet = this.selectedKeys.get(chartType) || new Set();
        if (selectedSet.has(keyId)) {
            selectedSet.delete(keyId);
        } else {
            selectedSet.add(keyId);
        }

        this.selectedKeys.set(chartType, selectedSet);
        await this.refreshWebview();
    }

    private async refreshWebview(): Promise<void> {
        if (!this.webviewPanel) return;
        this.webviewPanel.webview.html = await this.generateHTML();
    }

    private async handleChangeTimeWindow(timeWindow: '1h' | '24h' | '7d' | '30d'): Promise<void> {
        console.log('🕒 Changing time window to:', timeWindow);
        this.chartTimeWindow = timeWindow;
        await this.refreshWebview();
    }

    private async generateHTML(): Promise<string> {
        const nonce = Math.random().toString(36).slice(2, 12);
        const keys = await this.getAPIKeys();
        const activeKey = keys.find(k => k.isActive);
        const chartDataSets = await this.generateChartData();

        // Initialize selectedKeys with first available key for each chart
        if (chartDataSets.length > 0) {
            ['input', 'output', 'calls', 'cost'].forEach((chartType) => {
                const selectedSet = this.selectedKeys.get(chartType as any) || new Set();
                if (selectedSet.size === 0) {
                    selectedSet.add(chartDataSets[0].keyId);
                    this.selectedKeys.set(chartType as any, selectedSet);
                }
            });
        }

        const htmlContent = await this.buildHTMLContent(nonce, keys, activeKey, chartDataSets);
        return htmlContent;
    }

    private async buildHTMLContent(nonce: string, keys: APIKeyConfig[], activeKey: APIKeyConfig | undefined, chartDataSets: ChartData[]): Promise<string> {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>totoboX Dashboard</title>
                ${this.getStyles()}
            </head>
            <body>
                ${await this.getTabContent(keys, activeKey, chartDataSets)}
                ${this.getJavaScript(nonce, chartDataSets)}
            </body>
            </html>
        `;
    }

    private getConnectionBadge(): string {
        const badgeClass = this.connectionStatus === 'degraded' ? 'warning' : 'error';
        const text = this.connectionStatus === 'degraded' ? 'âš  Degraded' : 'âŒ Offline';
        return `<span class="badge ${badgeClass}">${text}</span>`;
    }

    private async getTabContent(keys: APIKeyConfig[], activeKey: APIKeyConfig | undefined, chartDataSets: ChartData[]): Promise<string> {
        switch (this.activeTab) {
            case 'home':
                return this.getHomeContent(keys, activeKey, chartDataSets);
            case 'logs':
                return await this.getLogsContent();
            case 'keys':
                return this.getKeysContent(keys);
            case 'settings':
                return this.getSettingsContent();
            default:
                return this.getHomeContent(keys, activeKey, chartDataSets);
        }
    }

    private getHomeContent(keys: APIKeyConfig[], activeKey: APIKeyConfig | undefined, chartDataSets: ChartData[]): string {
        return `
            <div class="app-container">
                <!-- Left Sidebar Navigation -->
                <nav class="sidebar">
                    <div class="nav-item active" onclick="switchTab('home')" title="Dashboard">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"/>
                        </svg>
                        <span class="nav-tooltip">Dashboard</span>
                    </div>
                    <div class="nav-item" onclick="switchTab('logs')" title="Logs">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Logs</span>
                    </div>
                    <div class="nav-item" onclick="switchTab('keys')" title="Keys">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Keys</span>
                    </div>
                    <div class="nav-item" onclick="switchTab('settings')" title="Settings">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Settings</span>
                    </div>
                </nav>

                <!-- Main Content Area -->
                <div class="main-content">
                    <header class="content-header">
                        <div>
                            <h1>📊 Dashboard</h1>
                            <p class="subtitle">${!this.hasRealKeys ? 'Demo data showing potential analytics capabilities' : 'Track your API usage patterns and costs in real-time'}</p>
                        </div>
                        <div style="display: flex; gap: 12px; align-items: center;">
                            <button class="btn secondary" onclick="refreshData()" title="Refresh analytics data">
                                🔄 Refresh
                            </button>
                            <button class="btn secondary" onclick="exportCSV()" title="Export analytics data to CSV">
                                📊 Export CSV
                            </button>
                            ${this.connectionStatus !== 'connected' ? this.getConnectionBadge() : ''}
                        </div>
                    </header>

                    <!-- 6 STAT CARDS - NEW! -->
                    <div class="stats-grid-6">
                        <div class="stat-card cost-card">
                            <div class="stat-icon">💰</div>
                            <div class="stat-content">
                                <h3>Today's Cost</h3>
                                <div class="stat-value">$${this.currentData.cost.toFixed(4)}</div>
                                <div class="stat-change">Total spend today</div>
                            </div>
                        </div>

                        <div class="stat-card input-card">
                            <div class="stat-icon">⬇️</div>
                            <div class="stat-content">
                                <h3>Input Tokens</h3>
                                <div class="stat-value">${(this.currentData.input_tokens || 0).toLocaleString()}</div>
                                <div class="stat-change">Prompt tokens</div>
                            </div>
                        </div>

                        <div class="stat-card output-card">
                            <div class="stat-icon">⬆️</div>
                            <div class="stat-content">
                                <h3>Output Tokens</h3>
                                <div class="stat-value">${(this.currentData.output_tokens || 0).toLocaleString()}</div>
                                <div class="stat-change">Completion tokens</div>
                            </div>
                        </div>

                        <div class="stat-card total-card">
                            <div class="stat-icon">🔢</div>
                            <div class="stat-content">
                                <h3>Total Tokens</h3>
                                <div class="stat-value">${this.currentData.tokens.toLocaleString()}</div>
                                <div class="stat-change">Combined usage</div>
                            </div>
                        </div>

                        <div class="stat-card calls-card">
                            <div class="stat-icon">📞</div>
                            <div class="stat-content">
                                <h3>API Calls</h3>
                                <div class="stat-value">${this.currentData.calls}</div>
                                <div class="stat-change">Requests made</div>
                            </div>
                        </div>

                        <div class="stat-card keys-card">
                            <div class="stat-icon">🔑</div>
                            <div class="stat-content">
                                <h3>Active Keys</h3>
                                <div class="stat-value">${keys.length}</div>
                                <div class="stat-change">Configured keys</div>
                            </div>
                        </div>
                    </div>

                    <!-- API KEY CONFIGURATION -->
                    <div class="card config-card">
                        <div class="card-header">
                            <h2>🔐 Configure API Key</h2>
                            <p>Convert your API key into a trackable proxy key</p>
                        </div>

                        <div class="form-grid">
                            <div class="form-group">
                                <label for="provider">Provider</label>
                                <select id="provider" onchange="updateVersions()">
                                    ${Object.entries(PROVIDERS).map(([key, val]) =>
                                        `<option value="${key}">${val.label}</option>`
                                    ).join('')}
                                </select>
                            </div>

                            <div class="form-group">
                                <label for="providerVersion">Model Version</label>
                                <select id="providerVersion">
                                    ${PROVIDERS.openai.versions.map(v =>
                                        `<option value="${v}">${v}</option>`
                                    ).join('')}
                                </select>
                            </div>
                        </div>

                        <div class="form-group">
                            <label for="apiKey">API Key</label>
                            <input type="password" id="apiKey" placeholder="sk-..." autocomplete="off">
                        </div>

                        <div class="button-group">
                            <button class="btn primary large" onclick="generateProxy()">
                                <span>🔄</span>
                                <span>Generate Proxy Key</span>
                            </button>
                        </div>
                    </div>

                    <!-- 4 CHARTS - UPDATED! -->
                    <div class="card charts-card">
                        <div class="card-header">
                            <h2>📈 Analytics Overview</h2>
                            <p>Visualize your API usage patterns over the last 7 days</p>
                        </div>

                    
                    <!-- ADD TIME WINDOW SELECTOR HERE -->
                    <div class="time-window-selector">
                        <div class="time-window-label">
                            <span>📅 Time Range:</span>
                            <span class="data-insight">${this.totalApiCalls} total calls</span>
                        </div>
                        <div class="time-window-buttons">
                            <button class="time-btn ${this.chartTimeWindow === '1h' ? 'active' : ''}" 
                                    onclick="changeTimeWindow('1h')" 
                                    ${this.totalApiCalls < 5 ? 'disabled' : ''}>
                                Last Hour
                            </button>
                            <button class="time-btn ${this.chartTimeWindow === '24h' ? 'active' : ''}" 
                                    onclick="changeTimeWindow('24h')">
                                24 Hours
                            </button>
                            <button class="time-btn ${this.chartTimeWindow === '7d' ? 'active' : ''}" 
                                    onclick="changeTimeWindow('7d')">
                                7 Days
                            </button>
                            <button class="time-btn ${this.chartTimeWindow === '30d' ? 'active' : ''}" 
                                    onclick="changeTimeWindow('30d')"
                                    ${this.totalApiCalls < 100 ? 'disabled' : ''}>
                                30 Days
                            </button>
                        </div>
                    </div>

                        <!-- Chart 1: Input Tokens -->
                        <div class="chart-section">
                            <div class="chart-header">
                                <h3>⬇️ Input Tokens Over Time</h3>
                                <span class="chart-badge input-badge">Prompt Tokens</span>
                            </div>
                            <div class="chart-legend">
                                ${chartDataSets.map((dataset) => {
                                    const isSelected = this.selectedKeys.get('input')?.has(dataset.keyId) || false;
                                    return `
                                        <div class="legend-item ${isSelected ? 'selected' : ''}" onclick="toggleKeySelection('${dataset.keyId}', 'input')">
                                            <span class="legend-color" style="background-color: ${dataset.color}"></span>
                                            <span>${dataset.keyName}</span>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                            <canvas id="inputTokenChart" width="800" height="300"></canvas>
                        </div>

                        <!-- Chart 2: Output Tokens -->
                        <div class="chart-section">
                            <div class="chart-header">
                                <h3>⬆️ Output Tokens Over Time</h3>
                                <span class="chart-badge output-badge">Completion Tokens</span>
                            </div>
                            <div class="chart-legend">
                                ${chartDataSets.map((dataset) => {
                                    const isSelected = this.selectedKeys.get('output')?.has(dataset.keyId) || false;
                                    return `
                                        <div class="legend-item ${isSelected ? 'selected' : ''}" onclick="toggleKeySelection('${dataset.keyId}', 'output')">
                                            <span class="legend-color" style="background-color: ${dataset.color}"></span>
                                            <span>${dataset.keyName}</span>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                            <canvas id="outputTokenChart" width="800" height="300"></canvas>
                        </div>

                        <!-- Chart 3: API Calls -->
                        <div class="chart-section">
                            <div class="chart-header">
                                <h3>📞 API Call Frequency</h3>
                                <span class="chart-badge calls-badge">Request Volume</span>
                            </div>
                            <div class="chart-legend">
                                ${chartDataSets.map((dataset) => {
                                    const isSelected = this.selectedKeys.get('calls')?.has(dataset.keyId) || false;
                                    return `
                                        <div class="legend-item ${isSelected ? 'selected' : ''}" onclick="toggleKeySelection('${dataset.keyId}', 'calls')">
                                            <span class="legend-color" style="background-color: ${dataset.color}"></span>
                                            <span>${dataset.keyName}</span>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                            <canvas id="callsChart" width="800" height="300"></canvas>
                        </div>

                        <!-- Chart 4: Cost Distribution -->
                        <div class="chart-section">
                            <div class="chart-header">
                                <h3>💰 Cost Distribution</h3>
                                <span class="chart-badge cost-badge">Total Spend</span>
                            </div>
                            <div class="cost-toggle">
                                <button class="toggle-btn active" id="totalCostBtn" onclick="toggleCostView('total')">Total</button>
                                <button class="toggle-btn" id="inputCostBtn" onclick="toggleCostView('input')">Input</button>
                                <button class="toggle-btn" id="outputCostBtn" onclick="toggleCostView('output')">Output</button>
                            </div>
                            <canvas id="costChart" width="800" height="300"></canvas>
                        </div>
                    </div>

                    ${keys.length > 0 ? this.getConfiguredKeysSection(keys) : ''}
                </div>
            </div>
        `;
    }
    
    private getConfiguredKeysSection(keys: APIKeyConfig[]): string {
        return `
            <div class="card">
                <h2>ðŸ” Configured Keys</h2>
                ${keys.map(key => `
                    <div class="key-item">
                        <div class="key-info">
                            <strong>${key.name}</strong>
                            ${key.isActive ? '<span class="badge primary">Active</span>' : ''}
                            <div class="key-meta">
                                ${key.provider} â€¢ ${key.providerVersion || 'default'} â€¢ Created: ${new Date(key.createdAt).toLocaleDateString()}
                                ${key.maskedKey ? ` â€¢ Key: ${key.maskedKey}` : ''}
                            </div>
                        </div>
                        <div class="key-actions">
                            ${!key.isActive ? `<button class="btn small" onclick="switchKey('${key.id}')">âœ” Activate</button>` : ''}
                            <button class="btn small secondary" onclick="copyProxy('${key.proxyKey}')">ðŸ“‹ Copy</button>
                            <button class="btn small danger" onclick="removeKey('${key.id}')">ðŸ—‘ Remove</button>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    
    private async getLogsContent(): Promise<string> {
        const logs = await this.fetchRecentLogs();
        
        const logsHTML = logs.length > 0 
            ? `
                <div class="logs-controls">
                    <div class="filters-container">
                        <select id="providerFilter" class="filter-select" onchange="applyFilters()">
                            <option value="">All Providers</option>
                            <option value="openai">OpenAI</option>
                            <option value="anthropic">Anthropic</option>
                            <option value="gemini">Gemini</option>
                        </select>
                        
                        <select id="modelFilter" class="filter-select" onchange="applyFilters()">
                            <option value="">All Models</option>
                            <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
                            <option value="gpt-4">GPT-4</option>
                            <option value="gpt-4o">GPT-4o</option>
                            <option value="claude-3">Claude 3</option>
                        </select>
                        
                        <input type="date" id="dateFilter" class="filter-input" onchange="applyFilters()" placeholder="Filter by date">
                        
                        <button class="btn secondary small" onclick="clearFilters()">Clear Filters</button>
                    </div>
                    
                    <div class="logs-stats">
                        <span id="logsCount">Showing ${logs.length} logs</span>
                    </div>
                </div>

                <div class="logs-table-container">
                    <table class="logs-table" id="logsTable">
                        <thead>
                            <tr>
                                <th class="col-id">ID</th>
                                <th class="col-timestamp">Timestamp</th>
                                <th class="col-provider">Provider</th>
                                <th class="col-model">Model</th>
                                <th class="col-endpoint">Endpoint</th>
                                <th class="col-number">Input ⬇️</th>
                                <th class="col-number">Output ⬆️</th>
                                <th class="col-number">Total</th>
                                <th class="col-number">Ratio</th>
                                <th class="col-number">Cost</th>
                                <th class="col-number">Latency</th>
                            </tr>
                        </thead>
                        <tbody id="logsTableBody">
                            ${logs.map(log => {
                                const date = new Date(log.timestamp);
                                const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                                
                                const provider = log.provider || 'Unknown';
                                const model = log.model || 'N/A';
                                const endpoint = log.endpoint || '/chat/completions';
                                const logId = log.id || '-';
                                
                                const inputTokens = log.input_tokens || 0;
                                const outputTokens = log.output_tokens || 0;
                                const totalTokens = log.tokens || (inputTokens + outputTokens);
                                
                                const ratio = log.ratio || (inputTokens > 0 ? (outputTokens / inputTokens).toFixed(2) : '0.00');
                                const cost = log.cost ? `$${parseFloat(log.cost).toFixed(6)}` : '$0.000000';
                                const latency = log.latency_ms ? `${log.latency_ms}ms` : 'N/A';
                                
                                // Provider badge color
                                const providerClass = provider === 'openai' ? 'badge-openai' : 
                                                    provider === 'anthropic' ? 'badge-anthropic' : 
                                                    provider === 'gemini' ? 'badge-gemini' :
                                                    'badge-default';
                                
                                // Ratio efficiency indicator
                                const ratioValue = parseFloat(ratio);
                                const efficiencyClass = ratioValue < 1 ? 'ratio-efficient' : 
                                                    ratioValue < 2 ? 'ratio-normal' : 
                                                    'ratio-high';
                                
                                return `
                                    <tr class="log-row" 
                                        data-provider="${provider}" 
                                        data-model="${model}" 
                                        data-date="${dateStr}">
                                        <td class="col-id">
                                            <span class="log-id">#${logId}</span>
                                        </td>
                                        <td class="col-timestamp">
                                            <div class="timestamp-wrapper">
                                                <div class="timestamp-time">${timeStr}</div>
                                                <div class="timestamp-date">${dateStr}</div>
                                            </div>
                                        </td>
                                        <td class="col-provider">
                                            <span class="provider-badge ${providerClass}">${provider}</span>
                                        </td>
                                        <td class="col-model">
                                            <span class="model-name">${model}</span>
                                        </td>
                                        <td class="col-endpoint">
                                            <code class="endpoint-code">${endpoint}</code>
                                        </td>
                                        <td class="col-number">
                                            <span class="token-value token-input">${inputTokens.toLocaleString()}</span>
                                        </td>
                                        <td class="col-number">
                                            <span class="token-value token-output">${outputTokens.toLocaleString()}</span>
                                        </td>
                                        <td class="col-number">
                                            <strong class="token-total">${totalTokens.toLocaleString()}</strong>
                                        </td>
                                        <td class="col-number">
                                            <span class="ratio-badge ${efficiencyClass}">${ratio}x</span>
                                        </td>
                                        <td class="col-number">
                                            <span class="cost-value">${cost}</span>
                                        </td>
                                        <td class="col-number">
                                            <span class="latency-value">${latency}</span>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>

                <div class="logs-footer">
                    <div class="logs-summary">
                        <div class="summary-stat">
                            <span class="summary-label">Total Requests:</span>
                            <span class="summary-value">${logs.length}</span>
                        </div>
                        <div class="summary-stat">
                            <span class="summary-label">Total Tokens:</span>
                            <span class="summary-value">${logs.reduce((sum, log) => sum + (log.tokens || 0), 0).toLocaleString()}</span>
                        </div>
                        <div class="summary-stat">
                            <span class="summary-label">Total Cost:</span>
                            <span class="summary-value">$${logs.reduce((sum, log) => sum + (log.cost || 0), 0).toFixed(6)}</span>
                        </div>
                        <div class="summary-stat">
                            <span class="summary-label">Avg Latency:</span>
                            <span class="summary-value">${Math.round(logs.reduce((sum, log) => sum + (log.latency_ms || 0), 0) / logs.length)}ms</span>
                        </div>
                    </div>
                </div>
            `
            : `
                <div class="empty-state">
                    <div class="empty-icon">📋</div>
                    <h3>No Activity Logs Yet</h3>
                    <p>Make API calls using your proxy key to see detailed logs here.</p>
                    <button class="btn primary" onclick="switchTab('home')">Configure Proxy Key</button>
                </div>
            `;

        return `
            <div class="app-container">
                <nav class="sidebar">
                    <div class="nav-item" onclick="switchTab('home')" title="Dashboard">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"/>
                        </svg>
                        <span class="nav-tooltip">Dashboard</span>
                    </div>
                    <div class="nav-item active" onclick="switchTab('logs')" title="Logs">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Logs</span>
                    </div>
                    <div class="nav-item" onclick="switchTab('keys')" title="Keys">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Keys</span>
                    </div>
                    <div class="nav-item" onclick="switchTab('settings')" title="Settings">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Settings</span>
                    </div>
                </nav>
                
                <div class="main-content">
                    <header class="content-header">
                        <div>
                            <h1>📋 Usage Logs</h1>
                            <p class="subtitle">Detailed history of your API requests with full granularity</p>
                        </div>
                        <button class="btn secondary" onclick="exportCSV()">📊 Export CSV</button>
                    </header>
                    
                    <div class="card logs-card">
                        ${logsHTML}
                    </div>
                </div>
            </div>
        `;
    }



    private getKeysContent(keys: APIKeyConfig[]): string {
        return `
            <div class="app-container">
                <nav class="sidebar">
                    <div class="nav-item" onclick="switchTab('home')" title="Dashboard">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"/>
                        </svg>
                        <span class="nav-tooltip">Dashboard</span>
                    </div>
                    <div class="nav-item" onclick="switchTab('logs')" title="Logs">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Logs</span>
                    </div>
                    <div class="nav-item active" onclick="switchTab('keys')" title="Keys">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Keys</span>
                    </div>
                    <div class="nav-item" onclick="switchTab('settings')" title="Settings">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Settings</span>
                    </div>
                </nav>

                <div class="main-content">
                    <header class="content-header">
                        <div>
                            <h1>🔑 Key Management</h1>
                            <p class="subtitle">Manage your API keys and proxy configurations</p>
                        </div>
                    </header>

                    ${keys.length > 0 ? `
                        <div class="keys-grid">
                            ${keys.map(key => `
                                <div class="key-card ${key.isActive ? 'active' : ''}">
                                    <div class="key-card-header">
                                        <div class="key-card-title">
                                            <span class="key-card-name" id="keyName_${key.id}">${key.name}</span>
                                            <input type="text" class="key-card-name-input" id="keyInput_${key.id}" value="${key.name}" style="display: none;" onblur="cancelRename('${key.id}', '${key.name}')" onkeydown="handleRenameKeyPress(event, '${key.id}')">
                                            ${key.isActive ? '<span class="badge primary">Active</span>' : ''}
                                        </div>
                                        <div class="key-card-actions">
                                            <button class="btn-icon" onclick="copyProxy('${key.proxyKey}')" title="Copy Proxy Key">📋</button>
                                           <button class="btn-icon" onclick="showRenameInput('${key.id}', '${key.name}')" title="Rename Key">✏️</button>
                                            <button class="btn-icon btn-icon-danger" onclick="removeKey('${key.id}')" title="Delete Key">🗑️</button>
                                        </div>
                                    </div>
                                    <div class="key-card-info">
                                        <div class="key-card-row">
                                            <span class="key-card-label">Provider:</span>
                                            <span>${PROVIDERS[key.provider]?.label || key.provider}</span>
                                        </div>
                                        <div class="key-card-row">
                                            <span class="key-card-label">Model:</span>
                                            <span>${key.providerVersion || 'Default'}</span>
                                        </div>
                                        <div class="key-card-row">
                                            <span class="key-card-label">Created:</span>
                                            <span>${new Date(key.createdAt).toLocaleDateString()}</span>
                                        </div>
                                        <div class="key-card-row">
                                            <span class="key-card-label">API Key:</span>
                                            <span class="masked-key">${key.maskedKey || 'Hidden'}</span>
                                        </div>
                                        <div class="key-card-row">
                                            <span class="key-card-label">Proxy Key:</span>
                                            <span class="proxy-key">${key.proxyKey.substring(0, 20)}...</span>
                                        </div>
                                        ${key.lastUsed ? `
                                            <div class="key-card-row">
                                                <span class="key-card-label">Last Used:</span>
                                                <span>${new Date(key.lastUsed).toLocaleDateString()}</span>
                                            </div>
                                        ` : ''}
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    ` : `
                        <div class="card">
                            <div style="text-align: center; padding: 40px 20px;">
                                <h3>No Keys Configured</h3>
                                <p>Go to the <strong>Dashboard</strong> to add your first API key and start tracking usage.</p>
                                <button class="btn primary" onclick="switchTab('home')">Add First Key</button>
                            </div>
                        </div>
                    `}
                </div>
            </div>
        `;
    }

    private getSettingsContent(): string {
        const refreshInterval = this.configManager.get('refreshInterval');
        const showNotifications = this.configManager.get('showNotifications');
        const backendUrl = this.configManager.get('backendUrl');
        const environment = this.configManager.get('environment');

        return `
            <div class="app-container">
                <nav class="sidebar">
                    <div class="nav-item" onclick="switchTab('home')" title="Dashboard">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"/>
                        </svg>
                        <span class="nav-tooltip">Dashboard</span>
                    </div>
                    <div class="nav-item" onclick="switchTab('logs')" title="Logs">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M3 3a1 1 0 011-1h12a1 1 0 011 1v3a1 1 0 01-.293.707L12 11.414V15a1 1 0 01-.293.707l-2 2A1 1 0 018 17v-5.586L3.293 6.707A1 1 0 013 6V3z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Logs</span>
                    </div>
                    <div class="nav-item" onclick="switchTab('keys')" title="Keys">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Keys</span>
                    </div>
                    <div class="nav-item active" onclick="switchTab('settings')" title="Settings">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
                        </svg>
                        <span class="nav-tooltip">Settings</span>
                    </div>
                </nav>

                <div class="main-content">
                    <header class="content-header">
                        <div>
                            <h1>⚙️ Settings</h1>
                            <p class="subtitle">Configure your totoboX preferences</p>
                        </div>
                    </header>

                    <div class="card">
                        <h2>General Settings</h2>
                        <div class="form-group">
                            <label for="backendUrl">Backend URL</label>
                            <input type="text" id="backendUrl" value="${backendUrl}">
                        </div>
                        <div class="form-group">
                            <label for="environment">Environment</label>
                            <select id="environment">
                                <option value="development" ${environment === 'development' ? 'selected' : ''}>Development</option>
                                <option value="staging" ${environment === 'staging' ? 'selected' : ''}>Staging</option>
                                <option value="production" ${environment === 'production' ? 'selected' : ''}>Production</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label for="refreshInterval">Refresh Interval (seconds)</label>
                            <input type="number" id="refreshInterval" value="${refreshInterval}" min="10" max="300">
                        </div>
                        <div class="form-group">
                            <label>
                                <input type="checkbox" id="showNotifications" ${showNotifications ? 'checked' : ''}>
                                Show notifications
                            </label>
                        </div>
                        <button class="btn primary" onclick="saveSettings()">Save Settings</button>
                    </div>
                </div>
            </div>
        `;
    }

    private getStyles(): string {
        return `
            <style>
                :root {
                    --surface: var(--vscode-editor-background);
                    --surface2: var(--vscode-editor-inactiveSelectionBackground);
                    --text: var(--vscode-foreground);
                    --muted: var(--vscode-descriptionForeground);
                    --border: var(--vscode-panel-border);
                    --accent: #4a9eff;
                    --error: var(--vscode-errorForeground);
                    --success: #00d26a;
                    --warning: #f59e0b;
                    --input-blue: #4a9eff;
                    --output-orange: #ff8c42;
                }

                * {
                    box-sizing: border-box;
                    margin: 0;
                    padding: 0;
                }
                
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif;
                    font-size: 14px;
                    line-height: 1.5;
                    color: var(--vscode-foreground);
                    background: var(--vscode-editor-background);
                    padding: 0;
                    min-height: 100vh;
                    font-weight: 400;
                    -webkit-font-smoothing: antialiased;
                    text-rendering: optimizeLegibility;
                }
                
                .app-container {
                    display: flex;
                    min-height: 100vh;
                }

                .sidebar {
                    width: 60px;
                    background: var(--vscode-sideBar-background);
                    border-right: 1px solid var(--vscode-panel-border);
                    display: flex;
                    flex-direction: column;
                    padding: 12px 0;
                    gap: 4px;
                    position: fixed;
                    left: 0;
                    top: 0;
                    bottom: 0;
                    z-index: 100;
                }

                .nav-item {
                    width: 100%;
                    height: 48px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: var(--vscode-foreground);
                    opacity: 0.6;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    position: relative;
                    border-left: 2px solid transparent;
                }

                .nav-item:hover {
                    opacity: 1;
                    background: var(--vscode-list-hoverBackground);
                }

                .nav-item.active {
                    opacity: 1;
                    border-left-color: var(--vscode-focusBorder);
                    background: var(--vscode-list-activeSelectionBackground);
                }

                .nav-item svg {
                    width: 20px;
                    height: 20px;
                }

                .nav-tooltip {
                    position: absolute;
                    left: 65px;
                    background: var(--vscode-editorHoverWidget-background);
                    color: var(--vscode-editorHoverWidget-foreground);
                    border: 1px solid var(--vscode-editorHoverWidget-border);
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 12px;
                    white-space: nowrap;
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.2s ease;
                    z-index: 1000;
                }

                .nav-item:hover .nav-tooltip {
                    opacity: 1;
                }

                .main-content {
                    flex: 1;
                    margin-left: 60px;
                    padding: 32px;
                    max-width: 1600px;
                    width: 100%;
                }

                .content-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 32px;
                    padding-bottom: 16px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }

                .content-header h1 {
                    font-size: 32px;
                    font-weight: 700;
                    margin: 0;
                    color: var(--vscode-foreground);
                    letter-spacing: -0.5px;
                }

                .subtitle {
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                    margin: 4px 0 0 0;
                }

                /* 6 CARD GRID - NEW! */
                .stats-grid-6 {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
                    gap: 20px;
                    margin-bottom: 32px;
                }
                
                .stat-card {
                    background: linear-gradient(135deg, var(--vscode-editor-inactiveSelectionBackground) 0%, var(--vscode-editor-background) 100%);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 16px;
                    padding: 24px;
                    display: flex;
                    align-items: center;
                    gap: 16px;
                    position: relative;
                    overflow: hidden;
                    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    cursor: default;
                }
                
                .stat-card:hover {
                    transform: translateY(-4px);
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
                    border-color: var(--vscode-focusBorder);
                }

                .stat-card::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 4px;
                    background: linear-gradient(90deg, var(--accent) 0%, var(--success) 100%);
                    opacity: 0;
                    transition: opacity 0.3s ease;
                }

                .stat-card:hover::before {
                    opacity: 1;
                }

                /* Specific card colors */
                .cost-card .stat-icon { background: linear-gradient(135deg, #10b981 0%, #059669 100%); }
                .input-card .stat-icon { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); }
                .output-card .stat-icon { background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); }
                .total-card .stat-icon { background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%); }
                .calls-card .stat-icon { background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); }
                .keys-card .stat-icon { background: linear-gradient(135deg, #06b6d4 0%, #0891b2 100%); }

                .stat-icon {
                    width: 56px;
                    height: 56px;
                    border-radius: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 24px;
                    flex-shrink: 0;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
                }

                .stat-content {
                    flex: 1;
                    min-width: 0;
                }
                
                .stat-card h3 {
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 8px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                
                .stat-value {
                    font-size: 28px;
                    font-weight: 800;
                    color: var(--vscode-foreground);
                    letter-spacing: -0.5px;
                    line-height: 1;
                    margin-bottom: 4px;
                }

                .stat-change {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    opacity: 0.8;
                }
                
                .card {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 16px;
                    padding: 32px;
                    margin-bottom: 24px;
                    transition: all 0.3s ease;
                }
                
                .card:hover {
                    border-color: var(--vscode-focusBorder);
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
                }

                .card-header {
                    margin-bottom: 24px;
                    padding-bottom: 16px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                
                .card h2 {
                    font-size: 22px;
                    font-weight: 700;
                    color: var(--vscode-foreground);
                    margin-bottom: 6px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                
                .card p {
                    color: var(--vscode-descriptionForeground);
                    font-size: 14px;
                    line-height: 1.6;
                    margin: 0;
                }

                .form-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
                    gap: 20px;
                    margin-bottom: 20px;
                }
                
                .form-group {
                    margin-bottom: 20px;
                }
                
                .form-group label {
                    display: block;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                    margin-bottom: 8px;
                    font-size: 13px;
                }
                
                .form-group input,
                .form-group select,
                .form-group textarea {
                    width: 100%;
                    padding: 12px 16px;
                    border: 2px solid var(--vscode-input-border);
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border-radius: 10px;
                    font-size: 14px;
                    font-family: inherit;
                    transition: all 0.2s ease;
                }
                
                .form-group input:focus,
                .form-group select:focus,
                .form-group textarea:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                    box-shadow: 0 0 0 3px var(--vscode-focusBorder)33;
                }
                
                .button-group {
                    display: flex;
                    gap: 12px;
                    margin-top: 24px;
                    flex-wrap: wrap;
                }
                
                .btn {
                    padding: 12px 24px;
                    border: none;
                    border-radius: 10px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                    display: inline-flex;
                    align-items: center;
                    gap: 8px;
                    min-height: 44px;
                    font-family: inherit;
                }

                .btn.large {
                    padding: 16px 32px;
                    font-size: 15px;
                    min-height: 52px;
                }
                
                .btn.primary {
                    background: linear-gradient(135deg, var(--vscode-button-background) 0%, #3b82f6 100%);
                    color: var(--vscode-button-foreground);
                    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
                }
                
                .btn.primary:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 20px rgba(59, 130, 246, 0.4);
                }
                
                .btn.primary:active {
                    transform: translateY(0);
                }
                
                .btn.secondary {
                    background: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                    border: 1px solid var(--vscode-panel-border);
                }
                
                .btn.secondary:hover {
                    background: var(--vscode-button-secondaryHoverBackground);
                    border-color: var(--vscode-focusBorder);
                }
                
                .btn.small {
                    padding: 8px 16px;
                    font-size: 12px;
                    min-height: 36px;
                }
                
                .btn.danger {
                    background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
                    color: white;
                }
                
                .btn.danger:hover {
                    box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);
                }

                .btn-icon {
                    background: none;
                    border: 1px solid transparent;
                    padding: 8px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 16px;
                    transition: all 0.2s;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                }

                .btn-icon:hover {
                    background: var(--vscode-list-hoverBackground);
                    border-color: var(--vscode-panel-border);
                }
                
                /* CHARTS */
                .chart-section {
                    margin: 32px 0;
                    background: var(--vscode-editor-background);
                    border-radius: 16px;
                    padding: 28px;
                    border: 1px solid var(--vscode-panel-border);
                    transition: all 0.3s ease;
                }

                .chart-section:hover {
                    border-color: var(--vscode-focusBorder);
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
                }

                .chart-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 20px;
                }

                .chart-section h3 {
                    font-size: 18px;
                    font-weight: 700;
                    color: var(--vscode-foreground);
                    margin: 0;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .chart-badge {
                    font-size: 11px;
                    font-weight: 600;
                    padding: 6px 12px;
                    border-radius: 20px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .input-badge {
                    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
                    color: white;
                }

                .output-badge {
                    background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
                    color: white;
                }

                .calls-badge {
                    background: linear-gradient(135deg, #ec4899 0%, #db2777 100%);
                    color: white;
                }

                .cost-badge {
                    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                    color: white;
                }

                .cost-toggle {
                    display: flex;
                    gap: 8px;
                    margin-bottom: 20px;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    padding: 4px;
                    border-radius: 10px;
                    width: fit-content;
                }

                .toggle-btn {
                    padding: 8px 16px;
                    border: none;
                    background: transparent;
                    color: var(--vscode-foreground);
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 600;
                    transition: all 0.2s ease;
                    font-family: inherit;
                }

                .toggle-btn:hover {
                    background: var(--vscode-list-hoverBackground);
                }

                .toggle-btn.active {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                
                .chart-legend {
                    display: flex;
                    gap: 16px;
                    margin-bottom: 24px;
                    flex-wrap: wrap;
                }
                
                .legend-item {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    cursor: pointer;
                    padding: 8px 14px;
                    border-radius: 8px;
                    transition: all 0.2s ease;
                    opacity: 0.6;
                    border: 1px solid transparent;
                    font-size: 13px;
                }
                
                .legend-item.selected {
                    opacity: 1;
                    background: var(--vscode-list-hoverBackground);
                    border-color: var(--vscode-focusBorder);
                }
                
                .legend-item:hover {
                    opacity: 1;
                    background: var(--vscode-list-hoverBackground);
                }
                
                .legend-color {
                    width: 16px;
                    height: 16px;
                    border-radius: 4px;
                    flex-shrink: 0;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                }
                
                canvas {
                    max-width: 100%;
                    height: 300px !important;
                    border-radius: 12px;
                    margin: 0 auto;
                    display: block;
                }

                .key-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 20px 0;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                
                .key-item:last-child {
                    border-bottom: none;
                }
                
                .key-info strong {
                    font-weight: 600;
                    color: var(--vscode-foreground);
                    font-size: 15px;
                }
                
                .key-meta {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    margin-top: 6px;
                    line-height: 1.5;
                }
                
                .key-actions {
                    display: flex;
                    gap: 8px;
                    flex-shrink: 0;
                }
                
                .badge {
                    font-size: 11px;
                    font-weight: 600;
                    padding: 5px 10px;
                    border-radius: 6px;
                    display: inline-block;
                    margin-left: 8px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                
                .badge.primary {
                    background: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                
                .badge.warning {
                    background: #f59e0b;
                    color: white;
                }
                
                .badge.error {
                    background: #dc2626;
                    color: white;
                }
                
                .log-entry {
                    padding: 14px 0;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
                    font-size: 13px;
                    color: var(--vscode-foreground);
                    line-height: 1.6;
                }

                .keys-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
                    gap: 20px;
                }

                .key-card {
                    background: var(--surface2);
                    border: 1px solid var(--border);
                    border-radius: 16px;
                    padding: 24px;
                    transition: all 0.3s ease;
                }

                .key-card:hover {
                    border-color: var(--accent);
                    box-shadow: 0 6px 20px rgba(74, 158, 255, 0.15);
                    transform: translateY(-2px);
                }

                .key-card.active {
                    border-color: var(--accent);
                    background: rgba(74, 158, 255, 0.05);
                }

                .key-card-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: 20px;
                    padding-bottom: 16px;
                    border-bottom: 1px solid var(--border);
                }

                .key-card-title {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }

                .key-card-name {
                    font-size: 17px;
                    font-weight: 700;
                    color: var(--text);
                }
                
                .key-card-name-input {
                    font-size: 16px;
                    font-weight: 600;
                    color: var(--text);
                    background: var(--vscode-input-background);
                    border: 1px solid var(--vscode-focusBorder);
                    padding: 6px 10px;
                    border-radius: 6px;
                    outline: none;
                    width: 220px;
                }

                .key-card-name-input:focus {
                    border-color: var(--vscode-focusBorder);
                    box-shadow: 0 0 0 2px var(--vscode-focusBorder)33;
                }

                .key-card-actions {
                    display: flex;
                    gap: 6px;
                }

                .key-card-info {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }

                .key-card-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    font-size: 13px;
                }

                .key-card-label {
                    color: var(--muted);
                    font-weight: 600;
                }

                .masked-key {
                    font-family: 'Monaco', 'Menlo', monospace;
                    font-size: 12px;
                    color: var(--text);
                    background: var(--surface);
                    padding: 4px 8px;
                    border-radius: 6px;
                }

                .proxy-key {
                    font-family: 'Monaco', 'Menlo', monospace;
                    font-size: 11px;
                    color: var(--accent);
                    background: var(--surface);
                    padding: 4px 8px;
                    border-radius: 6px;
                }

                .btn-icon-danger {
                    color: var(--error);
                }

                .btn-icon-danger:hover {
                    border-color: var(--error);
                    background: rgba(248, 81, 73, 0.1);
                }
                
                /* Responsive Design */
                @media (max-width: 1200px) {
                    .stats-grid-6 {
                        grid-template-columns: repeat(3, 1fr);
                    }
                }

                @media (max-width: 768px) {
                    .main-content {
                        padding: 20px;
                    }

                    .stats-grid-6 {
                        grid-template-columns: repeat(2, 1fr);
                    }
                    
                    .content-header {
                        flex-direction: column;
                        gap: 16px;
                    }
                    
                    .button-group {
                        flex-direction: column;
                    }
                    
                    .chart-legend {
                        justify-content: center;
                    }

                    .keys-grid {
                        grid-template-columns: 1fr;
                    }
                }

                @media (max-width: 480px) {
                    .stats-grid-6 {
                        grid-template-columns: 1fr;
                    }
                }
                
                /* Custom scrollbar */
                ::-webkit-scrollbar {
                    width: 10px;
                    height: 10px;
                }
                
                ::-webkit-scrollbar-track {
                    background: var(--vscode-scrollbar-shadow);
                    border-radius: 5px;
                }
                
                ::-webkit-scrollbar-thumb {
                    background: var(--vscode-scrollbarSlider-background);
                    border-radius: 5px;
                }
                
                ::-webkit-scrollbar-thumb:hover {
                    background: var(--vscode-scrollbarSlider-hoverBackground);
                }

                /* TIME WINDOW SELECTOR */
                .time-window-selector {
                    background: var(--vscode-editor-inactiveSelectionBackground);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 12px;
                    padding: 20px 24px;
                    margin-bottom: 32px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-wrap: wrap;
                    gap: 16px;
                }

                .time-window-label {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--vscode-foreground);
                }

                .data-insight {
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    background: var(--vscode-editor-background);
                    padding: 4px 10px;
                    border-radius: 6px;
                    font-weight: 500;
                }

                .time-window-buttons {
                    display: flex;
                    gap: 8px;
                    background: var(--vscode-editor-background);
                    padding: 4px;
                    border-radius: 10px;
                }

                .time-btn {
                    padding: 10px 20px;
                    border: none;
                    background: transparent;
                    color: var(--vscode-foreground);
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 13px;
                    font-weight: 600;
                    transition: all 0.2s ease;
                    font-family: inherit;
                    white-space: nowrap;
                }

                .time-btn:hover:not(:disabled) {
                    background: var(--vscode-list-hoverBackground);
                    transform: translateY(-1px);
                }

                .time-btn.active {
                    background: linear-gradient(135deg, var(--vscode-button-background) 0%, #3b82f6 100%);
                    color: var(--vscode-button-foreground);
                    box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
                }

                .time-btn:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                }

                @media (max-width: 768px) {
                    .time-window-selector {
                        flex-direction: column;
                        align-items: stretch;
                    }
                    
                    .time-window-buttons {
                        justify-content: center;
                    }
                    
                    .time-btn {
                        flex: 1;
                        padding: 12px 16px;
                    }
                }

                .logs-card {
                    padding: 0 !important;
                    overflow: hidden;
                }

                .logs-controls {
                    padding: 24px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 20px;
                    flex-wrap: wrap;
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }

                .filters-container {
                    display: flex;
                    gap: 12px;
                    flex-wrap: wrap;
                    align-items: center;
                }

                .filter-select,
                .filter-input {
                    padding: 8px 12px;
                    border: 1px solid var(--vscode-input-border);
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border-radius: 8px;
                    font-size: 13px;
                    font-family: inherit;
                    min-width: 150px;
                }

                .filter-select:focus,
                .filter-input:focus {
                    outline: none;
                    border-color: var(--vscode-focusBorder);
                }

                .logs-stats {
                    font-size: 13px;
                    color: var(--vscode-descriptionForeground);
                    font-weight: 600;
                }

                .logs-table-container {
                    overflow-x: auto;
                    max-height: 600px;
                    overflow-y: auto;
                }

                .logs-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 13px;
                }

                .logs-table thead {
                    position: sticky;
                    top: 0;
                    background: var(--vscode-editor-background);
                    z-index: 10;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
                }

                .logs-table th {
                    padding: 16px 12px;
                    text-align: left;
                    font-weight: 700;
                    color: var(--vscode-foreground);
                    border-bottom: 2px solid var(--vscode-panel-border);
                    text-transform: uppercase;
                    font-size: 11px;
                    letter-spacing: 0.5px;
                    white-space: nowrap;
                }

                .logs-table th.col-number {
                    text-align: right;
                }

                .logs-table tbody tr {
                    border-bottom: 1px solid var(--vscode-panel-border);
                    transition: background 0.2s ease;
                }

                .logs-table tbody tr:hover {
                    background: var(--vscode-list-hoverBackground);
                }

                .logs-table td {
                    padding: 14px 12px;
                    color: var(--vscode-foreground);
                    vertical-align: middle;
                }

                .logs-table td.col-number {
                    text-align: right;
                }

                /* Column Specific Styles */
                .col-id {
                    width: 60px;
                }

                .col-timestamp {
                    width: 140px;
                }

                .col-provider {
                    width: 100px;
                }

                .col-model {
                    width: 140px;
                }

                .col-endpoint {
                    min-width: 180px;
                }

                .col-number {
                    width: 90px;
                }

                .log-id {0
                    font-family: 'Monaco', 'Menlo', monospace;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                    font-weight: 600;
                }

                .timestamp-wrapper {
                    display: flex;
                    flex-direction: column;
                    gap: 2px;
                }

                .timestamp-time {
                    font-weight: 600;
                    color: var(--vscode-foreground);
                    font-size: 13px;
                }

                .timestamp-date {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                }

                .provider-badge {
                    display: inline-block;
                    padding: 4px 10px;
                    border-radius: 6px;
                    font-size: 11px;
                    font-weight: 700;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }

                .badge-openai {
                    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                    color: white;
                }

                .badge-anthropic {
                    background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
                    color: white;
                }

                .badge-gemini {
                    background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
                    color: white;
                }

                .badge-default {
                    background: var(--vscode-badge-background);
                    color: var(--vscode-badge-foreground);
                }

                .model-name {
                    font-family: 'Monaco', 'Menlo', monospace;
                    font-size: 12px;
                    color: var(--vscode-textLink-foreground);
                }

                .endpoint-code {
                    font-family: 'Monaco', 'Menlo', monospace;
                    font-size: 11px;
                    background: var(--vscode-textCodeBlock-background);
                    padding: 4px 8px;
                    border-radius: 4px;
                    color: var(--vscode-foreground);
                }

                .token-value {
                    font-weight: 600;
                    font-family: 'SF Mono', monospace;
                }

                .token-input {
                    color: #3b82f6;
                }

                .token-output {
                    color: #f59e0b;
                }

                .token-total {
                    color: var(--vscode-foreground);
                    font-size: 14px;
                }

                .ratio-badge {
                    display: inline-block;
                    padding: 4px 8px;
                    border-radius: 6px;
                    font-size: 11px;
                    font-weight: 700;
                    font-family: 'SF Mono', monospace;
                }

                .ratio-efficient {
                    background: rgba(16, 185, 129, 0.2);
                    color: #10b981;
                }

                .ratio-normal {
                    background: rgba(245, 158, 11, 0.2);
                    color: #f59e0b;
                }

                .ratio-high {
                    background: rgba(239, 68, 68, 0.2);
                    color: #ef4444;
                }

                .cost-value {
                    font-family: 'SF Mono', monospace;
                    font-weight: 600;
                    color: #10b981;
                }

                .latency-value {
                    font-family: 'SF Mono', monospace;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }

                .logs-footer {
                    padding: 24px;
                    border-top: 1px solid var(--vscode-panel-border);
                    background: var(--vscode-editor-inactiveSelectionBackground);
                }

                .logs-summary {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                }

                .summary-stat {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                }

                .summary-label {
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    font-weight: 600;
                }

                .summary-value {
                    font-size: 20px;
                    font-weight: 700;
                    color: var(--vscode-foreground);
                }

                .empty-state {
                    padding: 80px 40px;
                    text-align: center;
                }

                .empty-icon {
                    font-size: 64px;
                    margin-bottom: 20px;
                    opacity: 0.3;
                }

                .empty-state h3 {
                    font-size: 22px;
                    font-weight: 700;
                    color: var(--vscode-foreground);
                    margin-bottom: 12px;
                }

                .empty-state p {
                    font-size: 14px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 24px;
                }

                /* Responsive */
                @media (max-width: 1200px) {
                    .logs-table-container {
                        font-size: 12px;
                    }
                    
                    .logs-table th,
                    .logs-table td {
                        padding: 12px 8px;
                    }
                }

                @media (max-width: 768px) {
                    .logs-controls {
                        flex-direction: column;
                        align-items: stretch;
                    }
                    
                    .filters-container {
                        flex-direction: column;
                    }
                    
                    .filter-select,
                    .filter-input {
                        width: 100%;
                    }
                }

            </style>
        `;
    }

    private getJavaScript(nonce: string, chartDataSets: ChartData[]): string {
        const chartDataString = JSON.stringify(chartDataSets);
        const selectedKeysObj = {
            input: Array.from(this.selectedKeys.get('input') || []),
            output: Array.from(this.selectedKeys.get('output') || []),
            calls: Array.from(this.selectedKeys.get('calls') || []),
            cost: Array.from(this.selectedKeys.get('cost') || [])
        };
        const selectedKeysString = JSON.stringify(selectedKeysObj);
        const providersString = JSON.stringify(PROVIDERS);

        return `
            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
                const chartDataSets = ${chartDataString};
                const selectedKeys = ${selectedKeysString};
                const providers = ${providersString};
                let currentCostView = 'total'; // 'total', 'input', or 'output'

                // Custom line chart drawing
                function drawLineChart(canvasId, data, labels, color, clearCanvas = true) {
                    const canvas = document.getElementById(canvasId);
                    if (!canvas) return;

                    const ctx = canvas.getContext('2d');
                    if (!ctx) return;

                    const width = canvas.width;
                    const height = canvas.height;
                    const padding = 50;

                    if (clearCanvas) {
                        ctx.clearRect(0, 0, width, height);
                        
                        // Draw axes
                        ctx.strokeStyle = '#444';
                        ctx.lineWidth = 1;
                        ctx.beginPath();
                        ctx.moveTo(padding, padding);
                        ctx.lineTo(padding, height - padding);
                        ctx.lineTo(width - padding, height - padding);
                        ctx.stroke();
                    }

                    const chartWidth = width - 2 * padding;
                    const chartHeight = height - 2 * padding;
                    
                    const maxValue = Math.max(...data, 1);
                    const minValue = 0;
                    const valueRange = maxValue - minValue;

                    // Draw line
                    ctx.strokeStyle = color;
                    ctx.lineWidth = 3;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.beginPath();

                    const points = [];
                    
                    data.forEach((value, index) => {
                        const x = padding + (index / (data.length - 1)) * chartWidth;
                        const y = height - padding - ((value - minValue) / valueRange) * chartHeight;
                        points.push([x, y]);

                        if (index === 0) {
                            ctx.moveTo(x, y);
                        } else {
                            ctx.lineTo(x, y);
                        }
                    });

                    ctx.stroke();

                    // Fill area under line
                    ctx.fillStyle = color + '20';
                    ctx.beginPath();
                    ctx.moveTo(points[0][0], height - padding);
                    points.forEach(([x, y]) => ctx.lineTo(x, y));
                    ctx.lineTo(points[points.length - 1][0], height - padding);
                    ctx.closePath();
                    ctx.fill();

                    // Draw points
                    ctx.fillStyle = color;
                    points.forEach(([x, y]) => {
                        ctx.beginPath();
                        ctx.arc(x, y, 5, 0, 2 * Math.PI);
                        ctx.fill();
                    });

                    // Draw labels only on first call
                    if (clearCanvas) {
                        ctx.fillStyle = '#888';
                        ctx.font = '12px -apple-system, sans-serif';
                        ctx.textAlign = 'center';
                        
                        labels.forEach((label, index) => {
                            const x = padding + (index / (labels.length - 1)) * chartWidth;
                            ctx.fillText(label, x, height - padding + 25);
                        });

                        // Draw Y-axis labels
                        ctx.textAlign = 'right';
                        const steps = 5;
                        for (let i = 0; i <= steps; i++) {
                            const value = Math.round((maxValue / steps) * i);
                            const y = height - padding - (chartHeight / steps) * i;
                            ctx.fillText(value.toLocaleString(), padding - 10, y + 4);
                        }
                    }
                }

                // Bar chart for API calls
                function drawBarChart(canvasId, datasets) {
                    const canvas = document.getElementById(canvasId);
                    if (!canvas) return;

                    const ctx = canvas.getContext('2d');
                    if (!ctx) return;

                    const width = canvas.width;
                    const height = canvas.height;
                    const padding = 50;
                    
                    ctx.clearRect(0, 0, width, height);

                    const labels = datasets[0]?.data.labels || [];
                    if (labels.length === 0) return;

                    let maxValue = 0;
                    datasets.forEach(dataset => {
                        const max = Math.max(...dataset.data.calls);
                        if (max > maxValue) maxValue = max;
                    });

                    if (maxValue === 0) maxValue = 1;

                    const chartWidth = width - 2 * padding;
                    const chartHeight = height - 2 * padding;

                    // Draw axes
                    ctx.strokeStyle = '#444';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(padding, padding);
                    ctx.lineTo(padding, height - padding);
                    ctx.lineTo(width - padding, height - padding);
                    ctx.stroke();

                    const numDatasets = datasets.length;
                    const numBars = labels.length;
                    const groupWidth = chartWidth / numBars;
                    const barWidth = (groupWidth / (numDatasets + 1)) * 0.8;

                    // Draw bars
                    datasets.forEach((dataset, datasetIndex) => {
                        const gradient = ctx.createLinearGradient(0, height - padding, 0, padding);
                        gradient.addColorStop(0, dataset.color);
                        gradient.addColorStop(1, dataset.color + 'CC');
                        ctx.fillStyle = gradient;
                        
                        dataset.data.calls.forEach((value, index) => {
                            const barHeight = (value / maxValue) * chartHeight;
                            const x = padding + (index * groupWidth) + (datasetIndex * barWidth) + (barWidth * 0.2);
                            const y = height - padding - barHeight;
                            
                            ctx.fillRect(x, y, barWidth, barHeight);
                            
                            // Value on top
                            if (value > 0) {
                                ctx.fillStyle = '#fff';
                                ctx.font = '11px -apple-system, sans-serif';
                                ctx.textAlign = 'center';
                                ctx.fillText(value.toString(), x + (barWidth / 2), y - 5);
                                ctx.fillStyle = gradient;
                            }
                        });
                    });

                    // Draw labels
                    ctx.fillStyle = '#888';
                    ctx.font = '12px -apple-system, sans-serif';
                    ctx.textAlign = 'center';
                    
                    labels.forEach((label, index) => {
                        const x = padding + (index * groupWidth) + (groupWidth / 2);
                        ctx.fillText(label, x, height - padding + 25);
                    });

                    // Y-axis labels
                    ctx.textAlign = 'right';
                    const steps = 5;
                    for (let i = 0; i <= steps; i++) {
                        const value = Math.round((maxValue / steps) * i);
                        const y = height - padding - (chartHeight / steps) * i;
                        ctx.fillText(value.toString(), padding - 10, y + 4);
                    }
                }

                // Doughnut chart for cost
                function drawDoughnutChart(canvasId, datasets, viewType = 'total') {
                    const canvas = document.getElementById(canvasId);
                    if (!canvas) return;

                    const ctx = canvas.getContext('2d');
                    if (!ctx) return;

                    const width = canvas.width;
                    const height = canvas.height;
                    
                    ctx.clearRect(0, 0, width, height);

                    let totalValue = 0;
                    const dataPoints = [];
                    
                    datasets.forEach(dataset => {
                        let sum = 0;
                        
                        if (viewType === 'total') {
                            sum = dataset.data.costs.reduce((a, b) => a + b, 0);
                        } else if (viewType === 'input') {
                            // Calculate input cost (assuming 40% of total for demo)
                            sum = dataset.data.costs.reduce((a, b) => a + b, 0) * 0.4;
                        } else if (viewType === 'output') {
                            // Calculate output cost (assuming 60% of total for demo)
                            sum = dataset.data.costs.reduce((a, b) => a + b, 0) * 0.6;
                        }
                        
                        if (sum > 0) {
                            dataPoints.push({
                                label: dataset.keyName,
                                value: sum,
                                color: dataset.color
                            });
                            totalValue += sum;
                        }
                    });

                    if (totalValue === 0 || dataPoints.length === 0) {
                        ctx.fillStyle = '#888';
                        ctx.font = '16px -apple-system, sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillText('No cost data available', width / 2, height / 2);
                        return;
                    }

                    const centerX = width / 2;
                    const centerY = height / 2 - 20;
                    const radius = Math.min(width, height) / 3.5;
                    const innerRadius = radius * 0.6;

                    let currentAngle = -Math.PI / 2;

                    dataPoints.forEach(point => {
                        const sliceAngle = (point.value / totalValue) * 2 * Math.PI;
                        
                        ctx.beginPath();
                        ctx.arc(centerX, centerY, radius, currentAngle, currentAngle + sliceAngle);
                        ctx.arc(centerX, centerY, innerRadius, currentAngle + sliceAngle, currentAngle, true);
                        ctx.closePath();
                        
                        const gradient = ctx.createRadialGradient(centerX, centerY, innerRadius, centerX, centerY, radius);
                        gradient.addColorStop(0, point.color);
                        gradient.addColorStop(1, point.color + 'DD');
                        ctx.fillStyle = gradient;
                        ctx.fill();
                        
                        currentAngle += sliceAngle;
                    });

                    // Center circle
                    ctx.beginPath();
                    ctx.arc(centerX, centerY, innerRadius, 0, 2 * Math.PI);
                    ctx.fillStyle = '#1a1a1a';
                    ctx.fill();

                    // Total in center
                    ctx.fillStyle = '#fff';
                    ctx.font = 'bold 28px -apple-system, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('$' + totalValue.toFixed(3), centerX, centerY - 12);
                    
                    ctx.font = '13px -apple-system, sans-serif';
                    ctx.fillStyle = '#888';
                    const viewLabel = viewType === 'total' ? 'Total Cost' : viewType === 'input' ? 'Input Cost' : 'Output Cost';
                    ctx.fillText(viewLabel, centerX, centerY + 18);

                    // Legend
                    const legendY = centerY + radius + 50;
                    const legendItemWidth = 160;
                    const startX = centerX - (dataPoints.length * legendItemWidth) / 2;

                    dataPoints.forEach((point, index) => {
                        const x = startX + index * legendItemWidth;
                        
                        ctx.fillStyle = point.color;
                        ctx.fillRect(x, legendY, 14, 14);
                        
                        ctx.fillStyle = '#fff';
                        ctx.font = '13px -apple-system, sans-serif';
                        ctx.textAlign = 'left';
                        ctx.fillText(point.label, x + 20, legendY + 11);
                        
                        ctx.fillStyle = '#888';
                        ctx.font = '12px -apple-system, sans-serif';
                        ctx.fillText('$' + point.value.toFixed(3), x + 20, legendY + 28);
                    });
                }

                function initializeCharts() {
                    initChart('inputTokenChart', 'inputTokens', 'input');
                    initChart('outputTokenChart', 'outputTokens', 'output');
                    initChart('callsChart', 'calls', 'calls');
                    initChart('costChart', 'costs', 'cost');
                }

                function changeTimeWindow(window) {
                    console.log('Time window changed to:', window);
                    vscode.postMessage({ command: 'changeTimeWindow', timeWindow: window });
                }

                function initChart(canvasId, dataKey, selectionKey) {
                    const selected = selectedKeys[selectionKey] || [];
                    const datasets = selected.length > 0 
                        ? chartDataSets.filter(dataset => selected.includes(dataset.keyId))
                        : chartDataSets;
                    
                    if (datasets.length === 0) return;
                    
                    if (canvasId === 'costChart') {
                        drawDoughnutChart(canvasId, datasets, currentCostView);
                    } else if (canvasId === 'callsChart') {
                        drawBarChart(canvasId, datasets);
                    } else {
                        datasets.forEach((dataset, index) => {
                            drawLineChart(canvasId, dataset.data[dataKey], dataset.data.labels, dataset.color, index === 0);
                        });
                    }
                }

                function toggleCostView(view) {
                    currentCostView = view;
                    
                    // Update button states
                    document.getElementById('totalCostBtn').classList.remove('active');
                    document.getElementById('inputCostBtn').classList.remove('active');
                    document.getElementById('outputCostBtn').classList.remove('active');
                    document.getElementById(view + 'CostBtn').classList.add('active');
                    
                    // Redraw cost chart
                    initChart('costChart', 'costs', 'cost');
                }

                // Initialize charts with longer delay for reliability
                setTimeout(() => {
                    console.log('🎨 Starting chart initialization...');
                    const canvases = {
                        input: document.getElementById('inputTokenChart'),
                        output: document.getElementById('outputTokenChart'),
                        calls: document.getElementById('callsChart'),
                        cost: document.getElementById('costChart')
                    };
                    
                    console.log('📊 Canvas elements found:', {
                        input: !!canvases.input,
                        output: !!canvases.output,
                        calls: !!canvases.calls,
                        cost: !!canvases.cost
                    });
                    
                    if (canvases.input && canvases.output && canvases.calls && canvases.cost) {
                        initializeCharts();
                        console.log('✅ Charts initialized successfully');
                    } else {
                        console.error('❌ Some canvas elements not found');
                    }
                }, 500);

                function switchTab(tab) {
                    vscode.postMessage({ command: 'switchTab', tab: tab });
                }

                function updateVersions() {
                    const provider = document.getElementById('provider').value;
                    const versionSelect = document.getElementById('providerVersion');
                    versionSelect.innerHTML = '';
                    
                    providers[provider].versions.forEach(version => {
                        const option = document.createElement('option');
                        option.value = version;
                        option.textContent = version;
                        versionSelect.appendChild(option);
                    });
                }

                function generateProxy() {
                    const provider = document.getElementById('provider').value;
                    const providerVersion = document.getElementById('providerVersion').value;
                    const apiKey = document.getElementById('apiKey').value;

                    if (!provider || !apiKey) {
                        alert('Please fill in all required fields');
                        return;
                    }

                    vscode.postMessage({
                        command: 'generateProxy',
                        data: { provider, providerVersion, apiKey }
                    });
                }

                function refreshData() {
                    vscode.postMessage({ command: 'refreshData' });
                }

                function switchKey(keyId) {
                    vscode.postMessage({ command: 'switchKey', keyId: keyId });
                }

                function removeKey(keyId) {
                    vscode.postMessage({ command: 'removeKey', keyId: keyId });
                }
                
                function showRenameInput(keyId, currentName) {
                    const nameSpan = document.getElementById('keyName_' + keyId);
                    const nameInput = document.getElementById('keyInput_' + keyId);
                    
                    if (nameSpan && nameInput) {
                        nameSpan.style.display = 'none';
                        nameInput.style.display = 'inline-block';
                        nameInput.value = currentName;
                        nameInput.focus();
                        nameInput.select();
                    }
                }

                function cancelRename(keyId, originalName) {
                    setTimeout(() => {
                        const nameSpan = document.getElementById('keyName_' + keyId);
                        const nameInput = document.getElementById('keyInput_' + keyId);
                        
                        if (nameSpan && nameInput) {
                            nameInput.style.display = 'none';
                            nameSpan.style.display = 'inline';
                        }
                    }, 200);
                }

                function handleRenameKeyPress(event, keyId) {
                    if (event.key === 'Enter') {
                        const nameInput = document.getElementById('keyInput_' + keyId);
                        const newName = nameInput.value.trim();
                        
                        if (newName) {
                            vscode.postMessage({ 
                                command: 'renameKey', 
                                keyId: keyId, 
                                newName: newName 
                            });
                        }
                    } else if (event.key === 'Escape') {
                        const nameSpan = document.getElementById('keyName_' + keyId);
                        const nameInput = document.getElementById('keyInput_' + keyId);
                        
                        nameInput.style.display = 'none';
                        nameSpan.style.display = 'inline';
                    }
                }

                function copyProxy(proxyKey) {
                    navigator.clipboard.writeText(proxyKey);
                    vscode.postMessage({ command: 'copyProxy', proxyKey: proxyKey });
                }

                function saveSettings() {
                    const backendUrl = document.getElementById('backendUrl').value;
                    const environment = document.getElementById('environment').value;
                    const refreshInterval = document.getElementById('refreshInterval').value;
                    const notifications = document.getElementById('showNotifications').checked;

                    vscode.postMessage({
                        command: 'saveSettings',
                        data: { backendUrl, environment, refreshInterval, notifications }
                    });
                }

                function toggleKeySelection(keyId, chartType) {
                    vscode.postMessage({ command: 'toggleKeySelection', keyId: keyId, chartType: chartType });
                }

                function exportCSV() {
                    vscode.postMessage({ command: 'exportCSV' });
                }

                // Logs filtering
                let allLogs = [];

                function initializeLogs() {
                    const tbody = document.getElementById('logsTableBody');
                    if (tbody) {
                        const rows = tbody.querySelectorAll('.log-row');
                        allLogs = Array.from(rows);
                    }
                }

                function applyFilters() {
                    const providerFilter = document.getElementById('providerFilter').value.toLowerCase();
                    const modelFilter = document.getElementById('modelFilter').value.toLowerCase();
                    const dateFilter = document.getElementById('dateFilter').value;
                    
                    let visibleCount = 0;
                    
                    allLogs.forEach(row => {
                        const provider = row.dataset.provider.toLowerCase();
                        const model = row.dataset.model.toLowerCase();
                        const date = row.dataset.date;
                        
                        const providerMatch = !providerFilter || provider === providerFilter;
                        const modelMatch = !modelFilter || model.includes(modelFilter);
                        const dateMatch = !dateFilter || date.includes(dateFilter);
                        
                        if (providerMatch && modelMatch && dateMatch) {
                            row.style.display = '';
                            visibleCount++;
                        } else {
                            row.style.display = 'none';
                        }
                    });
                    
                    const logsCount = document.getElementById('logsCount');
                    if (logsCount) {
                        logsCount.textContent = \`Showing \${visibleCount} of \${allLogs.length} logs\`;
                    }
                }

                function clearFilters() {
                    document.getElementById('providerFilter').value = '';
                    document.getElementById('modelFilter').value = '';
                    document.getElementById('dateFilter').value = '';
                    applyFilters();
                }

                // Initialize logs on page load
                setTimeout(initializeLogs, 100);

            </script>
        `;
    }

    // FIXED: Updated handleGenerateProxy method with correct URL

    private async handleGenerateProxy(data: any): Promise<void> {
        const provider = data?.provider;
        const providerVersion = data?.providerVersion;
        const apiKey = data?.apiKey;

        if (!provider || !apiKey) {
            vscode.window.showErrorMessage('Provider and API key are required');
            return;
        }

        // Validate API key format
        const validation = this.cryptoUtils.validateApiKey(apiKey, provider);
        if (!validation.valid) {
            vscode.window.showErrorMessage(validation.error || 'Invalid API key');
            return;
        }

        try {
            const keys = await this.getAPIKeys();
            keys.forEach(k => k.isActive = false);

            // Generate clean user ID with unambiguous characters only
            const generateCleanId = (length: number = 7): string => {
                const chars = '23456789abcdefghjkmnpqrstuvwxyz'; // Excludes: 0, 1, o, l, i
                let result = '';
                for (let i = 0; i < length; i++) {
                    result += chars.charAt(Math.floor(Math.random() * chars.length));
                }
                return result;
            };

            const userId = `user_${Date.now()}_${generateCleanId()}`;

            console.log('🔑 Generated user ID:', userId);

            // Register with backend
            const backendUrl = this.configManager.getBackendUrl();
            
            console.log('📡 Registering with backend:', `${backendUrl}/api/register`);

            const response = await httpClient.postJson(`${backendUrl}/api/register`, {
                userId: userId,
                provider: provider,
                apiKey: apiKey
            });

            console.log('📥 Backend response:', {
                success: response.success,
                hasData: !!response.data,
                status: response.status
            });

            // The backend returns { success, data: { proxyKey, proxyUrl } }
            // But httpClient wraps it again as { success, status, data: <backend response> }
            // So we need to access response.data.data
            if (!response.success || !response.data) {
                throw new Error(response.error || 'Failed to register proxy key with backend');
            }

            // Handle double nesting - backend response is inside response.data
            const backendResponse = response.data as any;
            
            // Check if backend returned success
            if (!backendResponse.success || !backendResponse.data) {
                throw new Error(backendResponse.error || 'Backend registration failed');
            }

            const proxyKey = backendResponse.data.proxyKey;
            const proxyUrl = backendResponse.data.proxyUrl;

            if (!proxyKey) {
                throw new Error('No proxy key returned from backend');
            }

            console.log('✅ Proxy key generated successfully!');
            console.log('🔑 Proxy Key:', proxyKey);
            console.log('🌐 Proxy URL:', proxyUrl);

            // Encrypt and store locally
            const encryptedData = this.cryptoUtils.encrypt(apiKey);
            const maskedKey = this.cryptoUtils.maskApiKey(apiKey);

            const newKey: APIKeyConfig = {
                id: userId,
                name: `${PROVIDERS[provider]?.label || provider} Key ${keys.length + 1}`,
                provider,
                providerVersion,
                encryptedKey: JSON.stringify(encryptedData),
                maskedKey,
                proxyKey: proxyKey,
                isActive: true,
                createdAt: new Date().toISOString()
            };

            keys.push(newKey);
            await this.setAPIKeys(keys);
            this.hasRealKeys = true;

            console.log('💾 Key stored locally');

            // Show success notification
            const selection = await vscode.window.showInformationMessage(
                '✅ Proxy key generated successfully!',
                'Copy Proxy Key',
                'Copy Base URL',
                'View Instructions'
            );

            if (selection === 'Copy Proxy Key') {
                await vscode.env.clipboard.writeText(proxyKey);
                vscode.window.showInformationMessage('✅ Proxy key copied to clipboard!');
            } else if (selection === 'Copy Base URL') {
                await vscode.env.clipboard.writeText(proxyUrl);
                vscode.window.showInformationMessage('✅ Base URL copied to clipboard!');
            } else if (selection === 'View Instructions') {
                this.showProxyInstructions(proxyKey, proxyUrl);
            }

            // Refresh dashboard
            await this.refreshWebview();
            await this.fetchAnalytics();

            console.log('🎉 Setup complete!');

        } catch (err) {
            console.error('❌ Generate proxy error:', err);
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            vscode.window.showErrorMessage(`Failed to generate proxy: ${errorMessage}`);
        }
    }

    private showProxyInstructions(proxyKey: string, proxyUrl: string): void {
        const panel = vscode.window.createWebviewPanel(
            'proxyInstructions',
            'TotoboX Proxy Setup',
            vscode.ViewColumn.One,
            {}
        );

        panel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>TotoboX Proxy Setup</title>
                <style>
                    body {
                        padding: 20px;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
                        line-height: 1.6;
                        color: #333;
                        max-width: 800px;
                        margin: 0 auto;
                    }
                    h1 {
                        color: #4CAF50;
                        border-bottom: 2px solid #4CAF50;
                        padding-bottom: 10px;
                    }
                    h2 {
                        color: #2196F3;
                        margin-top: 30px;
                    }
                    pre {
                        background: #f5f5f5;
                        padding: 15px;
                        border-radius: 5px;
                        border-left: 4px solid #2196F3;
                        overflow-x: auto;
                        font-size: 13px;
                    }
                    code {
                        font-family: 'Courier New', monospace;
                        font-size: 13px;
                    }
                    .info-box {
                        background: #E3F2FD;
                        padding: 15px;
                        border-radius: 5px;
                        border-left: 4px solid #2196F3;
                        margin: 20px 0;
                    }
                    .warning-box {
                        background: #FFF3E0;
                        padding: 15px;
                        border-radius: 5px;
                        border-left: 4px solid #FF9800;
                        margin: 20px 0;
                    }
                    .key-value {
                        background: #fff;
                        padding: 10px;
                        border-radius: 5px;
                        border: 1px solid #ddd;
                        font-family: monospace;
                        word-break: break-all;
                        margin: 10px 0;
                    }
                </style>
            </head>
            <body>
                <h1>🎉 Proxy Key Generated Successfully!</h1>
                
                <div class="info-box">
                    <strong>📋 Your Credentials:</strong>
                    <div class="key-value"><strong>Proxy URL:</strong> ${proxyUrl}</div>
                    <div class="key-value"><strong>API Key:</strong> ${proxyKey}</div>
                </div>

                <h2>🐍 Python Example</h2>
                <pre><code>import openai

    openai.api_base = "${proxyUrl}"
    openai.api_key = "${proxyKey}"

    response = openai.ChatCompletion.create(
        model="gpt-3.5-turbo",
        messages=[{"role": "user", "content": "Hello from totoboX!"}]
    )

    print(response.choices[0].message.content)</code></pre>

                <h2>📡 cURL Example</h2>
                <pre><code>curl ${proxyUrl} \\
    -H "Authorization: Bearer ${proxyKey}" \\
    -H "Content-Type: application/json" \\
    -d '{
        "model": "gpt-3.5-turbo",
        "messages": [
        {"role": "user", "content": "Hello from totoboX!"}
        ]
    }'</code></pre>

                <h2>⚡ JavaScript/Node.js Example</h2>
                <pre><code>const response = await fetch("${proxyUrl}", {
    method: "POST",
    headers: {
        "Authorization": "Bearer ${proxyKey}",
        "Content-Type": "application/json"
    },
    body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [
        { role: "user", content: "Hello from totoboX!" }
        ]
    })
    });

    const data = await response.json();
    console.log(data.choices[0].message.content);</code></pre>

                <div class="warning-box">
                    <strong>⚠️ Security Note:</strong> Keep your proxy key secure! Never commit it to version control or share it publicly.
                </div>

                <div class="info-box">
                    <strong>📊 Track Your Usage:</strong> View real-time analytics in the totoboX dashboard to monitor your API calls, token usage, and costs.
                </div>
            </body>
            </html>
        `;
    }

    
    private async handleSwitchKey(keyId: string): Promise<void> {
        const keys = await this.getAPIKeys();
        keys.forEach(k => k.isActive = k.id === keyId);
        await this.setAPIKeys(keys);
        await this.refreshWebview();
    }

    private async handleRemoveKey(keyId: string): Promise<void> {
        const keys = await this.getAPIKeys();
        const filtered = keys.filter(k => k.id !== keyId);

        if (filtered.length > 0 && !filtered.some(k => k.isActive)) {
            filtered[0].isActive = true;
        }

        // Remove from selected keys
        ['token', 'cost', 'calls'].forEach(chartType => {
            const selectedSet = this.selectedKeys.get(chartType as any) || new Set();
            selectedSet.delete(keyId);
            this.selectedKeys.set(chartType as any, selectedSet);
        });

        await this.setAPIKeys(filtered);

        if (filtered.length === 0) {
            this.hasRealKeys = false;
        }

        await this.refreshWebview();
    }

    private async handleRenameKey(keyId: string, newName: string): Promise<void> {
        const keys = await this.getAPIKeys();
        const key = keys.find(k => k.id === keyId);
        if (key) {
            key.name = newName;
            await this.setAPIKeys(keys);
            await this.refreshWebview();
            if (this.configManager.get('showNotifications')) {
                vscode.window.showInformationMessage('Key renamed successfully');
            }
        }
    }

    private async handleCopyProxy(proxyKey: string): Promise<void> {
        await vscode.env.clipboard.writeText(proxyKey);
        if (this.configManager.get('showNotifications')) {
            vscode.window.showInformationMessage('Proxy key copied to clipboard');
        }
    }

    private async handleExportCSV(): Promise<void> {
        try {
            const logs = await this.fetchRecentLogs();
            
            if (logs.length === 0) {
                vscode.window.showWarningMessage('No logs available to export');
                return;
            }

            // CSV Header - all 10 columns
            const headers = [
                'ID',
                'Timestamp',
                'Provider',
                'Model',
                'Endpoint',
                'Input Tokens',
                'Output Tokens',
                'Total Tokens',
                'Ratio',
                'Cost (USD)',
                'Latency (ms)'
            ];

            // Convert logs to CSV rows
            const rows = logs.map(log => {
                const date = new Date(log.timestamp);
                const timestamp = date.toISOString();
                
                const id = log.id || '';
                const provider = log.provider || 'Unknown';
                const model = log.model || 'N/A';
                const endpoint = log.endpoint || '/chat/completions';
                const inputTokens = log.input_tokens || 0;
                const outputTokens = log.output_tokens || 0;
                const totalTokens = log.tokens || (inputTokens + outputTokens);
                const ratio = log.ratio || (inputTokens > 0 ? (outputTokens / inputTokens).toFixed(2) : '0.00');
                const cost = log.cost || 0;
                const latency = log.latency_ms || 0;

                return [
                    id,
                    timestamp,
                    provider,
                    model,
                    endpoint,
                    inputTokens,
                    outputTokens,
                    totalTokens,
                    ratio,
                    cost.toFixed(6),
                    latency
                ];
            });

            // Build CSV content
            const csvContent = [
                headers.join(','),
                ...rows.map(row => row.join(','))
            ].join('\n');

            // Generate filename with timestamp
            const now = new Date();
            const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
            const filename = `totobox-logs-${dateStr}.csv`;

            // Save file
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(filename),
                filters: {
                    'CSV Files': ['csv'],
                    'All Files': ['*']
                }
            });

            if (saveUri) {
                await vscode.workspace.fs.writeFile(
                    saveUri,
                    Buffer.from(csvContent, 'utf-8')
                );
                
                vscode.window.showInformationMessage(
                    `✅ Exported ${logs.length} logs to ${filename}`,
                    'Open File'
                ).then(selection => {
                    if (selection === 'Open File') {
                        vscode.commands.executeCommand('vscode.open', saveUri);
                    }
                });
            }

            console.log(`✅ CSV export completed: ${logs.length} logs`);
        } catch (error) {
            console.error('❌ CSV export failed:', error);
            vscode.window.showErrorMessage('Failed to export CSV: ' + (error as Error).message);
        }
    }

    private async handleSaveSettings(data: any): Promise<void> {
        try {
            if (data.backendUrl) {
                await this.configManager.set('backendUrl', data.backendUrl);
            }

            if (data.environment) {
                await this.configManager.set('environment', data.environment);
            }

            if (data.refreshInterval) {
                await this.configManager.set('refreshInterval', parseInt(data.refreshInterval));
            }

            if (data.notifications !== undefined) {
                await this.configManager.set('showNotifications', data.notifications);
            }

            if (this.configManager.get('showNotifications')) {
                vscode.window.showInformationMessage('Settings saved');
            }

            // Restart update loop with new interval
            if (this.updateTimer) {
                clearInterval(this.updateTimer);
            }
            this.startDataUpdateLoop();

        } catch (err) {
            await this.errorHandler.handleError(err as Error, {
                operation: 'saveSettings',
                details: data
            });
        }
    }

    public dispose(): void {
        this.isDisposed = true;
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }
        this.webviewPanel?.dispose();
        this.statusBarItem?.dispose();
        this.cryptoUtils.clearMasterKey();
    }
}

let extensionInstance: TotoBoxExtension | null = null;

export async function activate(context: vscode.ExtensionContext) {
    console.log('totoboX extension is being activated...');
    try {
        // Create instance
        extensionInstance = new TotoBoxExtension(context);
        // Initialize it (this is async)
        await extensionInstance.initialize();
        console.log('totoboX extension activated successfully');
        vscode.window.showInformationMessage('totoboX extension is ready!');
    } catch (error) {
        console.error('Failed to activate totoboX:', error);
        vscode.window.showErrorMessage(`Failed to activate totoboX: ${error}`);
        throw error; // Re-throw to let VS Code know activation failed
    }
}

export function deactivate() {
    console.log('totoboX extension is being deactivated...');
    extensionInstance?.dispose();
    extensionInstance = null;
}

