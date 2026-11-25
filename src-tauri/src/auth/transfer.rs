//! Export and import of the vault (encrypted or plain), batch import (mRemoteNG).

use crate::vault::cipher::{decrypt_bytes, decrypt_opt, derive_key, encrypt_bytes, generate_salt};
use crate::vault::models::{
    Connection, DecryptedExportData, ExportPayload, Group, ImportSummary, VaultData
};
use crate::vault::backup::backup_while_locked;
use crate::vault::storage::{load_vault_verified, update_vault};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::BTreeMap;
use zeroize::Zeroizing;
use super::*;

#[tauri::command]
pub fn vault_export(export_password: Option<String>, allow_plaintext: Option<bool>, group_ids: Option<Vec<String>>, include_ungrouped: Option<bool>, state: tauri::State<'_, AuthState>) -> Result<String, String> {
    vault_export_impl(export_password, allow_plaintext, group_ids, include_ungrouped.unwrap_or(false), &state)
}

fn filter_export_scope(vault: &mut VaultData, group_ids: Option<&[String]>, include_ungrouped: bool) -> Result<(), String> {
    let Some(group_ids) = group_ids else { return Ok(()); }; // None means the complete vault.
    if group_ids.is_empty() && !include_ungrouped {
        return Err(tr!("Wybierz co najmniej jedną grupę lub połączenia bez grupy", "Select at least one group or ungrouped connections").into());
    }
    let parents: BTreeMap<_, _> = vault.groups.iter().map(|g| (g.id.clone(), g.parent_id.clone())).collect();
    if group_ids.iter().any(|id| !parents.contains_key(id)) {
        return Err(tr!("Wybrana grupa już nie istnieje. Wybierz zakres eksportu ponownie.", "A selected group no longer exists. Select the export scope again.").into());
    }
    let mut included: std::collections::BTreeSet<String> = group_ids.iter().cloned().collect();
    loop {
        let before = included.len();
        for group in &vault.groups {
            if group.parent_id.as_ref().is_some_and(|id| included.contains(id)) { included.insert(group.id.clone()); }
        }
        if included.len() == before { break; }
    }
    vault.connections.retain(|connection| match connection.group_id.as_ref() {
        Some(id) if parents.contains_key(id) => included.contains(id),
        _ => include_ungrouped,
    });
    let credentials: std::collections::BTreeSet<_> = vault.connections.iter().filter_map(|c| c.credential_id.clone()).collect();
    vault.credentials.retain(|credential| credentials.contains(&credential.id));
    // Preserve the parent folder chain, but never add its other connections or sibling groups.
    let mut folders = included.clone();
    for id in included {
        let mut current = parents.get(&id).and_then(|parent| parent.clone());
        while let Some(parent) = current {
            if !parents.contains_key(&parent) || !folders.insert(parent.clone()) { break; }
            current = parents.get(&parent).and_then(|next| next.clone());
        }
    }
    vault.groups.retain(|group| folders.contains(&group.id));
    Ok(())
}

