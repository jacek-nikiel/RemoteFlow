import React, { useState, useEffect } from 'react';
import { X, Folder } from 'lucide-react';
import { Group } from '../../types';
import { useT } from '../../i18n';
import { descendantGroupIds } from '../../utils/groupTree';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave: (group: Group) => Promise<unknown>;
  editingGroup: Group | null;
  groups: Group[];
  defaultParentId?: string | null;
}

export const GroupModal: React.FC<Props> = ({
  isOpen,
  onClose,
  onSave,
  editingGroup,
  groups,
  defaultParentId,
}) => {
  const [name, setName] = useState('');
  const t = useT();
  const [parentId, setParentId] = useState<string | null>(null);
  // The folder itself and its subfolders cannot be its parent (that would make a cycle)
  const excluded = editingGroup ? new Set([editingGroup.id, ...descendantGroupIds(groups, editingGroup.id)]) : new Set<string>();
  const [color, setColor] = useState('#3b82f6');
  const [icon, setIcon] = useState('folder');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (editingGroup) {
      setName(editingGroup.name);
      setParentId(editingGroup.parentId);
      setColor(editingGroup.color || '#3b82f6');
      setIcon(editingGroup.icon || 'folder');
    } else {
      setName('');
      setParentId(defaultParentId || null);
      setColor('#3b82f6');
      setIcon('folder');
    }
    setError(null);
  }, [editingGroup, defaultParentId, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t('Podaj nazwę folderu / grupy'));
      return;
    }

    setSaving(true);
    try {
      const g: Group = {
        id: editingGroup ? editingGroup.id : 'group-' + Math.random().toString(36).substring(2, 9),
        name: name.trim(),
        parentId,
        icon,
        color,
      };
      await onSave(g);
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
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Folder className="h-5 w-5 text-amber-400" />
            <h2 className="text-sm font-bold text-white">
              {editingGroup ? t('Edytuj folder') : t('Nowy folder / grupa')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-400">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-300">
              {t('Nazwa grupy / folderu')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('np. Klastry Produkcyjne, DMZ, Test...')}
              autoFocus
              required
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300">
              {t('Folder nadrzędny (Zagnieżdżenie)')}
            </label>
            <select
              value={parentId || ''}
              onChange={(e) => setParentId(e.target.value || null)}
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
            >
              <option value="">{t('(Brak - folder główny)')}</option>
              {groups
                .filter((g) => !excluded.has(g.id))
                .map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              {t('Kolor wyróżniający')}
            </label>
            <div className="flex gap-2">
              {['#ef4444', '#f97316', '#eab308', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6'].map(
                (c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    style={{ backgroundColor: c }}
                    className={`h-7 w-7 rounded-full transition-transform ${
                      color === c ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-slate-900' : 'opacity-80 hover:opacity-100'
                    }`}
                  />
                )
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-slate-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              {t('Anuluj')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-cyan-600/25 hover:opacity-95 disabled:opacity-50"
            >
              {t('Zapisz folder')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
