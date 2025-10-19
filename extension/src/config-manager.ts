import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface TotoBoxConfig {
  backendUrl: string;
  refreshInterval: number;
  showNotifications: boolean;
  maxRetries: number;
  timeout: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  enableTelemetry: boolean;
  customPricing?: Record<string, { input: number; output: number }>;
  environment: 'development' | 'staging' | 'production';
}

export class ConfigManager {
  private static instance: ConfigManager;
  private config: TotoBoxConfig;
  private readonly configFile: string;
  private readonly defaultConfig: TotoBoxConfig = {
    backendUrl: 'https://totobox.vercel.app',
    refreshInterval: 30,
    showNotifications: true,
    maxRetries: 3,
    timeout: 15000,
    logLevel: 'info',
    enableTelemetry: false,
    environment: 'production',
    customPricing: {
      'gpt-4': { input: 0.03, output: 0.06 },
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
      'claude-3-opus': { input: 0.015, output: 0.075 },
      'claude-3-sonnet': { input: 0.003, output: 0.015 },
      'claude-3-haiku': { input: 0.00025, output: 0.00125 },
      'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
      'gemini-1.5-flash': { input: 0.00025, output: 0.0005 }
    }
  };

  private constructor(context: vscode.ExtensionContext) {
    this.configFile = path.join(context.globalStorageUri.fsPath, 'totobox-config.json');
    this.config = this.loadConfig();
    this.setupConfigWatcher();
  }

  static getInstance(context?: vscode.ExtensionContext): ConfigManager {
    if (!ConfigManager.instance && context) {
      ConfigManager.instance = new ConfigManager(context);
    } else if (!ConfigManager.instance) {
      throw new Error('ConfigManager not initialized. Provide context on first call.');
    }
    return ConfigManager.instance;
  }

  private loadConfig(): TotoBoxConfig {
    try {
      // First, load from VS Code settings
      const vsConfig = vscode.workspace.getConfiguration('totobox');
      const userConfig: Partial<TotoBoxConfig> = {
        backendUrl: vsConfig.get('backendUrl'),
        refreshInterval: vsConfig.get('refreshInterval'),
        showNotifications: vsConfig.get('showNotifications'),
        maxRetries: vsConfig.get('maxRetries'),
        timeout: vsConfig.get('timeout'),
        logLevel: vsConfig.get('logLevel'),
        enableTelemetry: vsConfig.get('enableTelemetry'),
        environment: vsConfig.get('environment')
      };

      // Load custom config file if exists
      if (fs.existsSync(this.configFile)) {
        const fileConfig = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        Object.assign(userConfig, fileConfig);
      }

      // Check for environment-specific overrides
      const env = process.env.TOTOBOX_ENV || userConfig.environment || 'production';
      const envConfig = this.getEnvironmentConfig(env as any);

      // Merge all configs (priority: env > file > vscode > default)
      return {
        ...this.defaultConfig,
        ...userConfig,
        ...envConfig
      } as TotoBoxConfig;
    } catch (error) {
      console.error('Failed to load config:', error);
      return this.defaultConfig;
    }
  }

  private getEnvironmentConfig(env: 'development' | 'staging' | 'production'): Partial<TotoBoxConfig> {
    const configs = {
      development: {
        backendUrl: 'http://localhost:3000',
        logLevel: 'debug' as const,
        enableTelemetry: false
      },
      staging: {
        backendUrl: 'https://totobox.vercel.app',
        logLevel: 'info' as const,
        enableTelemetry: true
      },
      production: {
        backendUrl: 'https://totobox.vercel.app',
        logLevel: 'error' as const,
        enableTelemetry: true
      }
    };
    return configs[env] || {};
  }

  private setupConfigWatcher(): void {
    // Watch for VS Code settings changes
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('totobox')) {
        this.config = this.loadConfig();
        this.notifyConfigChange();
      }
    });

    // Watch for config file changes
    if (fs.existsSync(this.configFile)) {
      fs.watchFile(this.configFile, () => {
        this.config = this.loadConfig();
        this.notifyConfigChange();
      });
    }
  }

  private notifyConfigChange(): void {
    vscode.window.showInformationMessage('totoboX configuration updated');
  }

  get<K extends keyof TotoBoxConfig>(key: K): TotoBoxConfig[K] {
    return this.config[key];
  }

  async set<K extends keyof TotoBoxConfig>(key: K, value: TotoBoxConfig[K]): Promise<void> {
    this.config[key] = value;
    
    // Save to VS Code settings
    const vsConfig = vscode.workspace.getConfiguration('totobox');
    await vsConfig.update(key, value, vscode.ConfigurationTarget.Global);
    
    // Also save to config file
    await this.saveConfigFile();
  }

  private async saveConfigFile(): Promise<void> {
    try {
      const dir = path.dirname(this.configFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Failed to save config file:', error);
    }
  }

  getAll(): TotoBoxConfig {
    return { ...this.config };
  }

  async reset(): Promise<void> {
    this.config = this.defaultConfig;
    await this.saveConfigFile();
    
    // Reset VS Code settings
    const vsConfig = vscode.workspace.getConfiguration('totobox');
    for (const key of Object.keys(this.defaultConfig) as (keyof TotoBoxConfig)[]) {
      await vsConfig.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  }

  getPricing(model: string): { input: number; output: number } | null {
    return this.config.customPricing?.[model] || null;
  }

  async updatePricing(model: string, pricing: { input: number; output: number }): Promise<void> {
    if (!this.config.customPricing) {
      this.config.customPricing = {};
    }
    this.config.customPricing[model] = pricing;
    await this.saveConfigFile();
  }

  getBackendUrl(endpoint?: string): string {
    const baseUrl = this.config.backendUrl.replace(/\/$/, '');
    return endpoint ? `${baseUrl}/${endpoint.replace(/^\//, '')}` : baseUrl;
  }
  

  isProduction(): boolean {
    return this.config.environment === 'production';
  }

  isDevelopment(): boolean {
    return this.config.environment === 'development';
  }
}
