import { t } from '../i18n';

export interface ConnectionPasswordStatus {
  connectionId: string;
  name: string;
  host: string;
  port: number;
  requiresPassword: boolean;
  hasPassword: boolean;
}

export type PasswordDecision = 'empty' | 'saved' | 'cancel';
export interface PasswordPromptRequest {
  status: ConnectionPasswordStatus;
  resolve: (decision: PasswordDecision) => void;
}

let promptHandler: ((request: PasswordPromptRequest) => void) | null = null;

export function registerPasswordPrompt(handler: (request: PasswordPromptRequest) => void): () => void {
  promptHandler = handler;
  return () => { if (promptHandler === handler) promptHandler = null; };
}

export function requestConnectionPassword(status: ConnectionPasswordStatus): Promise<PasswordDecision> {
  return new Promise((resolve) => {
    if (promptHandler) promptHandler({ status, resolve });
    else resolve('cancel');
  });
}

export class PasswordPromptCancelled extends Error {
  constructor() { super(t('Anulowano połączenie')); }
}
