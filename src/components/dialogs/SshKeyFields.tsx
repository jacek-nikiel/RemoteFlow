/**
 * SSH login method and its key / certificate fields – shared by the connection editor and the
 * saved credentials (before, the credentials window had only a pasted key and lost key files and
 * certificates when edited). The values belong to the parent window, which saves them.
 */
import React, { useRef, useState } from 'react';
import { Check, Eye, EyeOff, FileKey, FolderDown, FolderOpen, KeyRound, Loader2, Shield } from 'lucide-react';
import { api, isTauri } from '../../services/api';
import { SshAuthType } from '../../types';
import { useT } from '../../i18n';

export interface SshKeyFieldsProps {
  authType: SshAuthType;
  setAuthType: (type: SshAuthType) => void;
  privateKey: string;
  setPrivateKey: (value: string) => void;
  keyInputMode: 'file' | 'text';
  setKeyInputMode: (mode: 'file' | 'text') => void;
  keyFilePath: string;
  setKeyFilePath: (value: string) => void;
  passphrase: string;
  setPassphrase: (value: string) => void;
  promptKeyPassphrase: boolean;
  setPromptKeyPassphrase: (value: boolean) => void;
  /** A passphrase is already stored (placeholder "keep"). */
  hasStoredPassphrase: boolean;
  certificateContent: string;
  setCertificateContent: (value: string) => void;
  certInputMode: 'file' | 'text';
  setCertInputMode: (mode: 'file' | 'text') => void;
  certFilePath: string;
  setCertFilePath: (value: string) => void;
  setError: (message: string | null) => void;
}