pub(crate) fn vault_export_impl(export_password: Option<String>, allow_plaintext: Option<bool>, group_ids: Option<Vec<String>>, include_ungrouped: bool, state: &AuthState) -> Result<String, String> {
    let mgr = lock_auth(&state).map_err(|e| e.to_string())?;
    let key = mgr
        .unlocked_key()
        .map_err(|_| tr!("Sejf musi być odblokowany, aby wyeksportować dane", "The vault must be unlocked to export data").to_string())?;

    let mut vault = load_vault_verified(key)?;
    filter_export_scope(&mut vault, group_ids.as_deref(), include_ungrouped)?;
    let now = chrono::Utc::now().to_rfc3339();

    // Decrypt EVERY secret field. Any failure aborts the export instead of silently
    // writing ciphertext that could never be imported correctly.
    let mut clean_connections = Vec::with_capacity(vault.connections.len());
    for conn in &vault.connections {
        let mut clean = conn.clone();
        let ctx = |e: String| tr!("Nie udało się odszyfrować danych połączenia '{}': {}", "Could not decrypt the data of connection '{}': {}", conn.name, e);
        clean.password_encrypted = decrypt_opt(key, &conn.password_encrypted).map_err(ctx)?;
        clean.private_key_encrypted = decrypt_opt(key, &conn.private_key_encrypted).map_err(ctx)?;
        clean.private_key_passphrase_encrypted =
            decrypt_opt(key, &conn.private_key_passphrase_encrypted).map_err(ctx)?;
        clean_connections.push(clean);
    }
    let mut clean_credentials = Vec::with_capacity(vault.credentials.len());
    for cred in &vault.credentials {
        let mut clean = cred.clone();
        let ctx = |e: String| tr!("Nie udało się odszyfrować poświadczenia '{}': {}", "Could not decrypt credential '{}': {}", cred.name, e);
        clean.password_encrypted = decrypt_opt(key, &cred.password_encrypted).map_err(ctx)?;
        clean.private_key_encrypted = decrypt_opt(key, &cred.private_key_encrypted).map_err(ctx)?;
        clean.private_key_passphrase_encrypted =
            decrypt_opt(key, &cred.private_key_passphrase_encrypted).map_err(ctx)?;
        clean_credentials.push(clean);
    }

    if let Some(password) = export_password {
        let password = Zeroizing::new(password);
        check_new_password(&password, tr!("Hasło eksportu", "The export password"))?;

        let mut decrypted_data = DecryptedExportData {
            groups: vault.groups,
            connections: clean_connections,
            credentials: clean_credentials,
            exported_at: now.clone(),
        };
        let json_bytes = Zeroizing::new(
            serde_json::to_vec(&decrypted_data).map_err(|e| tr!("Błąd serializacji danych eksportu: {}", "Export data serialisation error: {}", e))?,
        );
        // The decrypted secrets are only needed in the serialised (wiped on drop) buffer
        {
            use zeroize::Zeroize;
            for c in &mut decrypted_data.connections {
                for secret in [&mut c.password_encrypted, &mut c.private_key_encrypted, &mut c.private_key_passphrase_encrypted].into_iter().flatten() {
                    secret.zeroize();
                }
            }
            for c in &mut decrypted_data.credentials {
                for secret in [&mut c.password_encrypted, &mut c.private_key_encrypted, &mut c.private_key_passphrase_encrypted].into_iter().flatten() {
                    secret.zeroize();
                }
            }
        }

        let salt = generate_salt();
        let export_key = derive_key(&password, &salt)?;
        let (ciphertext, nonce) = encrypt_bytes(&export_key, &json_bytes)?;

        let payload = ExportPayload {
            format: "remoteflow_export".to_string(),
            version: VAULT_FORMAT_VERSION,
            is_encrypted: true,
            salt_base64: Some(BASE64.encode(salt)),
            nonce_base64: Some(BASE64.encode(nonce)),
            ciphertext_base64: Some(BASE64.encode(ciphertext)),
            groups: None,
            connections: None,
            credentials: None,
            exported_at: now,
        };
        serde_json::to_string_pretty(&payload).map_err(|e| tr!("Błąd serializacji pliku eksportu: {}", "Export file serialisation error: {}", e))
    } else {
        if allow_plaintext != Some(true) {
            return Err(tr!("Eksport bez szyfrowania zapisuje wszystkie hasła i klucze jawnym tekstem – wymaga wyraźnego potwierdzenia", "An unencrypted export stores all passwords and keys in plain text – explicit confirmation is required").to_string());
        }
        let payload = ExportPayload {
            format: "remoteflow_export".to_string(),
            version: VAULT_FORMAT_VERSION,
            is_encrypted: false,
            salt_base64: None,
            nonce_base64: None,
            ciphertext_base64: None,
            groups: Some(vault.groups),
            connections: Some(clean_connections),
            credentials: Some(clean_credentials),
            exported_at: now,
        };
        serde_json::to_string_pretty(&payload).map_err(|e| tr!("Błąd serializacji pliku eksportu: {}", "Export file serialisation error: {}", e))
    }
}

#[tauri::command]
pub fn vault_import(payload_json: String, import_password: Option<String>, merge: bool, state: tauri::State<'_, AuthState>) -> Result<ImportSummary, String> {
    vault_import_impl(payload_json, import_password, merge, &state)
}

