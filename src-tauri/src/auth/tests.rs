//! Tests of the auth module (sealing, lifecycle: init, unlock, PIN, lock, import/export…).

#[cfg(test)]
mod tests {
    use crate::auth::*;

    #[test]
    fn seal_imported_does_not_double_encrypt_own_ciphertext() {
        let key = Zeroizing::new([3u8; 32]);
        let own = encrypt_string(&key, "secret").unwrap();

        let mut field = Some(own.clone());
        seal_imported(&key, &mut field, true).unwrap();
        assert_eq!(field.as_deref(), Some(own.as_str()));

        let mut plain = Some("secret".to_string());
        seal_imported(&key, &mut plain, true).unwrap();
        assert_eq!(decrypt_string(&key, plain.as_ref().unwrap()).unwrap(), "secret");

        let mut empty = Some(String::new());
        seal_imported(&key, &mut empty, false).unwrap();
        assert!(empty.is_none());
    }

    #[test]
    fn idle_auto_lock() {
        let state: AuthState = Mutex::new(AuthManager::new());
        {
            let mut mgr = state.lock().unwrap();
            mgr.set_unlocked(Zeroizing::new([5u8; 32]));
            mgr.idle_timeout_mins = 1;
        }
        assert_eq!(lock_if_idle(&state), None, "fresh activity -> no lock");
        {
            let mut mgr = state.lock().unwrap();
            mgr.last_activity = std::time::Instant::now() - std::time::Duration::from_secs(61);
        }
        assert_eq!(lock_if_idle(&state), Some(false), "idle > timeout -> full lock (no PIN)");
        assert!(!state.lock().unwrap().is_unlocked);
        assert_eq!(lock_if_idle(&state), None, "already locked");

        // with PIN armed -> PIN lock; timeout 0 disables
        {
            let mut mgr = state.lock().unwrap();
            let key = Zeroizing::new([5u8; 32]);
            mgr.arm_pin(&key, "1234").unwrap();
            mgr.set_unlocked(key);
            mgr.idle_timeout_mins = 0;
            mgr.last_activity = std::time::Instant::now() - std::time::Duration::from_secs(3600);
        }
        assert_eq!(lock_if_idle(&state), None, "timeout 0 = disabled");
        state.lock().unwrap().idle_timeout_mins = 5;
        assert_eq!(lock_if_idle(&state), Some(true));
        assert!(state.lock().unwrap().is_pin_locked);
    }

    #[test]
    fn pin_wrap_roundtrip_and_wrong_pin() {
        let master = Zeroizing::new([9u8; 32]);
        let mut mgr = AuthManager::new();
        mgr.arm_pin(&master, "1234").unwrap();
        let wrap = mgr.pin_wrap.as_ref().unwrap();
        let ok = decrypt_bytes(&derive_pin_key("1234", &wrap.salt).unwrap(), &wrap.ciphertext, &wrap.nonce).unwrap();
        assert_eq!(ok.as_slice(), master.as_slice());
        assert!(decrypt_bytes(&derive_pin_key("1235", &wrap.salt).unwrap(), &wrap.ciphertext, &wrap.nonce).is_err());
    }
}

/// End-to-end tests of the vault lifecycle (uses a real vault.json next to the test binary).
#[cfg(test)]
mod lifecycle_tests {
    use crate::auth::*;
    use crate::vault::models::ExportPayload;
    use crate::vault::known_hosts::{check_host, HostTrust};

