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
exports.CryptoUtils = void 0;
const crypto = __importStar(require("crypto"));
class CryptoUtils {
    constructor() {
        this.masterKey = null;
        this.algorithm = 'aes-256-gcm';
        this.iterations = 100000;
        this.keyLength = 32;
    }
    static getInstance() {
        if (!CryptoUtils.instance) {
            CryptoUtils.instance = new CryptoUtils();
        }
        return CryptoUtils.instance;
    }
    /**
     * Initialize or retrieve the master encryption key
     * Uses VS Code's SecretStorage for secure key management
     */
    async initializeMasterKey(context) {
        try {
            const secretStorage = context.secrets;
            const storedKey = await secretStorage.get('totobox-master-key');
            if (storedKey) {
                // Decode existing key
                this.masterKey = Buffer.from(storedKey, 'base64');
                console.log('Master key loaded from storage');
            }
            else {
                // Generate new key for first-time setup
                const salt = crypto.randomBytes(32);
                const password = crypto.randomBytes(32).toString('base64');
                this.masterKey = crypto.pbkdf2Sync(password, salt, this.iterations, this.keyLength, 'sha256');
                // Store in VS Code's secure storage
                await secretStorage.store('totobox-master-key', this.masterKey.toString('base64'));
                await secretStorage.store('totobox-salt', salt.toString('base64'));
                console.log('New master key generated and stored');
            }
        }
        catch (error) {
            console.error('Error initializing master key:', error);
            // Use a fallback key for development/testing
            this.masterKey = Buffer.from('development-key-do-not-use-in-production-000000');
            console.warn('Using fallback master key');
        }
    }
    /**
     * Encrypt sensitive data (API keys)
     */
    encrypt(text) {
        if (!this.masterKey) {
            throw new Error('Master key not initialized. Call initializeMasterKey first.');
        }
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(16);
        // Derive key from master key and salt
        const key = crypto.pbkdf2Sync(this.masterKey, salt, 10000, this.keyLength, 'sha256');
        const cipher = crypto.createCipheriv(this.algorithm, key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const tag = cipher.getAuthTag();
        return {
            encrypted,
            iv: iv.toString('hex'),
            salt: salt.toString('hex'),
            tag: tag.toString('hex')
        };
    }
    /**
     * Decrypt sensitive data
     */
    decrypt(encryptedData) {
        if (!this.masterKey) {
            throw new Error('Master key not initialized. Call initializeMasterKey first.');
        }
        const salt = Buffer.from(encryptedData.salt, 'hex');
        const iv = Buffer.from(encryptedData.iv, 'hex');
        const tag = Buffer.from(encryptedData.tag, 'hex');
        const encrypted = encryptedData.encrypted;
        // Derive key from master key and salt
        const key = crypto.pbkdf2Sync(this.masterKey, salt, 10000, this.keyLength, 'sha256');
        const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
    /**
     * Validate API key format - With debug logging
     */
    validateApiKey(key, provider) {
        console.log('🔍 Validating API key for provider:', provider);
        console.log('🔍 Key starts with:', key.substring(0, 10) + '...');
        console.log('🔍 Key length:', key.length);
        const patterns = {
            openai: /^sk-[a-zA-Z0-9_-]{20,}$/,
            anthropic: /^sk-ant-[a-zA-Z0-9]{90,}$/,
            gemini: /^[a-zA-Z0-9_-]{39}$/,
            perplexity: /^pplx-[a-zA-Z0-9]{48}$/,
        };
        if (!key || key.trim().length === 0) {
            console.log('❌ Validation failed: Empty key');
            return { valid: false, error: 'API key cannot be empty' };
        }
        const pattern = patterns[provider];
        if (!pattern) {
            if (key.length < 20) {
                console.log('❌ Validation failed: Key too short for unknown provider');
                return { valid: false, error: 'API key seems too short' };
            }
            console.log('✅ Validation passed: Unknown provider, basic check OK');
            return { valid: true };
        }
        const testResult = pattern.test(key);
        console.log('🔍 Pattern test result:', testResult);
        console.log('🔍 Pattern used:', pattern.toString());
        if (!testResult) {
            console.log('❌ Validation failed: Pattern mismatch');
            return {
                valid: false,
                error: `Invalid ${provider} API key format. Ensure the key starts with the correct prefix and has sufficient length.`
            };
        }
        console.log('✅ Validation passed');
        return { valid: true };
    }
    /**
     * Hash a value for comparison without storing the original
     */
    hash(value) {
        return crypto
            .createHash('sha256')
            .update(value)
            .digest('hex');
    }
    /**
     * Generate a secure random token
     */
    generateSecureToken(length = 32) {
        return crypto.randomBytes(length).toString('hex');
    }
    /**
     * Mask sensitive data for display
     */
    maskApiKey(key) {
        if (key.length <= 8) {
            return '****';
        }
        const firstFour = key.substring(0, 4);
        const lastFour = key.substring(key.length - 4);
        const masked = '*'.repeat(Math.min(key.length - 8, 20));
        return `${firstFour}${masked}${lastFour}`;
    }
    /**
     * Clear master key from memory (for security)
     */
    clearMasterKey() {
        if (this.masterKey) {
            this.masterKey.fill(0);
            this.masterKey = null;
        }
    }
}
exports.CryptoUtils = CryptoUtils;
//# sourceMappingURL=crypto-utils.js.map