export const SshKeyFields: React.FC<SshKeyFieldsProps> = ({
  authType,
  setAuthType,
  privateKey,
  setPrivateKey,
  keyInputMode,
  setKeyInputMode,
  keyFilePath,
  setKeyFilePath,
  passphrase,
  setPassphrase,
  promptKeyPassphrase,
  setPromptKeyPassphrase,
  hasStoredPassphrase,
  certificateContent,
  setCertificateContent,
  certInputMode,
  setCertInputMode,
  certFilePath,
  setCertFilePath,
  setError,
}) => {
  const t = useT();
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [keyFileLoading, setKeyFileLoading] = useState(false);
  const [keyFileSuccess, setKeyFileSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [certFileLoading, setCertFileLoading] = useState(false);
  const [certFileSuccess, setCertFileSuccess] = useState<string | null>(null);
  const certFileInputRef = useRef<HTMLInputElement>(null);

  // PuTTY key: converted automatically when connecting; can also be saved as an OpenSSH file
  const isPpk = privateKey.trimStart().startsWith('PuTTY-User-Key-File-');
  const [ppkSaving, setPpkSaving] = useState(false);
  const [ppkSaved, setPpkSaved] = useState<string | null>(null);
  const saveAsOpenssh = async () => {
    setPpkSaving(true);
    setError(null);
    try {
      const path = await api.ppkSaveAsOpenssh(privateKey, passphrase);
      if (path) setPpkSaved(path);
    } catch (err: any) {
      setError(String(err?.message || err));
    } finally {
      setPpkSaving(false);
    }
  };
  const ppkNotice = isPpk ? (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
      <span className="min-w-0 flex-1">
        {ppkSaved
          ? t('Zapisano klucz OpenSSH: {path}', { path: ppkSaved })
          : t('Klucz PuTTY (.ppk) – zostanie skonwertowany automatycznie przy łączeniu (zaszyfrowany wymaga hasła klucza).')}
      </span>
      {isTauri() && (
        <button
          type="button"
          onClick={saveAsOpenssh}
          disabled={ppkSaving}
          className="shrink-0 rounded border border-amber-400/40 px-2 py-0.5 text-amber-100 hover:bg-amber-500/20 disabled:opacity-50"
        >
          {t('Zapisz jako OpenSSH…')}
        </button>
      )}
    </div>
  ) : null;

  const handlePickKeyFile = async () => {
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      setKeyFileLoading(true);
      setError(null);
      const picked = await api.pickPrivateKeyFile(t('Wybierz plik klucza prywatnego SSH'));
      if (picked) {
        const { path: filePath, content } = picked;
        setKeyFilePath(filePath);
        if (content.trim()) {
          setPrivateKey(content);
          const fileName = filePath.split('/').pop()?.split('\\').pop() || filePath;
          setKeyFileSuccess(t('Wczytano klucz ({length} bajtów) z pliku: {fileName}', { length: content.length, fileName }));
        }
      }
    } catch (err: unknown) {
      setError(t('Błąd wyboru pliku klucza: {p0}', { p0: err instanceof Error ? err.message : String(err) }));
    } finally {
      setKeyFileLoading(false);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setKeyFilePath(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        setPrivateKey(text);
        setKeyFileSuccess(t('Wczytano klucz ({length} bajtów) z pliku: {name}', { length: text.length, name: file.name }));
      }
    };
    reader.readAsText(file);
  };

  const certLoadedMessage = (length: number, filePath: string) => {
    const fileName = filePath.split('/').pop()?.split('\\').pop() || filePath;
    return t('Wczytano certyfikat ({length} bajtów) z pliku: {fileName}', { length, fileName });
  };

  const handlePickCertFile = async () => {
    if (!isTauri()) {
      certFileInputRef.current?.click();
      return;
    }
    try {
      setCertFileLoading(true);
      setError(null);
      const picked = await api.pickSshCertificateFile(t('Wybierz plik certyfikatu SSH'));
      if (picked) {
        setCertFilePath(picked.path);
        setCertificateContent(picked.content);
        setCertFileSuccess(certLoadedMessage(picked.content.length, picked.path));
      }
    } catch (err: unknown) {
      setError(t('Błąd wyboru pliku certyfikatu: {p0}', { p0: err instanceof Error ? err.message : String(err) }));
    } finally {
      setCertFileLoading(false);
    }
  };

  const handleCertFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCertFilePath(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = String(event.target?.result || '').trim();
      if (text) {
        setCertificateContent(text);
        setCertFileSuccess(certLoadedMessage(text.length, file.name));
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1.5">
          {t('Metoda logowania SSH')}
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(['password', 'key', 'certificate', 'agent'] as SshAuthType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setAuthType(type)}
              className={`rounded-lg border py-2 text-center text-xs font-medium capitalize transition-all ${
                authType === type
                  ? 'border-cyan-500 bg-cyan-500/10 text-white'
                  : 'border-slate-800 bg-slate-800/40 text-slate-400 hover:border-slate-700'
              }`}
            >
              {type === 'password'
                ? t('Hasło')
                : type === 'key'
                ? t('Klucz prywatny')
                : type === 'certificate'
                ? t('Certyfikat SSH CA')
                : t('Agent SSH')}
            </button>
          ))}
        </div>
        {authType === 'agent' && (
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
            {t('Klucze z agenta SSH (ssh-agent, Pageant, agent KeePassXC/1Password). Hasło i klucze zapisane w połączeniu nie są wtedy używane.')}
          </p>
        )}
      </div>

      {(authType === 'key' || authType === 'certificate') && (
        <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
          {/* Hidden file input for web fallback */}
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileInputChange}
            className="hidden"
          />

          {/* 1. Wybór źródła klucza */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                <FileKey className="h-3.5 w-3.5 text-cyan-400" />
                <span>{t('Klucz prywatny SSH')}</span>
              </label>
              <div className="flex items-center rounded-lg bg-slate-900 border border-slate-800 p-0.5">
                <button
                  type="button"
                  onClick={() => setKeyInputMode('file')}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all ${
                    keyInputMode === 'file'
                      ? 'bg-cyan-600 text-white shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <FolderDown className="h-3 w-3" />
                  <span>{t('Wskaż plik z dysku')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setKeyInputMode('text')}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all ${
                    keyInputMode === 'text'
                      ? 'bg-cyan-600 text-white shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <KeyRound className="h-3 w-3" />
                  <span>{t('Wklej treść klucza')}</span>
                </button>
              </div>
            </div>

            {keyInputMode === 'file' ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={keyFilePath}
                    onChange={(e) => {
                      setKeyFilePath(e.target.value);
                      setKeyFileSuccess(null);
                    }}
                    placeholder={t('np. ~/.ssh/id_ed25519 lub C:\\Users\\user\\.ssh\\id_rsa')}
                    className="flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-hidden"
                  />
                  <button
                    type="button"
                    onClick={handlePickKeyFile}
                    disabled={keyFileLoading}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/50 bg-cyan-600/20 px-3.5 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-600/30 hover:border-cyan-400 transition-all shrink-0 cursor-pointer"
                  >
                    {keyFileLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FolderOpen className="h-3.5 w-3.5" />
                    )}
                    <span>{t('Przeglądaj...')}</span>
                  </button>
                </div>

                {keyFileSuccess && (
                  <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1.5 text-[11px] text-emerald-400">
                    <Check className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{keyFileSuccess}</span>
                  </div>
                )}

                {privateKey && !keyFileSuccess && (
                  <div className="flex items-center gap-2 rounded-lg bg-slate-800/60 border border-slate-700/60 px-2.5 py-1 text-[11px] text-slate-400">
                    <span>{t('Zapisana treść klucza w sejfie: {n} bajtów', { n: privateKey.length })}</span>
                  </div>
                )}
                {ppkNotice}
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-slate-400">
                    {t('Wklej treść klucza (OpenSSH / PEM / PuTTY .ppk)')}
                  </span>
                  <button
                    type="button"
                    onClick={handlePickKeyFile}
                    disabled={keyFileLoading}
                    className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 cursor-pointer"
                  >
                    <FolderDown className="h-3 w-3" />
                    <span>{t('Załaduj z pliku...')}</span>
                  </button>
                </div>
                <textarea
                  rows={4}
                  value={privateKey}
                  onChange={(e) => {
                    setPrivateKey(e.target.value);
                    setKeyFileSuccess(null);
                  }}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"
                  className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 font-mono text-[11px] text-white placeholder-slate-600 focus:border-cyan-500 focus:outline-hidden"
                />
                {ppkNotice}
              </div>
            )}
          </div>

          {/* 2. Hasło do klucza (Passphrase) */}
          <div className="pt-3 border-t border-slate-800/60 space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-300">
                {t('Hasło do klucza (Passphrase)')}
              </label>
              <span className="text-[11px] text-slate-500">
                {t('Opcjonalne, jeśli klucz jest zabezpieczony hasłem')}
              </span>
            </div>

            {/* Wybór: Wprowadź od razu lub monituj przy łączeniu */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPromptKeyPassphrase(false)}
                className={`flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition-all cursor-pointer ${
                  !promptKeyPassphrase
                    ? 'border-cyan-500/60 bg-cyan-500/10 text-white shadow-xs'
                    : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:border-slate-700'
                }`}
              >
                <KeyRound className="h-4 w-4 shrink-0 text-cyan-400" />
                <div>
                  <div className="text-xs font-semibold">{t('Wprowadź hasło od razu')}</div>
                  <div className="text-[10px] text-slate-400">{t('Zapisz zaszyfrowane w sejfie')}</div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setPromptKeyPassphrase(true);
                  setPassphrase('');
                }}
                className={`flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition-all cursor-pointer ${
                  promptKeyPassphrase
                    ? 'border-cyan-500/60 bg-cyan-500/10 text-white shadow-xs'
                    : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:border-slate-700'
                }`}
              >
                <Shield className="h-4 w-4 shrink-0 text-amber-400" />
                <div>
                  <div className="text-xs font-semibold">{t('Monit przy połączeniu')}</div>
                  <div className="text-[10px] text-slate-400">{t('Pytaj o hasło przy próbie połączenia')}</div>
                </div>
              </button>
            </div>

            {!promptKeyPassphrase ? (
              <div className="relative mt-1">
                <input
                  type={showPassphrase ? 'text' : 'password'}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={
                    hasStoredPassphrase
                      ? t('•••••••••••• (Zapisane w sejfie — wpisz nowe aby zmienić)')
                      : t('Wprowadź passphrase do klucza...')
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 pr-10 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-hidden"
                />
                <button
                  type="button"
                  onClick={() => setShowPassphrase(!showPassphrase)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                >
                  {showPassphrase ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            ) : (
              <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-2.5 text-xs text-amber-300 flex items-center gap-2">
                <Shield className="h-4 w-4 shrink-0 text-amber-400" />
                <span>
                  {t('Hasło nie będzie przechowywane w programie. Przed otwarciem sesji pojawi się okienko z prośbą o podanie passphrase.')}
                </span>
              </div>
            )}
          </div>

          {authType === 'certificate' && (
            <div className="pt-3 border-t border-slate-800/60 space-y-2">
              <input
                ref={certFileInputRef}
                type="file"
                accept=".pub,text/plain"
                onChange={handleCertFileInputChange}
                className="hidden"
              />
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5 text-cyan-400" />
                  <span>{t('Certyfikat SSH (id_ed25519-cert.pub)')}</span>
                </label>
                <div className="flex items-center rounded-lg bg-slate-900 border border-slate-800 p-0.5">
                  <button
                    type="button"
                    onClick={() => setCertInputMode('file')}
                    className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all ${
                      certInputMode === 'file' ? 'bg-cyan-600 text-white shadow-xs' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <FolderDown className="h-3 w-3" />
                    <span>{t('Wskaż plik z dysku')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setCertInputMode('text')}
                    className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all ${
                      certInputMode === 'text' ? 'bg-cyan-600 text-white shadow-xs' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <KeyRound className="h-3 w-3" />
                    <span>{t('Wklej treść certyfikatu')}</span>
                  </button>
                </div>
              </div>

              {certInputMode === 'file' ? (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={certFilePath}
                      onChange={(e) => {
                        setCertFilePath(e.target.value);
                        setCertFileSuccess(null);
                      }}
                      placeholder={t('np. ~/.ssh/id_ed25519-cert.pub lub C:\\Users\\user\\.ssh\\id_ed25519-cert.pub')}
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 font-mono text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-hidden"
                    />
                    <button
                      type="button"
                      onClick={handlePickCertFile}
                      disabled={certFileLoading}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/50 bg-cyan-600/20 px-3.5 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-600/30 hover:border-cyan-400 transition-all shrink-0 cursor-pointer"
                    >
                      {certFileLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
                      <span>{t('Przeglądaj...')}</span>
                    </button>
                  </div>
                  {certFileSuccess && (
                    <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1.5 text-[11px] text-emerald-400">
                      <Check className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{certFileSuccess}</span>
                    </div>
                  )}
                  {certificateContent && !certFileSuccess && (
                    <div className="flex items-center gap-2 rounded-lg bg-slate-800/60 border border-slate-700/60 px-2.5 py-1 text-[11px] text-slate-400">
                      <span>{t('Zapisana treść certyfikatu: {n} bajtów', { n: certificateContent.trim().length })}</span>
                    </div>
                  )}
                  <p className="text-[10px] text-slate-500">
                    {t('Plik jest odczytywany przy każdym połączeniu – odnowiony certyfikat zostanie użyty bez edycji połączenia. Jeśli pliku zabraknie, używana jest treść zapisana przy jego wyborze.')}
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">{t('Wklej treść certyfikatu (…-cert.pub)')}</span>
                    <button
                      type="button"
                      onClick={handlePickCertFile}
                      disabled={certFileLoading}
                      className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 cursor-pointer"
                    >
                      <FolderDown className="h-3 w-3" />
                      <span>{t('Załaduj z pliku...')}</span>
                    </button>
                  </div>
                  <textarea
                    rows={3}
                    value={certificateContent}
                    onChange={(e) => {
                      setCertificateContent(e.target.value);
                      setCertFileSuccess(null);
                    }}
                    placeholder="ssh-ed25519-cert-v01@openssh.com AAAA..."
                    className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 font-mono text-[11px] text-white placeholder-slate-600 focus:border-cyan-500 focus:outline-hidden"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