    fn conn(id: &str, host: &str) -> Connection {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": "srv", "groupId": null, "credentialId": null, "protocol": "ssh",
            "host": host, "port": 22, "username": "root", "passwordEncrypted": null,
            "sshAuthType": "password", "privateKeyEncrypted": null, "privateKeyPassphraseEncrypted": null,
            "certificateContent": null, "portForwarding": [], "rdpSettings": null, "tags": [],
            "notes": null, "createdAt": "", "updatedAt": ""
        }))
        .unwrap()
    }

    fn raw_file() -> String {
        std::fs::read_to_string(get_vault_path()).unwrap()
    }

    #[test]
    fn connection_draft_can_be_saved_after_idle_unlock() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let _ = std::fs::remove_file(&path);
        let state: AuthState = Mutex::new(AuthManager::new());
        vault_init_impl("password123", &state).unwrap();
        let mut draft = vault_save_connection_impl(
            conn("draft", "10.0.0.1"), Some("original-secret".into()), None, None, &state,
        ).unwrap();
        vault_set_pin_impl("1234", true, &state).unwrap();
        draft.name = "Unfinished edit".into();
        draft.host = "10.0.0.2".into();
        {
            let mut mgr = state.lock().unwrap();
            mgr.idle_timeout_mins = 1;
            mgr.last_activity = std::time::Instant::now() - std::time::Duration::from_secs(61);
        }
        let before = raw_file();
        assert_eq!(lock_if_idle(&state), Some(true));
        assert!(vault_save_connection_impl(draft.clone(), None, None, None, &state).is_err());
        assert_eq!(raw_file(), before, "a locked editor cannot write");
        assert!(vault_unlock_pin_impl("0000", &state).is_err());
        vault_unlock_pin_impl("1234", &state).unwrap();
        assert_eq!(lock_if_idle(&state), None, "unlock resets the inactivity timer");
        draft = vault_save_connection_impl(draft, None, None, None, &state).unwrap();
        assert_eq!(draft.host, "10.0.0.2");
        assert_eq!(vault_reveal_password_impl("draft", &state).unwrap(), "original-secret");

        // The same draft also survives switching from PIN to Master Password.
        vault_lock(&state);
        draft.notes = Some("Resumed after Master Password".into());
        assert!(vault_save_connection_impl(draft.clone(), Some("new-secret".into()), None, None, &state).is_err());
        vault_unlock_master_impl("password123", None, &state).unwrap();
        let saved = vault_save_connection_impl(draft, Some("new-secret".into()), None, None, &state).unwrap();
        assert_eq!(saved.notes.as_deref(), Some("Resumed after Master Password"));
        assert_eq!(vault_reveal_password_impl("draft", &state).unwrap(), "new-secret");
        vault_lock(&state);
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl("draft", &state).unwrap(), "new-secret");
        assert!(!raw_file().contains("new-secret"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn full_lifecycle() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let _ = std::fs::remove_file(&path);
        let state: AuthState = Mutex::new(AuthManager::new());

        // --- init ---------------------------------------------------------------------------
        assert!(vault_init_impl("short", &state).is_err(), "min length enforced");
        vault_init_impl("password123", &state).unwrap();
        assert!(vault_init_impl("password123", &state).is_err(), "init must not overwrite an existing vault");

        // --- secrets ------------------------------------------------------------------------
        vault_save_connection_impl(
            conn("c1", "10.0.0.1"),
            Some("s3cret".into()),
            Some("KEY".into()),
            Some("phrase".into()),
            &state,
        )
        .unwrap();
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret");
        assert!(!raw_file().contains("s3cret"));

        // --- lock without PIN = full lock -----------------------------------------------------
        assert!(!vault_lock_to_pin_impl(&state).unwrap());
        assert!(vault_reveal_password_impl("c1", &state).is_err());
        assert!(vault_unlock_master_impl("wrongpass1", None, &state).is_err());
        vault_unlock_master_impl("password123", None, &state).unwrap();

        // --- PIN: never stored as wrapped key on disk, limited attempts -------------------------
        vault_set_pin_impl("1234", true, &state).unwrap();
        let file = raw_file();
        assert!(!file.contains("pin_wrapped_master_key_base64"));
        assert!(!file.contains("pin_encrypted_base64"), "PIN configuration is inside the encrypted envelope");
        assert!(vault_unlock_pin_impl("1234", &state).is_err(), "PIN unlock only when PIN-locked");
        assert!(vault_lock_to_pin_impl(&state).unwrap());
        assert!(vault_unlock_pin_impl("0000", &state).unwrap_err().contains("Pozostało"));
        vault_unlock_pin_impl("1234", &state).unwrap();
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret");

        assert!(vault_lock_to_pin_impl(&state).unwrap());
        for _ in 0..2 {
            assert!(vault_unlock_pin_impl("9999", &state).is_err());
        }
        assert!(vault_unlock_pin_impl("9999", &state).unwrap_err().contains("Przekroczono"));
        assert!(vault_unlock_pin_impl("1234", &state).is_err(), "correct PIN rejected after lockout");
        // PIN is re-armed after a Master Password unlock (PIN read from the encrypted vault)
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert!(vault_lock_to_pin_impl(&state).unwrap());
        vault_unlock_pin_impl("1234", &state).unwrap();

        // --- integrity: external modification is detected ------------------------------------
        let original = raw_file();
        assert!(!original.contains("10.0.0.1"), "host addresses must be encrypted too");
        let mut tampered: serde_json::Value = serde_json::from_str(&original).unwrap();
        tampered["metadata"]["auto_lock_timeout_mins"] = serde_json::json!(999);
        std::fs::write(&path, tampered.to_string()).unwrap();
        assert!(vault_reveal_password_impl("c1", &state).unwrap_err().contains("VAULT_INTEGRITY_FAILED"));
        vault_lock(&state);
        assert!(vault_unlock_master_impl("password123", None, &state)
            .unwrap_err()
            .contains("VAULT_INTEGRITY_FAILED"));
        assert!(vault_unlock_master_impl("password123", Some(true), &state).is_err(), "encrypted envelopes always require integrity");
        std::fs::write(&path, original).unwrap();
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret");

        // --- export / import ------------------------------------------------------------------
        assert!(vault_export_impl(None, None, None, false, &state).is_err(), "plaintext export needs confirmation");
        let plain = vault_export_impl(None, Some(true), None, false, &state).unwrap();
        assert!(plain.contains("s3cret") && plain.contains("phrase"));
        let enc = vault_export_impl(Some("exportpass1".into()), None, None, false, &state).unwrap();
        assert!(!enc.contains("s3cret"));
        let summary = vault_import_impl(enc, Some("exportpass1".into()), true, &state).unwrap();
        assert_eq!(summary.connections_imported, 1);
        let key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        let v = load_vault_verified(&key).unwrap();
        let c = v.connections.iter().find(|c| c.id == "c1").unwrap();
        assert_eq!(decrypt_string(&key, c.private_key_passphrase_encrypted.as_ref().unwrap()).unwrap(), "phrase");
        assert_eq!(decrypt_string(&key, c.private_key_encrypted.as_ref().unwrap()).unwrap(), "KEY");

        // --- known hosts (TOFU) -----------------------------------------------------------------
        assert_eq!(check_host(Some(&key), "ssh", "Srv", 22, "SHA256:a").unwrap(), HostTrust::NewlyTrusted);
        assert_eq!(check_host(Some(&key), "ssh", "srv", 22, "SHA256:a").unwrap(), HostTrust::Known);
        assert!(check_host(Some(&key), "ssh", "srv", 22, "SHA256:b").unwrap_err().contains("MITM"));
        assert_eq!(check_host(None, "ssh", "srv", 22, "SHA256:a").unwrap(), HostTrust::Known);
        assert!(check_host(None, "ssh", "other", 22, "SHA256:a").is_err(), "no TOFU while locked");
        // A fingerprint planted in the file (MAC not updated) is ignored while locked: only the
        // list verified with the master key counts.
        let original = raw_file();
        let mut json: serde_json::Value = serde_json::from_str(&original).unwrap();
        json["metadata"]["knownHosts"]["ssh:srv:22"] = serde_json::Value::String("SHA256:evil".into());
        json["metadata"]["knownHosts"]["ssh:planted:22"] = serde_json::Value::String("SHA256:evil".into());
        std::fs::write(get_vault_path(), serde_json::to_string(&json).unwrap()).unwrap();
        assert!(check_host(None, "ssh", "srv", 22, "SHA256:evil").is_err());
        assert!(check_host(None, "ssh", "planted", 22, "SHA256:evil").is_err());
        assert_eq!(check_host(None, "ssh", "srv", 22, "SHA256:a").unwrap(), HostTrust::Known);
        std::fs::write(get_vault_path(), original).unwrap();

        // --- change master password ---------------------------------------------------------------
        vault_change_master_password_impl("password123", "newpassword9", &state).unwrap();
        vault_lock(&state);
        assert!(vault_unlock_master_impl("password123", None, &state).is_err());
        vault_unlock_master_impl("newpassword9", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret");

        // A signed v2 vault is upgraded without losing data; its backup remains restorable.
        let migration_key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        let mut v2 = load_vault_verified(&migration_key).unwrap();
        v2.metadata.version = 2;
        let (ct, nonce) = encrypt_bytes(&migration_key, CANARY_PHRASE_V2.as_bytes()).unwrap();
        v2.metadata.canary_ciphertext_base64 = BASE64.encode(ct);
        v2.metadata.canary_nonce_base64 = BASE64.encode(nonce);
        v2.mac = None;
        v2.mac = Some(crate::vault::cipher::compute_mac(&migration_key, &serde_json::to_vec(&v2).unwrap()).unwrap());
        std::fs::write(&path, serde_json::to_string_pretty(&v2).unwrap()).unwrap();
        assert!(raw_file().contains("10.0.0.1"));
        vault_lock(&state);
        vault_unlock_master_impl("newpassword9", None, &state).unwrap();
        assert!(!raw_file().contains("10.0.0.1"));
        assert_eq!(load_vault_verified(&migration_key).unwrap().metadata.version, 3);
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret");

        // --- legacy v1 vault is migrated -----------------------------------------------------------
        let salt = generate_salt();
        let k1 = derive_key("legacypass1", &salt).unwrap();
        let (cct, cn) = encrypt_bytes(&k1, CANARY_PHRASE_V1.as_bytes()).unwrap();
        let mut c_legacy = conn("old", "10.1.1.1");
        c_legacy.password_encrypted = Some(encrypt_string(&k1, "oldpw").unwrap());
        let legacy = serde_json::json!({
            "metadata": {
                "version": 1, "salt_base64": BASE64.encode(salt),
                "canary_nonce_base64": BASE64.encode(cn), "canary_ciphertext_base64": BASE64.encode(cct),
                "pin_enabled": true, "pin_salt_base64": "AAAA", "pin_wrapped_master_key_base64": "AAAA",
                "pin_nonce_base64": "AAAA", "auto_lock_screen": true, "auto_lock_timeout_mins": 15,
                "max_pin_attempts": 3
            },
            "groups": [], "connections": [c_legacy]
        });
        std::fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();
        vault_lock(&state);
        let st = vault_unlock_master_impl("legacypass1", None, &state).unwrap();
        assert!(st.security_warning.unwrap().contains("PIN"));
        assert!(!st.pin_enabled);
        let file = raw_file();
        assert!(file.contains("\"mac\"") && !file.contains("pin_wrapped_master_key_base64"));
        assert_eq!(vault_reveal_password_impl("old", &state).unwrap(), "oldpw");
        // A migrated (v2) vault can no longer be downgraded by stripping the MAC.
        let stripped: serde_json::Value = serde_json::from_str(&file).unwrap();
        let mut stripped = stripped;
        stripped.as_object_mut().unwrap().remove("mac");
        std::fs::write(&path, stripped.to_string()).unwrap();
        vault_lock(&state);
        assert!(vault_unlock_master_impl("legacypass1", None, &state)
            .unwrap_err()
            .contains("VAULT_INTEGRITY_FAILED"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn backups_and_restore() {
        // Separate state; runs after/before full_lifecycle in the same process – serialise via a file lock.
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let backups = crate::vault::backup::backup_dir(&BackupSettings::default());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&backups);
        let state: AuthState = Mutex::new(AuthManager::new());

        vault_init_impl("password123", &state).unwrap();
        assert!(!raw_file().contains("\"backup\""), "default backup settings are not serialised (MAC compatibility)");
        vault_save_connection_impl(conn("b1", "10.0.0.9"), Some("first".into()), None, None, &state).unwrap();

        let settings = BackupSettings::default();
        let first = crate::vault::backup::create_backup(&settings, "manual", false).unwrap().unwrap();
        // unchanged vault -> no duplicate automatic backup
        assert!(crate::vault::backup::create_backup(&settings, "auto", true).unwrap().is_none());

        vault_save_connection_impl(conn("b1", "10.0.0.9"), Some("second".into()), None, None, &state).unwrap();
        vault_change_master_password_impl("password123", "otherpass99", &state).unwrap();
        let list = crate::vault::backup::list_backups(&settings);
        assert!(list.iter().any(|b| b.name.contains("pre-password-change")));

        // rotation
        let small = BackupSettings { keep: 2, ..BackupSettings::default() };
        crate::vault::backup::create_backup(&small, "manual", false).unwrap();
        assert_eq!(crate::vault::backup::list_backups(&small).len(), 2);
        // the very first backup was rotated away; make a fresh one of the current state to restore later
        let _ = first;

        // restore the pre-password-change backup -> old password + old secret
        let pre = crate::vault::backup::list_backups(&settings)
            .into_iter()
            .find(|b| b.name.contains("pre-password-change"))
            .unwrap();
        crate::vault::backup::restore_backup(&settings, &pre.name).unwrap();
        lock_auth(&state).unwrap().clear();
        assert!(vault_unlock_master_impl("otherpass99", None, &state).is_err());
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl("b1", &state).unwrap(), "second");
        assert!(crate::vault::backup::restore_backup(&settings, "../vault.json").is_err());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&backups);
    }

    #[test]
    fn failed_pre_migration_backup_does_not_lock_the_user_out() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let backups = path.with_file_name("backups");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&backups);
        let _ = std::fs::remove_file(&backups);
        let state: AuthState = Mutex::new(AuthManager::new());
        vault_init_impl("password123", &state).unwrap();
        vault_save_connection_impl(conn("c1", "10.0.0.1"), Some("s3cret".into()), None, None, &state).unwrap();
        // Turn the file into a signed v2 vault (as written by RemoteFlow < 1.6.1)
        let key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        let mut v2 = load_vault_verified(&key).unwrap();
        v2.metadata.version = 2;
        let (ct, nonce) = encrypt_bytes(&key, CANARY_PHRASE_V2.as_bytes()).unwrap();
        v2.metadata.canary_ciphertext_base64 = BASE64.encode(ct);
        v2.metadata.canary_nonce_base64 = BASE64.encode(nonce);
        v2.mac = None;
        v2.mac = Some(crate::vault::cipher::compute_mac(&key, &serde_json::to_vec(&v2).unwrap()).unwrap());
        std::fs::write(&path, serde_json::to_string_pretty(&v2).unwrap()).unwrap();
        vault_lock(&state);

        // The backup folder cannot be created (a file is in the way)
        let _ = std::fs::remove_dir_all(&backups);
        std::fs::write(&backups, b"not a folder").unwrap();
        let status = vault_unlock_master_impl("password123", None, &state).unwrap();
        assert!(status.security_warning.unwrap_or_default().contains("v3"), "the user is told why");
        assert!(raw_file().contains("10.0.0.1"), "not converted without a backup");
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret", "the vault is usable");
        assert!(vault_save_connection_impl(conn("c2", "10.0.0.2"), None, None, None, &state).is_err(),
            "writing (= converting) still requires the backup");
        assert!(raw_file().contains("10.0.0.1"));

        // Once the backup works, the first write converts the vault and keeps a restorable copy
        std::fs::remove_file(&backups).unwrap();
        vault_save_connection_impl(conn("c2", "10.0.0.2"), None, None, None, &state).unwrap();
        assert!(!raw_file().contains("10.0.0.1"));
        let copies: Vec<_> = std::fs::read_dir(&backups).unwrap().flatten().collect();
        assert!(copies.iter().any(|e| e.file_name().to_string_lossy().contains("pre-migration-v3")));
        assert!(copies.iter().any(|e| std::fs::read_to_string(e.path()).unwrap().contains("10.0.0.1")));
        let _ = std::fs::remove_dir_all(&backups);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn prompted_password_is_encrypted_and_does_not_change_shared_credentials() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let _ = std::fs::remove_file(&path);
        let state: AuthState = Mutex::new(AuthManager::new());
        vault_init_impl("password123", &state).unwrap();
        let mut first = conn("first", "server-a");
        first.credential_id = Some("shared".into());
        let mut second = conn("second", "server-b");
        second.credential_id = Some("shared".into());
        vault_save_connection_impl(first, None, None, None, &state).unwrap();
        vault_save_connection_impl(second, None, None, None, &state).unwrap();
        let key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        update_vault(&key, |v| {
            v.credentials.push(serde_json::from_value(serde_json::json!({
                "id": "shared", "name": "shared", "username": "alice", "authType": "password",
                "createdAt": "", "updatedAt": ""
            })).unwrap());
            Ok(())
        }).unwrap();
        assert!(vault_set_connection_password_impl("first", "".into(), &state).is_err());
        assert!(vault_set_connection_password_impl("missing", "secret".into(), &state).is_err());
        let saved = vault_set_connection_password_impl("first", "new connection password".into(), &state).unwrap();
        assert_eq!(saved.host, "server-a");
        assert_eq!(saved.credential_id.as_deref(), Some("shared"));
        assert_eq!(vault_reveal_password_impl("first", &state).unwrap(), "new connection password");
        assert_eq!(vault_reveal_password_impl("second", &state).unwrap(), "");
        assert!(load_vault_verified(&key).unwrap().credentials[0].password_encrypted.is_none());
        assert!(!raw_file().contains("new connection password"));
        vault_lock(&state);
        assert!(vault_set_connection_password_impl("first", "other".into(), &state).is_err());
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl("first", &state).unwrap(), "new connection password");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cloned_connections_preserve_configuration_and_secrets_with_independent_ids() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let _ = std::fs::remove_file(&path);
        let state: AuthState = Mutex::new(AuthManager::new());
        vault_init_impl("password123", &state).unwrap();
        let mut source = conn("source", "server.example");
        source.name = "Production database".into();
        source.group_id = Some("group-prod".into());
        source.credential_id = Some("shared".into());
        source.tags = vec!["production".into()];
        source.notes = Some("Keep these notes".into());
        source.sftp_remote_dir = Some("/srv/data".into());
        source.rdp_settings = Some(serde_json::from_value(serde_json::json!({
            "width": 1920, "height": 1080, "colorDepth": 32, "sound": true, "clipboard": true
        })).unwrap());
        source.port_forwarding.push(serde_json::from_value(serde_json::json!({
            "id": "forward", "forwardType": "local", "localPort": 8000,
            "remoteHost": "localhost", "remotePort": 80, "enabled": true
        })).unwrap());
        let source = vault_save_connection_impl(source, Some("clone secret".into()), Some("PRIVATE KEY".into()), Some("key phrase".into()), &state).unwrap();
        let key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        update_vault(&key, |v| {
            v.credentials.push(serde_json::from_value(serde_json::json!({
                "id": "shared", "name": "shared", "username": "alice", "authType": "password", "createdAt": "", "updatedAt": ""
            })).unwrap());
            Ok(())
        }).unwrap();
        let first = vault_clone_connection_impl("source", &state).unwrap();
        let second = vault_clone_connection_impl("source", &state).unwrap();
        assert_ne!(source.id, first.id);
        assert_ne!(first.id, second.id);
        assert_ne!(first.name, second.name);
        assert!(first.name.starts_with(&source.name));
        assert!(second.name.ends_with(" 2)"));
        let canonical = |connection: &Connection| {
            let mut json = serde_json::to_value(connection).unwrap();
            for field in ["id", "name", "createdAt", "updatedAt"] { json.as_object_mut().unwrap().remove(field); }
            json
        };
        assert_eq!(canonical(&source), canonical(&first));
        assert_eq!(canonical(&source), canonical(&second));
        assert_eq!(vault_reveal_password_impl(&first.id, &state).unwrap(), "clone secret");
        assert_eq!(decrypt_string(&key, first.private_key_encrypted.as_ref().unwrap()).unwrap(), "PRIVATE KEY");
        assert_eq!(decrypt_string(&key, first.private_key_passphrase_encrypted.as_ref().unwrap()).unwrap(), "key phrase");
        assert!(vault_clone_connection_impl("missing", &state).is_err());
        let saved = load_vault_verified(&key).unwrap();
        assert_eq!(saved.connections.len(), 3);
        assert_eq!(saved.credentials.len(), 1);
        assert_eq!(serde_json::to_value(&source).unwrap(), serde_json::to_value(&saved.connections[0]).unwrap());
        vault_set_connection_password_impl(&first.id, "only the copy".into(), &state).unwrap();
        assert_eq!(vault_reveal_password_impl(&source.id, &state).unwrap(), "clone secret");
        assert!(!raw_file().contains("clone secret"));
        vault_lock(&state);
        assert!(vault_clone_connection_impl("source", &state).is_err());
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl(&first.id, &state).unwrap(), "only the copy");
        assert_eq!(vault_reveal_password_impl(&second.id, &state).unwrap(), "clone secret");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn export_scope_preserves_subtrees_without_leaking_other_connections_or_credentials() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let _ = std::fs::remove_file(&path);
        let state: AuthState = Mutex::new(AuthManager::new());
        vault_init_impl("password123", &state).unwrap();
        let key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        update_vault(&key, |v| {
            let group = |id: &str, parent: Option<&str>| Group {
                id: id.into(), name: id.into(), parent_id: parent.map(str::to_string), icon: None, color: None,
            };
            v.groups = vec![group("parent", None), group("child", Some("parent")), group("grandchild", Some("child")), group("other", None)];
            for (id, secret) in [("used", "used-profile-secret"), ("unrelated", "unrelated-profile-secret"), ("unused", "unused-profile-secret")] {
                v.credentials.push(serde_json::from_value(serde_json::json!({
                    "id": id, "name": id, "username": id, "authType": "password", "passwordEncrypted": encrypt_string(&key, secret).unwrap(),
                    "createdAt": "", "updatedAt": ""
                })).unwrap());
            }
            Ok(())
        }).unwrap();
        for (id, group, credential) in [
            ("parent-conn", Some("parent"), Some("unrelated")), ("child-conn", Some("child"), Some("used")),
            ("grandchild-conn", Some("grandchild"), Some("used")), ("other-conn", Some("other"), Some("unrelated")), ("root-conn", None, None),
        ] {
            let mut connection = conn(id, &format!("{}.example", id));
            connection.group_id = group.map(str::to_string);
            connection.credential_id = credential.map(str::to_string);
            vault_save_connection_impl(connection, Some(format!("{}-secret", id)), None, None, &state).unwrap();
        }
        let plain = |selection, root| -> ExportPayload {
            serde_json::from_str(&vault_export_impl(None, Some(true), selection, root, &state).unwrap()).unwrap()
        };
        let all = plain(None, false);
        assert_eq!(all.connections.unwrap().len(), 5);
        assert_eq!(all.credentials.unwrap().len(), 3);
        let subset = plain(Some(vec!["child".into(), "grandchild".into()]), false);
        assert_eq!(subset.connections.as_ref().unwrap().len(), 2);
        assert_eq!(subset.credentials.as_ref().unwrap().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["used"]);
        assert_eq!(subset.groups.unwrap().iter().map(|g| g.id.as_str()).collect::<Vec<_>>(), vec!["parent", "child", "grandchild"]);
        let parent = plain(Some(vec!["parent".into(), "child".into()]), false);
        assert_eq!(parent.connections.unwrap().len(), 3, "overlapping selections do not duplicate connections");
        let multiple = plain(Some(vec!["child".into(), "other".into()]), false);
        assert_eq!(multiple.connections.unwrap().len(), 3);
        let root = plain(Some(vec![]), true);
        assert_eq!(root.connections.unwrap()[0].id, "root-conn");
        assert!(root.groups.unwrap().is_empty());
        assert!(root.credentials.unwrap().is_empty());
        assert_eq!(plain(Some(vec!["child".into()]), true).connections.unwrap().len(), 3);
        assert!(vault_export_impl(None, Some(true), Some(vec![]), false, &state).is_err());
        assert!(vault_export_impl(None, Some(true), Some(vec!["missing".into()]), true, &state).is_err());
        assert!(vault_export_impl(None, None, Some(vec!["child".into()]), false, &state).is_err(), "plaintext still requires confirmation");
        // Excluded secrets are never decrypted, even if damaged.
        update_vault(&key, |v| {
            v.connections.iter_mut().find(|c| c.id == "other-conn").unwrap().password_encrypted = Some("broken".into());
            v.credentials.iter_mut().find(|c| c.id == "unrelated").unwrap().password_encrypted = Some("broken".into());
            Ok(())
        }).unwrap();
        let partial = vault_export_impl(None, Some(true), Some(vec!["child".into()]), false, &state).unwrap();
        assert!(!partial.contains("parent-conn") && !partial.contains("other-conn") && !partial.contains("root-conn"));
        assert!(!partial.contains("unrelated-profile-secret") && !partial.contains("unused-profile-secret"));
        let encrypted = vault_export_impl(Some("exportpass1".into()), None, Some(vec!["child".into()]), false, &state).unwrap();
        assert!(!encrypted.contains("child-conn-secret"));
        let summary = vault_import_impl(encrypted, Some("exportpass1".into()), false, &state).unwrap();
        assert_eq!((summary.connections_imported, summary.groups_imported, summary.credentials_imported), (2, 3, 1));
        assert_eq!(vault_reveal_password_impl("child-conn", &state).unwrap(), "child-conn-secret");
        assert!(vault_reveal_password_impl("other-conn", &state).is_err());
        let restored = load_vault_verified(&key).unwrap();
        assert_eq!(restored.groups.iter().find(|g| g.id == "child").unwrap().parent_id.as_deref(), Some("parent"));
        assert_eq!(decrypt_string(&key, restored.credentials[0].password_encrypted.as_ref().unwrap()).unwrap(), "used-profile-secret");
        vault_lock(&state);
        assert!(vault_export_impl(None, Some(true), None, false, &state).is_err());
        let _ = std::fs::remove_file(&path);
    }

    static TEST_SERIAL: Mutex<()> = Mutex::new(());

    fn vault_lock(state: &AuthState) {
        lock_auth(state).unwrap().clear();
    }
}
