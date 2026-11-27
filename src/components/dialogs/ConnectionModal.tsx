import React, { useState, useEffect, useMemo } from 'react';
import { jumpChain, jumpHostCandidates } from '../../utils/jumpHosts';
import {
  X,
  Terminal,
  Monitor,
  Eye,
  EyeOff,
  ArrowRightLeft,
  Plus,
  Trash2,
  Shield,
  Loader2,
  KeyRound,
  FolderDown,
  Check,
} from 'lucide-react';
import { api } from '../../services/api';
import {
  Connection,
  Credential,
  Group,
  PortForwardRule,
  ProtocolType,
  SshAuthType,
  ForwardType,
} from '../../types';
import { normalizeRdpIdentity, rdpLoginLabel } from '../../utils/rdpIdentity';
import { useT } from '../../i18n';
import { SshKeyFields } from './SshKeyFields';
import { JumpHostPicker } from './JumpHostPicker';
import { clampTyped, isValidPort, isValidRdpSize, MAX_PORT, MAX_RDP_SIZE, MIN_RDP_SIZE } from '../../utils/numberInput';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (connection: Connection, rawPassword?: string, rawKey?: string, rawPassphrase?: string) => Promise<void>;
  editingConnection: Connection | null;
  groups: Group[];
  credentials: Credential[];
  defaultGroupId: string | null;
  /** Creates a new folder/group directly from the connection form. */
  onCreateGroup?: (group: Group) => Promise<Group>;
  /** New connection pre-filled from a quick connection ("Save in the vault" on its tab). */
  draft?: Partial<Connection> | null;
  /** Saved connections – the jump host choice. */
  connections?: Connection[];
}

