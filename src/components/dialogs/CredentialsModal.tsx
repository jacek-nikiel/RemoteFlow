import React, { useState } from 'react';
import {
  X,
  KeyRound,
  Plus,
  Trash2,
  Edit2,
  Eye,
  EyeOff,
  Loader2,
  Key,
} from 'lucide-react';
import { api } from '../../services/api';
import { Credential, SshAuthType } from '../../types';
import { anchorFromElement, ConfirmDialog, DialogAnchor } from './ConfirmDialog';
import { useT } from '../../i18n';
import { SshKeyFields } from './SshKeyFields';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  credentials: Credential[];
  onCredentialsChanged: () => Promise<void>;
}

export const CredentialsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  credentials,
  onCredentialsChanged,
}) => {
  const t = useT();
  const [editingCred, setEditingCred] = useState<Credential | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [authType, setAuthType] = useState<SshAuthType>('password');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [keyInputMode, setKeyInputMode] = useState<'file' | 'text'>('text');
  const [keyFilePath, setKeyFilePath] = useState('');
  const [promptKeyPassphrase, setPromptKeyPassphrase] = useState(false);
  const [certificateContent, setCertificateContent] = useState('');
  const [certInputMode, setCertInputMode] = useState<'file' | 'text'>('file');
  const [certFilePath, setCertFilePath] = useState('');
  const [saving, setSaving] = useState(false);
  const [revealingId, setRevealingId] = useState<string | null>(null);
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; anchor: DialogAnchor | null } | null>(null);

  const openNewForm = () => {
    setEditingCred(null);
    setName('');
    setUsername('');
    setAuthType('password');
    setPassword('');
    setShowPassword(false);
    setPrivateKey('');
    setPassphrase('');
    setKeyInputMode('file');
    setKeyFilePath('');
    setPromptKeyPassphrase(false);
    setCertificateContent('');
    setCertInputMode('file');
    setCertFilePath('');
    setError(null);
    setIsFormOpen(true);
  };

  const openEditForm = (cred: Credential) => {
    setEditingCred(cred);
    setName(cred.name);
    setUsername(cred.username);
    setAuthType(cred.authType);
    setPassword('');
    setShowPassword(false);
    setPrivateKey('');
    setPassphrase('');
    setKeyInputMode(cred.keyFilePath ? 'file' : 'text');
    setKeyFilePath(cred.keyFilePath || '');
    setPromptKeyPassphrase(Boolean(cred.promptKeyPassphrase));
    setCertificateContent(cred.certificateContent || '');
    setCertInputMode(cred.certificateFilePath || !cred.certificateContent ? 'file' : 'text');
    setCertFilePath(cred.certificateFilePath || '');
    setError(null);
    setIsFormOpen(true);
  };

  const handleRevealPassword = async (credId: string) => {
    if (revealedPasswords[credId]) {
      setRevealedPasswords((prev) => {
        const copy = { ...prev };
        delete copy[credId];
        return copy;
      });
      return;
    }

    setRevealingId(credId);
    try {
      const plaintext = await api.revealCredentialPassword(credId);
      setRevealedPasswords((prev) => ({ ...prev, [credId]: plaintext }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevealingId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t('Podaj nazwę poświadczenia'));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // Everything the form does not show (fields added later, data from an import) is kept
      const cred: Credential = {
        ...(editingCred ?? {}),
        id: editingCred ? editingCred.id : 'cred-' + Math.random().toString(36).substring(2, 9),
        name: name.trim(),
        username: username.trim(),
        authType,
        passwordEncrypted: editingCred ? editingCred.passwordEncrypted : undefined,
        privateKeyEncrypted: editingCred ? editingCred.privateKeyEncrypted : undefined,
        privateKeyPassphraseEncrypted: promptKeyPassphrase ? undefined : editingCred?.privateKeyPassphraseEncrypted,
        certificateContent: certificateContent.trim() || undefined,
        // A file (read at every connection) applies only when "file" is selected – as in the connection editor
        certificateFilePath: (certInputMode === 'file' && certFilePath.trim()) || undefined,
        keyFilePath: (keyInputMode === 'file' && keyFilePath.trim()) || undefined,
        promptKeyPassphrase: promptKeyPassphrase,
        createdAt: editingCred ? editingCred.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await api.saveCredential(
        cred,
        password || undefined,
        privateKey || undefined,
        promptKeyPassphrase ? '' : passphrase || undefined
      );

      await onCredentialsChanged();
      setIsFormOpen(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteCredential(id);
      await onCredentialsChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="flex h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex h-14 items-center justify-between border-b border-slate-800 px-6 bg-slate-900/80">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-cyan-400" />
            <div>
              <h2 className="text-sm font-bold text-white">
                {t('Menedżer Zapisanych Poświadczeń')}
              </h2>
              <p className="text-[11px] text-slate-400">
                {t('Współdzielone loginy, hasła i klucze do wielokrotnego użytku')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
              {error}
            </div>
          )}

          {!isFormOpen ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400">
                  {t('Zdefiniowane poświadczenia ({n}):', { n: credentials.length })}
                </span>
                <button
                  onClick={openNewForm}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 transition-colors shadow-sm"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('Dodaj nowe poświadczenie')}
                </button>
              </div>

              {credentials.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-xs text-slate-500">
                  {t('Brak zapisanych poświadczeń. Kliknij przycisk powyżej, aby utworzyć pierwsze poświadczenie wielokrotnego użytku.')}
                </div>
              ) : (
                <div className="space-y-2">
                  {credentials.map((cred) => {
                    const isRevealed = !!revealedPasswords[cred.id];
                    return (
                      <div
                        key={cred.id}
                        className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 p-3 hover:border-slate-700 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400">
                            <Key className="h-4 w-4" />
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-slate-200">
                              {cred.name}
                            </div>
                            <div className="text-[11px] text-slate-400 font-mono">
                              {t('Użytkownik:')} <span className="text-slate-300">{cred.username || t('(brak)')}</span> | {t('Typ:')} {cred.authType === 'password' ? t('Hasło') : cred.authType === 'key' ? t('Klucz prywatny') : cred.authType === 'certificate' ? t('Certyfikat SSH CA') : t('Agent SSH')}
                            </div>
                            {isRevealed && (
                              <div className="mt-1 text-[11px] font-mono text-cyan-300 bg-cyan-950/50 px-2 py-0.5 rounded border border-cyan-800/40">
                                {t('Hasło:')} {revealedPasswords[cred.id]}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5">
                          {cred.passwordEncrypted && (
                            <button
                              type="button"
                              onClick={() => handleRevealPassword(cred.id)}
                              disabled={revealingId === cred.id}
                              title={t('Pokaż hasło')}
                              className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-cyan-400"
                            >
                              {revealingId === cred.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : isRevealed ? (
                                <EyeOff className="h-3.5 w-3.5" />
                              ) : (
                                <Eye className="h-3.5 w-3.5" />
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => openEditForm(cred)}
                            title={t('Edytuj poświadczenie')}
                            className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-white"
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => setPendingDelete({ id: cred.id, anchor: anchorFromElement(e.currentTarget) })}
                            title={t('Usuń poświadczenie')}
                            className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-red-500/10 hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* Add / Edit Form */
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <span className="text-xs font-bold text-white uppercase tracking-wider">
                  {editingCred ? t('Edytuj poświadczenie') : t('Nowe poświadczenie')}
                </span>
                <button
                  type="button"
                  onClick={() => setIsFormOpen(false)}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  {t('Wróć do listy')}
                </button>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300">
                  {t('Nazwa poświadczenia (etykieta)')}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('np. Root Global, Windows Domain Admin, SSH Deployer')}
                  required
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                />
              </div>

              <div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300">
                    {t('Nazwa użytkownika (Login)')}
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={t('np. root, Administrator, ubuntu')}
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                  />
                </div>

              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300">
                  {t('Hasło (szyfrowane AES-256-GCM)')}
                </label>
                <div className="relative mt-1.5">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      editingCred?.passwordEncrypted
                        ? t('•••••••• (Pozostaw puste, aby zachować)')
                        : t('Wprowadź hasło...')
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 pr-10 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <SshKeyFields
                authType={authType}
                setAuthType={setAuthType}
                privateKey={privateKey}
                setPrivateKey={setPrivateKey}
                keyInputMode={keyInputMode}
                setKeyInputMode={setKeyInputMode}
                keyFilePath={keyFilePath}
                setKeyFilePath={setKeyFilePath}
                passphrase={passphrase}
                setPassphrase={setPassphrase}
                promptKeyPassphrase={promptKeyPassphrase}
                setPromptKeyPassphrase={setPromptKeyPassphrase}
                hasStoredPassphrase={Boolean(editingCred?.privateKeyPassphraseEncrypted)}
                certificateContent={certificateContent}
                setCertificateContent={setCertificateContent}
                certInputMode={certInputMode}
                setCertInputMode={setCertInputMode}
                certFilePath={certFilePath}
                setCertFilePath={setCertFilePath}
                setError={setError}
              />

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsFormOpen(false)}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
                >
                  {t('Anuluj')}
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-5 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {t('Zapisz poświadczenie')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title={t('Usunąć poświadczenie?')}
        message={t('Poświadczenie „{name}” zostanie usunięte. Połączenia z niego korzystające zostaną odpięte.', {
          name: credentials.find((c) => c.id === pendingDelete?.id)?.name ?? '',
        })}
        confirmLabel={t('Usuń')}
        anchor={pendingDelete?.anchor}
        onConfirm={() => {
          const id = pendingDelete?.id;
          setPendingDelete(null);
          if (id) handleDelete(id);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};
