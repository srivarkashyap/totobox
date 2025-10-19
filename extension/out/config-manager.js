"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigManager = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
class ConfigManager {
    constructor(context) {
        this.defaultConfig = {
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
        this.configFile = path.join(context.globalStorageUri.fsPath, 'totobox-config.json');
        this.config = this.loadConfig();
        this.setupConfigWatcher();
    }
    static getInstance(context) {
        if (!ConfigManager.instance && context) {
            ConfigManager.instance = new ConfigManager(context);
        }
        else if (!ConfigManager.instance) {
            throw new Error('ConfigManager not initialized. Provide context on first call.');
        }
        return ConfigManager.instance;
    }
    loadConfig() {
        try {
            // First, load from VS Code settings
            const vsConfig = vscode.workspace.getConfiguration('totobox');
            const userConfig = {
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
            const envConfig = this.getEnvironmentConfig(env);
            // Merge all configs (priority: env > file > vscode > default)
            return {
                ...this.defaultConfig,
                ...userConfig,
                ...envConfig
            };
        }
        catch (error) {
            console.error('Failed to load config:', error);
            return this.defaultConfig;
        }
    }
    getEnvironmentConfig(env) {
        const configs = {
            development: {
                backendUrl: 'http://localhost:3000',
                logLevel: 'debug',
                enableTelemetry: false
            },
            staging: {
                backendUrl: 'https://totobox.vercel.app',
                logLevel: 'info',
                enableTelemetry: true
            },
            production: {
                backendUrl: 'https://totobox.vercel.app',
                logLevel: 'error',
                enableTelemetry: true
            }
        };
        return configs[env] || {};
    }
    setupConfigWatcher() {
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
    notifyConfigChange() {
        vscode.window.showInformationMessage('totoboX configuration updated');
    }
    get(key) {
        return this.config[key];
    }
    async set(key, value) {
        this.config[key] = value;
        // Save to VS Code settings
        const vsConfig = vscode.workspace.getConfiguration('totobox');
        await vsConfig.update(key, value, vscode.ConfigurationTarget.Global);
        // Also save to config file
        await this.saveConfigFile();
    }
    async saveConfigFile() {
        try {
            const dir = path.dirname(this.configFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
        }
        catch (error) {
            console.error('Failed to save config file:', error);
        }
    }
    getAll() {
        return { ...this.config };
    }
    async reset() {
        this.config = this.defaultConfig;
        await this.saveConfigFile();
        // Reset VS Code settings
        const vsConfig = vscode.workspace.getConfiguration('totobox');
        for (const key of Object.keys(this.defaultConfig)) {
            await vsConfig.update(key, undefined, vscode.ConfigurationTarget.Global);
        }
    }
    getPricing(model) {
        return this.config.customPricing?.[model] || null;
    }
    async updatePricing(model, pricing) {
        if (!this.config.customPricing) {
            this.config.customPricing = {};
        }
        this.config.customPricing[model] = pricing;
        await this.saveConfigFile();
    }
    getBackendUrl(endpoint) {
        const baseUrl = this.config.backendUrl.replace(/\/$/, '');
        return endpoint ? `${baseUrl}/${endpoint.replace(/^\//, '')}` : baseUrl;
    }
    isProduction() {
        return this.config.environment === 'production';
    }
    isDevelopment() {
        return this.config.environment === 'development';
    }
}
exports.ConfigManager = ConfigManager;
//# sourceMappingURL=config-manager.js.map