export const ConnectionModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onSave,
  editingConnection,
  groups,
  credentials,
  defaultGroupId,
  onCreateGroup,
  draft,
  connections = [],
}) => {
  const t = useT();
  const [activeTab, setActiveTab] = useState<'general' | 'auth' | 'tunnels' | 'rdp' | 'notes'>('general');

  // Form states
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);
  // Inline "new group" form
  const [isAddingGroup, setIsAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupParentId, setNewGroupParentId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [protocol, setProtocol] = useState<ProtocolType>('ssh');
  const [host, setHost] = useState('');
  const [port, setPort] = useState<number>(22);
  const [jumpHostId, setJumpHostId] = useState<string>('');
  const [username, setUsername] = useState('');

  // Password & credentials
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [revealingPassword, setRevealingPassword] = useState(false);

  const [sshAuthType, setSshAuthType] = useState<SshAuthType>('password');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [certificateContent, setCertificateContent] = useState('');
  const [keyInputMode, setKeyInputMode] = useState<'file' | 'text'>('file');
  const [keyFilePath, setKeyFilePath] = useState('');
  const [promptKeyPassphrase, setPromptKeyPassphrase] = useState(false);
  const [certInputMode, setCertInputMode] = useState<'file' | 'text'>('file');
  const [certFilePath, setCertFilePath] = useState('');

  // Port forwarding
  const [portForwarding, setPortForwarding] = useState<PortForwardRule[]>([]);

  // RDP settings
  const [rdpWidth, setRdpWidth] = useState(1920);
  const [rdpHeight, setRdpHeight] = useState(1080);
  const [rdpDomain, setRdpDomain] = useState('');
  const [rdpSound, setRdpSound] = useState(false);
  const [rdpClipboard, setRdpClipboard] = useState(true);

  // Tags & notes
  const [tagsInput, setTagsInput] = useState('');
  const [notes, setNotes] = useState('');
  const [defaultDownloadDir, setDefaultDownloadDir] = useState(''); // RDP exchange folder
  const [sftpLocalDir, setSftpLocalDir] = useState('');
  const [sftpRemoteDir, setSftpRemoteDir] = useState('');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editingConnection) {
      setName(editingConnection.name);
      setGroupId(editingConnection.groupId);
      setCredentialId(editingConnection.credentialId || null);
      setProtocol(editingConnection.protocol);
      setHost(editingConnection.host);
      setPort(editingConnection.port);
      setJumpHostId(editingConnection.jumpHostId || '');
      setUsername(editingConnection.username);
      setSshAuthType(editingConnection.sshAuthType);
      setPassword(''); // keep blank unless user types new one or reveals
      setShowPassword(false);
      setPrivateKey('');
      setPassphrase('');
      setKeyFilePath(editingConnection.keyFilePath || '');
      setPromptKeyPassphrase(Boolean(editingConnection.promptKeyPassphrase));
      setKeyInputMode(editingConnection.keyFilePath ? 'file' : 'text');
      setCertificateContent(editingConnection.certificateContent || '');
      setCertFilePath(editingConnection.certificateFilePath || '');
      setCertInputMode(editingConnection.certificateFilePath || !editingConnection.certificateContent ? 'file' : 'text');
      setPortForwarding(editingConnection.portForwarding || []);
      if (editingConnection.rdpSettings) {
        setRdpWidth(editingConnection.rdpSettings.width);
        setRdpHeight(editingConnection.rdpSettings.height);
        setRdpDomain(editingConnection.rdpSettings.domain || '');
        setRdpSound(editingConnection.rdpSettings.sound);
        setRdpClipboard(editingConnection.rdpSettings.clipboard);
      }
      setTagsInput(editingConnection.tags.join(', '));
      setNotes(editingConnection.notes || '');
      const isSsh = editingConnection.protocol === 'ssh';
      setDefaultDownloadDir(isSsh ? '' : editingConnection.defaultDownloadDir || '');
      // Up to 1.1.3 the SFTP local start folder was kept in defaultDownloadDir
      setSftpLocalDir(editingConnection.sftpLocalDir || (isSsh ? editingConnection.defaultDownloadDir || '' : ''));
      setSftpRemoteDir(editingConnection.sftpRemoteDir || '');
    } else {
      // New connection defaults
      setName('');
      setGroupId(defaultGroupId);
      setCredentialId(null);
      setProtocol('ssh');
      setHost('');
      setPort(22);
      setJumpHostId('');
      setUsername('root');
      setPassword('');
      setShowPassword(false);
      setSshAuthType('password');
      setPrivateKey('');
      setPassphrase('');
      setKeyFilePath('');
      setPromptKeyPassphrase(false);
      setKeyInputMode('file');
      setCertificateContent('');
      setCertFilePath('');
      setCertInputMode('file');
      setPortForwarding([]);
      setRdpWidth(1920);
      setRdpHeight(1080);
      setRdpDomain('');
      setRdpSound(false);
      setRdpClipboard(true);
      setTagsInput('');
      setNotes('');
      setDefaultDownloadDir('');
      setSftpLocalDir('');
      setSftpRemoteDir('');
      if (draft) {
        setName(draft.name ?? '');
        if (draft.protocol) setProtocol(draft.protocol);
        if (draft.host) setHost(draft.host);
        if (draft.port) setPort(draft.port);
        setUsername(draft.username ?? '');
        if (draft.sshAuthType) setSshAuthType(draft.sshAuthType);
      }
    }
    setActiveTab('general');
    setError(null);
    setIsAddingGroup(false);
    setGroupError(null);
  }, [editingConnection, defaultGroupId, isOpen, draft]);

  const selfId = editingConnection?.id ?? null;
  const jumpCandidates = useMemo(() => jumpHostCandidates(connections, selfId), [connections, selfId]);
  // "this computer → bastion2 → bastion1 → target" for the hint under the field
  const jumpPath = useMemo(() => {
    if (!jumpHostId) return '';
    const first = connections.find((c) => c.id === jumpHostId);
    if (!first) return '';
    const chain = [first, ...jumpChain(connections, first)].reverse();
    return [t('ten komputer'), ...chain.map((c) => c.name), name.trim() || host.trim() || t('cel')].join(' → ');
  }, [jumpHostId, connections, name, host, t]);

  const handleCreateGroup = async () => {
    if (!onCreateGroup) return;
    const trimmed = newGroupName.trim();
    if (!trimmed) {
      setGroupError(t('Podaj nazwę grupy'));
      return;
    }
    const duplicate = groups.some(
      (g) => g.name.trim().toLowerCase() === trimmed.toLowerCase() && (g.parentId || null) === newGroupParentId
    );
    if (duplicate) {
      setGroupError(t('Grupa o tej nazwie już istnieje w wybranym miejscu'));
      return;
    }
    setCreatingGroup(true);
    setGroupError(null);
    try {
      const created = await onCreateGroup({
        id: 'group-' + Math.random().toString(36).substring(2, 9),
        name: trimmed,
        parentId: newGroupParentId,
        icon: 'folder',
        color: '#3b82f6',
      });
      setGroupId(created.id);
      setIsAddingGroup(false);
      setNewGroupName('');
    } catch (err: unknown) {
      setGroupError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingGroup(false);
    }
  };

  // Update default port when changing protocol
  const handleProtocolChange = (p: ProtocolType) => {
    setProtocol(p);
    if (!editingConnection) {
      setPort(p === 'ssh' ? 22 : 3389);
    }
  };

  // Reveal password via Master Password (Założenie 7)
  const handleRevealPassword = async () => {
    if (!editingConnection) {
      setShowPassword(!showPassword);
      return;
    }

    if (showPassword) {
      setShowPassword(false);
      return;
    }

    setRevealingPassword(true);
    try {
      const plaintext = await api.revealPassword(editingConnection.id);
      setPassword(plaintext);
      setShowPassword(true);
    } catch (err: unknown) {
      setError(t('Nie udało się odszyfrować hasła: ') + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRevealingPassword(false);
    }
  };

  // Port forwarding rule management (Założenie 4)
  const addPortForwardRule = (forwardType: ForwardType) => {
    const newRule: PortForwardRule = {
      id: 'pf-' + Math.random().toString(36).substring(2, 9),
      forwardType,
      localPort: forwardType === 'dynamic' ? 1080 : 8080,
      remoteHost: forwardType === 'dynamic' ? undefined : '127.0.0.1',
      remotePort: forwardType === 'dynamic' ? undefined : 80,
      enabled: true,
    };
    setPortForwarding([...portForwarding, newRule]);
  };

  const removePortForwardRule = (id: string) => {
    setPortForwarding(portForwarding.filter(r => r.id !== id));
  };

  const updatePortForwardRule = (id: string, updates: Partial<PortForwardRule>) => {
    setPortForwarding(portForwarding.map(r => r.id === id ? { ...r, ...updates } : r));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t('Podaj nazwę połączenia'));
      setActiveTab('general');
      return;
    }
    if (!host.trim()) {
      setError(t('Podaj adres hosta'));
      setActiveTab('general');
      return;
    }
    if (!isValidPort(port)) {
      setError(t('Port musi być liczbą od 1 do {max}', { max: MAX_PORT }));
      setActiveTab('general');
      return;
    }
    if (protocol === 'ssh' && portForwarding.some((r) => !isValidPort(r.localPort) || (r.forwardType !== 'dynamic' && !isValidPort(r.remotePort ?? 80)))) {
      setError(t('Porty tuneli SSH muszą być liczbami od 1 do {max}', { max: MAX_PORT }));
      setActiveTab('tunnels');
      return;
    }
    if (protocol === 'rdp' && (!isValidRdpSize(rdpWidth) || !isValidRdpSize(rdpHeight))) {
      setError(t('Rozdzielczość RDP: szerokość i wysokość od {min} do {max} pikseli', { min: MIN_RDP_SIZE, max: MAX_RDP_SIZE }));
      setActiveTab('rdp');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const conn: Connection = {
        id: editingConnection ? editingConnection.id : 'conn-' + Math.random().toString(36).substring(2, 9),
        name: name.trim(),
        groupId,
        credentialId: credentialId || undefined,
        protocol,
        host: host.trim(),
        port,
        username: username.trim(),
        passwordEncrypted: editingConnection ? editingConnection.passwordEncrypted : undefined,
        sshAuthType,
        privateKeyEncrypted: editingConnection ? editingConnection.privateKeyEncrypted : undefined,
        privateKeyPassphraseEncrypted: promptKeyPassphrase ? undefined : (editingConnection ? editingConnection.privateKeyPassphraseEncrypted : undefined),
        certificateContent: certificateContent.trim() || undefined,
        // The file (read at every connection) applies only when "file" is selected – otherwise a
        // pasted key/certificate would be silently replaced by an old file.
        certificateFilePath: (certInputMode === 'file' && certFilePath.trim()) || undefined,
        keyFilePath: (keyInputMode === 'file' && keyFilePath.trim()) || undefined,
        promptKeyPassphrase: Boolean(promptKeyPassphrase),
        jumpHostId: jumpHostId || undefined,
        portForwarding,
        rdpSettings: protocol === 'rdp' ? {
          width: rdpWidth,
          height: rdpHeight,
          colorDepth: 32,
          domain: rdpDomain.trim() || undefined,
          sound: rdpSound,
          clipboard: rdpClipboard,
        } : undefined,
        tags: tagsInput.split(',').map(t => t.trim()).filter(Boolean),
        notes: notes.trim() || undefined,
        defaultDownloadDir: protocol === 'rdp' ? defaultDownloadDir.trim() || undefined : undefined,
        sftpLocalDir: protocol === 'ssh' ? sftpLocalDir.trim() || undefined : undefined,
        sftpRemoteDir: protocol === 'ssh' ? sftpRemoteDir.trim() || undefined : undefined,
        createdAt: editingConnection ? editingConnection.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await onSave(
        conn,
        password ? password : undefined,
        privateKey ? privateKey : undefined,
        promptKeyPassphrase ? '' : (passphrase ? passphrase : undefined)
      );

      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="flex h-[88vh] w-full max-w-3xl flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex h-14 items-center justify-between border-b border-slate-800 px-6 bg-slate-900/80">
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                protocol === 'ssh'
                  ? 'bg-emerald-500/10 text-emerald-400'
                  : 'bg-blue-500/10 text-blue-400'
              }`}
            >
              {protocol === 'ssh' ? <Terminal className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">
                {editingConnection ? t('Edytuj połączenie') : t('Nowe połączenie')}
              </h2>
              <p className="text-[11px] text-slate-400">
                {t('Konfiguracja hosta, poświadczeń i tuneli')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Modal Tabs */}
        <div className="flex border-b border-slate-800 bg-slate-950/60 px-6 gap-2 text-xs font-medium">
          <button
            onClick={() => setActiveTab('general')}
            className={`border-b-2 py-2.5 px-3 transition-colors ${
              activeTab === 'general'
                ? 'border-cyan-400 text-white font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('Ogólne')}
          </button>
          <button
            onClick={() => setActiveTab('auth')}
            className={`border-b-2 py-2.5 px-3 transition-colors ${
              activeTab === 'auth'
                ? 'border-cyan-400 text-white font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('Uwierzytelnianie & Klucze')}
          </button>
          {protocol === 'ssh' && (
            <button
              onClick={() => setActiveTab('tunnels')}
              className={`border-b-2 py-2.5 px-3 transition-colors ${
                activeTab === 'tunnels'
                  ? 'border-cyan-400 text-white font-semibold'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('Tunele SSH ({n})', { n: portForwarding.length })}
            </button>
          )}
          {protocol === 'rdp' && (
            <button
              onClick={() => setActiveTab('rdp')}
              className={`border-b-2 py-2.5 px-3 transition-colors ${
                activeTab === 'rdp'
                  ? 'border-cyan-400 text-white font-semibold'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('Ustawienia RDP')}
            </button>
          )}
          <button
            onClick={() => setActiveTab('notes')}
            className={`border-b-2 py-2.5 px-3 transition-colors ${
              activeTab === 'notes'
                ? 'border-cyan-400 text-white font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t('Tagi & Notatki')}
          </button>
        </div>

        {/* Tab Content */}
        <form onSubmit={handleSubmit} className="flex flex-1 flex-col justify-between overflow-hidden">
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
                {error}
              </div>
            )}

            {/* TAB: GENERAL */}
            {activeTab === 'general' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300">
                      {t('Nazwa wyświetlana')}
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t('np. web-prod-01 (Nginx)')}
                      required
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-300">
                      {t('Folder / Grupa')}
                    </label>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <select
                        value={groupId || ''}
                        onChange={(e) => setGroupId(e.target.value || null)}
                        className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                      >
                        <option value="">{t('(Brak - poziom główny)')}</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                      {onCreateGroup && (
                        <button
                          type="button"
                          title={t('Dodaj nową grupę')}
                          onClick={() => {
                            setIsAddingGroup((v) => !v);
                            setNewGroupName('');
                            setNewGroupParentId(groupId);
                            setGroupError(null);
                          }}
                          className={`shrink-0 rounded-lg border px-2 py-2 text-xs transition-colors ${
                            isAddingGroup
                              ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300'
                              : 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
                          }`}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {isAddingGroup && onCreateGroup && (
                      <div className="mt-2 space-y-2 rounded-lg border border-cyan-800/40 bg-slate-950/60 p-2.5">
                        <input
                          type="text"
                          autoFocus
                          value={newGroupName}
                          onChange={(e) => setNewGroupName(e.target.value)}
                          onKeyDown={(e) => {
                            // Do not submit the whole connection form with Enter
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleCreateGroup();
                            } else if (e.key === 'Escape') {
                              e.stopPropagation();
                              setIsAddingGroup(false);
                            }
                          }}
                          placeholder={t('Nazwa nowej grupy...')}
                          className="w-full rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                        />
                        <select
                          value={newGroupParentId || ''}
                          onChange={(e) => setNewGroupParentId(e.target.value || null)}
                          className="w-full rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] text-slate-300 focus:border-cyan-500 focus:outline-none"
                        >
                          <option value="">{t('Grupa nadrzędna: (brak - poziom główny)')}</option>
                          {groups.map((g) => (
                            <option key={g.id} value={g.id}>
                              {t('Grupa nadrzędna: {name}', { name: g.name })}
                            </option>
                          ))}
                        </select>
                        {groupError && <div className="text-[11px] text-red-400">{groupError}</div>}
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setIsAddingGroup(false)}
                            className="rounded-md border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                          >
                            {t('Anuluj')}
                          </button>
                          <button
                            type="button"
                            disabled={creatingGroup || !newGroupName.trim()}
                            onClick={handleCreateGroup}
                            className="flex items-center gap-1 rounded-md bg-cyan-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
                          >
                            {creatingGroup ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                            {t('Utwórz i wybierz')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Protocol selector */}
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    {t('Protokół połączenia')}
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => handleProtocolChange('ssh')}
                      className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-all ${
                        protocol === 'ssh'
                          ? 'border-emerald-500 bg-emerald-500/10 text-white shadow-sm'
                          : 'border-slate-800 bg-slate-800/40 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <Terminal className="h-5 w-5 text-emerald-400" />
                      <div>
                        <div className="text-xs font-semibold">{t('SSH (Terminal & Tunele)')}</div>
                        <div className="text-[10px] text-slate-400">
                          {t('Port 22, klucze, certyfikaty, SOCKS5')}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleProtocolChange('rdp')}
                      className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-all ${
                        protocol === 'rdp'
                          ? 'border-blue-500 bg-blue-500/10 text-white shadow-sm'
                          : 'border-slate-800 bg-slate-800/40 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      <Monitor className="h-5 w-5 text-blue-400" />
                      <div>
                        <div className="text-xs font-semibold">{t('RDP (Pulpit Zdalny Windows)')}</div>
                        <div className="text-[10px] text-slate-400">
                          {t('Port 3389, graficzny interfejs, schowek')}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Host & Port */}
                <div className="grid grid-cols-3 gap-4">
                  <div className="col-span-2">
                    <label className="block text-xs font-semibold text-slate-300">
                      {t('Adres Hosta (IP lub domena)')}
                    </label>
                    <input
                      type="text"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder={t('192.168.1.100 lub server.domain.com')}
                      required
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-300">
                      {t('Port')}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={MAX_PORT}
                      step={1}
                      value={port || ''}
                      onChange={(e) => setPort(clampTyped(e.target.value, MAX_PORT))}
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                </div>

                {(
                  <div>
                    <label htmlFor="conn-jump-host" className="block text-xs font-semibold text-slate-300">
                      {t('Serwer pośredniczący (jump host)')}
                    </label>
                    <JumpHostPicker
                      id="conn-jump-host"
                      value={jumpHostId}
                      onChange={setJumpHostId}
                      candidates={jumpCandidates}
                      groups={groups}
                    />
                    <p className="mt-1 text-[10px] text-slate-500">
                      {jumpPath
                        ? t('Droga: {path}', { path: jumpPath })
                        : protocol === 'rdp'
                          ? t('Pulpit zdalny przez tunel SSH: połączenie idzie przez wybrany zapisany serwer SSH (bastion), który używa swoich danych logowania.')
                          : t('Jak ssh -J: połączenie idzie przez wybrany zapisany serwer SSH (bastion), który używa swoich danych logowania.')}
                    </p>
                  </div>
                )}

                {protocol === 'ssh' ? (
                  /* SFTP start folders (per connection) */
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                        <FolderDown className="h-4 w-4 text-emerald-400" />
                        <span>{t('Katalogi startowe SFTP')}</span>
                      </label>
                      {(sftpLocalDir || sftpRemoteDir) && (
                        <button
                          type="button"
                          onClick={() => {
                            setSftpLocalDir('');
                            setSftpRemoteDir('');
                          }}
                          className="text-[10px] text-slate-400 hover:text-rose-300 transition-colors"
                        >
                          {t('Przywróć katalogi domowe')}
                        </button>
                      )}
                    </div>
                    <div className="space-y-1">
                      <div className="text-[11px] text-slate-400">{t('Ten komputer')}</div>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={sftpLocalDir}
                          onChange={(e) => setSftpLocalDir(e.target.value)}
                          placeholder={t('Domyślnie: katalog domowy')}
                          className="flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            const folder = await api.pickLocalFolder();
                            if (folder) setSftpLocalDir(folder);
                          }}
                          className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 hover:text-white transition-colors shrink-0"
                        >
                          {t('Wybierz folder...')}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-[11px] text-slate-400">{t('Serwer')}</div>
                      <input
                        type="text"
                        value={sftpRemoteDir}
                        onChange={(e) => setSftpRemoteDir(e.target.value)}
                        placeholder={t('Domyślnie: katalog domowy użytkownika połączenia')}
                        className="w-full flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                    <p className="text-[10px] leading-relaxed text-slate-500">
                      {t('Bieżące katalogi można też zapamiętać przyciskiem z pinezką w oknie SFTP.')}
                    </p>
                  </div>
                ) : (
                  /* RDP: local folder for files exchanged with the remote session */
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                        <FolderDown className="h-4 w-4 text-emerald-400" />
                        <span>{t('Folder wymiany plików (RDP)')}</span>
                      </label>
                      {defaultDownloadDir && (
                        <button
                          type="button"
                          onClick={() => setDefaultDownloadDir('')}
                          className="text-[10px] text-slate-400 hover:text-rose-300 transition-colors"
                        >
                          {t('Wyczyść (użyj systemowego ~/Downloads)')}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={defaultDownloadDir}
                        onChange={(e) => setDefaultDownloadDir(e.target.value)}
                        placeholder={t('Domyślnie: ~/Downloads (pozostaw puste lub wybierz folder)')}
                        className="flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          const folder = await api.pickLocalFolder();
                          if (folder) setDefaultDownloadDir(folder);
                        }}
                        className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 hover:text-white transition-colors shrink-0"
                      >
                        {t('Wybierz folder...')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* TAB: AUTH & CREDENTIALS (Założenie 7: Podgląd hasła) */}
            {activeTab === 'auth' && (
              <div className="space-y-4">
                {/* Reusable Credentials Selector */}
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                      <KeyRound className="h-4 w-4 text-cyan-400" />
                      <span>{t('Współdzielone poświadczenia')}</span>
                    </div>
                    {credentialId && (
                      <button
                        type="button"
                        onClick={() => setCredentialId(null)}
                        className="text-[11px] text-slate-400 hover:text-red-400 transition-colors"
                      >
                        {t('Odłącz poświadczenie')}
                      </button>
                    )}
                  </div>

                  <p className="text-[11px] text-slate-400 mb-3">
                    {t('Możesz wybrać zdefiniowane poświadczenie i współdzielić je pomiędzy połączeniami lub wprowadzić dane jednorazowo poniżej.')}
                  </p>

                  <select
                    value={credentialId || ''}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      setCredentialId(id);
                      if (id) {
                        const cred = credentials.find((c) => c.id === id);
                        if (cred) {
                          if (cred.username && (!username || username === 'root')) {
                            setUsername(cred.username);
                          }
                          setSshAuthType(cred.authType);
                        }
                      }
                    }}
                    className="w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                  >
                    <option value="">{t('(Brak - wprowadź dane jednorazowo poniżej)')}</option>
                    {credentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} — {c.username} ({c.authType === 'password' ? t('Hasło') : c.authType === 'key' ? t('Klucz prywatny') : t('Certyfikat')})
                      </option>
                    ))}
                  </select>

                  {credentialId && (() => {
                    const selected = credentials.find((c) => c.id === credentialId);
                    if (!selected) return null;
                    return (
                      <div className="mt-3 flex items-center gap-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-2.5 text-xs text-cyan-300">
                        <KeyRound className="h-4 w-4 shrink-0 text-cyan-400" />
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold text-white">{selected.name}</span>
                          <span className="text-slate-300"> ({selected.username})</span>
                          <span className="ml-2 rounded bg-cyan-900/50 px-1.5 py-0.5 text-[10px] text-cyan-200 uppercase font-mono">
                            {selected.authType}
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="flex items-center gap-2 text-xs font-semibold text-cyan-400 mb-3">
                    <Shield className="h-4 w-4" />
                    {t('Wszystkie dane uwierzytelniające są szyfrowane AES-256-GCM')}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-300">
                        {t('Nazwa użytkownika')}
                      </label>
                      <input
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder={t('np. root, admin, administrator')}
                        className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    {/* Password with Reveal Button (Założenie 7) */}
                    <div>
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-semibold text-slate-300">
                          {t('Hasło')}
                        </label>
                        {editingConnection && (
                          <button
                            type="button"
                            onClick={handleRevealPassword}
                            disabled={revealingPassword}
                            className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300"
                          >
                            {revealingPassword ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : showPassword ? (
                              <EyeOff className="h-3 w-3" />
                            ) : (
                              <Eye className="h-3 w-3" />
                            )}
                            {showPassword ? t('Ukryj hasło') : t('Pokaż hasło')}
                          </button>
                        )}
                      </div>
                      <div className="relative mt-1.5">
                        <input
                          type={showPassword ? 'text' : 'password'}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder={
                            editingConnection?.passwordEncrypted
                              ? showPassword ? password : t('•••••••••••• (Zapisane w sejfie)')
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
                  </div>

                  {protocol === 'rdp' && (() => {
                    const cred = credentialId ? credentials.find((c) => c.id === credentialId) : undefined;
                    const effectiveUser = cred?.username || username;
                    const login = rdpLoginLabel(effectiveUser, rdpDomain);
                    const effectiveDomain = normalizeRdpIdentity(effectiveUser, rdpDomain).domain ?? '';
                    // The separate field is not used when the user name already decides the domain
                    const ignored =
                      rdpDomain.trim() !== '' && effectiveDomain.toLowerCase() !== rdpDomain.trim().toLowerCase();
                    return (
                      <div className="mt-4">
                        <label className="block text-xs font-semibold text-slate-300">
                          {t('Domena Windows')} <span className="font-normal text-slate-500">{t('(opcjonalnie)')}</span>
                        </label>
                        <input
                          type="text"
                          value={rdpDomain}
                          onChange={(e) => setRdpDomain(e.target.value)}
                          placeholder={t('np. CORP lub corp.local – puste dla konta lokalnego')}
                          className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                        />
                        <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                          {t('Domenę można też wpisać w nazwie użytkownika:')} <span className="font-mono text-slate-400">CORP\jan</span> {t('lub')}{' '}
                          <span className="font-mono text-slate-400">jan@corp.local</span>. {t('Konto lokalne serwera:')}{' '}
                          <span className="font-mono text-slate-400">.\administrator</span>.
                        </p>
                        {login && (
                          <p className="mt-1 text-[11px] text-slate-400">
                            {t('Logowanie jako:')} <span className="font-mono text-cyan-300">{login}</span>
                            {ignored && (
                              <span className="text-amber-300/90"> {t('(pole „Domena” jest pomijane, bo nazwa użytkownika już ją określa)')}</span>
                            )}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* SSH Specific Auth: Keys & Certs (Założenie 4) */}
                {protocol === 'ssh' && (
                  <SshKeyFields
                    authType={sshAuthType}
                    setAuthType={setSshAuthType}
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
                    hasStoredPassphrase={Boolean(editingConnection?.privateKeyPassphraseEncrypted)}
                    certificateContent={certificateContent}
                    setCertificateContent={setCertificateContent}
                    certInputMode={certInputMode}
                    setCertInputMode={setCertInputMode}
                    certFilePath={certFilePath}
                    setCertFilePath={setCertFilePath}
                    setError={setError}
                  />
                )}
              </div>
            )}

            {/* TAB: SSH TUNNELS / PORT FORWARDING (Założenie 4) */}
            {activeTab === 'tunnels' && protocol === 'ssh' && (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 space-y-3">
                  <div>
                    <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                      <ArrowRightLeft className="h-4 w-4 text-cyan-400" />
                      {t('Przekierowania Portów (Port Forwarding)')}
                    </h3>
                    <p className="mt-1 text-xs text-slate-400 leading-relaxed">
                      {t('Konfiguracja tuneli SSH: ruch lokalny do zdalnego (Local -L), ruch zdalny do lokalnego (Remote -R) oraz dynamiczny serwer proxy (Dynamic SOCKS5 -D).')}
                    </p>
                  </div>

                  {/* Ergonomic button bar below description */}
                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80">
                    <button
                      type="button"
                      onClick={() => addPortForwardRule('local')}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-500/50 hover:bg-slate-700 hover:text-white transition-all shadow-xs cursor-pointer"
                    >
                      <Plus className="h-3.5 w-3.5 text-emerald-400" />
                      {t('Dodaj Local (-L)')}
                    </button>
                    <button
                      type="button"
                      onClick={() => addPortForwardRule('remote')}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-500/50 hover:bg-slate-700 hover:text-white transition-all shadow-xs cursor-pointer"
                    >
                      <Plus className="h-3.5 w-3.5 text-amber-400" />
                      {t('Dodaj Remote (-R)')}
                    </button>
                    <button
                      type="button"
                      onClick={() => addPortForwardRule('dynamic')}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-600/20 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-cyan-600/30 hover:border-cyan-400 transition-all shadow-xs cursor-pointer"
                    >
                      <Plus className="h-3.5 w-3.5 text-cyan-400" />
                      {t('Dodaj Dynamic SOCKS5 (-D)')}
                    </button>
                  </div>
                </div>

                {portForwarding.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center text-xs text-slate-500">
                    {t('Brak skonfigurowanych przekierowań portów. Kliknij przycisk powyżej, aby dodać tunel.')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {portForwarding.map((rule) => (
                      <div
                        key={rule.id}
                        className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3"
                      >
                        {/* Enabled switch */}
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={(e) => updatePortForwardRule(rule.id, { enabled: e.target.checked })}
                          className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                        />

                        {/* Type badge */}
                        <span
                          className={`rounded px-2 py-0.5 text-[10px] font-bold font-mono uppercase ${
                            rule.forwardType === 'local'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : rule.forwardType === 'remote'
                              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                              : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                          }`}
                        >
                          {rule.forwardType === 'dynamic' ? t('Dynamic SOCKS5') : rule.forwardType}
                        </span>

                        {/* Listening port: on this computer for -L / -D, on the server for -R */}
                        <div
                          className="flex items-center gap-1"
                          title={
                            rule.forwardType === 'remote'
                              ? t('Port, na którym serwer SSH nasłuchuje (ssh -R port:cel)')
                              : t('Port na tym komputerze (127.0.0.1), z którym łączą się programy')
                          }
                        >
                          <span className="whitespace-nowrap text-[11px] text-slate-400">
                            {rule.forwardType === 'remote' ? t('Port na serwerze:') : t('Port lokalny:')}
                          </span>
                          <input
                            type="number"
                            min={1}
                            max={MAX_PORT}
                            step={1}
                            value={rule.localPort || ''}
                            onChange={(e) => updatePortForwardRule(rule.id, { localPort: clampTyped(e.target.value, MAX_PORT) })}
                            className="w-20 rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-xs text-white"
                          />
                        </div>

                        {/* Remote Destination (for local and remote) */}
                        {rule.forwardType !== 'dynamic' && (
                          <>
                            <ArrowRightLeft className="h-3.5 w-3.5 text-slate-500" />
                            <div
                              className="flex items-center gap-1 flex-1"
                              title={
                                rule.forwardType === 'remote'
                                  ? t('Dokąd przekazać połączenia z serwera – adres widziany z tego komputera')
                                  : t('Dokąd serwer SSH ma przekazać połączenie – adres widziany z serwera')
                              }
                            >
                              <span className="whitespace-nowrap text-[11px] text-slate-400">
                                {rule.forwardType === 'remote' ? t('Cel na tym komputerze:') : t('Cel (z serwera):')}
                              </span>
                              <input
                                type="text"
                                value={rule.remoteHost || '127.0.0.1'}
                                onChange={(e) => updatePortForwardRule(rule.id, { remoteHost: e.target.value })}
                                placeholder="127.0.0.1"
                                className="flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-xs text-white"
                              />
                              <span className="text-slate-500">:</span>
                              <input
                                type="number"
                                min={1}
                                max={MAX_PORT}
                                step={1}
                                value={rule.remotePort === undefined ? 80 : rule.remotePort || ''}
                                onChange={(e) => updatePortForwardRule(rule.id, { remotePort: clampTyped(e.target.value, MAX_PORT) })}
                                className="w-20 rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-xs text-white"
                              />
                            </div>
                          </>
                        )}

                        {rule.forwardType === 'dynamic' && (
                          <span className="flex-1 text-[11px] text-slate-500 italic">
                            {t('Lokalny serwer SOCKS5 proxy dla przeglądarki lub narzędzi')}
                          </span>
                        )}

                        <button
                          type="button"
                          onClick={() => removePortForwardRule(rule.id)}
                          className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB: RDP SETTINGS */}
            {activeTab === 'rdp' && protocol === 'rdp' && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300">
                      {t('Szerokość (px)')}
                    </label>
                    <input
                      type="number"
                      min={MIN_RDP_SIZE}
                      max={MAX_RDP_SIZE}
                      step={1}
                      value={rdpWidth || ''}
                      onChange={(e) => setRdpWidth(clampTyped(e.target.value, MAX_RDP_SIZE))}
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-300">
                      {t('Wysokość (px)')}
                    </label>
                    <input
                      type="number"
                      min={MIN_RDP_SIZE}
                      max={MAX_RDP_SIZE}
                      step={1}
                      value={rdpHeight || ''}
                      onChange={(e) => setRdpHeight(clampTyped(e.target.value, MAX_RDP_SIZE))}
                      className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="space-y-2 pt-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rdpClipboard}
                      onChange={(e) => setRdpClipboard(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                    />
                    <span className="text-xs text-slate-300">
                      {t('Synchronizacja schowka (kopiuj / wklej)')}
                    </span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rdpSound}
                      onChange={(e) => setRdpSound(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                    />
                    <span className="text-xs text-slate-300">
                      {t('Przesyłanie dźwięku z pulpitu zdalnego')}
                    </span>
                  </label>
                </div>
              </div>
            )}

            {/* TAB: NOTES & TAGS */}
            {activeTab === 'notes' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300">
                    {t('Tagi (rozdzielane przecinkami)')}
                  </label>
                  <input
                    type="text"
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                    placeholder={t('web, staging, nginx, k8s, dmz')}
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300">
                    {t('Notatki administracyjne')}
                  </label>
                  <textarea
                    rows={6}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={t('Wprowadź instrukcje, procedury serwisowe, dane kontaktowe...')}
                    className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Modal Footer */}
          <div className="flex items-center justify-between border-t border-slate-800 bg-slate-900 px-6 py-3">
            <span className="text-[11px] text-slate-500">
              {editingConnection ? `ID: ${editingConnection.id}` : t('Nowy wpis w bazie')}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 transition-colors"
              >
                {t('Anuluj')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-cyan-600/25 hover:opacity-95 disabled:opacity-50 transition-all"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t('Zapisz połączenie')}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
