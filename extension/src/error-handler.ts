import * as vscode from 'vscode';

export interface ErrorContext {
  operation: string;
  details?: any;
  retry?: () => Promise<void>;
}

export class ErrorHandler {
  private static instance: ErrorHandler;
  private errorCounts = new Map<string, number>();
  private lastErrors = new Map<string, number>();
  private readonly MAX_ERRORS_PER_OPERATION = 3;
  private readonly ERROR_RESET_TIME = 300000; // 5 minutes

  static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }
    return ErrorHandler.instance;
  }

  async handleError(error: Error | string, context: ErrorContext): Promise<void> {
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

  private incrementErrorCount(operation: string): void {
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

  private shouldShowErrorToUser(operation: string, errorMessage: string): boolean {
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

  private async showErrorToUser(errorMessage: string, context: ErrorContext): Promise<void> {
    const actions: string[] = [];
    
    if (context.retry) {
      actions.push('Retry');
    }
    
    actions.push('Dismiss');
    
    const userAction = await vscode.window.showErrorMessage(
      `totoboX ${context.operation}: ${errorMessage}`,
      ...actions
    );
    
    if (userAction === 'Retry' && context.retry) {
      try {
        await context.retry();
      } catch (retryError) {
        // Don't show retry errors immediately to avoid spam
        console.error('Retry failed:', retryError);
      }
    }
  }

  getErrorCount(operation: string): number {
    return this.errorCounts.get(operation) || 0;
  }

  clearErrors(operation?: string): void {
    if (operation) {
      this.errorCounts.delete(operation);
      this.lastErrors.delete(operation);
    } else {
      this.errorCounts.clear();
      this.lastErrors.clear();
    }
  }
}

