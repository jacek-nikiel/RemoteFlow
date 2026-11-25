import React, { useState, useRef } from 'react';
import {
  X,
  Upload,
  Download,
  Lock,
  FileCode,
  CheckCircle2,
  AlertCircle,
  FileText,
  Loader2,
  Database,
  FolderOpen,
} from 'lucide-react';
import { api, MrngParams } from '../../services/api';
import { parseMRemoteNGXml, readMRemoteNGEncryption, MRemoteNGParseResult } from '../../utils/mremoteng';
import { tn, useT } from '../../i18n';
import { Connection, Group } from '../../types';
import { ExportScope, ExportScopeSelector } from './ExportScopeSelector';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onDataChanged: () => Promise<void>;
  groups: Group[];
  connections: Connection[];
}

export const ImportExportModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onDataChanged,
  groups,
  connections,
}) => {
  const t = useT();
  const [activeTab, setActiveTab] = useState<'export' | 'import_rf' | 'import_mrng'>('export');

  // Export state
  const [exportEncrypted, setExportEncrypted] = useState(true);
  const [exportPassword, setExportPassword] = useState('');
  const [confirmExportPassword, setConfirmExportPassword] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const [plaintextConfirmed, setPlaintextConfirmed] = useState(false);
  const [exportScope, setExportScope] = useState<ExportScope>({ groupIds: null, includeUngrouped: false });
  const emptySelection = exportScope.groupIds !== null && exportScope.groupIds.length === 0 && !exportScope.includeUngrouped;

  // Import RemoteFlow state
  const [rfFileContent, setRfFileContent] = useState('');
  const [rfFileName, setRfFileName] = useState('');
  const [rfImportPassword, setRfImportPassword] = useState('');
  const [rfMerge, setRfMerge] = useState(true);
  const [rfLoading, setRfLoading] = useState(false);

  // Import mRemoteNG state
  const [mrngXmlContent, setMrngXmlContent] = useState('');
  // mRemoteNG encryption parameters / custom master password
  const [mrngParams, setMrngParams] = useState<MrngParams | null>(null);
  const [mrngNeedsPassword, setMrngNeedsPassword] = useState(false);
  const [mrngPassword, setMrngPassword] = useState('');
  const [mrngFileName, setMrngFileName] = useState('');
  const [mrngParseResult, setMrngParseResult] = useState<MRemoteNGParseResult | null>(null);
  const [mrngMerge, setMrngMerge] = useState(true);
  const [mrngLoading, setMrngLoading] = useState(false);

  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const rfFileInputRef = useRef<HTMLInputElement>(null);
  const mrngFileInputRef = useRef<HTMLInputElement>(null);

  // Handle Export
  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (emptySelection) {
      setMessage({ text: t('Wybierz co najmniej jedną grupę lub połączenia bez grupy'), type: 'error' });
      return;
    }
    if (exportEncrypted) {
      if (exportPassword.length < 8) {
        setMessage({ text: t('Hasło eksportu musi mieć co najmniej 8 znaków'), type: 'error' });
        return;
      }
      if (exportPassword !== confirmExportPassword) {
        setMessage({ text: t('Wprowadzone hasła nie są identyczne'), type: 'error' });
        return;
      }
    } else if (!plaintextConfirmed) {
      setMessage({
        text: t('Potwierdź, że rozumiesz, iż plik będzie zawierał wszystkie hasła i klucze prywatne jawnym tekstem.'),
        type: 'error',
      });
      return;
    }

    setExportLoading(true);
    try {
      const payloadString = await api.exportVault(
        exportEncrypted ? exportPassword : undefined,
        !exportEncrypted && plaintextConfirmed,
        exportScope.groupIds,
        exportScope.includeUngrouped
      );
      
      // Saved where the user chooses ("Save as" dialog)
      const dateStr = new Date().toISOString().split('T')[0];
      const savedPath = await api.saveFileAs(
        exportEncrypted ? `remoteflow-export-encrypted-${dateStr}.rfvault` : `remoteflow-export-plain-${dateStr}.json`,
        payloadString,
        exportEncrypted ? t('Zaszyfrowany eksport RemoteFlow') : t('Jawny eksport RemoteFlow (JSON)'),
        exportEncrypted ? 'rfvault' : 'json'
      );
      if (!savedPath) {
        // Cancelled in the dialog – nothing was written
        return;
      }

      setMessage({
        text: exportEncrypted
          ? t('Zapisano zaszyfrowany plik eksportu: {path}', { path: savedPath })
          : t('Zapisano jawny plik eksportu: {path}', { path: savedPath }),
        type: 'success',
      });
      setExportPassword('');
      setConfirmExportPassword('');
    } catch (err: unknown) {
      setMessage({ text: err instanceof Error ? err.message : String(err), type: 'error' });
    } finally {
      setExportLoading(false);
    }
  };

  // Handle File Selection for RemoteFlow Import
  const handleRfFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setRfFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setRfFileContent(text);
      setMessage(null);
    };
    reader.readAsText(file);
  };

  const handleImportRemoteFlow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rfFileContent.trim()) {
      setMessage({ text: t('Wybierz plik do importu'), type: 'error' });
      return;
    }

    setRfLoading(true);
    setMessage(null);
    try {
      const summary = await api.importVault(
        rfFileContent,
        rfImportPassword ? rfImportPassword : undefined,
        rfMerge
      );
      await onDataChanged();
      setMessage({
        text: t('Pomyślnie zaimportowano {connectionsImported} połączeń, {groupsImported} folderów oraz {p2} poświadczeń!', { connectionsImported: summary.connectionsImported, groupsImported: summary.groupsImported, p2: summary.credentialsImported ?? 0 }),
        type: 'success',
      });
      setRfFileContent('');
      setRfFileName('');
      setRfImportPassword('');
    } catch (err: unknown) {
      setMessage({ text: err instanceof Error ? err.message : String(err), type: 'error' });
    } finally {
      setRfLoading(false);
    }
  };

  // Handle File Selection for mRemoteNG Import
  const handleMrngFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setMrngFileName(file.name);
    setMrngPassword('');
    setMrngNeedsPassword(false);
    const reader = new FileReader();
    reader.onload = (event) => {
      const xml = event.target?.result as string;
      setMrngXmlContent(xml);
      prepareMRemoteNG(xml, null);
    };
    reader.readAsText(file);
  };

  // Reads encryption settings, verifies the mRemoteNG master password (default "mR3m" or custom),
  // decrypts "full file encryption" files and parses the connections. Passwords stay encrypted
  // here – they are decrypted only in the Rust backend during the import.
  const prepareMRemoteNG = async (xml: string, password: string | null) => {
    setMessage(null);
    setMrngParseResult(null);
    try {
      const enc = readMRemoteNGEncryption(xml);
      const params: MrngParams = {
        password: password || null,
        encryptionEngine: enc.encryptionEngine,
        blockCipherMode: enc.blockCipherMode,
        kdfIterations: enc.kdfIterations,
      };
      let xmlToParse = xml;
      try {
        const inner = await api.mremotengUnlock(params, enc.protected, enc.encryptedPayload);
        if (inner) xmlToParse = `<Connections>${inner}</Connections>`;
        setMrngNeedsPassword(false);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('MRNG_PASSWORD_REQUIRED')) {
          setMrngNeedsPassword(true);
          setMessage({
            text: password
              ? t('Nieprawidłowe hasło główne mRemoteNG.')
              : t('Plik mRemoteNG jest zabezpieczony własnym hasłem głównym – podaj je poniżej.'),
            type: 'error',
          });
          return;
        }
        throw err;
      }
      setMrngParams(params);
      setMrngParseResult(parseMRemoteNGXml(xmlToParse));
    } catch (err: unknown) {
      setMessage({ text: err instanceof Error ? err.message : String(err), type: 'error' });
      setMrngParseResult(null);
    }
  };

  const handleImportMRemoteNG = async () => {
    if (!mrngParseResult || mrngParseResult.connections.length === 0) {
      setMessage({ text: t('Brak połączeń do zaimportowania'), type: 'error' });
      return;
    }

    setMrngLoading(true);
    setMessage(null);
    try {
      const summary = await api.batchImport(
        mrngParseResult.groups,
        mrngParseResult.connections,
        mrngMerge,
        mrngParams
      );
      await onDataChanged();
      const failed = summary.passwordsFailed ?? 0;
      setMessage({
        text:
          t('Pomyślnie zaimportowano z mRemoteNG: {connectionsImported} połączeń w {groupsImported} folderach!', { connectionsImported: summary.connectionsImported, groupsImported: summary.groupsImported }) +
          (failed > 0 ? t(' Nie udało się odszyfrować {failed} haseł – te połączenia zaimportowano bez hasła.', { failed }) : ''),
        type: failed > 0 ? 'error' : 'success',
      });
      setMrngParseResult(null);
      setMrngXmlContent('');
      setMrngFileName('');
      setMrngParams(null);
      setMrngPassword('');
    } catch (err: unknown) {
      setMessage({ text: err instanceof Error ? err.message : String(err), type: 'error' });
    } finally {
      setMrngLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="flex h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex h-14 items-center justify-between border-b border-slate-800 px-6 bg-slate-900/80">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-cyan-400" />
            <h2 className="text-sm font-bold text-white">
              {t('Import & Eksport Połączeń')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 bg-slate-950/60 px-6 gap-2 text-xs font-medium">
          <button
            onClick={() => {
              setActiveTab('export');
              setMessage(null);
            }}
            className={`flex items-center gap-1.5 border-b-2 py-3 px-3 transition-colors ${
              activeTab === 'export'
                ? 'border-cyan-400 text-white font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Download className="h-3.5 w-3.5" />
            {t('Eksport Bazy')}
          </button>
          <button
            onClick={() => {
              setActiveTab('import_rf');
              setMessage(null);
            }}
            className={`flex items-center gap-1.5 border-b-2 py-3 px-3 transition-colors ${
              activeTab === 'import_rf'
                ? 'border-cyan-400 text-white font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Upload className="h-3.5 w-3.5" />
            {t('Import (RemoteFlow)')}
          </button>
          <button
            onClick={() => {
              setActiveTab('import_mrng');
              setMessage(null);
            }}
            className={`flex items-center gap-1.5 border-b-2 py-3 px-3 transition-colors ${
              activeTab === 'import_mrng'
                ? 'border-cyan-400 text-white font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <FolderOpen className="h-3.5 w-3.5 text-amber-400" />
            {t('Import z mRemoteNG (XML)')}
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-6">
          {message && (
            <div
              className={`mb-4 flex items-center gap-2 rounded-xl border p-3 text-xs ${
                message.type === 'success'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-red-500/30 bg-red-500/10 text-red-400'
              }`}
            >
              {message.type === 'success' ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
              )}
              <span>{message.text}</span>
            </div>
          )}

          {/* TAB 1: EXPORT */}
          {activeTab === 'export' && (
            <form onSubmit={handleExport} className="space-y-5">
              <ExportScopeSelector groups={groups} connections={connections} value={exportScope}
                onChange={(scope) => { setExportScope(scope); setMessage(null); }} disabled={exportLoading} />
              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
                <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Download className="h-3.5 w-3.5 text-cyan-400" />
                  {t('Format i Opcje Eksportu')}
                </div>
                <p className="text-xs text-slate-400">
                  {t('Wyeksportuj konfiguracje połączeń z wybranego zakresu, tunele SSH i poświadczenia do pliku.')}
                </p>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setExportEncrypted(true)}
                    className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-all ${
                      exportEncrypted
                        ? 'border-cyan-500 bg-cyan-500/10 text-white shadow-sm'
                        : 'border-slate-800 bg-slate-800/40 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <Lock className="h-5 w-5 text-cyan-400 mt-0.5" />
                    <div>
                      <div className="text-xs font-bold">{t('Zaszyfrowany plik (.rfvault)')}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {t('Zabezpieczony hasłem (Argon2id + AES-GCM). Rekomendowany do kopii zapasowych i przenoszenia.')}
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setExportEncrypted(false)}
                    className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-all ${
                      !exportEncrypted
                        ? 'border-amber-500 bg-amber-500/10 text-white shadow-sm'
                        : 'border-slate-800 bg-slate-800/40 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <FileCode className="h-5 w-5 text-amber-400 mt-0.5" />
                    <div>
                      <div className="text-xs font-bold">{t('Jawny plik JSON (.json)')}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {t('Czytelny format tekstowy do skryptów lub audytu.')}
                      </div>
                    </div>
                  </button>
                </div>
              </div>

              {!exportEncrypted && (
                <label className="flex items-start gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] text-amber-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={plaintextConfirmed}
                    onChange={(e) => setPlaintextConfirmed(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-amber-500/60 bg-slate-800 text-amber-500 focus:ring-0"
                  />
                  <span>
                    {t('Rozumiem, że plik JSON będzie zawierał wszystkie hasła, klucze prywatne SSH i hasła do kluczy jawnym tekstem. Każdy, kto uzyska dostęp do pliku, przejmie te dane.')}
                  </span>
                </label>
              )}

              {exportEncrypted && (
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
                  <div className="text-xs font-semibold text-slate-300">
                    {t('Hasło szyfrujące plik eksportu')}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] text-slate-400">
                        {t('Wprowadź hasło')}
                      </label>
                      <input
                        type="password"
                        value={exportPassword}
                        onChange={(e) => setExportPassword(e.target.value)}
                        placeholder={t('Hasło do pliku eksportu...')}
                        required
                        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400">
                        {t('Powtórz hasło')}
                      </label>
                      <input
                        type="password"
                        value={confirmExportPassword}
                        onChange={(e) => setConfirmExportPassword(e.target.value)}
                        placeholder={t('Powtórz hasło...')}
                        required
                        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={exportLoading || emptySelection}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 py-3 text-xs font-semibold text-white shadow-lg shadow-cyan-600/20 hover:opacity-95 disabled:opacity-50"
              >
                {exportLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('Szyfrowanie i generowanie pliku...')}
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" />
                    {t('Zapisz plik eksportu ({ext})…', { ext: exportEncrypted ? '.rfvault' : '.json' })}
                  </>
                )}
              </button>
            </form>
          )}

          {/* TAB 2: IMPORT REMOTEFLOW */}
          {activeTab === 'import_rf' && (
            <form onSubmit={handleImportRemoteFlow} className="space-y-5">
              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
                <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Upload className="h-3.5 w-3.5 text-cyan-400" />
                  {t('Wybierz plik RemoteFlow (.rfvault lub .json)')}
                </div>

                <input
                  type="file"
                  ref={rfFileInputRef}
                  accept=".rfvault,.json"
                  onChange={handleRfFileChange}
                  className="hidden"
                />

                <div
                  onClick={() => rfFileInputRef.current?.click()}
                  className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-700 p-8 text-center cursor-pointer hover:border-cyan-500 hover:bg-slate-800/40 transition-colors"
                >
                  <FileText className="h-8 w-8 text-slate-400 mb-2" />
                  <div className="text-xs font-semibold text-slate-200">
                    {rfFileName ? rfFileName : t('Kliknij, aby wybrać plik .rfvault lub .json')}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1">
                    {t('Obsługuje zarówno pliki zaszyfrowane, jak i jawne')}
                  </div>
                </div>
              </div>

              {/* Password field if encrypted */}
              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-2">
                <label className="block text-xs font-semibold text-slate-300">
                  {t('Hasło odszyfrowania pliku (jeśli plik był zaszyfrowany hasłem)')}
                </label>
                <input
                  type="password"
                  value={rfImportPassword}
                  onChange={(e) => setRfImportPassword(e.target.value)}
                  placeholder={t('Wprowadź hasło pliku (opcjonalnie dla jawnego JSON)...')}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                />
              </div>

              {/* Merge / Replace option */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={rfMerge}
                  onChange={(e) => setRfMerge(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                />
                <span className="text-xs text-slate-300">
                  {t('Połącz z istniejącymi połączeniami (Merge) zamiast zastępować całą bazę')}
                </span>
              </label>

              <button
                type="submit"
                disabled={rfLoading || !rfFileContent}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 py-3 text-xs font-semibold text-white shadow-lg shadow-cyan-600/20 hover:opacity-95 disabled:opacity-50"
              >
                {rfLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('Odszyfrowywanie i importowanie...')}
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4" />
                    {t('Zaimportuj połączenia')}
                  </>
                )}
              </button>
            </form>
          )}

          {/* TAB 3: IMPORT MREMOTENG */}
          {activeTab === 'import_mrng' && (
            <div className="space-y-5">
              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
                <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <FolderOpen className="h-3.5 w-3.5 text-amber-400" />
                  {t('Import z pliku XML mRemoteNG (confCons.xml)')}
                </div>
                <p className="text-xs text-slate-400">
                  {t('Wybierz plik confCons.xml wyeksportowany z programu mRemoteNG (lub zlokalizowany w %APPDATA%\\mRemoteNG\\confCons.xml).')}
                </p>

                <input
                  type="file"
                  ref={mrngFileInputRef}
                  accept=".xml"
                  onChange={handleMrngFileChange}
                  className="hidden"
                />

                <div
                  onClick={() => mrngFileInputRef.current?.click()}
                  className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-700 p-8 text-center cursor-pointer hover:border-amber-500 hover:bg-slate-800/40 transition-colors"
                >
                  <FileCode className="h-8 w-8 text-amber-400 mb-2" />
                  <div className="text-xs font-semibold text-slate-200">
                    {mrngFileName ? mrngFileName : t('Kliknij, aby wybrać plik confCons.xml')}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1">
                    {t('Automatycznie odczyta foldery, połączenia RDP, SSH, porty i opisy')}
                  </div>
                </div>
              </div>

              {/* Custom mRemoteNG master password */}
              {mrngNeedsPassword && mrngXmlContent && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
                  <label className="block text-xs font-semibold text-amber-200">
                    {t('Hasło główne mRemoteNG (Opcje → Bezpieczeństwo w mRemoteNG)')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={mrngPassword}
                      autoFocus
                      onChange={(e) => setMrngPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          prepareMRemoteNG(mrngXmlContent, mrngPassword);
                        }
                      }}
                      placeholder={t('Hasło użyte do zabezpieczenia pliku confCons.xml')}
                      className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={!mrngPassword}
                      onClick={() => prepareMRemoteNG(mrngXmlContent, mrngPassword)}
                      className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
                    >
                      {t('Odblokuj')}
                    </button>
                  </div>
                </div>
              )}

              {/* Parsed Preview */}
              {mrngParseResult && (
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4" />
                      {t('Wykryto poprawną strukturę mRemoteNG')}
                    </span>
                    <span className="text-xs text-slate-300 font-mono">
                      {tn(mrngParseResult.connections.length, ['{c} połączenie', '{c} połączenia', '{c} połączeń'], { c: mrngParseResult.connections.length })}{' '}
                      {tn(mrngParseResult.groups.length, ['w {g} folderze', 'w {g} folderach', 'w {g} folderach'], { g: mrngParseResult.groups.length })}
                    </span>
                  </div>

                  {mrngParseResult.skipped.length > 0 && (
                    <div
                      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200"
                      title={mrngParseResult.skipped.map((x) => `${x.name} (${x.protocol})`).join('\n')}
                    >
                      {t('Pominięto połączenia z nieobsługiwanymi protokołami ({n}): {list}. RemoteFlow obsługuje SSH i RDP.', {
                        n: mrngParseResult.skipped.length,
                        list: Object.entries(
                          mrngParseResult.skipped.reduce<Record<string, number>>((acc, x) => {
                            acc[x.protocol] = (acc[x.protocol] || 0) + 1;
                            return acc;
                          }, {})
                        )
                          .map(([proto, count]) => `${proto} × ${count}`)
                          .join(', '),
                      })}
                    </div>
                  )}

                  {/* Sample preview list */}
                  <div className="max-h-48 overflow-y-auto space-y-1 rounded-lg border border-slate-800 p-2 bg-slate-900/50">
                    {mrngParseResult.connections.slice(0, 15).map((c) => (
                      <div key={c.id} className="flex items-center justify-between text-[11px] py-1 px-2 rounded hover:bg-slate-800">
                        <div className="flex items-center gap-2">
                          <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${c.protocol === 'ssh' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-blue-500/20 text-blue-300'}`}>
                            {c.protocol.toUpperCase()}
                          </span>
                          <span className="text-slate-200 font-medium">{c.name}</span>
                        </div>
                        <span className="text-slate-500 font-mono">{c.host}:{c.port}</span>
                      </div>
                    ))}
                    {mrngParseResult.connections.length > 15 && (
                      <div className="text-center text-[11px] text-slate-500 py-1">
                        {t('... oraz {n} kolejnych połączeń', { n: mrngParseResult.connections.length - 15 })}
                      </div>
                    )}
                  </div>

                  <label className="flex items-center gap-2 cursor-pointer pt-1">
                    <input
                      type="checkbox"
                      checked={mrngMerge}
                      onChange={(e) => setMrngMerge(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                    />
                    <span className="text-xs text-slate-300">
                      {t('Połącz z istniejącą bazą (Merge)')}
                    </span>
                  </label>

                  <button
                    type="button"
                    onClick={handleImportMRemoteNG}
                    disabled={mrngLoading}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 py-3 text-xs font-semibold text-white shadow-lg shadow-emerald-600/20 hover:opacity-95 disabled:opacity-50"
                  >
                    {mrngLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t('Szyfrowanie i zapisywanie do bazy...')}
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4" />
                        {tn(mrngParseResult.connections.length, ['Zatwierdź i zaimportuj {n} połączenie', 'Zatwierdź i zaimportuj {n} połączenia', 'Zatwierdź i zaimportuj {n} połączeń'], { n: mrngParseResult.connections.length })}
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
