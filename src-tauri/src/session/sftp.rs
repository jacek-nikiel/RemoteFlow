use crate::session::ssh::SshConnectionConfig;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpFileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub permissions: u32,
    /// Symbolic link (shown with the type / size of its target).
    #[serde(rename = "isLink", default, skip_serializing_if = "std::ops::Not::not")]
    pub is_link: bool,
}

pub fn sftp_connect(config: &SshConnectionConfig) -> Result<(ssh2::Session, ssh2::Sftp), String> {
    let sess = crate::session::ssh::ssh_connect_raw(config)?;
    sess.set_timeout(20_000);
    let sftp = sess.sftp().map_err(|e| tr!("Błąd otwierania podsystemu SFTP: {}", "Error opening the SFTP subsystem: {}", e))?;
    Ok((sess, sftp))
}