pub(crate) fn vault_import_impl(payload_json: String, import_password: Option<String>, merge: bool, state: &AuthState) -> Result<ImportSummary, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr
        .unlocked_key()
        .map_err(|_| tr!("Sejf musi być odblokowany, aby zaimportować dane", "The vault must be unlocked to import data").to_string())?;

    let export_payload: ExportPayload =
        serde_json::from_str(&payload_json).map_err(|e| tr!("Błąd parsowania pliku importu: {}", "Import file parse error: {}", e))?;
    if export_payload.format != "remoteflow_export" {
        return Err(tr!("Nieobsługiwany format pliku importu", "Unsupported import file format").to_string());
    }
    // v1 exports: the passphrase field (and fields whose decryption failed) still hold
    // ciphertext of the source vault.
    let legacy = export_payload.version < 2;

    let (imported_groups, mut imported_connections, mut imported_credentials) = if export_payload.is_encrypted {
        let password = Zeroizing::new(import_password.ok_or(tr!("Plik importu jest zaszyfrowany. Wprowadź hasło.", "The import file is encrypted. Enter the password."))?);
        let salt_b64 = export_payload.salt_base64.ok_or(tr!("Brak soli w pliku importu", "The import file has no salt"))?;
        let nonce_b64 = export_payload.nonce_base64.ok_or(tr!("Brak nonce w pliku importu", "The import file has no nonce"))?;
        let ct_b64 = export_payload.ciphertext_base64.ok_or(tr!("Brak szyfrogramu w pliku importu", "The import file has no ciphertext"))?;

        let salt = BASE64.decode(salt_b64).map_err(|e| e.to_string())?;
        let nonce = decode_nonce(&nonce_b64)?;
        let ct = BASE64.decode(ct_b64).map_err(|e| e.to_string())?;

        let import_key = derive_key(&password, &salt)?;
        let decrypted_bytes = Zeroizing::new(
            decrypt_bytes(&import_key, &ct, &nonce)
                .map_err(|_| tr!("Błędne hasło pliku importu lub uszkodzone dane", "Wrong import file password or corrupted data").to_string())?,
        );
        let data: DecryptedExportData = serde_json::from_slice(&decrypted_bytes)
            .map_err(|e| tr!("Błąd parsowania odszyfrowanych danych: {}", "Error parsing the decrypted data: {}", e))?;
        (data.groups, data.connections, data.credentials)
    } else {
        (
            export_payload.groups.unwrap_or_default(),
            export_payload.connections.unwrap_or_default(),
            export_payload.credentials.unwrap_or_default(),
        )
    };

    for conn in imported_connections.iter_mut() {
        seal_connection(key, conn, legacy)?;
    }
    for cred in imported_credentials.iter_mut() {
        seal_credential(key, cred, legacy)?;
    }

    let summary = ImportSummary {
        groups_imported: imported_groups.len(),
        connections_imported: imported_connections.len(),
        credentials_imported: imported_credentials.len(),
        passwords_failed: 0,
    };

    update_vault(key, |v| {
        if !merge {
            // Replacing all connections – keep a restore point first.
            backup_while_locked(&v.metadata.backup, "pre-import", true)?;
        }
        if merge {
            for group in imported_groups {
                if !v.groups.iter().any(|g| g.id == group.id) {
                    v.groups.push(group);
                }
            }
            for conn in imported_connections {
                upsert_by_id(&mut v.connections, conn, |c| c.id.as_str());
            }
            for cred in imported_credentials {
                upsert_by_id(&mut v.credentials, cred, |c| c.id.as_str());
            }
        } else {
            v.groups = imported_groups;
            v.connections = imported_connections;
            // Legacy exports did not contain credentials – keep the existing ones then.
            if !legacy {
                v.credentials = imported_credentials;
            }
        }
        Ok(())
    })?;

    Ok(summary)
}

#[tauri::command]
pub fn vault_batch_import(
    groups: Vec<Group>,
    connections: Vec<Connection>,
    merge: bool,
    mremoteng: Option<crate::vault::mremoteng::MrngParams>,
    state: tauri::State<'_, AuthState>,
) -> Result<ImportSummary, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr
        .unlocked_key()
        .map_err(|_| tr!("Sejf musi być odblokowany, aby zaimportować połączenia", "The vault must be unlocked to import connections").to_string())?;

    let groups_count = groups.len();
    let conns_count = connections.len();

    // mRemoteNG: the password fields still hold mRemoteNG ciphertext – decrypt them here, so the
    // plaintext never passes through the UI.
    let mut encrypted_conns = connections;
    let mut passwords_failed = 0usize;
    if let Some(params) = &mremoteng {
        crate::vault::mremoteng::verify_password(params, None)?;
        for conn in encrypted_conns.iter_mut() {
            if let Some(raw) = conn.password_encrypted.take() {
                if raw.trim().is_empty() {
                    continue;
                }
                match crate::vault::mremoteng::decrypt_value(params, &raw) {
                    Some(plain) => conn.password_encrypted = Some(plain.to_string()),
                    None => passwords_failed += 1,
                }
            }
        }
    }

    // Every secret field is now plaintext – encrypt all of them with the vault key.
    for conn in encrypted_conns.iter_mut() {
        seal_connection(key, conn, false)?;
    }

    update_vault(key, |v| {
        if merge {
            for group in groups {
                if !v.groups.iter().any(|g| g.id == group.id) {
                    v.groups.push(group);
                }
            }
            for conn in encrypted_conns {
                upsert_by_id(&mut v.connections, conn, |c| c.id.as_str());
            }
        } else {
            v.groups = groups;
            v.connections = encrypted_conns;
        }
        Ok(())
    })?;

    Ok(ImportSummary {
        groups_imported: groups_count,
        connections_imported: conns_count,
        credentials_imported: 0,
        passwords_failed,
    })
}
