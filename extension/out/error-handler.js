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
exports.ErrorHandler = void 0;
const vscode = __importStar(require("vscode"));
class ErrorHandler {
    constructor() {
        this.errorCounts = new Map();
        this.lastErrors = new Map();
        this.MAX_ERRORS_PER_OPERATION = 3;
        this.ERROR_RESET_TIME = 300000; // 5 minutes
    }
    static getInstance() {
        if (!ErrorHandler.instance) {
            ErrorHandler.instance = new ErrorHandler();
        }
        return ErrorHandler.instance;
    }
    async handleError(error, context) {
        const errorMessage = error instanceof Error ? error.message : error;
        const operationKey = context.operation;
        // Track error frequency
        this.incrementErrorCount(operationKey);
        console.error(`totoboX ${context.operation} error:`, errorMessage, context.details);
        // Determine error severity and appropriate response
        if (this.shouldShowErrorToUser(operationKey, errorMessage)) {
            await this.showErrorToUser(errorMessage, context);
        }
    }
    incrementErrorCount(operation) {
        const now = Date.now();
        const lastError = this.lastErrors.get(operation) || 0;
        // Reset count if enough time has passed
        if (now - lastError > this.ERROR_RESET_TIME) {
            this.errorCounts.set(operation, 0);
        }
        const currentCount = this.errorCounts.get(operation) || 0;
        this.errorCounts.set(operation, currentCount + 1);
        this.lastErrors.set(operation, now);
    }
    shouldShowErrorToUser(operation, errorMessage) {
        const errorCount = this.errorCounts.get(operation) || 0;
        // Don't spam user with repeated errors
        if (errorCount > this.MAX_ERRORS_PER_OPERATION) {
            return false;
        }
        // Show network/service errors to user
        if (errorMessage.includes('fetch') ||
            errorMessage.includes('network') ||
            errorMessage.includes('timeout') ||
            errorMessage.includes('unavailable')) {
            return true;
        }
        // Show configuration errors
        if (errorMessage.includes('API key') ||
            errorMessage.includes('configuration') ||
            errorMessage.includes('authentication')) {
            return true;
        }
        return false;
    }
    async showErrorToUser(errorMessage, context) {
        const actions = [];
        if (context.retry) {
            actions.push('Retry');
        }
        actions.push('Dismiss');
        const userAction = await vscode.window.showErrorMessage(`totoboX ${context.operation}: ${errorMessage}`, ...actions);
        if (userAction === 'Retry' && context.retry) {
            try {
                await context.retry();
            }
            catch (retryError) {
                // Don't show retry errors immediately to avoid spam
                console.error('Retry failed:', retryError);
            }
        }
    }
    getErrorCount(operation) {
        return this.errorCounts.get(operation) || 0;
    }
    clearErrors(operation) {
        if (operation) {
            this.errorCounts.delete(operation);
            this.lastErrors.delete(operation);
        }
        else {
            this.errorCounts.clear();
            this.lastErrors.clear();
        }
    }
}
exports.ErrorHandler = ErrorHandler;
//# sourceMappingURL=error-handler.js.map